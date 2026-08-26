import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import {
  boundCheckOutput,
  isSafeCheckArgv,
  matchCheckCommand,
  normalizeCheckCommand,
  packageScriptCommands,
  resolveLocalBinary,
  parseScriptCommand,
  runVerifiedCheck,
  sandboxFlagsFor,
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
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, project, task, agent, projectRoot };
}

function claimWork(store, agent, task, title = "Do the work") {
  store.createAssignment({ taskId: task.id, title, description: "Work.", role: "implementer" });
  return store.claimNextAssignment(agent.id);
}

test("a check whose command exits non-zero cannot be recorded as passing", async (t) => {
  const { store, task, agent } = await checksFixture(t);
  const claim = claimWork(store, agent, task);

  const refused = await store.completeAssignment({
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
  const blocked = await store.completeAssignment({
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

  const result = await store.completeAssignment({
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
  const untouched = await store.completeAssignment({
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
  const unknown = await store.completeAssignment({
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
  const off = await store.completeAssignment({
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
  const result = await store.completeAssignment({
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
  const result = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done.",
    checks: [{ label: "unit tests", command: "test" }],
  });
  assert.equal(result.completed, true);
  assert.equal(result.checks[0].status, "passed", "the pinned script ran, not the substituted one");
  assert.match(result.checks[0].output, /142\/142 passing/);

  // The human can see the drift and re-snapshot deliberately.
  // Reading what is *available* does reflect the rewrite — that is the point of showing a human
  // what enabling would allow — and now says where each entry came from.
  assert.deepEqual(store.availableCheckCommands(project.id),
    [{ name: "test", argv: ["node", "scripts/fail.mjs"], source: "package.json" }]);
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
  const missing = await runVerifiedCheck({ argv: ["devteam-no-such-program-exists"], cwd: projectRoot, timeoutMs: 5000 });
  assert.equal(missing.verified, false, "nothing was verified, so nothing is recorded as verified");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.exitCode, null);

  // A check that hangs is a failing check, not a pass.
  const hang = await runVerifiedCheck({
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

// --- hardening added after an independent security review ----------------------------------------

test("an allowlist entry may not itself be a way to run something else", () => {
  // Every one of these was accepted before the review. Each hands back the shell, the network, or a
  // live re-read of package.json — undoing shell:false or the pinned snapshot. The credential that
  // reaches the allowlist endpoint is not strong enough to treat "a human sent it" as review.
  for (const argv of [
    ["node", "-e", "require('fs').writeFileSync('PWNED','x')"],
    ["node", "--eval=1"],
    ["node", "-p", "1"],
    ["node", "--require", "./hook.mjs"],
    ["node", "--import", "./tools/hook.mjs", "--test"],
    ["node", "--experimental-loader", "./l.mjs"],
    ["cmd", "/c", "whoami"],
    ["cmd.exe", "/c", "whoami"],
    ["powershell", "-c", "ls"],
    ["sh", "-c", "ls"],
    ["bash", "-lc", "ls"],
    ["env", "node", "x.mjs"],
    ["xargs", "node"],
    ["npx", "tsc"],
    ["npm", "run", "test"],       // resolves the script body at run time, defeating the snapshot
    ["yarn", "test"],
    ["bun", "test"],
    ["node", "../../../evil.mjs"],
    ["node", "a/../../b.mjs"],
  ]) {
    assert.equal(normalizeCheckCommand({ name: "x", argv }), null, `must refuse: ${JSON.stringify(argv)}`);
    assert.equal(isSafeCheckArgv(argv), false, `must refuse: ${JSON.stringify(argv)}`);
  }
  // The same rules apply to a package.json script body, so a snapshot cannot smuggle one in.
  for (const body of ["cmd /c whoami", "npm run build", "node --import ./h.mjs --test", "node ../../../evil.mjs"]) {
    assert.equal(parseScriptCommand(body), null, `must refuse: ${body}`);
  }
  // Ordinary checks still work.
  assert.deepEqual(normalizeCheckCommand({ name: "unit", argv: ["node", "--test"] }), { name: "unit", argv: ["node", "--test"] });
  assert.deepEqual(parseScriptCommand("node --test"), ["node", "--test"]);
  assert.deepEqual(parseScriptCommand("eslint src --max-warnings=0"), ["eslint", "src", "--max-warnings=0"]);
});

test("a failing command cannot launder itself into 'not run' by drowning the output buffer", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-flood-"));
  t.after(async () => { await rm(projectRoot, { recursive: true, force: true }); });
  // Exits non-zero AND prints past the 2MB capture limit. Graded "unavailable" before the review,
  // which let the report complete; an exit status we could not read is not a pass.
  const flooded = await runVerifiedCheck({
    argv: ["node", "--eval", "process.stdout.write('x'.repeat(4*1024*1024)); process.exit(7);"],
    cwd: projectRoot, timeoutMs: 30_000,
  });
  assert.equal(flooded.status, "failed", "an unreadable result is a failure, never a pass");
  assert.equal(flooded.verified, true);
  assert.match(flooded.output, /cannot count as a pass/);
});

test("the verification timeout bounds the whole report, not each command in it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-budget-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-budget-project-"));
  await writeFile(path.join(projectRoot, "hang.mjs"), "setTimeout(() => {}, 60000);\n", "utf8");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "budget-fixture", scripts: { slow: "node hang.mjs" },
  }), "utf8");
  // spawnSync blocks the event loop, so ten allowlisted hangs must not be able to hold the whole
  // server for ten timeouts' worth of wall clock on a single tool call.
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, checks: { timeoutMs: 2000 } });
  t.after(async () => {
    try { store.close(); } catch { /* already closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Budget project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Budget", description: "Exercise the report budget." });
  store.setProjectCheckCommands({ projectId: project.id });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const claim = claimWork(store, agent, task);

  const startedAt = Date.now();
  const result = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done.", status: "blocked",
    checks: Array.from({ length: 10 }, (unused, index) => ({ label: `slow ${index}`, command: "slow" })),
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 8000, `ten hanging checks must share one budget, took ${elapsed}ms`);
  const ran = result.checks.filter((record) => record.verified);
  assert.equal(ran.length, 1, "the first check spends the budget; the rest are not run");
  assert.ok(result.checks.slice(1).every((record) => record.status === "unavailable"));
  assert.match(result.checks[9].output, /budget/);
});

test("only the latest report attempt describes the work as it now stands", async (t) => {
  // A rejected report leaves the claim intact so the agent can fix and report again. Before this,
  // every attempt appended, so an assignment that failed a check and then passed it went on showing
  // the verified failure forever and grew assignment_checks without bound on a retry loop.
  const { store, task, agent } = await checksFixture(t);
  const claim = claimWork(store, agent, task);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refused = await store.completeAssignment({
      agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
      message: "Green, honest.", checks: [{ label: "unit tests", command: "lint" }],
    });
    assert.equal(refused.completed, false);
  }
  const midway = store.taskDetail(task.id).assignments.find((item) => item.id === claim.id);
  assert.equal(midway.checks.length, 1, "two failed attempts show as one current verdict, not two");
  assert.equal(midway.checks[0].status, "failed");

  // The agent fixes the work and reports a check that really passes.
  const fixed = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Fixed.", checks: [{ label: "unit tests", command: "test" }],
  });
  assert.equal(fixed.completed, true);

  const card = store.taskDetail(task.id).assignments.find((item) => item.id === claim.id);
  assert.equal(card.checks.length, 1, "the completed assignment shows only its final verdict");
  assert.equal(card.checks[0].status, "passed");
  assert.ok(!card.checks.some((record) => record.status === "failed"),
    "a fixed assignment does not permanently display the failure it recovered from");

  // The earlier attempts are still on record, marked superseded rather than deleted.
  const history = store.db.prepare("SELECT status, superseded_at FROM assignment_checks WHERE assignment_id = ?").all(claim.id);
  assert.equal(history.length, 3, "every attempt is kept");
  assert.equal(history.filter((row) => row.superseded_at).length, 2);
});

test("a sandboxed project confines its checks to the project folder", async (t) => {
  const { store, project, task, agent, projectRoot } = await checksFixture(t);
  // Honest work still passes: the temp directory stays writable, because real suites use it.
  await writeFile(path.join(projectRoot, "scripts", "pass.mjs"),
    "import {writeFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';\n"
    + "writeFileSync(path.join(os.tmpdir(),'devteam-sandbox-probe.txt'),'ok');process.stdout.write('142/142 passing');\n", "utf8");
  // A test file the agent wrote tries to read the operator's home directory.
  await writeFile(path.join(projectRoot, "scripts", "fail.mjs"),
    "import {readFileSync} from 'node:fs';import os from 'node:os';import path from 'node:path';\n"
    + "readFileSync(path.join(os.homedir(),'.gitconfig'),'utf8');\n", "utf8");

  assert.equal(store.projectCheckSandbox(project.id), false, "confinement is off unless the human asks for it");
  store.setProjectCheckCommands({ projectId: project.id, sandbox: true });
  assert.equal(store.projectCheckSandbox(project.id), true);

  const claim = claimWork(store, agent, task);
  const result = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done.", status: "blocked",
    checks: [{ label: "unit tests", command: "test" }, { label: "exfiltration attempt", command: "lint" }],
  });
  const [honest, exfil] = result.checks;
  assert.equal(honest.status, "passed", "the temp directory stays writable, so honest suites still run");
  assert.equal(exfil.status, "failed", "reading outside the project folder is refused");
  assert.match(exfil.output, /ERR_ACCESS_DENIED/);
});

test("confinement is refused rather than silently skipped for a program it cannot confine", async () => {
  // Only node can be confined this way. Running anything else unconfined while the project is marked
  // sandboxed would make "sandboxed" mean nothing, so it is not run at all.
  assert.equal(sandboxFlagsFor("git", "/tmp/x"), null);
  assert.ok(sandboxFlagsFor("node", "/tmp/x").includes("--permission"));
  const refused = await runVerifiedCheck({ argv: ["git", "status"], cwd: os.tmpdir(), sandbox: true });
  assert.equal(refused.status, "unavailable");
  assert.equal(refused.verified, false);
  assert.match(refused.output, /can only confine/);
});

// --- T0.2: verification runs off the event loop -------------------------------------------------

// A project whose one allowlisted check takes long enough to observe. Everything else about it is
// the ordinary fixture; only the script body differs.
async function slowChecksFixture(t, { millis = 900, exitCode = 0 } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-slow-checks-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-slow-checks-project-"));
  await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  await writeFile(path.join(projectRoot, "scripts", "slow.mjs"),
    `setTimeout(() => { process.stdout.write("slow check done"); process.exit(${exitCode}); }, ${millis});\n`, "utf8");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "slow-checks-fixture",
    scripts: { test: "node scripts/slow.mjs" },
  }, null, 2), "utf8");
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, checks: { timeoutMs: 30_000 } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Slow checks project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Slow checks", description: "Exercise off-loop verification." });
  store.setProjectCheckCommands({ projectId: project.id });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, project, task, agent, projectRoot };
}

test("verification does not hold the event loop, and says so on the board while it runs", async (t) => {
  // This is the whole point of running checks off-loop. Under spawnSync the timer below could not
  // fire at all until the check finished, and every other agent's call, the dashboard, SSE and the
  // heartbeats that decide who still holds a write lease waited with it.
  const { store, task, agent } = await slowChecksFixture(t, { millis: 900 });
  const claim = claimWork(store, agent, task);

  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 50);
  t.after(() => clearInterval(ticker));

  const settling = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Ran the slow check.", checks: [{ label: "suite", command: "test" }],
  });

  // The flag is set synchronously, before the first await, so it is already visible here.
  const verifyingRow = store.db.prepare("SELECT verifying_at, status, agent_id FROM assignments WHERE id = ?").get(claim.id);
  assert.ok(verifyingRow.verifying_at, "the assignment is marked verifying while its checks run");
  assert.equal(verifyingRow.status, "claimed", "and keeps its claim, so its write lease never lapses mid-verification");
  assert.equal(verifyingRow.agent_id, agent.id);
  assert.ok(store.taskDetail(task.id).events.some((event) => event.type === "assignment.verifying"),
    "the timeline says checks are running rather than going silent");

  // Ordinary reads keep answering while the child process runs.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(store.listAgents().length >= 1, "the store still answers while verification is in flight");

  const result = await settling;
  assert.equal(result.completed, true);
  assert.equal(result.checks[0].status, "passed");
  assert.ok(ticks >= 3, `the event loop kept running during verification (ticks: ${ticks})`);
  assert.equal(store.db.prepare("SELECT verifying_at FROM assignments WHERE id = ?").get(claim.id).verifying_at, null,
    "the flag is cleared once the report settles");
});

test("a second report is refused while the first one's checks are still running", async (t) => {
  // Each accepted report spawns real processes against one working tree. A duplicate call would run
  // the suite twice over the same files and record whichever finished last.
  const { store, task, agent } = await slowChecksFixture(t, { millis: 700 });
  const claim = claimWork(store, agent, task);
  const first = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "First report.", checks: [{ label: "suite", command: "test" }],
  });
  const second = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Same work, reported twice.", checks: [{ label: "suite", command: "test" }],
  });
  assert.equal(second.completed, false);
  assert.equal(second.verifying.assignmentId, claim.id);
  assert.match(second.reason, /still running the checks/i);

  const settled = await first;
  assert.equal(settled.completed, true, "the first report is unaffected by the refused duplicate");
  // One report ran, so exactly one batch of check rows is current.
  const current = store.db.prepare("SELECT COUNT(*) AS count FROM assignment_checks WHERE assignment_id = ? AND superseded_at IS NULL").get(claim.id);
  assert.equal(current.count, 1);
});

test("a claim that moves while its checks run cannot be settled by the session that lost it", async (t) => {
  // Verification is no longer instantaneous, so the claim can move underneath a report in flight —
  // a force-release, a resume, or a checkpoint takeover all reassign it without waiting. Settling
  // against the row read before the checks started would write a report on a lease this session no
  // longer holds.
  const { store, task, agent } = await slowChecksFixture(t, { millis: 900 });
  const claim = claimWork(store, agent, task);
  const settling = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Reported just before losing the lease.", checks: [{ label: "suite", command: "test" }],
  });
  // The human force-releases it while the check is still running.
  await new Promise((resolve) => setTimeout(resolve, 100));
  store.forceReleaseAssignment({ assignmentId: claim.id, confirmTitle: claim.title });

  const result = await settling;
  assert.equal(result.completed, false, "a report whose lease moved mid-verification is refused");
  assert.ok(result.claimConflict, "and is refused with a structured conflict, not a silent overwrite");
  const row = store.db.prepare("SELECT status, completed_at, verifying_at FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(row.status, "queued", "the released assignment stays queued for whoever picks it up");
  assert.equal(row.completed_at, null, "and was never recorded as done by the session that lost it");
  assert.equal(row.verifying_at, null);
});

test("a report that only asserts never enters the verifying window", async (t) => {
  // Nothing is executed, so there is nothing to wait for. Flagging it would put "checks running" on
  // the board for work nobody is checking.
  const { store, task, agent } = await slowChecksFixture(t);
  const claim = claimWork(store, agent, task);
  const settling = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Read the code.", checks: ["I read it carefully"],
  });
  assert.equal(store.db.prepare("SELECT verifying_at FROM assignments WHERE id = ?").get(claim.id).verifying_at, null);
  const result = await settling;
  assert.equal(result.completed, true);
  assert.equal(result.checks[0].verified, false, "an assertion is still recorded as the agent's own claim");
  assert.equal(store.taskDetail(task.id).events.some((event) => event.type === "assignment.verifying"), false);
});

test("a failed check clears the verifying flag and leaves the claim intact", async (t) => {
  const { store, task, agent } = await slowChecksFixture(t, { millis: 200, exitCode: 3 });
  const claim = claimWork(store, agent, task);
  const refused = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Claiming this is done.", checks: [{ label: "suite", command: "test" }],
  });
  assert.equal(refused.completed, false);
  assert.ok(refused.checksFailed, "a verified failure is refused, exactly as before");
  const row = store.db.prepare("SELECT status, agent_id, verifying_at FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(row.verifying_at, null, "the flag never outlives the report that set it");
  assert.equal(row.status, "claimed", "and the claim is left intact so the agent can fix and report again");
  assert.equal(row.agent_id, agent.id);
});

test("a verifying flag left by a crash is cleared on the next startup", async (t) => {
  // The child processes died with the process that spawned them, so nothing is coming to settle
  // that report. The claim, the lease and the fencing token were never released, so clearing the
  // flag returns the assignment to exactly what it still is: a live claim the agent can report on.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-verify-crash-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-verify-crash-project-"));
  const opened = [];
  t.after(async () => {
    for (const instance of opened) { try { instance.close(); } catch { /* already closed */ } }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  opened.push(store);
  const project = store.ensureProject("Crash project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Crash", description: "Die mid-verification." });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  store.db.prepare("UPDATE assignments SET verifying_at = ? WHERE id = ?").run(new Date().toISOString(), plan.id);
  store.close();

  const restarted = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  opened.push(restarted);
  const row = restarted.db.prepare("SELECT verifying_at, status, agent_id FROM assignments WHERE id = ?").get(plan.id);
  assert.equal(row.verifying_at, null, "a stale verifying flag never survives a restart");
  assert.equal(row.status, "claimed");
  assert.equal(row.agent_id, agent.id, "and the claim it belonged to is untouched");
});

// --- T2.3: regression awareness -----------------------------------------------------------------

// A project whose one allowlisted check can be flipped between passing and failing from the test, so
// "it used to pass and now it does not" is a real observation rather than a simulated one.
async function regressionFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-regress-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-regress-project-"));
  await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  const setSuite = async (passing) => {
    await writeFile(path.join(projectRoot, "scripts", "suite.mjs"),
      passing ? "process.stdout.write('ok');\n" : "process.stderr.write('broken');\nprocess.exit(1);\n", "utf8");
  };
  await setSuite(true);
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "regress-fixture", scripts: { test: "node scripts/suite.mjs" },
  }, null, 2), "utf8");

  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, checks: { timeoutMs: 20_000 } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Regress project", projectRoot);
  store.setProjectCheckCommands({ projectId: project.id });
  const task = store.createTask({ projectId: project.id, title: "Keep it green", description: "Do not break each other's work." });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, project, task, alice, bob, setSuite };
}

const SUITE = [{ label: "suite", command: "test" }];

// Claim a fresh assignment for an agent and report it, returning the report result.
async function doWork(store, agent, task, title, { changedFiles = [], checks = [], paths = undefined } = {}) {
  store.createAssignment({ taskId: task.id, title, description: "Work.", role: "implementer", requiresWrite: true, paths, targetAgentName: agent.name });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim.title, title, `${agent.name} should have claimed ${title}`);
  return { claim, result: await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: `${title} done.`, changedFiles, checks,
  }) };
}

