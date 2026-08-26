import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

// T0.4 — durability. Long work now outlives the call that started it in the record, and one data
// directory belongs to one process. Multi-process is deliberately NOT here: the roadmap's own
// ordering is a durable job table first, and nothing has hit a measured limit that would justify
// the second half.

async function fixture(t, { millis = 400, exitCode = 0 } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-durable-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-durable-project-"));
  await mkdir(path.join(projectRoot, "scripts"), { recursive: true });
  await writeFile(path.join(projectRoot, "scripts", "slow.mjs"),
    `setTimeout(() => { process.stdout.write("done"); process.exit(${exitCode}); }, ${millis});\n`, "utf8");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "durable-fixture", scripts: { test: "node scripts/slow.mjs" },
  }, null, 2), "utf8");
  const opened = [];
  const open = () => {
    const store = new DevTeamStore(dataDir, {
      knowledge: { enabled: false }, codegraph: { enabled: false }, checks: { timeoutMs: 30_000 },
    });
    opened.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of opened) { try { store.close(); } catch { /* already closed */ } }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const store = open();
  const project = store.ensureProject("Durable project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Durable work", description: "Exercise durability." });
  store.setProjectCheckCommands({ projectId: project.id });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, open, dataDir, project, task, agent };
}

function claimWork(store, agent, task, title = "Do the work") {
  store.createAssignment({ taskId: task.id, title, description: "Work.", role: "implementer" });
  return store.claimNextAssignment(agent.id);
}

test("work that runs real commands is recorded as a job while it runs, and settled when it ends", async (t) => {
  const { store, task, agent } = await fixture(t, { millis: 500 });
  const claim = claimWork(store, agent, task);

  const settling = store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Ran the suite.", changedFiles: ["scripts/slow.mjs"], checks: [{ label: "suite", command: "test" }],
  });

  await new Promise((resolve) => setTimeout(resolve, 150));
  const running = store.openJobs();
  assert.equal(running.length, 1, "the report in flight is a row, not just an in-memory promise");
  assert.equal(running[0].kind, "verified_checks");
  assert.equal(running[0].assignment_id, claim.id);
  assert.equal(running[0].task_id, task.id);
  assert.deepEqual(JSON.parse(running[0].detail).commands, ["test"], "and it records what it is running");

  const result = await settling;
  assert.equal(result.completed, true);
  assert.equal(store.openJobs().length, 0, "nothing is left running once the report settles");
  const [job] = store.jobs(task.id);
  assert.equal(job.state, "finished");
  assert.ok(job.finished_at, "a finished job carries when it finished");
});

test("a report that only asserts starts no job", async (t) => {
  // Nothing is executed, so there is nothing that could outlive a restart. A row here would put a
  // permanent "was running" record on work nobody ran.
  const { store, task, agent } = await fixture(t);
  const claim = claimWork(store, agent, task);
  await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Read it.", checks: ["I read it carefully"],
  });
  assert.equal(store.jobs(task.id).length, 0);
});

