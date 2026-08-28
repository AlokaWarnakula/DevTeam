// Verified checks, check baselines and regression detection: the part of DevTeamStore that answers
// "did this actually pass", as opposed to "who does this work go to".
//
// Composed onto DevTeamStore.prototype as a mixin rather than held as a collaborator object. These
// methods call the store's own internals constantly, and a collaborator would have had to be handed
// every one of them. As a mixin, `this` is still the store and no call site changed. The price is
// that the internals they reach for cannot be #private; see the note on _transaction in store.mjs.
import { randomUUID } from "node:crypto";
import { fromJson, json, now } from "./util.mjs";
import {
  CHECK_ALLOWLIST_LIMIT,
  matchCheckCommand,
  normalizeCheckCommand,
  packageScriptCommands,
  projectDeclaredCommands,
  resolveLocalBinary,
  runVerifiedCheck,
  VERIFIED_CHECKS_PER_REPORT,
} from "./checks.mjs";

export const checksMethods = {
  // The commands DevTeam is allowed to run for this project. This is the whole authority: an empty
  // list means nothing is ever executed and every reported check stays visibly agent-asserted.
  // Whether this project confines its checks. Off by default: turning it on can break a suite that
  // reaches outside the project root, so it is the human's decision like the allowlist itself.
  projectCheckSandbox(projectId) {
    return Boolean(this.db.prepare("SELECT check_sandbox FROM projects WHERE id = ?").get(projectId)?.check_sandbox);
  },

  projectCheckCommands(projectId) {
    return this.db.prepare("SELECT name, argv FROM project_check_commands WHERE project_id = ? ORDER BY name ASC")
      .all(projectId)
      .map((row) => ({ name: row.name, argv: fromJson(row.argv, []) }))
      .filter((entry) => Array.isArray(entry.argv) && entry.argv.length);
  },

  // What the project's package.json offers, so a human can see what enabling verification would
  // allow *before* enabling it. Reading this executes nothing and authorizes nothing.
  availableCheckCommands(projectId) {
    const project = this.db.prepare("SELECT root FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    return this._derivableCheckCommands(project.root);
  },

  // Everything this project *could* offer: what it declares for itself in .devteam/checks.json, plus
  // whatever is derivable from package.json if it happens to be a Node package. Declared entries win
  // on a name collision — a human writing the file is a stronger statement of intent than a script
  // body DevTeam parsed. Every entry has its local-binary shim resolved here, so what the dashboard
  // shows before enabling is exactly the argv that would run.
  _derivableCheckCommands(projectRoot) {
    const declared = projectDeclaredCommands(projectRoot);
    const derived = packageScriptCommands(projectRoot).map((entry) => ({ ...entry, source: "package.json" }));
    const byName = new Map();
    for (const entry of [...derived, ...declared]) {
      byName.set(entry.name, { ...entry, argv: resolveLocalBinary(projectRoot, entry.argv) });
    }
    return [...byName.values()].slice(0, CHECK_ALLOWLIST_LIMIT);
  },

  // Turn verification on (or off) for a project. Passing no commands snapshots the project's own
  // package.json scripts; passing an explicit list stores exactly that; passing an empty list turns
  // verification back off. Snapshotting is what keeps this safe — an agent that later edits a script
  // body changes nothing, because the argv DevTeam runs was pinned here by a human.
  setProjectCheckCommands({ projectId, commands = null, sandbox = null }) {
    const project = this.db.prepare("SELECT id, root FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    const requested = commands === null ? this._derivableCheckCommands(project.root) : commands;
    if (!Array.isArray(requested)) throw new Error("Check commands must be a list.");
    const entries = [];
    const seen = new Set();
    for (const candidate of requested.slice(0, CHECK_ALLOWLIST_LIMIT)) {
      const entry = normalizeCheckCommand(candidate);
      if (!entry) throw new Error(`Unusable check command: ${JSON.stringify(candidate)?.slice(0, 120)}. A command is a name plus an argv list whose program is a bare executable name.`);
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      // A human typing `eslint` means the one installed in this project. Resolve it here, at the
      // moment of pinning, so the stored argv is runnable rather than a name that fails to spawn.
      entries.push({ ...entry, argv: resolveLocalBinary(project.root, entry.argv) });
    }
    const stamp = now();
    this._transaction(() => {
      this.db.prepare("DELETE FROM project_check_commands WHERE project_id = ?").run(projectId);
      for (const entry of entries) {
        this.db.prepare("INSERT INTO project_check_commands (project_id, name, argv, created_at) VALUES (?, ?, ?, ?)")
          .run(projectId, entry.name, json(entry.argv), stamp);
      }
      if (sandbox !== null) this.db.prepare("UPDATE projects SET check_sandbox = ? WHERE id = ?").run(sandbox ? 1 : 0, projectId);
    });
    this._changed("project.check_commands");
    return {
      projectId, commands: entries, verificationEnabled: entries.length > 0,
      sandbox: this.projectCheckSandbox(projectId),
    };
  },

  // What a report claimed and what DevTeam found. Every record says whether it was verified, so an
  // unverified assertion can never be displayed as if DevTeam had confirmed it.
  _checksFor(assignmentId) {
    return this.db.prepare(`
      SELECT label, requested_command, command, verified, status, exit_code, duration_ms, output, created_at
      FROM assignment_checks WHERE assignment_id = ? AND superseded_at IS NULL
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId).map((row) => ({
      label: row.label,
      requestedCommand: row.requested_command,
      command: fromJson(row.command, null),
      verified: Boolean(row.verified),
      status: row.status,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      output: row.output,
      // The dashboard and the task detail payload both read this, so an unverified claim is labeled
      // wherever it is shown rather than only where someone remembered to label it.
      agentAsserted: !row.verified,
      createdAt: row.created_at,
    }));
  },

  // Normalize what an agent reported, then verify whatever it asked DevTeam to verify. A check is a
  // plain string (an assertion, as before) or { label, command } where command *selects* an entry
  // from the project's allowlist. The selected entry's argv is what runs; the agent's text never is.
  async _gradeReportedChecks(assignment, task, checks) {
    const allowlist = task?.project_id ? this.projectCheckCommands(task.project_id) : [];
    const sandbox = task?.project_id ? this.projectCheckSandbox(task.project_id) : false;
    const records = [];
    let executed = 0;
    // The configured timeout is the budget for the *report*, not for each command in it. Checks no
    // longer block the event loop, so this is no longer about keeping the server alive — it is about
    // keeping one report bounded: the refusal path deliberately leaves the claim intact, so ten
    // allowlisted checks at the default timeout could otherwise be replayed forever, each round
    // holding a write lease for twenty minutes while the rest of the team waited on those paths.
    const budgetStartedAt = Date.now();
    const remainingBudget = () => this.checkTimeoutMs - (Date.now() - budgetStartedAt);
    for (const item of Array.isArray(checks) ? checks.slice(0, 100) : []) {
      const isObject = item && typeof item === "object" && !Array.isArray(item);
      const requested = isObject ? String(item.command ?? "").trim() : "";
      const label = String((isObject ? (item.label ?? item.command ?? "") : item) ?? "").trim();
      if (!label) continue;
      const record = { label: label.slice(0, 500), requestedCommand: requested ? requested.slice(0, 200) : null, command: null, verified: false, status: "asserted", exitCode: null, durationMs: null, output: null };
      const entry = requested ? matchCheckCommand(allowlist, requested) : null;
      if (requested && !entry) {
        // The agent asked for something the human never allowlisted. Recorded plainly as
        // unavailable: DevTeam refuses to run it *and* refuses to call it verified.
        record.status = "unavailable";
        record.output = allowlist.length
          ? "No allowlisted command matches this name for the project."
          : "Command verification is not enabled for this project.";
      } else if (entry && executed >= VERIFIED_CHECKS_PER_REPORT) {
        record.status = "unavailable";
        record.output = `Only ${VERIFIED_CHECKS_PER_REPORT} commands are executed per report.`;
      } else if (entry && remainingBudget() <= 1000) {
        record.status = "unavailable";
        record.output = `The ${this.checkTimeoutMs}ms verification budget for this report was already spent.`;
      } else if (entry) {
        executed += 1;
        record.command = entry.argv;
        Object.assign(record, await runVerifiedCheck({
          argv: entry.argv,
          cwd: task.project_root,  // pinned to the project root; nothing selects a working directory
          timeoutMs: remainingBudget(),
          sandbox,
        }));
      }
      records.push(record);
    }
    return records;
  },

  // T2.3 — regression awareness.
  //
  // Verified checks always produced the raw material (exit codes over time) but nothing compared two
  // runs, so nothing in DevTeam ever noticed that agent B broke what agent A delivered. A team that
  // cannot see that cannot cover for each other; it is just several agents in one room.
  //
  // The comparison is per task, per *command*, and only over verified results. A label is prose an
  // agent chose; the argv is the allowlist entry DevTeam actually ran, so two agents describing the
  // same suite differently still compare against the same baseline, and an assertion can neither
  // establish a baseline nor quietly repair one.
  _checkCommandKey(record) {
    return Array.isArray(record.command) ? json(record.command) : null;
  },

  // Who plausibly broke it. Not "the agent that reported the failure" — that agent is usually the one
  // who *found* it — but whoever changed files between the last time this check passed and now.
  // Deliberately a list: with more than one writer in that window, naming one would be a guess
  // dressed up as a finding, so the honest answer is the set and its size.
  _regressionSuspects(taskId, sinceEventId, excludeAssignmentIds) {
    const excluded = new Set([excludeAssignmentIds].flat().filter(Boolean));
    const rows = this.db.prepare(`
      SELECT e.metadata, e.agent_id, e.author_name, e.created_at
      FROM events e
      WHERE e.task_id = ? AND e.type = 'assignment.completed' AND e.id > ?
      ORDER BY e.id ASC
    `).all(taskId, Number(sinceEventId) || 0);
    const suspects = new Map();
    for (const row of rows) {
      const metadata = fromJson(row.metadata, {});
      const changed = Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
      if (!changed.length) continue;                          // a read-only report changed nothing
      // Neither the report that surfaced the failure nor the one that last made this check green.
      // The mark is taken before a passing report writes its own completion event, so without the
      // second exclusion the assignment that fixed a check becomes a suspect for breaking it.
      if (excluded.has(metadata.assignmentId)) continue;
      const assignment = this.db.prepare("SELECT title FROM assignments WHERE id = ?").get(metadata.assignmentId);
      if (!assignment) continue;
      suspects.set(metadata.assignmentId, {
        assignmentId: metadata.assignmentId,
        title: assignment.title,
        author: row.author_name || null,
        authorAgentId: row.agent_id || null,
        changedFiles: changed.slice(0, 20),
        completedAt: row.created_at,
      });
    }
    return [...suspects.values()];
  },

  // Compare this report's verified checks against the task's baseline, record the new baseline, and
  // return whatever regressed. Called on both report paths — a refused report is still evidence, and
  // is in fact the path on which a regression is most often first seen.
  _recordCheckBaselines({ taskId, assignmentId, records, version, stamp }) {
    const regressions = [];
    for (const record of records) {
      if (!record.verified) continue;                          // assertions never touch a baseline
      if (!["passed", "failed"].includes(record.status)) continue; // 'unavailable' is not a result
      const commandKey = this._checkCommandKey(record);
      if (!commandKey) continue;
      const previous = this.db.prepare("SELECT * FROM check_baselines WHERE task_id = ? AND command_key = ?").get(taskId, commandKey);
      const regressed = previous?.status === "passed" && record.status === "failed";
      if (regressed) {
        const suspects = this._regressionSuspects(taskId, previous.last_passed_event_id,
          [assignmentId, previous.last_passed_assignment_id]);
        regressions.push({
          id: randomUUID(),
          commandKey,
          label: record.label,
          command: record.command,
          lastPassedAt: previous.last_passed_at || previous.updated_at,
          lastPassedAssignmentId: previous.last_passed_assignment_id || previous.assignment_id || null,
          suspects,
        });
      }
      // Where the timeline stands right now. Captured before this report writes its own completion
      // event, so the mark never includes the report that set it.
      const timelineMark = Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE task_id = ?").get(taskId).id) || 0;
      this.db.prepare(`
        INSERT INTO check_baselines (task_id, command_key, status, label, assignment_id, task_version, last_passed_at, last_passed_assignment_id, last_passed_event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, command_key) DO UPDATE SET
          status = excluded.status, label = excluded.label, assignment_id = excluded.assignment_id,
          task_version = excluded.task_version, updated_at = excluded.updated_at,
          -- Only a pass moves the "last green" mark. Keeping it pinned is what lets the *next*
          -- failure still name the whole window of changes since things actually worked.
          last_passed_at = CASE WHEN excluded.status = 'passed' THEN excluded.updated_at ELSE check_baselines.last_passed_at END,
          last_passed_assignment_id = CASE WHEN excluded.status = 'passed' THEN excluded.assignment_id ELSE check_baselines.last_passed_assignment_id END,
          last_passed_event_id = CASE WHEN excluded.status = 'passed' THEN excluded.last_passed_event_id ELSE check_baselines.last_passed_event_id END
      `).run(taskId, commandKey, record.status, record.label, assignmentId, Number(version) || 1,
        record.status === "passed" ? stamp : (previous?.last_passed_at || null),
        record.status === "passed" ? assignmentId : (previous?.last_passed_assignment_id || null),
        record.status === "passed" ? timelineMark : (previous?.last_passed_event_id || 0),
        stamp);
      // A check going green again closes whatever it broke, so the board does not accumulate
      // regressions that were quietly fixed by ordinary work.
      if (record.status === "passed") {
        this.db.prepare("UPDATE check_regressions SET resolved_at = ? WHERE task_id = ? AND command_key = ? AND resolved_at IS NULL")
          .run(stamp, taskId, commandKey);
      }
    }
    return regressions;
  },

  // Record the regressions and, where the breakage is attributable to work *other* than the report
  // that surfaced it, route a fix back to whoever did it. This is the mechanism that turns a group of
  // agents into a team that covers for each other: the agent that tripped over the breakage is told
  // it is not theirs to chase, and the agent that caused it is handed the work.
  _openRegressions({ taskId, assignmentId, regressions, stamp, projectId }) {
    const opened = [];
    for (const regression of regressions) {
      // One open fix per broken check. Without this, every subsequent report that runs the same
      // failing suite would queue another near-identical assignment.
      const existing = this.db.prepare(`
        SELECT fix_assignment_id FROM check_regressions
        WHERE task_id = ? AND command_key = ? AND resolved_at IS NULL AND fix_assignment_id IS NOT NULL LIMIT 1
      `).get(taskId, regression.commandKey);
      let fixAssignmentId = null;
      const soleSuspect = regression.suspects.length === 1 ? regression.suspects[0] : null;
      if (!existing && regression.suspects.length) {
        fixAssignmentId = randomUUID();
        const behaviour = this.roleBehaviour(projectId, "implementer");
        const suspectSummary = soleSuspect
          ? `“${soleSuspect.title}”${soleSuspect.author ? ` (${soleSuspect.author})` : ""}`
          : `${regression.suspects.length} pieces of work`;
        this.db.prepare(`
          INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, verifies, plans)
          VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?, ?)
        `).run(
          fixAssignmentId, taskId,
          `Fix the regression in “${regression.label}”`,
          [
            `The check “${regression.label}” passed before and now fails.`,
            `It was last green before ${suspectSummary} landed.`,
            regression.suspects.length === 1
              ? `Changed files: ${soleSuspect.changedFiles.join(", ")}.`
              : `Changed files across that window: ${[...new Set(regression.suspects.flatMap((suspect) => suspect.changedFiles))].slice(0, 20).join(", ")}.`,
            regression.suspects.length > 1
              ? "More than one piece of work landed in that window, so this attribution is a starting point, not a verdict — check before assuming."
              : "",
            "Restore the check to passing without reverting unrelated work.",
          ].filter(Boolean).join(" "),
          "implementer", soleSuspect?.author || null, stamp,
          behaviour.verifies ? 1 : 0, behaviour.plans ? 1 : 0,
        );
        // Scope the fix to the files the suspects actually touched. Left unscoped it would take a
        // whole-project lease and block every unrelated writer in the room — a regression fix that
        // stops the rest of the team is a worse outcome than the regression.
        const scope = [...new Set(regression.suspects.flatMap((suspect) => suspect.changedFiles))].slice(0, 50);
        if (scope.length) {
          this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)")
            .run(fixAssignmentId, json(scope));
        }
        this._event(taskId, null, "assignment.created", `Fix the regression in “${regression.label}”`, {
          assignmentId: fixAssignmentId, role: "implementer", requiresWrite: true,
          targetAgentName: soleSuspect?.author || null, regressionOf: regression.commandKey, writePaths: scope,
        });
      }
      this.db.prepare(`
        INSERT INTO check_regressions (id, task_id, command_key, label, detected_by_assignment_id, last_passed_assignment_id, suspects, fix_assignment_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(regression.id, taskId, regression.commandKey, regression.label, assignmentId,
        regression.lastPassedAssignmentId, json(regression.suspects), fixAssignmentId, stamp);
      this._event(taskId, null, "check.regressed",
        `“${regression.label}” passed before and now fails${soleSuspect ? `, first failing after “${soleSuspect.title}”` : ""}.`, {
          label: regression.label,
          command: regression.command,
          suspects: regression.suspects.map((suspect) => ({ assignmentId: suspect.assignmentId, title: suspect.title, author: suspect.author })),
          fixAssignmentId,
          detectedByAssignmentId: assignmentId,
        });
      opened.push({
        id: regression.id,
        label: regression.label,
        command: regression.command,
        lastPassedAt: regression.lastPassedAt,
        suspects: regression.suspects.map((suspect) => ({ assignmentId: suspect.assignmentId, title: suspect.title, author: suspect.author, changedFiles: suspect.changedFiles })),
        fixAssignmentId,
        attribution: regression.suspects.length === 1 ? "single" : (regression.suspects.length ? "ambiguous" : "unattributed"),
      });
    }
    return opened;
  },

  // Open regressions for a task, for the dashboard and for an agent asking what is currently broken.
  openRegressions(taskId) {
    return this.db.prepare(`
      SELECT id, command_key, label, detected_by_assignment_id, suspects, fix_assignment_id, created_at
      FROM check_regressions WHERE task_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20
    `).all(taskId).map((row) => ({
      id: row.id,
      label: row.label,
      command: fromJson(row.command_key, null),
      detectedByAssignmentId: row.detected_by_assignment_id,
      suspects: fromJson(row.suspects, []),
      fixAssignmentId: row.fix_assignment_id,
      createdAt: row.created_at,
    }));
  },

  // The check baseline for a task: what each verified command last did, and when it was last green.
  checkBaseline(taskId) {
    return this.db.prepare(`
      SELECT command_key, status, label, task_version, last_passed_at, updated_at
      FROM check_baselines WHERE task_id = ? ORDER BY label ASC
    `).all(taskId).map((row) => ({
      label: row.label,
      command: fromJson(row.command_key, null),
      status: row.status,
      taskVersion: row.task_version,
      lastPassedAt: row.last_passed_at,
      updatedAt: row.updated_at,
    }));
  },

  _storeReportedChecks(assignmentId, taskId, records, stamp) {
    // A rejected report leaves the claim intact so the agent can fix the work and report again, so
    // an assignment accumulates one batch per attempt. Only the latest attempt describes the work as
    // it now stands: without this, an assignment that failed a check and then passed it would go on
    // showing the failure forever, and "did a check fail here?" would answer yes about work that is
    // green. Earlier attempts are kept, marked superseded, so the history is still on record.
    this.db.prepare("UPDATE assignment_checks SET superseded_at = ? WHERE assignment_id = ? AND superseded_at IS NULL")
      .run(stamp, assignmentId);
    for (const record of records) {
      this.db.prepare(`
        INSERT INTO assignment_checks (
          id, assignment_id, task_id, label, requested_command, command,
          verified, status, exit_code, duration_ms, output, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), assignmentId, taskId, record.label, record.requestedCommand, record.command ? json(record.command) : null,
        record.verified ? 1 : 0, record.status, record.exitCode ?? null, record.durationMs ?? null, record.output ?? null, stamp,
      );
    }
  },

  // Whether this report will actually execute anything. A report whose checks are all plain
  // assertions runs no processes and settles in one turn, so it never enters the verifying window —
  // flagging it would put a "checks running" state on the board for work nobody is checking.
  _reportRunsCommands(task, checks) {
    return this._reportedCheckCommands(task, checks).length > 0;
  },

  // The allowlisted commands this report will actually execute. Both the verifying window and the
  // durable job row are about *these*, so they are derived once rather than being decided twice by
  // two nearly-identical predicates that could drift apart.
  _reportedCheckCommands(task, checks) {
    if (!Array.isArray(checks) || !checks.length) return [];
    const allowlist = task?.project_id ? this.projectCheckCommands(task.project_id) : [];
    if (!allowlist.length) return [];
    const commands = [];
    for (const item of checks.slice(0, 100)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const requested = String(item.command ?? "").trim();
      const label = String(item.label ?? item.command ?? "").trim();
      if (label && requested && matchCheckCommand(allowlist, requested)) commands.push(requested);
    }
    return [...new Set(commands)];
  },
};