test("a check that used to pass and now fails is named a regression, and routed to whoever broke it", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);

  // Alice delivers with the suite green. That establishes the baseline.
  const first = await doWork(store, alice, task, "Add the feature", { changedFiles: ["src/feature.mjs"], checks: SUITE, paths: ["src/feature.mjs"] });
  assert.equal(first.result.completed, true);
  assert.equal(first.result.checks[0].status, "passed");
  assert.equal(store.checkBaseline(task.id)[0].status, "passed");
  assert.ok(store.checkBaseline(task.id)[0].lastPassedAt);
  assert.equal(store.openRegressions(task.id).length, 0);

  // Alice then lands a change that breaks it, without running the suite herself.
  await setSuite(false);
  const breaking = await doWork(store, alice, task, "Refactor the shared helper", { changedFiles: ["src/helper.mjs"], paths: ["src/helper.mjs"] });
  assert.equal(breaking.result.completed, true, "nothing catches it yet — nobody ran the suite");
  assert.equal(store.openRegressions(task.id).length, 0);

  // Bob, doing unrelated work, runs the suite and trips over Alice's breakage.
  const caught = await doWork(store, bob, task, "Do something else", { changedFiles: ["src/other.mjs"], checks: SUITE, paths: ["src/other.mjs"] });
  assert.equal(caught.result.completed, false, "a failing check still refuses the report");
  assert.equal(caught.result.regressions.length, 1, "and it is recognised as a regression, not just a failure");

  const regression = caught.result.regressions[0];
  assert.equal(regression.label, "suite");
  assert.equal(regression.attribution, "single");
  assert.equal(regression.suspects.length, 1);
  assert.equal(regression.suspects[0].title, "Refactor the shared helper");
  assert.equal(regression.suspects[0].author, "Alice", "the agent that changed files since it was last green");
  assert.deepEqual(regression.suspects[0].changedFiles, ["src/helper.mjs"]);
  assert.match(caught.result.regressionNote, /not yours/i, "Bob is told this is not his to chase");

  // A fix assignment is queued and addressed to Alice.
  assert.ok(regression.fixAssignmentId);
  const fix = store.taskDetail(task.id).assignments.find((item) => item.id === regression.fixAssignmentId);
  assert.equal(fix.status, "queued");
  assert.equal(fix.target_agent_name, "Alice");
  assert.equal(fix.requires_write, 1);
  assert.match(fix.title, /regression/i);
  assert.match(fix.description, /src\/helper\.mjs/);

  // And it is on the timeline as its own event, not buried in a failed report.
  assert.ok(store.taskDetail(task.id).events.some((event) => event.type === "check.regressed"));
  assert.equal(store.taskDetail(task.id).regressions.length, 1);
});