test("a job left running by a crash is marked interrupted on the next startup, and says so", async (t) => {
  // The child processes died with the process that spawned them, so nothing is coming to finish
  // that job. Before this, the only trace was a verifying flag that startup quietly cleared — the
  // record simply forgot that DevTeam had been part-way through running something.
  const { store, open, task, agent } = await fixture(t);
  const claim = claimWork(store, agent, task);
  const stamp = new Date().toISOString();
  store.db.prepare("UPDATE assignments SET verifying_at = ? WHERE id = ?").run(stamp, claim.id);
  store.db.prepare(`
    INSERT INTO jobs (id, kind, task_id, assignment_id, agent_id, state, detail, instance_id, started_at)
    VALUES ('11111111-1111-4111-8111-111111111111', 'verified_checks', ?, ?, ?, 'running', ?, 'dead-instance', ?)
  `).run(task.id, claim.id, agent.id, JSON.stringify({ commands: ["test"] }), stamp);
  store.close();

  const restarted = open();
  const [job] = restarted.jobs(task.id);
  assert.equal(job.state, "interrupted", "a job whose process died is interrupted, not silently forgotten");
  assert.ok(job.finished_at, "and it is closed out rather than left open forever");
  assert.match(job.outcome || "", /restart/i);
  assert.equal(restarted.openJobs().length, 0);

  const events = restarted.taskDetail(task.id).events;
  assert.ok(events.some((event) => event.type === "job.interrupted"), "the timeline says verification was interrupted");

  const row = restarted.db.prepare("SELECT status, agent_id, verifying_at FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(row.verifying_at, null, "the stale verifying flag is still cleared");
  assert.equal(row.status, "claimed", "and the claim, lease and fencing token are untouched — the agent simply reports again");
  assert.equal(row.agent_id, agent.id);
});

test("an interrupted job is history, not a queue: nothing re-runs it", async (t) => {
  // A job table invites a worker that picks work back up. That would re-run a suite in a working
  // tree that has moved on, against a claim that may now belong to someone else. Recovery records
  // what happened and stops there.
  const { store, open, task, agent } = await fixture(t);
  const claim = claimWork(store, agent, task);
  store.db.prepare(`
    INSERT INTO jobs (id, kind, task_id, assignment_id, agent_id, state, detail, instance_id, started_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 'verified_checks', ?, ?, ?, 'running', ?, 'dead-instance', ?)
  `).run(task.id, claim.id, agent.id, JSON.stringify({ commands: ["test"] }), new Date().toISOString());
  store.close();

  const restarted = open();
  await new Promise((resolve) => setTimeout(resolve, 700)); // longer than the fixture's check
  assert.equal(restarted.openJobs().length, 0, "recovery never restarts a job");
  assert.equal(restarted.db.prepare("SELECT COUNT(*) AS count FROM assignment_checks WHERE assignment_id = ?")
    .get(claim.id).count, 0, "and no check result appears for a run nobody made");
});

test("one data directory belongs to one process while that process is live", async (t) => {
  // Two servers on one database would hand out write leases from two schedulers, each reaping the
  // other's agents. The lease model is the thing that must never be loosened for throughput, so
  // this is refused loudly rather than papered over.
  const { store, open, dataDir } = await fixture(t);
  assert.ok(store.instanceId, "a live store identifies itself");
  assert.throws(() => open(), /already using this data directory/i);
  assert.match(String(dataDir), /devteam-durable-data-/);
});

test("closing a store hands its data directory to the next process", async (t) => {
  const { store, open } = await fixture(t);
  store.close();
  const next = open();
  assert.notEqual(next.instanceId, store.instanceId);
  assert.ok(next.openJobs().length === 0);
});

test("a data directory left locked by a crashed process is taken over once the lock goes stale", async (t) => {
  // The alternative is a server that refuses to start after a hard kill until someone deletes a
  // file by hand, which is how a safety measure becomes the thing people disable.
  const { store, open } = await fixture(t);
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const lock = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get().value);
  store.db.prepare("UPDATE metadata SET value = ? WHERE key = 'server_instance'")
    .run(JSON.stringify({ ...lock, heartbeatAt: stale }));
  // Simulate the process being gone without close() ever running.
  store.db.close();

  const restarted = open();
  assert.ok(restarted.instanceId, "a stale lock is taken over rather than requiring manual cleanup");
  assert.notEqual(restarted.instanceId, store.instanceId);
});

test("a CLI can read the database while the server owns it, without touching scheduling state", async (t) => {
  // `devteam token` is run while the server is up, by definition. Before the lock it opened the
  // database as a second owner and ran orphan recovery, checkpoint expiry and status derivation
  // against a live scheduler — quietly moving work around from a command that only prints a string.
  const { store, dataDir, task, agent } = await fixture(t);
  const claim = claimWork(store, agent, task);
  const before = store.db.prepare("SELECT status, agent_id, claim_generation FROM assignments WHERE id = ?").get(claim.id);

  const observer = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false }, exclusive: false });
  t.after(() => { try { observer.close(); } catch { /* already closed */ } });
  assert.equal(observer.token, store.token, "an observer can read what it came for");
  assert.equal(observer.instanceId, null, "and never claims the directory");

  const after = store.db.prepare("SELECT status, agent_id, claim_generation FROM assignments WHERE id = ?").get(claim.id);
  assert.deepEqual(after, before, "the live claim is exactly as the server left it");
  const lock = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get().value);
  assert.equal(lock.instanceId, store.instanceId, "and the server still owns the lock");
  observer.close();
  const stillLocked = store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get();
  assert.ok(stillLocked, "an observer closing does not release someone else's lock");
});

test("a lock held by a process that no longer exists is not a lock", async (t) => {
  // A clean shutdown releases the directory, but a SIGKILL cannot. Waiting out the stale window
  // would mean refusing to restart for two minutes after any hard kill, which is how a safety
  // measure teaches people to disable it. The lock guards a local directory, so the pid can be asked
  // directly — and a fresh heartbeat from a dead pid is still a dead process.
  const { store, open } = await fixture(t);
  const lock = JSON.parse(store.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get().value);
  store.db.prepare("UPDATE metadata SET value = ? WHERE key = 'server_instance'").run(JSON.stringify({
    ...lock,
    instanceId: "someone-elses-instance",
    pid: 0x7fffffff, // a pid nothing on this machine is using
    heartbeatAt: new Date().toISOString(),
  }));
  store.db.close();

  const restarted = open();
  assert.ok(restarted.instanceId, "the directory is taken over immediately rather than after a timeout");
});
