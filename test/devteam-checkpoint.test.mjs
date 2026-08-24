import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checkpoint-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-checkpoint-project-"));
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "work.mjs"), "export const work = true;\n", "utf8");
  const store = new DevTeamStore(dataDir, {
    knowledge: { enabled: false },
    codegraph: { enabled: false },
    ...options,
  });
  t.after(async () => {
    try { store.close(); } catch { /* a restart test may already have closed it */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Checkpoint project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Safe session handoff", description: "Transfer an active writer without losing its claim." });
  const oldAgent = store.connectAgent({ name: "Old Codex", provider: "test" });
  const assignment = store.claimNextAssignment(oldAgent.id);
  return { store, dataDir, projectRoot, project, task, oldAgent, assignment };
}

test("checkpoint capsules are byte-exact, bounded, redacted, and never expose stored hashes", async (t) => {
  const { store, task, oldAgent, assignment } = await fixture(t);
  store.postMessage({ agentId: oldAgent.id, taskId: task.id, type: "agent.decision", message: `Use SQLite. password=hunter2 ${"😀".repeat(20_000)}` });
  const result = store.createSessionCheckpoint({
    agentId: oldAgent.id,
    taskId: task.id,
    assignmentId: assignment.id,
    decisions: Array.from({ length: 30 }, (_, index) => `decision ${index} ${"界".repeat(800)}`),
    blockers: ["Bearer abcdefghijklmnopqrstuvwxyz"],
    checks: ["API_KEY=super-secret-value", ...Array.from({ length: 50 }, (_, index) => `check ${index} ${"x".repeat(900)}`)],
    failedApproaches: ["token: should-not-survive"],
    nextAction: "Continue safely.",
  });

  const capsuleJson = JSON.stringify(result.checkpoint.capsule);
  assert.equal(result.checkpoint.capsule.capsuleMeta.bytes, Buffer.byteLength(capsuleJson, "utf8"));
  assert.ok(Buffer.byteLength(capsuleJson, "utf8") <= 16_384);
  assert.equal(result.checkpoint.capsule.capsuleMeta.sourceBodiesIncluded, false);
  assert.equal(result.checkpoint.capsule.capsuleMeta.truncated, true);
  assert.ok(result.checkpoint.capsule.capsuleMeta.redacted >= 4);
  assert.doesNotMatch(capsuleJson, /hunter2|super-secret-value|should-not-survive|abcdefghijklmnopqrst/);
  assert.match(capsuleJson, /\[REDACTED\]/);
  assert.equal(capsuleJson.includes(result.handoffToken), false);

  const stored = store.db.prepare("SELECT * FROM session_checkpoints WHERE id = ?").get(result.checkpoint.id);
  assert.notEqual(stored.handoff_token_hash, result.handoffToken);
  assert.equal(stored.handoff_token_hash.length, 64);
  assert.equal(JSON.stringify(store.taskDetail(task.id)).includes("handoff_token_hash"), false);
  assert.equal(JSON.stringify(store.taskBrief(oldAgent.id, task.id)).includes("handoff_token_hash"), false);
  assert.equal(JSON.stringify(store.listAgents()).includes("resume_token_hash"), false);
});

test("takeover atomically moves the claim, bumps fencing, rejects replay, and fences the old report", async (t) => {
  const { store, task, oldAgent, assignment } = await fixture(t);
  const checkpoint = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id, nextAction: "Finish planning." });
  const fresh = store.connectAgent({ name: "Fresh Codex", provider: "test" });
  const competitor = store.connectAgent({ name: "Other fresh session", provider: "test" });

  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: oldAgent.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  }), /distinct fresh/);
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: "wrong-token-value-wrong-token",
  }), /invalid/);
  const taken = store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  });
  assert.equal(taken.takenOver, true);
  assert.equal(taken.assignment.id, assignment.id);
  assert.equal(taken.assignment.claimGeneration, assignment.claimGeneration + 1);
  assert.ok(taken.assignment.claimToken);
  assert.equal(store.getAgent(oldAgent.id).status, "disconnected");
  assert.equal(store.getAgent(fresh.id).status, "busy");
  assert.equal(store.db.prepare("SELECT agent_id FROM assignments WHERE id = ?").get(assignment.id).agent_id, fresh.id);
  const consumed = store.db.prepare("SELECT status, handoff_token_hash FROM session_checkpoints WHERE id = ?").get(checkpoint.checkpoint.id);
  assert.equal(consumed.status, "claimed");
  assert.equal(consumed.handoff_token_hash, null);

  const staleReport = store.completeAssignment({
    agentId: oldAgent.id,
    assignmentId: assignment.id,
    claimToken: assignment.claimToken,
    message: "Old session must not land this.",
  });
  assert.equal(staleReport.completed, false);
  assert.equal(staleReport.claimConflict.generation, assignment.claimGeneration + 1);
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: competitor.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  }), /one-time|no longer ready/i);
  const completed = store.completeAssignment({
    agentId: fresh.id,
    assignmentId: assignment.id,
    claimToken: taken.assignment.claimToken,
    message: "Fresh session completed safely.",
  });
  assert.equal(completed.completed, true);
});

