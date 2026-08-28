import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { assessAssignment } from "../src/devteam/runtime/index.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-runtime-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-runtime-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* restart tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Runtime project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Runtime gates", description: "Assess work before claiming it." });
  return { store, dataDir, projectRoot, project, task };
}

test("provider-neutral complexity policy is deterministic, explainable, and contains no provider catalog", () => {
  const simple = assessAssignment({ title: "Edit docs", description: "Clarify one paragraph.", role: "implementer", paths: ["README.md"] });
  assert.equal(simple.level, "base");
  assert.deepEqual(simple, assessAssignment({ title: "Edit docs", description: "Clarify one paragraph.", role: "implementer", paths: ["README.md"] }));
  const critical = assessAssignment({
    title: "Review access flow", description: "Review authentication tokens and permission checks.", role: "security-reviewer", paths: ["src/auth.mjs"],
  });
  assert.equal(critical.level, "critical");
  assert.ok(critical.score >= 8);
  assert.ok(critical.reasons.every((reason) => reason.code && reason.detail));
  assert.deepEqual(critical.requirements, { modelClass: "frontier", effortClass: "high", humanApprovalRequired: false });
  assert.doesNotMatch(JSON.stringify({ simple, critical }), /codex|claude|gpt|sonnet|opus/i);
  const recovery = assessAssignment({ title: "Recover failure", description: "Resolve a distributed lease recovery failure.", role: "implementer", priorFailures: 4 });
  assert.equal(recovery.level, "recovery");
});

test("task context is capped while assignment text, checklist, and paths retain full weight", () => {
  const contextual = assessAssignment({
    title: "Edit docs",
    description: "Clarify one paragraph.",
    role: "implementer",
    paths: ["README.md"],
    taskTitle: "Platform recovery",
    taskDescription: "Authentication token database schema migration, distributed lease recovery, and architecture-wide changes.",
  });
  assert.equal(contextual.score, 2, "risk words in the parent task contribute at most two points");
  assert.equal(contextual.level, "base");
  assert.equal(contextual.reasons.filter((reason) => reason.source === "task").reduce((sum, reason) => sum + reason.points, 0), 2);

  const assignmentScoped = assessAssignment({
    title: "Edit docs",
    description: "Clarify one paragraph.",
    role: "implementer",
    checklist: ["Verify authentication token and migration safety."],
    paths: ["src/lease/recovery.mjs"],
  });
  assert.ok(assignmentScoped.score >= 14, "assignment checklist and paths remain full-weight evidence");
  assert.ok(assignmentScoped.reasons.every((reason) => ["assignment", "task"].includes(reason.source)));
  assert.ok(assignmentScoped.reasons.filter((reason) => ["security_scope", "migration_risk", "concurrency_recovery"].includes(reason.code)).every((reason) => reason.source === "assignment"));
});

test("prior failure scoring matches only the same assignment at the current task version", async (t) => {
  const { store, task } = await fixture(t);
  const assignment = store.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(task.id);
  const insert = store.db.prepare(`
    INSERT INTO events (task_id, agent_id, type, message, metadata, created_at)
    VALUES (?, NULL, 'assignment.blocked', ?, ?, ?)
  `);
  const stamp = new Date().toISOString();
  insert.run(task.id, `Unrelated report mentioning ${assignment.title}`, JSON.stringify({ assignmentId: "another-assignment", version: task.version }), stamp);
  insert.run(task.id, "Old-version failure.", JSON.stringify({ assignmentId: assignment.id, version: task.version - 1 }), stamp);
  insert.run(task.id, "Current-version failure.", JSON.stringify({ assignmentId: assignment.id, version: task.version }), stamp);

  const assessment = store.assignmentAssessment({ assignmentId: assignment.id, refresh: true });
  const failureReason = assessment.reasons.find((reason) => reason.code === "prior_failures");
  assert.equal(failureReason.points, 3, "only one exact current-version failure is counted");
  assert.match(failureReason.detail, /^1 prior/);
});

test("assignment and task evidence changes invalidate an assessment", async (t) => {
  const { store, task } = await fixture(t);
  const assignment = store.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(task.id);
  const first = store.assignmentAssessment({ assignmentId: assignment.id });
  store.updateTask(task.id, { description: "Now includes database schema migration and rollback." });
  const second = store.assignmentAssessment({ assignmentId: assignment.id });
  assert.notEqual(second.id, first.id);
  assert.ok(store.db.prepare("SELECT invalidated_at FROM complexity_assessments WHERE id = ?").get(first.id).invalidated_at);
});