test("a regression closes itself when the check goes green again", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: SUITE, paths: ["src/a.mjs"] });
  await setSuite(false);
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });
  const caught = await doWork(store, bob, task, "Trip over it", { changedFiles: ["src/c.mjs"], checks: SUITE, paths: ["src/c.mjs"] });
  const fixId = caught.result.regressions[0].fixAssignmentId;
  assert.equal(store.openRegressions(task.id).length, 1);

  // Alice claims the fix and repairs the suite.
  await setSuite(true);
  const fixClaim = store.claimNextAssignment(alice.id);
  assert.equal(fixClaim.id, fixId, "the fix is addressed to Alice, so she gets it first");
  const fixed = await store.completeAssignment({
    agentId: alice.id, assignmentId: fixId, claimToken: fixClaim.claimToken,
    message: "Repaired the helper.", changedFiles: ["src/helper.mjs"], checks: SUITE,
  });
  assert.equal(fixed.completed, true);
  assert.equal(store.openRegressions(task.id).length, 0, "a check going green closes what it broke");
  assert.equal(store.checkBaseline(task.id)[0].status, "passed");
});

test("one broken check queues one fix, however many agents trip over it", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: SUITE, paths: ["src/a.mjs"] });
  await setSuite(false);
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });

  const firstCatch = await doWork(store, bob, task, "First to notice", { changedFiles: ["src/c.mjs"], checks: SUITE, paths: ["src/c.mjs"] });
  assert.equal(firstCatch.result.regressions.length, 1);
  const fixId = firstCatch.result.regressions[0].fixAssignmentId;
  assert.ok(fixId);

  // Bob's report was refused, so he still holds that claim. Report it again — the suite still fails,
  // but the baseline already records the failure, so this is the same breakage rather than a new one.
  const second = await store.completeAssignment({
    agentId: bob.id, assignmentId: firstCatch.claim.id, claimToken: firstCatch.claim.claimToken,
    message: "Trying again.", changedFiles: ["src/c.mjs"], checks: SUITE,
  });
  assert.equal(second.completed, false);
  assert.equal(second.regressions ?? undefined, undefined, "a check that was already failing does not regress twice");
  const fixAssignments = store.taskDetail(task.id).assignments.filter((item) => /regression/i.test(item.title));
  assert.equal(fixAssignments.length, 1, "and the board never accumulates duplicate fix assignments");
});

