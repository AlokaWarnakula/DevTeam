import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import {
  assessAssignment,
  GenericManualRuntimeAdapter,
  normalizeRuntimeProfile,
  resolveRuntimeRequirement,
} from "../src/devteam/runtime/index.mjs";

const balancedProfile = (overrides = {}) => ({
  providerId: "fixture-provider",
  currentModel: "fixture-balanced",
  currentEffort: "fixture-medium",
  availableModels: [
    { id: "fixture-balanced", label: "Fixture balanced", class: "balanced", efforts: [
      { id: "fixture-medium", class: "medium" }, { id: "fixture-high", class: "high" },
    ] },
    { id: "fixture-frontier", label: "Fixture frontier", class: "frontier", efforts: [
      { id: "fixture-high", class: "high" }, { id: "fixture-extra", class: "extra_high" }, { id: "fixture-max", class: "maximum" },
    ] },
  ],
  switchMode: "user_required",
  source: "host",
  observedAt: new Date().toISOString(),
  ...overrides,
});

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

test("generic manual adapter normalizes only supplied capabilities and never creates launch arguments", () => {
  const adapter = new GenericManualRuntimeAdapter(balancedProfile());
  const profile = adapter.normalizeCapabilities(adapter.probe());
  assert.equal(profile.availableModels.length, 2);
  assert.equal(profile.currentModelClass, "balanced");
  assert.equal(adapter.buildLaunchArgs({ modelId: "anything" }), null);
  const result = adapter.resolveProfile({ modelClass: "frontier", effortClass: "high" }, profile);
  assert.equal(result.satisfied, false);
  assert.equal(result.recommendation.modelId, "fixture-frontier");
  assert.equal(adapter.verifyCurrent({ modelId: "fixture-balanced", effortId: "fixture-medium" }), true);
});

test("runtime recommendations choose the least sufficient advertised effort regardless of host ordering", () => {
  const profile = normalizeRuntimeProfile(balancedProfile({
    currentModel: "fixture-frontier",
    currentEffort: "fixture-medium",
    availableModels: [{ id: "fixture-frontier", class: "frontier", efforts: [
      { id: "fixture-max", class: "maximum" },
      { id: "fixture-high", class: "high" },
      { id: "fixture-extra", class: "extra_high" },
      { id: "fixture-medium", class: "medium" },
    ] }],
  }));
  const result = resolveRuntimeRequirement({ modelClass: "frontier", effortClass: "high" }, profile);
  assert.equal(result.recommendation.effortId, "fixture-high");
});

