import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import {
  boundCheckOutput,
  matchCheckCommand,
  normalizeCheckCommand,
  packageScriptCommands,
  parseScriptCommand,
  runVerifiedCheck,
} from "../src/devteam/checks.mjs";

// A project whose package.json offers one passing script, one failing script, and several scripts
// DevTeam must refuse to derive a command from.
async function checksFixture(t, { scripts = null, enable = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-project-"));
  await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  await writeFile(path.join(projectRoot, "scripts", "pass.mjs"), "process.stdout.write('142/142 passing');\n", "utf8");
  await writeFile(path.join(projectRoot, "scripts", "fail.mjs"), "process.stderr.write('3 failing');\nprocess.exit(3);\n", "utf8");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "checks-fixture",
    scripts: scripts || {
      test: "node scripts/pass.mjs",
      lint: "node scripts/fail.mjs",
      build: "node build.mjs && node bundle.mjs",  // shell operator: not derivable
      release: "./tools/release.sh",                // path separator: not derivable
    },
  }, null, 2), "utf8");

  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, checks: { timeoutMs: 30_000 } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Checks project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Checks", description: "Exercise verified checks." });
  if (enable) store.setProjectCheckCommands({ projectId: project.id });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture" });
  const plan = store.claimNextAssignment(agent.id);
  store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, project, task, agent, projectRoot };
}

function claimWork(store, agent, task, title = "Do the work") {
  store.createAssignment({ taskId: task.id, title, description: "Work.", role: "implementer" });
  return store.claimNextAssignment(agent.id);
}

test("a check whose command exits non-zero cannot be recorded as passing", async (t) => {
  const { store, task, agent } = await checksFixture(t);
  const claim = claimWork(store, agent, task);

  const refused = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "All green, shipping it.",
    checks: [{ label: "lint: 0 problems", command: "lint" }],
  });

  assert.equal(refused.completed, false, "a report claiming success for a command that failed is rejected");
  assert.equal(refused.checksFailed.failed.length, 1);
  assert.equal(refused.checksFailed.failed[0].exitCode, 3, "the real exit code is recorded, not the claim");
  assert.match(refused.checksFailed.failed[0].output, /3 failing/, "and so is what the command actually printed");

  // Nothing was recorded as done, and the lease is intact so the agent can fix and report again.
  const after = store.db.prepare("SELECT status, agent_id FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(after.status, "claimed", "a caught overclaim does not cost the agent its lease");
  assert.equal(after.agent_id, agent.id);
  const detail = store.taskDetail(task.id);
  const card = detail.assignments.find((item) => item.id === claim.id);
  assert.equal(card.checks[0].status, "failed");
  assert.equal(card.checks[0].verified, true, "DevTeam verified it — the verdict is failure, not absence");
  assert.ok(detail.events.some((event) => event.type === "assignment.check_failed"),
    "the attempt is visible to the human rather than silently swallowed");

  // The honest path stays open: the same failing check may be reported as blocked.
  const blocked = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Lint fails and I cannot fix it here.", status: "blocked",
    checks: [{ label: "lint", command: "lint" }],
  });
  assert.equal(blocked.completed, true);
  assert.equal(blocked.status, "blocked");
});

test("a passing command is verified and recorded with its real evidence", async (t) => {
  const { store, task, agent } = await checksFixture(t);
  const claim = claimWork(store, agent, task);

  const result = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Done.",
    checks: [{ label: "unit tests", command: "test" }, "reviewed the diff by eye"],
  });

  assert.equal(result.completed, true);
  assert.equal(result.verifiedChecks, 1, "one of the two checks was actually run");
  const [ran, asserted] = result.checks;
  assert.equal(ran.status, "passed");
  assert.equal(ran.verified, true);
  assert.equal(ran.exitCode, 0);
  assert.deepEqual(ran.command, ["node", "scripts/pass.mjs"], "the argv that ran came from the allowlist");
  assert.match(ran.output, /142\/142 passing/);
  assert.ok(typeof ran.durationMs === "number" && ran.durationMs >= 0);

  assert.equal(asserted.status, "asserted", "an unverified assertion is still allowed");
  assert.equal(asserted.verified, false);

  const card = store.taskDetail(task.id).assignments.find((item) => item.id === claim.id);
  assert.equal(card.checks[1].agentAsserted, true, "and is labeled as agent-asserted in the task detail payload");
  assert.equal(card.checks[0].agentAsserted, false);
});