test("ambiguous attribution says so instead of blaming the first name it finds", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: SUITE, paths: ["src/a.mjs"] });
  await setSuite(false);
  // Two writers land between the last green run and the failure.
  await doWork(store, alice, task, "Alice changes things", { changedFiles: ["src/one.mjs"], paths: ["src/one.mjs"] });
  await doWork(store, bob, task, "Bob changes things", { changedFiles: ["src/two.mjs"], paths: ["src/two.mjs"] });

  const caught = await doWork(store, alice, task, "Run the suite", { changedFiles: ["src/three.mjs"], checks: SUITE, paths: ["src/three.mjs"] });
  const regression = caught.result.regressions[0];
  assert.equal(regression.attribution, "ambiguous");
  assert.equal(regression.suspects.length, 2);
  const fix = store.taskDetail(task.id).assignments.find((item) => item.id === regression.fixAssignmentId);
  assert.equal(fix.target_agent_name, null, "with two candidates it is not addressed to either of them");
  assert.match(fix.description, /starting point, not a verdict/);
});

test("an asserted check can neither set a baseline nor manufacture a regression", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);
  // A plain string check is the agent's word, never executed.
  await doWork(store, alice, task, "Claim it passes", { changedFiles: ["src/a.mjs"], checks: ["the suite passes, trust me"], paths: ["src/a.mjs"] });
  assert.equal(store.checkBaseline(task.id).length, 0, "an assertion establishes nothing");

  await setSuite(false);
  const caught = await doWork(store, bob, task, "Actually run it", { changedFiles: ["src/b.mjs"], checks: SUITE, paths: ["src/b.mjs"] });
  assert.equal(caught.result.completed, false);
  assert.equal(caught.result.regressions ?? undefined, undefined,
    "with no verified baseline there is nothing to have regressed from — it is a plain failure");
  assert.equal(store.openRegressions(task.id).length, 0);

  // Now establish a real baseline, and confirm an assertion cannot quietly repair it either.
  await setSuite(true);
  await doWork(store, alice, task, "Really green", { changedFiles: ["src/c.mjs"], checks: SUITE, paths: ["src/c.mjs"] });
  assert.equal(store.checkBaseline(task.id)[0].status, "passed");
  await setSuite(false);
  await doWork(store, alice, task, "Break and assert", { changedFiles: ["src/d.mjs"], checks: ["still fine, honest"], paths: ["src/d.mjs"] });
  assert.equal(store.checkBaseline(task.id)[0].status, "passed", "the assertion did not touch the baseline");
});

