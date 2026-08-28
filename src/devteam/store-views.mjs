// What the store shows rather than what it changes: the dashboard snapshot, the task detail view,
// the bounded brief an agent is handed when it claims work, the task replay, and the reliability
// record derived from the event log.
//
// Everything here is a read. taskBrief is the largest single method in DevTeam and the one with a
// hard contract — a 32 KiB ceiling measured on the serialized object, with deterministic omissions
// when it does not fit — so it sits beside the other views that answer "what does this look like
// from outside" rather than beside the scheduler that decides what happens next.
//
// A mixin on DevTeamStore.prototype, for the reasons in store-checks.mjs.
import path from "node:path";
import { fromJson, now } from "./util.mjs";
import { buildBudgetedBrief, clipUtf8, DEFAULT_BRIEF_BUDGET } from "./brief.mjs";

export const viewMethods = {
  // T4.3 — replay a task as a narrative.
  //
  // The events were always there and always rich, but reading them meant reading a table. When a task
  // has gone wrong, the question is "where did this turn", and answering it needs the story in order:
  // what was assigned, who took it, what they reported, what DevTeam actually ran, who reviewed it,
  // what went back, what regressed.
  //
  // Read-only and derived entirely from the record — it invents nothing and, in particular, does not
  // re-grade anything. A check that was agent-asserted at the time still reads as asserted here.
  taskReplay(taskId, { limit = 1000 } = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const events = this.db.prepare(`
      SELECT id, type, message, metadata, created_at, author_name, author_kind
      FROM events WHERE task_id = ? ORDER BY id ASC LIMIT ?
    `).all(taskId, Math.max(1, Math.min(5_000, Number(limit) || 1000)));

    const escape = (value) => String(value ?? "").replace(/\r/g, "").trim();
    const lines = [
      `# ${task.title}`,
      "",
      `**Project:** ${task.project_name || task.project_id}  `,
      `**Status:** ${task.status} · version ${task.version} · ${task.required_approvals} approval${task.required_approvals === 1 ? "" : "s"} required  `,
      `**Opened:** ${task.created_at}`,
      "",
      escape(task.description) || "_No description._",
      "",
      "---",
      "",
      "## What happened",
      "",
    ];

    let currentVersion = 1;
    for (const event of events) {
      const metadata = fromJson(event.metadata, {}) || {};
      const who = event.author_name || (event.author_kind === "human" ? "The human" : "DevTeam");
      const when = escape(event.created_at);
      // A version bump is the spine of the story: everything after it is review of different work.
      if (Number(metadata.version) && Number(metadata.version) !== currentVersion) {
        currentVersion = Number(metadata.version);
        lines.push("", `### Version ${currentVersion}`, "");
      }
      const detail = [];
      if (Array.isArray(metadata.changedFiles) && metadata.changedFiles.length) {
        detail.push(`changed \`${metadata.changedFiles.slice(0, 12).join("`, `")}\``);
      }
      if (Array.isArray(metadata.checkRecords) && metadata.checkRecords.length) {
        detail.push(metadata.checkRecords.slice(0, 8).map((record) => {
          const label = escape(record.label);
          if (!record.verified) return `${label} _(asserted, not run)_`;
          return `${label} **${record.status}**${record.exitCode == null ? "" : ` (exit ${record.exitCode})`}`;
        }).join("; "));
      }
      if (Array.isArray(metadata.findings) && metadata.findings.length) {
        detail.push(`findings: ${metadata.findings.slice(0, 8).map((finding) => escape(finding.detail)).join("; ")}`);
      }
      if (metadata.role) detail.push(`role ${escape(metadata.role)}`);
      const suffix = detail.length ? ` — ${detail.join(" · ")}` : "";
      const body = escape(event.message);
      const headline = body.split("\n")[0].slice(0, 300);
      lines.push(`- \`${when}\` **${escape(who)}** · _${escape(event.type)}_ — ${headline}${suffix}`);
      // Keep a report's own prose, indented, when it says more than its first line.
      const rest = body.split("\n").slice(1).filter(Boolean).slice(0, 6);
      for (const extra of rest) lines.push(`  > ${extra.slice(0, 300)}`);
    }

    const regressions = this.openRegressions(taskId);
    lines.push("", "---", "", "## Where it stands", "");
    lines.push(`- **Status:** ${task.status}, version ${task.version}`);
    const approvals = this.db.prepare(`
      SELECT ag.name, ap.version, ap.independent FROM approvals ap JOIN agents ag ON ag.id = ap.agent_id WHERE ap.task_id = ?
    `).all(taskId);
    lines.push(`- **Approvals on the current version:** ${approvals.filter((a) => Number(a.version) === Number(task.version)).length}`
      + (approvals.some((a) => !a.independent) ? " (includes a self-review)" : ""));
    if (regressions.length) {
      lines.push(`- **Broken checks:** ${regressions.map((item) => escape(item.label)).join(", ")}`);
    }
    if (events.length >= Math.min(5_000, Number(limit) || 1000)) {
      lines.push("", `_Truncated at ${events.length} events._`);
    }
    return { taskId, title: task.title, events: events.length, markdown: `${lines.join("\n")}\n` };
  },

  // T2.5 — what the team has learned about each of its members.
  //
  // Nothing tracked whose work got sent back, who reported checks that failed verification, or whose
  // changes caused regressions. A team learns who to trust with what; a queue cannot.
  //
  // Derived on read from the event log and the tables the earlier items already fill, rather than
  // maintained as counters. That is the important design call: a counter can drift from the timeline
  // and then quietly libel an agent, and there is no way to notice. Deriving is slower and always
  // agrees with the record. Scoped by agent *name*, not session id, because a reliability record
  // that resets every time a desktop chat reconnects is worthless.
  agentReliability(agentName, { windowDays = 30 } = {}) {
    const name = String(agentName || "").trim();
    if (!name) return null;
    const since = new Date(Date.now() - Math.max(1, Number(windowDays) || 30) * 86_400_000).toISOString();

    const completed = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'assignment.completed' AND lower(author_name) = lower(?) AND created_at >= ?
    `).get(name, since).count);

    // Reports DevTeam refused because a command it ran did not pass. This is the honest-overclaim
    // signal: the agent said done, and the evidence said otherwise.
    const refusedByChecks = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'assignment.check_failed' AND lower(author_name) = lower(?) AND created_at >= ?
    `).get(name, since).count);

    // Work of this agent's that a reviewer sent back, and how many rounds it took.
    const reworked = this.db.prepare(`
      SELECT a.rework_count AS rounds FROM assignments a
      WHERE a.rework_count > 0 AND a.id IN (
        SELECT json_extract(e.metadata, '$.assignmentId') FROM events e
        WHERE e.type = 'assignment.completed' AND lower(e.author_name) = lower(?) AND e.created_at >= ?
      )
    `).all(name, since).map((row) => Number(row.rounds) || 0);
    const reworkRounds = reworked.reduce((total, rounds) => total + rounds, 0);

    // Regressions this agent's work is the sole suspect for. Ambiguous ones are deliberately not
    // counted against anyone: attributing a shared window to one name would be a guess, and a guess
    // that follows someone around as a reliability number is worse than no number.
    const regressionsCaused = this.db.prepare(`
      SELECT suspects FROM check_regressions WHERE created_at >= ?
    `).all(since).filter((row) => {
      const suspects = fromJson(row.suspects, []);
      return suspects.length === 1 && String(suspects[0]?.author || "").toLowerCase() === name.toLowerCase();
    }).length;

    // Regressions this agent found by running the checks. The counterpart signal, and the reason
    // this is not a blame ledger: noticing breakage is a contribution, and a record that only ever
    // counts faults teaches agents not to run checks.
    const regressionsCaught = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM check_regressions r
      JOIN events e ON e.type = 'assignment.check_failed'
        AND json_extract(e.metadata, '$.assignmentId') = r.detected_by_assignment_id
      WHERE r.created_at >= ? AND lower(e.author_name) = lower(?)
    `).get(since, name).count);

    const approvals = this.db.prepare(`
      SELECT independent FROM approvals ap
      JOIN agents ag ON ag.id = ap.agent_id
      WHERE lower(ag.name) = lower(?) AND ap.created_at >= ?
    `).all(name, since);

    const attempts = completed + refusedByChecks;
    return {
      agentName: name,
      windowDays: Math.max(1, Number(windowDays) || 30),
      completed,
      refusedByChecks,
      reworkedAssignments: reworked.length,
      reworkRounds,
      averageReworkRounds: completed ? Number((reworkRounds / completed).toFixed(2)) : 0,
      regressionsCaused,
      regressionsCaught,
      approvals: approvals.length,
      independentApprovals: approvals.filter((approval) => approval.independent).length,
      // A single number for ordering and for the gate. Deliberately conservative: an agent with very
      // little history sits near the top rather than being punished for being new, because a
      // reliability score that suppresses newcomers starves the very work that would give it data.
      cleanReportRate: attempts ? Number((completed / attempts).toFixed(2)) : 1,
      sample: attempts,
    };
  },

  // Every agent the room has an opinion about, for the dashboard.
  teamReliability({ windowDays = 30 } = {}) {
    const names = this.db.prepare(`
      SELECT DISTINCT author_name AS name FROM events
      WHERE author_kind = 'agent' AND author_name IS NOT NULL
      ORDER BY author_name ASC LIMIT 50
    `).all().map((row) => row.name);
    return names.map((name) => this.agentReliability(name, { windowDays })).filter(Boolean);
  },

  // The one-line version of whyNotClaimable, for a card with room for a single sentence. It
  // delegates rather than re-deriving the cases, so the hold shown on the dashboard and the chain
  // an agent reads over MCP can never disagree. Dependencies are left out here only because the
  // same card already lists them as blockedBy.
  _schedulingHold(assignment) {
    if (assignment.status !== "queued") return null;
    const HOLD_PRECEDENCE = ["awaiting_writer", "write_lease_conflict", "verifier_is_author", "target_absent"];
    const { reasons } = this.whyNotClaimable(assignment.id);
    for (const code of HOLD_PRECEDENCE) {
      const hold = reasons.find((reason) => reason.code === code);
      if (hold) return { reason: hold.code, detail: hold.detail };
    }
    return null;
  },

  taskDetail(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const assignments = this.db.prepare(`
      SELECT a.*, ag.name AS agent_name, ag.provider AS agent_provider
      FROM assignments a LEFT JOIN agents ag ON ag.id = a.agent_id
      WHERE a.task_id = ? ORDER BY a.created_at ASC
    `).all(taskId).map((assignment) => {
      const dependencies = this._dependenciesFor(assignment.id);
      const assessment = this._assessmentRecord(this.db.prepare(`
        SELECT * FROM complexity_assessments WHERE assignment_id = ? AND invalidated_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(assignment.id));
      return {
        ...assignment,
        checklist: this._checklistFor(assignment.id),
        writeScope: assignment.requires_write ? this._writeScopeFor(assignment.id) : [],
        dependsOn: dependencies.map((item) => item.id),
        blockedBy: dependencies.filter((item) => item.status !== "done"),
        checks: this._checksFor(assignment.id),
        findings: this._findingsFor(assignment.id),
        resolvedFindings: this._findingsFor(assignment.id, { includeResolved: true }).filter((finding) => finding.resolved_at),
        schedulingHold: this._schedulingHold(assignment),
        assessment,
        // The score in the words the human uses for their own models. "Base · Score 0" is DevTeam's
        // vocabulary, not anyone else's; "Needs Sonnet 5 · medium" is the same fact said usefully.
        needsRung: assessment ? this._rungLabelFor(task.project_id, assessment.level) : null,
      };
    });
    // The roles this project understands travel with the task, so the dashboard's assignment form
    // offers the project's own vocabulary rather than a hardcoded list of software job titles.
    const roleCatalogue = this.roleCatalogue(task.project_id);
    const members = this.db.prepare(`
      SELECT m.role, ag.id AS agent_id, ag.name AS agent_name, ag.provider AS agent_provider, ag.status
      FROM task_members m JOIN agents ag ON ag.id = m.agent_id
      WHERE m.task_id = ? ORDER BY m.joined_at ASC
    `).all(taskId);
    const approvals = this.db.prepare(`
      SELECT ap.*, ag.name AS agent_name, ag.provider AS agent_provider
      FROM approvals ap JOIN agents ag ON ag.id = ap.agent_id
      WHERE ap.task_id = ? AND ap.version = ? ORDER BY ap.created_at ASC
    `).all(taskId, task.version);
    const events = this.db.prepare(`
      SELECT recent.*, ag.name AS agent_name, ag.provider AS agent_provider
      FROM (
        SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 500
      ) recent
      LEFT JOIN agents ag ON ag.id = recent.agent_id
      ORDER BY recent.id ASC
    `).all(taskId).map((event) => ({ ...event, metadata: fromJson(event.metadata, {}) }));
    const receipts = this.db.prepare(`
      SELECT r.event_id, r.delivered_at, r.seen_at, ag.name AS agent_name, ag.provider AS agent_provider
      FROM message_receipts r
      JOIN agents ag ON ag.id = r.agent_id
      WHERE r.event_id IN (SELECT id FROM events WHERE task_id = ? AND type = 'human.message')
      ORDER BY r.delivered_at ASC
    `).all(taskId);
    const receiptsByEvent = new Map();
    for (const receipt of receipts) {
      if (!receiptsByEvent.has(receipt.event_id)) receiptsByEvent.set(receipt.event_id, []);
      receiptsByEvent.get(receipt.event_id).push(receipt);
    }
    for (const event of events) {
      if (event.type === "human.message") event.receipts = receiptsByEvent.get(event.id) || [];
    }
    const proposals = this.proposalsForTask(taskId);
    const blackboard = this.db.prepare("SELECT key, value, version, updated_by_name, updated_at FROM blackboard WHERE task_id = ? ORDER BY key ASC")
      .all(taskId).map((row) => ({ scope: "task", key: row.key, value: row.value, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at }));
    const projectBlackboard = this.db.prepare("SELECT key, value, version, updated_by_name, updated_at FROM project_blackboard WHERE project_id = ? ORDER BY key ASC")
      .all(task.project_id).map((row) => ({ scope: "project", key: row.key, value: row.value, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at }));
    const knowledge = this.knowledge.list(task.project_id, { limit: 30 });
    const knowledgeLifecycle = Object.fromEntries(["verified", "inferred", "disputed", "stale", "archived"].map((status) => [status, 0]));
    for (const row of this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM knowledge_notes WHERE project_id = ? GROUP BY status
    `).all(task.project_id)) knowledgeLifecycle[row.status] = Number(row.count);
    const codeGraphState = this.codegraph.projectState(task.project_id);
    return {
      ...task, assignments, approvals, events, proposals, blackboard, projectBlackboard, knowledge, members, roleCatalogue,
      blockedRecovery: this.blockedRecovery(taskId),
      regressions: this.openRegressions(taskId), checkBaseline: this.checkBaseline(taskId),
      reliability: this.teamReliability(),
      // What this server has been running for the task, including anything a restart cut short.
      jobs: this.jobs(taskId, { limit: 10 }),
      knowledgeVault: {
        automated: this.knowledge.enabled,
        path: path.join(task.project_root, "knowledge"),
        noteCount: knowledge.length,
        error: this.knowledgeErrors.get(taskId) || this.knowledgeErrors.get(`project:${task.project_id}`) || null,
      },
      codeGraph: {
        automated: this.codegraph.enabled,
        path: path.join(task.project_root, "knowledge", "graph"),
        moduleCount: codeGraphState?.moduleCount || 0,
        edgeCount: codeGraphState?.edgeCount || 0,
        truncated: Boolean(codeGraphState?.truncated),
        indexedAt: codeGraphState?.indexedAt || null,
        error: this.codegraphErrors.get(`project:${task.project_id}`) || null,
      },
      memoryHealth: {
        brief: this.briefHealth.get(taskId) || {
          version: 1,
          bytes: null,
          limitBytes: DEFAULT_BRIEF_BUDGET.totalBytes,
          truncated: null,
          included: {},
          omitted: {},
          clipped: {},
          generatedAt: null,
        },
        taskMemoryCount: blackboard.length,
        projectMemoryCount: projectBlackboard.length,
        knowledge: knowledgeLifecycle,
        knowledgeError: this.knowledgeErrors.get(taskId) || this.knowledgeErrors.get(`project:${task.project_id}`) || null,
        graphIndexedAt: codeGraphState?.indexedAt || null,
        graphTruncated: Boolean(codeGraphState?.truncated),
        graphError: this.codegraphErrors.get(`project:${task.project_id}`) || null,
      },
    };
  },

  taskBrief(agentId, taskId, {
    currentAssignment: assignmentOverride = null,
    assignmentKey = "currentAssignment",
    responseCore = {},
    pendingMessages = [],
    pendingProposals = [],
  } = {}) {
    this.getAgent(agentId);
    this.assertMembership(agentId, taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const errorKey = task ? `project:${task.project_id}` : null;
    try {
      this.codegraph.reconcileTask(taskId);
      if (errorKey) this.codegraphErrors.delete(errorKey);
    } catch (error) {
      if (errorKey) this.codegraphErrors.set(errorKey, { message: error.message, at: now() });
      this.emit("codegraph-error", { taskId, type: "codegraph.brief", error });
    }
    const clipped = {};
    const clip = (value, maxBytes, key) => {
      const result = clipUtf8(value, maxBytes);
      if (result.truncated) clipped[key] = (clipped[key] || 0) + 1;
      return result.value;
    };
    const boundedPendingMessages = (Array.isArray(pendingMessages) ? pendingMessages : []).slice(0, 50).map((message) => ({
      id: message.id,
      taskId: message.taskId,
      message: clip(message.message, 1_200, "pendingMessageBodies"),
      from: clip(message.from, 200, "pendingMessageAuthors"),
      target: clip(message.target, 200, "pendingMessageTargets"),
      broadcast: Boolean(message.broadcast),
      at: message.at,
    }));
    const boundedPendingProposals = (Array.isArray(pendingProposals) ? pendingProposals : []).slice(0, 20).map((proposal) => ({
      id: proposal.id,
      taskId: proposal.taskId,
      kind: proposal.kind,
      summary: clip(proposal.summary, 800, "pendingProposalSummaries"),
      proposer: proposal.proposer ? clip(proposal.proposer, 200, "pendingProposalAuthors") : null,
      details: proposal.details,
    }));
    const assignmentRows = this.db.prepare(`
      SELECT a.id, a.task_id, substr(a.title, 1, 1200) AS title,
             substr(a.description, 1, 2400) AS description, a.role, a.requires_write,
             a.target_agent_name, a.agent_id, a.status, a.created_at, a.claimed_at,
             a.claim_generation, ag.name AS agent_name
      FROM assignments a LEFT JOIN agents ag ON ag.id = a.agent_id
      WHERE a.task_id = ? AND a.status IN ('queued', 'claimed')
      ORDER BY a.created_at ASC LIMIT 80
    `).all(taskId);
    const assignmentTotal = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')
    `).get(taskId).count);
    const dependencySummary = (assignmentId, maxItems = 12) => {
      const dependencies = this._dependenciesFor(assignmentId);
      return {
        dependsOn: dependencies.slice(0, maxItems).map((item) => item.id),
        blockedBy: dependencies.filter((item) => item.status !== "done").slice(0, maxItems).map((item) => ({
          id: item.id,
          title: clip(item.title, 240, "assignmentDependencyTitles"),
          status: item.status,
          role: item.role,
        })),
        omitted: Math.max(0, dependencies.length - maxItems),
      };
    };
    const openAssignments = assignmentRows.map((assignment) => {
      const dependencies = dependencySummary(assignment.id, 8);
      return {
        id: assignment.id,
        title: clip(assignment.title, 360, "assignmentTitles"),
        description: clip(assignment.description, 900, "assignmentDescriptions"),
        role: clip(assignment.role, 100, "assignmentRoles"),
        status: assignment.status,
        agent: assignment.agent_name ? clip(assignment.agent_name, 200, "assignmentAgentNames") : null,
        dependsOn: dependencies.dependsOn,
        blockedBy: dependencies.blockedBy,
      };
    });
    let currentSource = assignmentOverride;
    if (!currentSource) {
      currentSource = this.db.prepare(`
        SELECT a.*, ag.name AS agent_name FROM assignments a
        LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE a.task_id = ? AND a.agent_id = ? AND a.status = 'claimed' LIMIT 1
      `).get(taskId, agentId) || null;
    }
    const mandatoryOmitted = {};
    let currentAssignment = null;
    if (currentSource) {
      const dependencies = dependencySummary(currentSource.id, 20);
      const checklist = (Array.isArray(currentSource.checklist) ? currentSource.checklist : this._checklistFor(currentSource.id));
      const writeScope = currentSource.requires_write
        ? (Array.isArray(currentSource.writeScope) ? currentSource.writeScope : this._writeScopeFor(currentSource.id))
        : [];
      mandatoryOmitted.currentAssignmentChecklist = Math.max(0, checklist.length - 12);
      mandatoryOmitted.currentAssignmentWriteScope = Math.max(0, writeScope.length - 12);
      mandatoryOmitted.currentAssignmentDependencies = dependencies.omitted;
      currentAssignment = {
        id: currentSource.id,
        task_id: currentSource.task_id,
        taskId: currentSource.task_id,
        title: clip(currentSource.title, 500, "currentAssignmentTitle"),
        description: clip(currentSource.description, 1_600, "currentAssignmentDescription"),
        role: clip(currentSource.role, 100, "currentAssignmentRole"),
        status: currentSource.status,
        requires_write: Number(Boolean(currentSource.requires_write)),
        requiresWrite: Boolean(currentSource.requires_write),
        target_agent_name: currentSource.target_agent_name || null,
        agent_id: currentSource.agent_id || null,
        agent: currentSource.agent_name ? clip(currentSource.agent_name, 200, "currentAssignmentAgent") : null,
        claimed_at: currentSource.claimed_at || null,
        checklist: checklist.slice(0, 12).map((item) => clip(item, 180, "currentAssignmentChecklistItems")),
        writeScope: writeScope.slice(0, 12).map((item) => clip(item, 300, "currentAssignmentWriteScopeItems")),
        dependsOn: dependencies.dependsOn,
        blockedBy: dependencies.blockedBy,
        task_title: clip(currentSource.task_title || task.title, 600, "currentAssignmentTaskTitle"),
        task_description: clip(currentSource.task_description || task.description, 2_003, "currentAssignmentTaskDescription"),
        task_version: Number(currentSource.task_version ?? task.version),
        required_approvals: Number(currentSource.required_approvals ?? task.required_approvals),
        project_root: clip(currentSource.project_root || task.project_root, 2_000, "currentAssignmentProjectRoot"),
        project_name: clip(currentSource.project_name || task.project_name, 400, "currentAssignmentProjectName"),
        claimGeneration: Number(currentSource.claimGeneration ?? currentSource.claim_generation ?? 0),
        assessment: this._assessmentForBrief(this.db.prepare(`
          SELECT * FROM complexity_assessments WHERE assignment_id = ? AND invalidated_at IS NULL
          ORDER BY created_at DESC LIMIT 1
        `).get(currentSource.id)),
        ...(currentSource.claimToken ? { claimToken: currentSource.claimToken } : {}),
      };
    }
    const taskMemoryTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM blackboard WHERE task_id = ?").get(taskId).count);
    const taskMemory = this.db.prepare(`
      SELECT key, substr(value, 1, 4096) AS value, version, updated_by_name, updated_at
      FROM blackboard WHERE task_id = ? ORDER BY key ASC LIMIT 80
    `).all(taskId).map((note) => ({
      scope: "task",
      key: clip(note.key, 300, "taskMemoryKeys"),
      value: clip(note.value, 2_003, "taskMemoryValues"),
      version: note.version,
      updatedBy: note.updated_by_name ? clip(note.updated_by_name, 200, "taskMemoryAuthors") : null,
      updatedAt: note.updated_at,
    }));
    const projectMemoryTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM project_blackboard WHERE project_id = ?").get(task.project_id).count);
    const projectMemory = this.db.prepare(`
      SELECT key, substr(value, 1, 4096) AS value, version, updated_by_name, updated_at
      FROM project_blackboard WHERE project_id = ? ORDER BY key ASC LIMIT 80
    `).all(task.project_id).map((note) => ({
      scope: "project",
      key: clip(note.key, 300, "projectMemoryKeys"),
      value: clip(note.value, 2_003, "projectMemoryValues"),
      version: note.version,
      updatedBy: note.updated_by_name ? clip(note.updated_by_name, 200, "projectMemoryAuthors") : null,
      updatedAt: note.updated_at,
    }));
    const knowledgeTotal = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_notes
      WHERE project_id = ? AND status IN ('verified', 'inferred')
    `).get(task.project_id)?.count || 0);
    const openProposalTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE task_id = ? AND status = 'open'").get(taskId).count);
    const pendingProposalIds = new Set(boundedPendingProposals.filter((proposal) => proposal.taskId === taskId).map((proposal) => proposal.id));
    const openProposals = this.db.prepare(`
      SELECT id, kind, substr(summary, 1, 1600) AS summary FROM proposals
      WHERE task_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 30
    `).all(taskId).filter((proposal) => !pendingProposalIds.has(proposal.id)).map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      summary: clip(proposal.summary, 800, "proposalSummaries"),
      votes: this.db.prepare(`
        SELECT voter_name, vote, substr(comment, 1, 600) AS comment, created_at
        FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at ASC LIMIT 20
      `).all(proposal.id).map((vote) => ({ ...vote, comment: vote.comment ? clip(vote.comment, 300, "proposalVoteComments") : null })),
    }));
    const recentTypes = ["human.message", "agent.decision", "agent.finding", "task.blocked", "task.unblocked", "task.accepted"];
    const typePlaceholders = recentTypes.map(() => "?").join(", ");
    const recentTotal = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type IN (${typePlaceholders})`).get(taskId, ...recentTypes).count);
    const recent = this.db.prepare(`
      SELECT recent.*, ag.name AS agent_name FROM (
        SELECT id, agent_id, type, substr(message, 1, 1600) AS message, created_at
        FROM events WHERE task_id = ? AND type IN (${typePlaceholders})
        ORDER BY id DESC LIMIT 12
      ) recent LEFT JOIN agents ag ON ag.id = recent.agent_id ORDER BY recent.id ASC
    `).all(taskId, ...recentTypes).map((event) => ({
      id: event.id,
      type: event.type,
      from: event.agent_name ? clip(event.agent_name, 200, "activityAuthors") : "human",
      message: clip(event.message, 800, "activityMessages"),
      at: event.created_at,
    }));
    const unresolvedWhere = `
      q.task_id = ? AND q.type = 'agent.question' AND NOT EXISTS (
        SELECT 1 FROM events reply
        WHERE reply.task_id = q.task_id AND CAST(json_extract(reply.metadata, '$.replyTo') AS INTEGER) = q.id
      )
    `;
    const unresolvedTotal = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events q WHERE ${unresolvedWhere}`).get(taskId).count);
    const unresolvedQuestions = this.db.prepare(`
      SELECT recent.*, ag.name AS agent_name FROM (
        SELECT q.id, q.agent_id, substr(q.message, 1, 1600) AS message, q.created_at
        FROM events q WHERE ${unresolvedWhere} ORDER BY q.id DESC LIMIT 10
      ) recent LEFT JOIN agents ag ON ag.id = recent.agent_id ORDER BY recent.id ASC
    `).all(taskId).map((event) => ({
      id: event.id,
      from: event.agent_name ? clip(event.agent_name, 200, "questionAuthors") : "agent",
      message: clip(event.message, 800, "questionMessages"),
      at: event.created_at,
    }));
    let codeContext = this.codegraph.enabled ? [] : null;
    try { codeContext = this.codegraph.codeContext(taskId, { assignmentId: currentAssignment?.id || null, maxBytes: DEFAULT_BRIEF_BUDGET.codeContextBytes }); }
    catch (error) {
      if (errorKey) this.codegraphErrors.set(errorKey, { message: error.message, at: now() });
      this.emit("codegraph-error", { taskId, type: "codegraph.context", error });
    }
    const recentChangedFiles = this.db.prepare(`
      SELECT metadata FROM events WHERE task_id = ?
        AND type IN ('assignment.completed', 'assignment.blocked') ORDER BY id DESC LIMIT 30
    `).all(taskId).flatMap((event) => {
      const metadata = fromJson(event.metadata, {});
      return Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
    });
    const codePaths = (codeContext || []).flatMap((module) => [module.path, ...(module.imports || []), ...(module.importedBy || [])]);
    const projectKnowledge = this.knowledge.relevant(task.project_id, taskId, 30, {
      taskTitle: task.title,
      taskDescription: task.description,
      taskVersion: task.version,
      taskUpdatedAt: task.updated_at,
      assignmentTitle: currentAssignment?.title,
      assignmentDescription: currentAssignment?.description,
      role: currentAssignment?.role,
      checklist: currentAssignment?.checklist || [],
      declaredPaths: [...(currentAssignment?.writeScope || []), ...recentChangedFiles],
      codePaths,
      memoryKeys: [...taskMemory.map((note) => note.key), ...projectMemory.map((note) => note.key)],
      unresolvedQuestions: unresolvedQuestions.map((question) => question.message),
      blockers: (currentAssignment?.blockedBy || []).map((blocker) => blocker.title),
    }).map((note) => ({
      ...note,
      title: clip(note.title, 360, "knowledgeTitles"),
      // Only the few notes that carry a body pay for one. The rest arrive as a headline and a
      // wikilink, which devteam_memory reads in full when the agent decides it matters.
      ...(note.body === undefined ? {} : { body: clip(note.body, 1_400, "knowledgeBodies") }),
      relatedFiles: (note.relatedFiles || []).slice(0, 8).map((file) => clip(file, 400, "knowledgePaths")),
    }));
    const brief = buildBudgetedBrief({
      core: {
        ...responseCore,
        task: {
          id: task.id,
          title: clip(task.title, 600, "taskTitle"),
          description: clip(task.description, 2_003, "taskDescription"),
          status: task.status,
          version: task.version,
          project: {
            id: task.project_id,
            name: clip(task.project_name, 400, "projectName"),
            root: clip(task.project_root, 2_000, "projectRoot"),
          },
        },
        [assignmentKey]: currentAssignment,
        claimInstructions: "Retain the claim token privately, inspect the current project state before writing, stay inside the declared write scope, and pass the token to devteam_report so stale work is fenced.",
      },
      clipped,
      omitted: mandatoryOmitted,
      sections: [
        { key: "openAssignments", group: "assignments", items: openAssignments, totalCount: assignmentTotal, maxItems: 30, maxBytes: DEFAULT_BRIEF_BUDGET.assignmentBytes },
        { key: "taskMemory", group: "taskMemory", items: taskMemory, totalCount: taskMemoryTotal, maxItems: 20, maxBytes: DEFAULT_BRIEF_BUDGET.taskMemoryBytes },
        { key: "projectMemory", group: "projectMemory", items: projectMemory, totalCount: projectMemoryTotal, maxItems: 16, maxBytes: DEFAULT_BRIEF_BUDGET.projectMemoryBytes },
        { key: "projectKnowledge", group: "knowledge", items: projectKnowledge, totalCount: knowledgeTotal, maxItems: 12, maxBytes: DEFAULT_BRIEF_BUDGET.knowledgeBytes },
        { key: "codeContext", group: "codeContext", items: codeContext || [], emptyValue: this.codegraph.enabled ? [] : null, totalCount: codeContext?.length || 0, maxItems: 30, maxBytes: DEFAULT_BRIEF_BUDGET.codeContextBytes },
        { key: "pendingMessages", group: "activity", items: boundedPendingMessages, totalCount: Array.isArray(pendingMessages) ? pendingMessages.length : 0, maxItems: 20, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "pendingProposals", group: "activity", items: boundedPendingProposals, totalCount: Array.isArray(pendingProposals) ? pendingProposals.length : 0, maxItems: 10, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "openProposals", group: "activity", items: openProposals, totalCount: Math.max(0, openProposalTotal - pendingProposalIds.size), maxItems: 10, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "recent", group: "activity", items: recent, totalCount: recentTotal, maxItems: 12, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "unresolvedQuestions", group: "activity", items: unresolvedQuestions, totalCount: unresolvedTotal, maxItems: 10, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
      ],
    });
    const health = {
      ...brief.briefMeta,
      generatedAt: now(),
      assignmentId: currentAssignment?.id || null,
      delivery: assignmentKey === "assignment" ? "automatic" : "requested",
    };
    const previous = this.briefHealth.get(taskId);
    this.briefHealth.set(taskId, health);
    if (!previous || previous.bytes !== health.bytes || previous.truncated !== health.truncated
      || JSON.stringify(previous.omitted) !== JSON.stringify(health.omitted)) {
      this.emit("change", { type: "brief.health", taskId, at: health.generatedAt });
    }
    return brief;
  },

  snapshot(taskId = undefined) {
    const tasks = this.listTasks();
    const selectedId = taskId === undefined ? tasks[0]?.id || null : taskId;
    return {
      serverTime: now(),
      projects: this.listProjects(),
      agents: this.listAgents(),
      tasks,
      selectedTask: selectedId ? this.taskDetail(selectedId) : null,
    };
  },

  // The dashboard snapshot as one agent may see it: the pre-selected task detail is limited to a
  // room the agent belongs to, so a no-taskId devteam_next with want=state never hands a non-member another
  // room's full timeline. The project/agent/task lists stay visible (they carry no room secrets).
  snapshotForAgent(agentId) {
    const tasks = this.listTasks();
    const rooms = this._memberTaskIds(agentId);
    const selectedId = tasks.find((task) => rooms.includes(task.id))?.id || null;
    return {
      serverTime: now(),
      projects: this.listProjects(),
      agents: this.listAgents(),
      tasks,
      selectedTask: selectedId ? this.taskDetail(selectedId) : null,
    };
  },
};