test("nothing runs unless a human enabled it, and only what they allowlisted", async (t) => {
  const { store, project, task, agent } = await checksFixture(t, { enable: false });
  assert.deepEqual(store.projectCheckCommands(project.id), [], "verification is off until a human turns it on");

  const first = claimWork(store, agent, task, "Before enabling");
  const untouched = store.completeAssignment({
    agentId: agent.id, assignmentId: first.id, claimToken: first.claimToken, message: "Done.",
    checks: [{ label: "lint", command: "lint" }],
  });
  assert.equal(untouched.completed, true, "a disabled project runs nothing, so nothing can fail");
  assert.equal(untouched.checks[0].status, "unavailable");
  assert.equal(untouched.checks[0].verified, false, "and the unrun check is never recorded as verified");
  assert.match(untouched.checks[0].output, /not enabled/);

  // Enabling snapshots only the scripts DevTeam can run faithfully.
  const enabled = store.setProjectCheckCommands({ projectId: project.id });
  assert.deepEqual(enabled.commands.map((entry) => entry.name).sort(), ["lint", "test"],
    "a script with a shell operator or a path-qualified program is not derivable and is left out");

  const second = claimWork(store, agent, task, "After enabling");
  const unknown = store.completeAssignment({
    agentId: agent.id, assignmentId: second.id, claimToken: second.claimToken, message: "Done.",
    checks: [{ label: "deploy to production", command: "deploy" }],
  });
  assert.equal(unknown.completed, true);
  assert.equal(unknown.checks[0].status, "unavailable", "a command the human never allowlisted is refused");
  assert.equal(unknown.checks[0].verified, false);
  assert.match(unknown.checks[0].output, /No allowlisted command/);

  // Turning it back off is one call, and it stops execution immediately.
  store.setProjectCheckCommands({ projectId: project.id, commands: [] });
  const third = claimWork(store, agent, task, "After disabling");
  const off = store.completeAssignment({
    agentId: agent.id, assignmentId: third.id, claimToken: third.claimToken, message: "Done.",
    checks: [{ label: "lint", command: "lint" }],
  });
  assert.equal(off.completed, true, "a failing script is not even run once verification is off");
  assert.equal(off.checks[0].status, "unavailable");
});

test("agent text selects an allowlist entry and is never executed as written", async (t) => {
  const { store, project, task, agent } = await checksFixture(t);

  // Every one of these is an attempt to get something other than the pinned argv to run. All of
  // them fail to *match* an entry, which is the only way agent text can influence execution at all.
  const injections = [
    "test; rm -rf .",
    "test && node scripts/fail.mjs",
    "test | node scripts/fail.mjs",
    "../../../usr/bin/env",
    "$(node scripts/fail.mjs)",
    "test\nlint",
  ];
  for (const command of injections) {
    assert.equal(matchCheckCommand(store.projectCheckCommands(project.id), command), null,
      `"${command}" must not select any allowlisted entry`);
  }

  const claim = claimWork(store, agent, task);
  const result = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done.",
    checks: injections.map((command) => ({ label: `attempt: ${command}`, command })),
  });
  assert.equal(result.completed, true);
  assert.equal(result.verifiedChecks, 0, "not one injection attempt ran");
  assert.ok(result.checks.every((record) => record.status === "unavailable" && record.command === null));

  // The natural aliases still resolve, so honest reporting is not made awkward by the hardening.
  const allowlist = store.projectCheckCommands(project.id);
  for (const alias of ["test", "npm run test", "npm test", "node scripts/pass.mjs", "TEST"]) {
    assert.equal(matchCheckCommand(allowlist, alias)?.name, "test", `"${alias}" names the allowlisted test script`);
  }
  // Naming an entry by its exact argv is still only naming an entry: it selects the pinned "lint"
  // command, and what runs is that stored argv rather than the text the agent supplied.
  assert.equal(matchCheckCommand(allowlist, "node scripts/fail.mjs")?.name, "lint");
});