test("concurrent takeover attempts produce exactly one owner and one new fencing token", async (t) => {
  const { store, task, oldAgent, assignment } = await fixture(t);
  const checkpoint = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  const first = store.connectAgent({ name: "Concurrent A", provider: "test" });
  const second = store.connectAgent({ name: "Concurrent B", provider: "test" });
  const attempts = await Promise.allSettled([first, second].map((agent) => Promise.resolve().then(() => store.takeoverSessionCheckpoint({
    agentId: agent.id,
    taskId: task.id,
    checkpointId: checkpoint.checkpoint.id,
    handoffToken: checkpoint.handoffToken,
  }))));
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  const winner = attempts.find((result) => result.status === "fulfilled").value;
  const stored = store.db.prepare("SELECT agent_id, claim_generation, claim_token_hash FROM assignments WHERE id = ?").get(assignment.id);
  assert.equal(stored.agent_id, winner.assignment.agent_id);
  assert.equal(stored.claim_generation, assignment.claimGeneration + 1);
  assert.equal(stored.claim_token_hash.length, 64);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE id = ? AND status = 'claimed'").get(assignment.id).count, 1);
});

test("a disconnected old session can be recovered from its persisted checkpoint after restart", async (t) => {
  const { store, dataDir, projectRoot, task, oldAgent, assignment } = await fixture(t);
  const checkpoint = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  store.disconnectAgent(oldAgent.id, "Desktop closed after checkpoint.");
  assert.equal(store.db.prepare("SELECT status, agent_id, claim_token_hash FROM assignments WHERE id = ?").get(assignment.id).status, "queued");
  store.close();

  const restarted = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(() => { try { restarted.close(); } catch { /* already closed */ } });
  assert.equal(restarted.sessionCheckpointGet({ taskId: task.id, checkpointId: checkpoint.checkpoint.id }).status, "ready");
  const fresh = restarted.connectAgent({ name: "Restarted Codex", provider: "test" });
  const taken = restarted.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  });
  assert.equal(taken.assignment.id, assignment.id);
  assert.equal(taken.assignment.claimGeneration, assignment.claimGeneration + 1);
  assert.equal(path.resolve(taken.checkpoint.capsule.task.project.root), path.resolve(projectRoot));
  restarted.close();
});