// --- T1.3: checks a project declares for itself ---------------------------------------------------

test("a project with no package.json can still declare and run real checks", async (t) => {
  // A research project: Python tooling, no Node package anywhere. Before this it could report checks
  // but never have any of them verified, so every claim stayed agent-asserted forever.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-declared-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-declared-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, checks: { timeoutMs: 20_000 } });
  t.after(async () => {
    try { store.close(); } catch { /* closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(projectRoot, "tools"), { recursive: true });
  await mkdir(path.join(projectRoot, ".devteam"), { recursive: true });
  await writeFile(path.join(projectRoot, "tools", "citations.mjs"), "process.stdout.write('all citations resolve');\n", "utf8");
  await writeFile(path.join(projectRoot, ".devteam", "checks.json"), JSON.stringify({
    checks: [
      { name: "citations", argv: ["node", "tools/citations.mjs"] },
      { name: "shell-attempt", argv: ["bash", "-c", "echo nope"] },
    ],
  }, null, 2), "utf8");

  const project = store.ensureProject("Research project", projectRoot);
  const available = store.availableCheckCommands(project.id);
  assert.deepEqual(available.map((entry) => entry.name), ["citations"],
    "a declared entry that is a way to run something else is refused, exactly as a derived one is");
  assert.equal(available[0].source, "project");

  store.setProjectCheckCommands({ projectId: project.id });
  const task = store.createTask({ projectId: project.id, title: "Write it up", description: "Not a Node project." });
  const agent = store.connectAgent({ name: "Researcher", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  const claim = claimWork(store, agent, task, "Check the citations");
  const result = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Checked.", checks: [{ label: "citations resolve", command: "citations" }],
  });
  assert.equal(result.completed, true);
  assert.equal(result.checks[0].verified, true, "a project that declares its own checks gets real verification");
  assert.equal(result.checks[0].status, "passed");
});

test("a declared check overrides a package script of the same name", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-override-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-override-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(projectRoot, ".devteam"), { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ scripts: { test: "node from-package.mjs" } }), "utf8");
  await writeFile(path.join(projectRoot, ".devteam", "checks.json"), JSON.stringify({
    checks: [{ name: "test", argv: ["node", "from-config.mjs"] }],
  }), "utf8");
  const project = store.ensureProject("Override project", projectRoot);
  const available = store.availableCheckCommands(project.id);
  assert.equal(available.length, 1);
  assert.deepEqual(available[0].argv, ["node", "from-config.mjs"],
    "a human writing the file outranks a script body DevTeam parsed");
});

test("a locally installed tool is resolved to its real entry point instead of an unrunnable shim", async (t) => {
  // The Windows failure this fixes: `eslint` is a .cmd shim, spawn with shell:false cannot run it,
  // and the check graded 'unavailable' forever — indistinguishable from having no verification.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-shim-"));
  t.after(async () => { await rm(projectRoot, { recursive: true, force: true }); });
  const binDirectory = path.join(projectRoot, "node_modules", ".bin");
  await mkdir(binDirectory, { recursive: true });
  await mkdir(path.join(projectRoot, "node_modules", "toolkit", "bin"), { recursive: true });
  await writeFile(path.join(projectRoot, "node_modules", "toolkit", "bin", "cli.js"), "process.exit(0);\n", "utf8");
  await writeFile(path.join(binDirectory, "toolkit.cmd"),
    String.raw`@ECHO off\r\n"%_prog%" "%dp0%\\..\\toolkit\\bin\\cli.js" %*`, "utf8");

  assert.deepEqual(resolveLocalBinary(projectRoot, ["toolkit", "--strict"]),
    ["node", "node_modules/toolkit/bin/cli.js", "--strict"],
    "the shim is read at snapshot time and rewritten to run its entry point under node");

  // Nothing else is touched: node stays node, an absolute-looking program is left alone, and a
  // program with no shim is left exactly as written.
  assert.deepEqual(resolveLocalBinary(projectRoot, ["node", "--test"]), ["node", "--test"]);
  assert.deepEqual(resolveLocalBinary(projectRoot, ["nothing-here", "x"]), ["nothing-here", "x"]);
  assert.deepEqual(resolveLocalBinary(null, ["toolkit"]), ["toolkit"]);

  // A shim pointing outside the project is refused rather than run on its say-so.
  await writeFile(path.join(binDirectory, "escapee.cmd"), String.raw`"%_prog%" "%dp0%\\..\\..\\..\\outside\\evil.js" %*`, "utf8");
  assert.deepEqual(resolveLocalBinary(projectRoot, ["escapee"]), ["escapee"]);
});

// --- T2.4 / T2.5: independence and reliability ----------------------------------------------------

test("where verification is enabled, an approval must rest on something DevTeam actually ran", async (t) => {
  const { store, task, agent } = await checksFixture(t);
  const claim = claimWork(store, agent, task, "Do it");
  // Reported with an assertion only: nothing was executed.
  await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Done.", checks: ["I ran the tests myself, they pass"],
  });
  const review = store.createAssignment({ taskId: task.id, title: "Review it", description: "Read it.", role: "reviewer" });
  const reviewClaim = store.claimNextAssignment(agent.id);
  assert.equal(reviewClaim.id, review.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: review.id, claimToken: reviewClaim.claimToken, message: "Reviewed." });

  assert.throws(() => store.approveTask({ agentId: agent.id, taskId: task.id, summary: "Looks good." }),
    /passed one/i, "an assertion cannot carry an approval in a project that runs real checks");

  // Run a real check, and the approval becomes available.
  const fix = store.createAssignment({ taskId: task.id, title: "Actually run it", description: "Run the suite.", role: "implementer" });
  const fixClaim = store.claimNextAssignment(agent.id);
  await store.completeAssignment({
    agentId: agent.id, assignmentId: fix.id, claimToken: fixClaim.claimToken,
    message: "Ran it.", changedFiles: ["src/thing.mjs"], checks: [{ label: "suite", command: "test" }],
  });
  const secondReview = store.createAssignment({ taskId: task.id, title: "Review again", description: "Read it.", role: "reviewer" });
  const secondClaim = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: secondReview.id, claimToken: secondClaim.claimToken, message: "Reviewed." });
  const approved = store.approveTask({ agentId: agent.id, taskId: task.id, summary: "Verified and good." });
  assert.equal(approved.selfReviewed, true, "a solo run still finishes, and is still labeled honestly");

  const approvals = store.taskDetail(task.id).approvals;
  assert.equal(approvals[0].independent, 0,
    "the approver authored the current version, so the approval is recorded as not independent");
  assert.equal(approvals[0].verified_evidence, 1);
});

test("the team keeps an honest record of who overclaims, who reworks, and who catches breakage", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);

  // Alice establishes green, then breaks it without running anything.
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: SUITE, paths: ["src/a.mjs"] });
  await setSuite(false);
  await doWork(store, alice, task, "Break it", { changedFiles: ["src/b.mjs"], paths: ["src/b.mjs"] });
  // Bob runs the suite and trips over it.
  await doWork(store, bob, task, "Trip over it", { changedFiles: ["src/c.mjs"], checks: SUITE, paths: ["src/c.mjs"] });

  const aliceRecord = store.agentReliability("Alice");
  const bobRecord = store.agentReliability("Bob");

  assert.equal(aliceRecord.completed, 3, "the planner report plus two pieces of work");
  assert.equal(aliceRecord.regressionsCaused, 1, "and she is the sole suspect for the breakage");
  assert.equal(aliceRecord.refusedByChecks, 0);

  assert.equal(bobRecord.refusedByChecks, 1, "Bob's report was refused because a check failed");
  assert.equal(bobRecord.regressionsCaused, 0, "but he did not cause it");
  assert.equal(bobRecord.regressionsCaught, 1, "he found it, and that counts for him rather than against");
  assert.ok(bobRecord.cleanReportRate < 1);

  // A name nobody has heard of is treated as trustworthy rather than punished for being new.
  const newcomer = store.agentReliability("Someone New");
  assert.equal(newcomer.sample, 0);
  assert.equal(newcomer.cleanReportRate, 1);

  assert.ok(store.teamReliability().some((entry) => entry.agentName === "Alice"));
  assert.equal(store.agentReliability("  "), null);
});

test("an ambiguous regression is not charged to anyone's record", async (t) => {
  const { store, task, alice, bob, setSuite } = await regressionFixture(t);
  await doWork(store, alice, task, "Establish green", { changedFiles: ["src/a.mjs"], checks: SUITE, paths: ["src/a.mjs"] });
  await setSuite(false);
  await doWork(store, alice, task, "Alice changes things", { changedFiles: ["src/one.mjs"], paths: ["src/one.mjs"] });
  await doWork(store, bob, task, "Bob changes things", { changedFiles: ["src/two.mjs"], paths: ["src/two.mjs"] });
  await doWork(store, alice, task, "Run the suite", { changedFiles: ["src/three.mjs"], checks: SUITE, paths: ["src/three.mjs"] });

  assert.equal(store.openRegressions(task.id).length, 1);
  assert.equal(store.agentReliability("Alice").regressionsCaused, 0,
    "a shared window is a guess, and a guess must not follow someone around as a number");
  assert.equal(store.agentReliability("Bob").regressionsCaused, 0);
});