test("the allowlist is a pinned snapshot, so rewriting package.json changes nothing", async (t) => {
  const { store, project, task, agent, projectRoot } = await checksFixture(t);
  const pinned = store.projectCheckCommands(project.id).find((entry) => entry.name === "test");
  assert.deepEqual(pinned.argv, ["node", "scripts/pass.mjs"]);

  // An agent has write access to the repo. If the allowlist were read from disk on demand, this
  // would be arbitrary code execution; because it was pinned by a human, it is inert.
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "checks-fixture",
    scripts: { test: "node scripts/fail.mjs" },
  }, null, 2), "utf8");

  assert.deepEqual(store.projectCheckCommands(project.id).find((entry) => entry.name === "test").argv,
    ["node", "scripts/pass.mjs"], "the stored argv is unchanged by the rewrite");

  const claim = claimWork(store, agent, task);
  const result = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done.",
    checks: [{ label: "unit tests", command: "test" }],
  });
  assert.equal(result.completed, true);
  assert.equal(result.checks[0].status, "passed", "the pinned script ran, not the substituted one");
  assert.match(result.checks[0].output, /142\/142 passing/);

  // The human can see the drift and re-snapshot deliberately.
  assert.deepEqual(store.availableCheckCommands(project.id), [{ name: "test", argv: ["node", "scripts/fail.mjs"] }]);
  store.setProjectCheckCommands({ projectId: project.id });
  assert.deepEqual(store.projectCheckCommands(project.id), [{ name: "test", argv: ["node", "scripts/fail.mjs"] }]);
});

test("command parsing refuses everything it cannot run faithfully", () => {
  assert.deepEqual(parseScriptCommand("node --test"), ["node", "--test"]);
  assert.deepEqual(parseScriptCommand("  eslint   src  "), ["eslint", "src"]);
  for (const body of [
    "node a.mjs && node b.mjs", "node a.mjs; node b.mjs", "node a.mjs | tee log", "node a.mjs > out.txt",
    "node $(cat x)", "node `cat x`", "node a.mjs &", "rm -rf ~", "node test/*.mjs", "node 'a b.mjs'",
    "./tools/run.sh", "../escape", "/usr/bin/env node", "C:/tools/run.exe", "", "   ",
  ]) {
    assert.equal(parseScriptCommand(body), null, `refuses: ${JSON.stringify(body)}`);
  }
  assert.equal(parseScriptCommand("node " + "x".repeat(500)), null, "refuses an absurdly long body");

  // The same rules apply to an entry a human types, because there is still no shell behind it.
  assert.deepEqual(normalizeCheckCommand({ name: "unit", argv: ["node", "--test"] }), { name: "unit", argv: ["node", "--test"] });
  assert.equal(normalizeCheckCommand({ name: "unit", argv: ["./x"] }), null);
  assert.equal(normalizeCheckCommand({ name: "", argv: ["node"] }), null);
  assert.equal(normalizeCheckCommand({ name: "unit", argv: [] }), null);
  assert.equal(normalizeCheckCommand({ name: "unit", argv: ["node", ""] }), null);
});

test("a check that cannot start is unavailable, never a pass and never a failure", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-missing-"));
  t.after(async () => { await rm(projectRoot, { recursive: true, force: true }); });
  const missing = runVerifiedCheck({ argv: ["devteam-no-such-program-exists"], cwd: projectRoot, timeoutMs: 5000 });
  assert.equal(missing.verified, false, "nothing was verified, so nothing is recorded as verified");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.exitCode, null);

  // A check that hangs is a failing check, not a pass.
  const hang = runVerifiedCheck({
    argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
    cwd: projectRoot,
    timeoutMs: 1000,
  });
  assert.equal(hang.verified, true);
  assert.equal(hang.status, "failed");
  assert.equal(hang.timedOut, true);
  assert.match(hang.output, /killed after/);
});

test("captured output is bounded and package scripts are read without being trusted", async (t) => {
  const long = "x".repeat(20_000);
  const bounded = boundCheckOutput(long);
  assert.ok(bounded.length < 5000, "an unbounded transcript never reaches the database");
  assert.match(bounded, /characters omitted/);
  assert.equal(boundCheckOutput("short\r\noutput\r\n"), "short\noutput");

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-manifest-"));
  t.after(async () => { await rm(projectRoot, { recursive: true, force: true }); });
  assert.deepEqual(packageScriptCommands(projectRoot), [], "a project with no manifest offers nothing");
  await writeFile(path.join(projectRoot, "package.json"), "{ not json", "utf8");
  assert.deepEqual(packageScriptCommands(projectRoot), [], "an unreadable manifest offers nothing rather than throwing");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: "not-an-object" }), "utf8");
  assert.deepEqual(packageScriptCommands(projectRoot), []);
});