test("expired, cancelled, and stale checkpoints never release or steal a live claim", async (t) => {
  const { store, task, oldAgent, assignment } = await fixture(t, { checkpoint: { ttlMs: 1 } });
  const expired = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const fresh = store.connectAgent({ name: "Fresh", provider: "test" });
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: expired.checkpoint.id, handoffToken: expired.handoffToken,
  }), /expired/);
  assert.equal(store.db.prepare("SELECT agent_id FROM assignments WHERE id = ?").get(assignment.id).agent_id, oldAgent.id);
  store.checkpoint.ttlMs = 30 * 60 * 1000;

  const cancelled = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  store.cancelSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id, checkpointId: cancelled.checkpoint.id });
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: cancelled.checkpoint.id, handoffToken: cancelled.handoffToken,
  }), /one-time|no longer ready/i);
  assert.equal(store.db.prepare("SELECT agent_id FROM assignments WHERE id = ?").get(assignment.id).agent_id, oldAgent.id);

  const stale = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  store.db.prepare("UPDATE assignments SET claim_generation = claim_generation + 1 WHERE id = ?").run(assignment.id);
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: stale.checkpoint.id, handoffToken: stale.handoffToken,
  }), /stale|moved/);
  assert.equal(store.db.prepare("SELECT agent_id FROM assignments WHERE id = ?").get(assignment.id).agent_id, oldAgent.id);

  const forceReleased = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  store.forceReleaseAssignment({ assignmentId: assignment.id, confirmTitle: assignment.title });
  assert.equal(store.sessionCheckpointGet({ taskId: task.id, checkpointId: forceReleased.checkpoint.id }).status, "cancelled");
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: forceReleased.checkpoint.id, handoffToken: forceReleased.handoffToken,
  }), /one-time|no longer ready/i);
});

test("checkpoint takeover enforces task rooms and observer boundaries", async (t) => {
  const { store, project, task, oldAgent } = await fixture(t);
  const checkpoint = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  const otherTask = store.createTask({ projectId: project.id, title: "Other room", description: "Must remain isolated." });
  const outsider = store.connectAgent({ name: "Outsider", provider: "test" });
  store.joinTask(outsider.id, otherTask.id, "contributor");
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: outsider.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  }), /not a member/);
  assert.throws(() => store.sessionCheckpointGet({ agentId: outsider.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id }), /not a member/);

  const observer = store.connectAgent({ name: "Observer", provider: "test" });
  store.joinTask(observer.id, task.id, "observer");
  assert.throws(() => store.takeoverSessionCheckpoint({
    agentId: observer.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  }), /Observers/);
  assert.equal(store.sessionCheckpointGet({ agentId: observer.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id }).status, "ready");
});

test("task-version drift warns the new session while preserving an unchanged active claim", async (t) => {
  const { store, task, oldAgent } = await fixture(t);
  const checkpoint = store.createSessionCheckpoint({ agentId: oldAgent.id, taskId: task.id });
  const sibling = store.connectAgent({ name: "Sibling", provider: "test" });
  const work = store.createAssignment({ taskId: task.id, title: "Independent update", description: "Advance task evidence.", role: "implementer" });
  const siblingClaim = store.claimNextAssignment(sibling.id);
  assert.equal(siblingClaim.id, work.id);
  store.completeAssignment({ agentId: sibling.id, assignmentId: work.id, claimToken: siblingClaim.claimToken, message: "Updated evidence.", changedFiles: ["src/work.mjs"] });
  const fresh = store.connectAgent({ name: "Fresh after drift", provider: "test" });
  const taken = store.takeoverSessionCheckpoint({
    agentId: fresh.id, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken,
  });
  assert.ok(taken.warnings.some((warning) => /task version changed/i.test(warning)));
  assert.equal(taken.assignment.agent_id, fresh.id);
});

test("restart-safe migration recreates the additive checkpoint table without altering existing tasks", async (t) => {
  const { store, dataDir, task } = await fixture(t);
  store.db.exec("DROP TABLE session_checkpoints");
  store.close();
  const migrated = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(() => { try { migrated.close(); } catch { /* already closed */ } });
  const columns = new Set(migrated.db.prepare("PRAGMA table_info(session_checkpoints)").all().map((column) => column.name));
  for (const name of ["capsule", "checkpoint_generation", "handoff_token_hash", "claimed_by_agent_id", "expires_at"]) {
    assert.equal(columns.has(name), true);
  }
  assert.equal(migrated.getTask(task.id).title, task.title);
  migrated.close();
});
