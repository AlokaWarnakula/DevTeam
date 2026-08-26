import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

const profile = {
  providerId: "session-fixture", currentModel: "balanced", currentEffort: "medium",
  currentModelClass: "balanced", currentEffortClass: "medium",
  availableModels: [{ id: "balanced", class: "balanced", efforts: [{ id: "medium", class: "medium" }] }],
  switchMode: "user_required", source: "host", observedAt: new Date().toISOString(),
};

test("new tasks default per-task while migrated/defaulted rows remain manual", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-session-policy-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "devteam-session-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { try { store.close(); } catch {} await rm(dataDir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  const project = store.ensureProject("Sessions", root);
  const fresh = store.createTask({ projectId: project.id, title: "Fresh", description: "New policy default." });
  assert.equal(fresh.session_policy, "per_task");
  const stamp = new Date().toISOString();
  const legacyId = crypto.randomUUID();
  store.db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, version, required_approvals, created_at, updated_at)
    VALUES (?, ?, 'Legacy', 'Migrated policy default.', 'planning', 1, 1, ?, ?)`).run(legacyId, project.id, stamp, stamp);
  assert.equal(store.getTask(legacyId).session_policy, "manual");
  assert.equal(store.updateTask(fresh.id, { sessionPolicy: "adaptive" }).session_policy_version, 2);
});

test("per-task policy recommends one fresh profiled session but not rotation between related assignments", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-session-flow-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "devteam-session-flow-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  const project = store.ensureProject("Sessions", root);
  const task = store.createTask({ projectId: project.id, title: "Task session", description: "Keep related work together." });
  const fresh = store.connectAgent({ name: "Fresh", provider: "fixture", runtimeProfile: profile, freshTaskId: task.id, sessionGeneration: 3 });
  assert.equal(store.sessionRotationRecommendation(fresh.id), null);
  const first = store.claimNextAssignment(fresh.id);
  await store.completeAssignment({ agentId: fresh.id, assignmentId: first.id, claimToken: first.claimToken, message: "Plan done." });
  store.createAssignment({ taskId: task.id, title: "Related work", description: "Small implementation.", role: "implementer" });
  assert.equal(store.sessionRotationRecommendation(fresh.id), null, "related assignments stay in the task session");

  const otherTask = store.createTask({ projectId: project.id, title: "Other", description: "Different context." });
  const reused = store.connectAgent({ name: "Reused", provider: "fixture", runtimeProfile: profile, freshTaskId: otherTask.id, sessionGeneration: 4 });
  store.joinTask(reused.id, task.id);
  const recommendation = store.sessionRotationRecommendation(reused.id);
  assert.equal(recommendation.status, "session_rotation_recommended");
  assert.equal(recommendation.taskId, task.id);
  assert.equal(store.continueCurrentSession({ agentId: reused.id, taskId: task.id }).continued, true);
  assert.equal(store.sessionRotationRecommendation(reused.id), null);
});

test("per-assignment policy honors a fresh session or one explicit continuation, then rotates again", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-per-assignment-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "devteam-per-assignment-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  const project = store.ensureProject("Sessions", root);
  const task = store.createTask({ projectId: project.id, title: "Assignment sessions", description: "Rotate at assignment boundaries.", sessionPolicy: "per_assignment" });
  const agent = store.connectAgent({ name: "Fresh", provider: "fixture", runtimeProfile: profile, freshTaskId: task.id });
  assert.equal(store.sessionRotationRecommendation(agent.id), null, "the task-specific fresh session can claim its first assignment");
  const first = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: first.id, claimToken: first.claimToken, message: "First assignment done." });
  store.createAssignment({ taskId: task.id, title: "Second", description: "Second assignment.", role: "implementer" });
  assert.equal(store.sessionRotationRecommendation(agent.id).status, "session_rotation_recommended");
  store.continueCurrentSession({ agentId: agent.id, taskId: task.id });
  assert.equal(store.sessionRotationRecommendation(agent.id), null, "the explicit continuation is honored once");
  const second = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: second.id, claimToken: second.claimToken, message: "Second assignment done." });
  store.createAssignment({ taskId: task.id, title: "Third", description: "Third assignment.", role: "implementer" });
  assert.equal(store.sessionRotationRecommendation(agent.id).status, "session_rotation_recommended", "the next boundary recommends rotation again");
});