test("runtime profiles persist per session with source trust and TTL behavior", async (t) => {
  const { store } = await fixture(t);
  const agent = store.connectAgent({ name: "Profiled", provider: "fixture", runtimeProfile: balancedProfile() });
  assert.equal(store.runtimeProfile(agent.id).source, "host");
  assert.throws(() => store.updateRuntimeProfile({
    agentId: agent.id,
    profile: balancedProfile({ source: "agent_estimate", currentModel: "guess" }),
  }), /outranks/);
  assert.throws(() => store.updateRuntimeProfile({
    agentId: agent.id,
    profile: balancedProfile({ source: "user", currentModelClass: "frontier", currentEffortClass: "maximum" }),
  }), /outranks/, "a lower-trust source cannot replace fresh host facts while retaining the same ids");
  const legacyInconsistent = { ...store.runtimeProfile(agent.id), currentModelClass: "frontier" };
  delete legacyInconsistent.validationIssues;
  delete legacyInconsistent.stale;
  store.db.prepare("UPDATE agent_runtime_profiles SET profile = ? WHERE agent_id = ?").run(JSON.stringify(legacyInconsistent), agent.id);
  assert.ok(store.runtimeProfile(agent.id).validationIssues.includes("current_model_class_mismatch"), "persisted pre-fix profiles are revalidated on read");
  const expired = store.updateRuntimeProfile({
    agentId: agent.id,
    force: true,
    profile: balancedProfile({ observedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:01:00.000Z" }),
  });
  assert.equal(expired.expiresAt, "2020-01-01T00:01:00.000Z");
  assert.equal(store.runtimeProfile(agent.id).stale, true);
  const other = store.connectAgent({ name: "Other", provider: "fixture" });
  assert.equal(store.runtimeProfile(other.id), null);
});

test("the runtime gate returns before lease acquisition and continue/switch/reassign decisions unblock deterministically", async (t) => {
  const { store, task } = await fixture(t);
  const planner = store.connectAgent({ name: "Planner", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const work = store.createAssignment({
    taskId: task.id,
    title: "Audit access",
    description: "Implement authentication permission checks with a database schema migration.",
    role: "implementer",
    requiresWrite: true,
    paths: ["src/auth.mjs"],
  });
  const agent = store.connectAgent({ name: "Runtime agent", provider: "fixture", runtimeProfile: balancedProfile(), freshTaskId: task.id });
  const gate = store.claimNextAssignment(agent.id);
  assert.equal(gate.status, "runtime_action_required");
  assert.equal(gate.leaseAcquired, false);
  assert.equal(gate.assessment.level, "critical");
  assert.equal(store.db.prepare("SELECT status, agent_id FROM assignments WHERE id = ?").get(work.id).status, "queued");
  store.runtimeDecision({ agentId: agent.id, assignmentId: work.id, assessmentId: gate.assessment.id, choice: "continue", reason: "Human prioritizes continuity." });
  const continuedClaim = store.claimNextAssignment(agent.id);
  assert.equal(continuedClaim.id, work.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: work.id, claimToken: continuedClaim.claimToken, message: "Finished first critical fixture." });

  const switchedWork = store.createAssignment({ taskId: task.id, title: "Protect credentials", description: "Implement authentication and schema migration safety.", role: "implementer" });
  const gateAgain = store.claimNextAssignment(agent.id);
  assert.equal(gateAgain.status, "runtime_action_required");
  store.updateRuntimeProfile({ agentId: agent.id, profile: balancedProfile({ currentModel: "fixture-frontier", currentEffort: "fixture-high" }) });
  store.runtimeDecision({ agentId: agent.id, assignmentId: switchedWork.id, assessmentId: gateAgain.assessment.id, choice: "switched" });
  const switchedClaim = store.claimNextAssignment(agent.id);
  assert.equal(switchedClaim.id, switchedWork.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: switchedWork.id, claimToken: switchedClaim.claimToken, message: "Finished switched fixture." });

  const reassignedWork = store.createAssignment({ taskId: task.id, title: "Secure authorization", description: "Implement authentication and schema migration controls.", role: "implementer" });
  store.updateRuntimeProfile({ agentId: agent.id, profile: balancedProfile() });
  const reassignGate = store.claimNextAssignment(agent.id);
  store.runtimeDecision({ agentId: agent.id, assignmentId: reassignedWork.id, assessmentId: reassignGate.assessment.id, choice: "reassign" });
  assert.equal(store.claimNextAssignment(agent.id), null);
  const compatible = store.connectAgent({ name: "Compatible", provider: "fixture", runtimeProfile: balancedProfile({ currentModel: "fixture-frontier", currentEffort: "fixture-high" }), freshTaskId: task.id });
  assert.equal(store.claimNextAssignment(compatible.id).id, reassignedWork.id);
});

test("a gated queue head does not hide a later compatible assignment", async (t) => {
  const { store, task } = await fixture(t);
  const planner = store.connectAgent({ name: "Planner", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const gated = store.createAssignment({
    taskId: task.id,
    title: "Secure migration",
    description: "Implement authentication tokens and a database schema migration.",
    role: "implementer",
  });
  const compatible = store.createAssignment({
    taskId: task.id,
    title: "Clarify docs",
    description: "Edit one paragraph.",
    role: "implementer",
  });
  const agent = store.connectAgent({ name: "Balanced worker", provider: "fixture", runtimeProfile: balancedProfile(), freshTaskId: task.id });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim.id, compatible.id, "the scan continues past the first runtime gate");
  await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Docs done." });
  const remainingGate = store.claimNextAssignment(agent.id);
  assert.equal(remainingGate.assignment.id, gated.id);
  assert.equal(remainingGate.alreadyRecommended, false, "a scanned gate is surfaced only after compatible work is exhausted");
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

test("assignment and task evidence changes invalidate assessments; exceptional decisions require human approval", async (t) => {
  const { store, task } = await fixture(t);
  const assignment = store.db.prepare("SELECT * FROM assignments WHERE task_id = ?").get(task.id);
  const first = store.assignmentAssessment({ assignmentId: assignment.id });
  store.updateTask(task.id, { description: "Now includes database schema migration and rollback." });
  const second = store.assignmentAssessment({ assignmentId: assignment.id });
  assert.notEqual(second.id, first.id);
  assert.ok(store.db.prepare("SELECT invalidated_at FROM complexity_assessments WHERE id = ?").get(first.id).invalidated_at);
  const exceptional = store.setAssignmentComplexityOverride({ assignmentId: assignment.id, override: { level: "exceptional" } });
  const agent = store.connectAgent({ name: "Exceptional", provider: "fixture", runtimeProfile: balancedProfile({ currentModel: "fixture-frontier", currentEffort: "fixture-max" }), freshTaskId: task.id });
  assert.throws(() => store.runtimeDecision({ agentId: agent.id, assignmentId: assignment.id, assessmentId: exceptional.id, choice: "switched" }), /human approval/i);
  assert.equal(store.runtimeDecision({ agentId: agent.id, assignmentId: assignment.id, assessmentId: exceptional.id, choice: "switched", actor: "human", humanApproved: true }).humanApproved, true);
});

test("a prior switched decision does not bypass the gate after the advertised runtime is downgraded", async (t) => {
  const { store, task } = await fixture(t);
  const planner = store.connectAgent({ name: "Planner", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const work = store.createAssignment({
    taskId: task.id,
    title: "Protect credentials",
    description: "Implement authentication and schema migration safety.",
    role: "implementer",
  });
  const agent = store.connectAgent({ name: "Switch then downgrade", provider: "fixture", runtimeProfile: balancedProfile(), freshTaskId: task.id });
  const gate = store.claimNextAssignment(agent.id);
  store.updateRuntimeProfile({ agentId: agent.id, profile: balancedProfile({ currentModel: "fixture-frontier", currentEffort: "fixture-high" }) });
  store.runtimeDecision({ agentId: agent.id, assignmentId: work.id, assessmentId: gate.assessment.id, choice: "switched" });
  store.updateRuntimeProfile({ agentId: agent.id, profile: balancedProfile() });
  const gatedAgain = store.claimNextAssignment(agent.id);
  assert.equal(gatedAgain.status, "runtime_action_required");
  assert.equal(gatedAgain.leaseAcquired, false);
});

test("runtime schema and decisions survive a restart without manufacturing disconnected profiles", async (t) => {
  const { store, dataDir, task } = await fixture(t);
  const agent = store.connectAgent({ name: "Restart", provider: "fixture", runtimeProfile: balancedProfile(), freshTaskId: task.id });
  const assignment = store.db.prepare("SELECT id FROM assignments LIMIT 1").get();
  const assessment = store.assignmentAssessment({ assignmentId: assignment.id });
  store.runtimeDecision({ agentId: agent.id, assignmentId: assignment.id, assessmentId: assessment.id, choice: "continue" });
  store.close();
  const reopened = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  assert.equal(reopened.runtimeProfile(agent.id).providerId, "fixture-provider");
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM runtime_decisions").get().count, 1);
  const legacy = reopened.connectAgent({ name: "Legacy", provider: "fixture" });
  assert.equal(reopened.runtimeProfile(legacy.id), null);
  reopened.close();
});

test("malformed or unclassified advertised data is never silently treated as sufficient", () => {
  assert.throws(() => normalizeRuntimeProfile({}), /source/);
  const profile = normalizeRuntimeProfile({
    providerId: "unknown-host", currentModel: "mystery", currentEffort: "opaque",
    availableModels: [{ id: "mystery", class: "unknown", efforts: ["opaque"] }],
    switchMode: "unknown", source: "host",
  });
  const result = resolveRuntimeRequirement({ modelClass: "balanced", effortClass: "medium" }, profile);
  assert.equal(result.satisfied, false);
  assert.equal(result.confirmationRequired, true);

  const inconsistent = normalizeRuntimeProfile({
    providerId: "inconsistent-host", currentModel: "balanced", currentEffort: "medium",
    currentModelClass: "frontier", currentEffortClass: "maximum",
    availableModels: [{ id: "balanced", class: "balanced", efforts: [{ id: "medium", class: "medium" }] }],
    switchMode: "user_required", source: "host",
  });
  const inconsistentResult = resolveRuntimeRequirement({ modelClass: "balanced", effortClass: "medium" }, inconsistent);
  assert.deepEqual(inconsistent.validationIssues.sort(), ["current_effort_class_mismatch", "current_model_class_mismatch"]);
  assert.equal(inconsistentResult.satisfied, false);
  assert.equal(inconsistentResult.confirmationRequired, true);
});

// Shared setup for the base-profile gate: an unprofiled session, a completed plan, and one
// assignment whose own text is genuinely security/migration scoped.
async function baseProfileFixture(t, baseRuntimeProfile) {
  const context = await fixture(t);
  const { store, task } = context;
  store.updateTask(task.id, { baseRuntimeProfile });
  const agent = store.connectAgent({ name: "Unprofiled", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const demanding = store.createAssignment({
    taskId: task.id,
    title: "Rotate credentials",
    description: "Implement authentication token rotation and a database schema migration.",
    role: "implementer",
  });
  return { ...context, agent, demanding };
}

test("a task base runtime profile gates a session that advertises nothing, and never outranks a live profile", async (t) => {
  const { store, task, agent, demanding } = await baseProfileFixture(t, balancedProfile({ source: "user" }));
  const gate = store.claimNextAssignment(agent.id);
  assert.equal(gate.runtimeActionRequired, true, "the base profile makes the gate active for a session that advertises nothing");
  assert.equal(gate.assignment.id, demanding.id);
  assert.equal(gate.profileSource, "task_base");
  assert.equal(gate.runtimeProfile.source, "user", "a stored base profile is always read back as a user claim");
  assert.equal(gate.leaseAcquired, false);
  // A session that advertises a sufficient runtime of its own is never overridden by the note.
  const profiled = store.connectAgent({
    name: "Profiled",
    provider: "fixture",
    runtimeProfile: balancedProfile({ currentModel: "fixture-frontier", currentEffort: "fixture-high" }),
    freshTaskId: task.id,
  });
  const claim = store.claimNextAssignment(profiled.id);
  assert.equal(claim.id, demanding.id, "a sufficient live profile satisfies the requirement");
  assert.equal(typeof claim.claimToken, "string");
});

test("a stored base profile cannot impersonate a host observation to outrank a live session profile", async (t) => {
  const { store, agent } = await baseProfileFixture(t, balancedProfile({ source: "host" }));
  const gate = store.claimNextAssignment(agent.id);
  assert.equal(gate.runtimeProfile.source, "user", "the stored source is ignored in favour of a user claim");
  assert.equal(gate.runtimeProfile.confidence < 1, true, "a stored note can never carry host confidence");
});

test("an aged-out base profile returns legacy behavior instead of stalling every claim", async (t) => {
  const { store, agent, demanding } = await baseProfileFixture(t, balancedProfile({
    source: "user",
    observedAt: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  }));
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim.id, demanding.id, "a stale standing note falls back to legacy claiming rather than blocking work");
});

test("a malformed base runtime profile is refused on write and never gates work", async (t) => {
  const { store, task } = await fixture(t);
  assert.throws(
    () => store.updateTask(task.id, { baseRuntimeProfile: { providerId: "", availableModels: [] } }),
    /providerId is required/,
  );
  assert.throws(() => store.updateTask(task.id, { baseRuntimeProfile: ["not", "an", "object"] }), /must be an object or null/);
  // The shorter {modelClass, effortClass} hint the session-handoff capsule reads stays accepted,
  // and is simply not usable for gating.
  const { store: hintStore, agent, demanding } = await baseProfileFixture(t, { modelClass: "balanced", effortClass: "medium" });
  const claim = hintStore.claimNextAssignment(agent.id);
  assert.equal(claim.id, demanding.id, "an unusable hint leaves the legacy bypass in place");
});

test("a satisfied resolution reports advertised display names, and never invents one", () => {
  const profile = normalizeRuntimeProfile(balancedProfile());
  const satisfied = resolveRuntimeRequirement({ modelClass: "balanced", effortClass: "medium" }, profile);
  assert.equal(satisfied.satisfied, true);
  assert.equal(satisfied.current.modelLabel, "Fixture balanced", "the advertised model name is available to the UI");
  assert.equal(satisfied.current.effortLabel, "fixture-medium");
  assert.equal(satisfied.current.modelClass, "balanced", "the capability class remains the underlying rule");
  assert.equal(satisfied.recommendation.modelLabel, "Fixture balanced");
  // A current model the profile does not advertise must not acquire a borrowed name. Such a profile
  // is also not usable, so the caller is told to confirm rather than shown a guess.
  const unadvertised = normalizeRuntimeProfile({ ...balancedProfile(), availableModels: [] });
  const unresolved = resolveRuntimeRequirement({ modelClass: "balanced", effortClass: "medium" }, unadvertised);
  assert.equal(unresolved.satisfied, false);
  assert.equal(unresolved.current, null);
  assert.equal(unresolved.confirmationRequired, true);
});
