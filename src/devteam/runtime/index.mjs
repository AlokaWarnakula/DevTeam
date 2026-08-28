import { createHash } from "node:crypto";

export const COMPLEXITY_POLICY_VERSION = 2;

const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const contains = (text, expression) => expression.test(text);
const addReason = (state, points, code, detail, source = "assignment") => {
  state.score += points;
  state.reasons.push({ code, points, detail, source });
};

const TEXT_SIGNALS = [
  [5, "security_scope", "Authentication, authorization, secrets, or cryptography are in scope.", /\b(auth(?:entication|orization)?|permission|secret|cryptograph|credential|csrf|origin|token)\b/],
  [5, "migration_risk", "Database/schema migration or destructive-data risk is in scope.", /\b(database|schema|migration|rollback|destructive|data loss)\b/],
  [4, "concurrency_recovery", "Concurrency, distributed state, leases, or recovery behavior is in scope.", /\b(concurren|distributed|atomic|lease|fencing|race condition|takeover|recovery)\b/],
  [3, "architecture_breadth", "Cross-project or architecture-wide behavior is in scope.", /\b(architecture-wide|cross-project|cross project|system-wide|system wide)\b/],
];

function scoreTextSignals(state, text, source, cap = Number.POSITIVE_INFINITY) {
  let awarded = 0;
  for (const [points, code, detail, expression] of TEXT_SIGNALS) {
    if (!contains(text, expression) || awarded >= cap) continue;
    const applied = Math.min(points, cap - awarded);
    addReason(state, applied, code, source === "task" ? `Task context: ${detail}` : detail, source);
    awarded += applied;
  }
}

export function assignmentEvidence(input) {
  const evidence = {
    title: clean(input.title, 500),
    description: clean(input.description, 4_000),
    role: clean(input.role, 120).toLowerCase(),
    requiresWrite: Boolean(input.requiresWrite ?? input.requires_write),
    paths: [...new Set((input.paths || input.writeScope || []).map((item) => clean(item, 400)).filter(Boolean))].sort(),
    checklist: (input.checklist || []).map((item) => clean(item, 500)).filter(Boolean),
    dependencyDepth: Math.max(0, Number(input.dependencyDepth) || 0),
    priorFailures: Math.max(0, Number(input.priorFailures) || 0),
    taskTitle: clean(input.taskTitle || input.task_title, 500),
    taskDescription: clean(input.taskDescription || input.task_description, 4_000),
    taskVersion: Math.max(1, Number(input.taskVersion || input.task_version) || 1),
    override: input.override || null,
  };
  return { evidence, hash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}

export function assessAssignment(input) {
  const { evidence, hash } = assignmentEvidence(input);
  const state = { score: 0, reasons: [] };
  const assignmentText = [evidence.title, evidence.description, evidence.role, ...evidence.checklist, ...evidence.paths].join("\n").toLowerCase();
  const taskText = `${evidence.taskTitle}\n${evidence.taskDescription}`.toLowerCase();
  const distinctRoots = new Set(evidence.paths.map((item) => item.replace(/\\/g, "/").split("/")[0])).size;
  if (evidence.paths.length >= 2) addReason(state, 1, "multi_path", `${evidence.paths.length} declared paths.`);
  if (evidence.paths.length >= 6 || distinctRoots >= 3) addReason(state, 2, "broad_scope", `Work spans ${evidence.paths.length} paths across ${distinctRoots} roots.`);
  if (["reviewer", "tester"].includes(evidence.role)) addReason(state, 1, "verification_role", `${evidence.role} work requires independent evidence.`);
  if (evidence.role === "security-reviewer") addReason(state, 5, "security_role", "Security review requires critical-risk capability.");
  scoreTextSignals(state, assignmentText, "assignment");
  // Task context still matters, but it must not promote every small assignment merely because the
  // parent task mentions several risky subsystems. Its total contribution is deliberately capped.
  scoreTextSignals(state, taskText, "task", 2);
  if (evidence.checklist.length >= 6) addReason(state, evidence.checklist.length >= 12 ? 2 : 1, "deep_checklist", `${evidence.checklist.length} verification points are required.`);
  if (evidence.dependencyDepth >= 2) addReason(state, Math.min(3, evidence.dependencyDepth - 1), "dependency_depth", `Dependency depth is ${evidence.dependencyDepth}.`);
  if (evidence.priorFailures > 0) addReason(state, Math.min(8, evidence.priorFailures * 3), "prior_failures", `${evidence.priorFailures} prior blocked or failed attempts were recorded.`);
  const overrideLevel = typeof evidence.override === "string" ? evidence.override : evidence.override?.level;
  const overrideScore = evidence.override && typeof evidence.override === "object" && evidence.override.score != null
    ? Number(evidence.override.score)
    : NaN;
  if (Number.isFinite(overrideScore)) addReason(state, Math.max(0, Math.floor(overrideScore) - state.score), "human_override", "A human complexity score override applies.");
  const score = Math.max(state.score, Number.isFinite(overrideScore) ? Math.floor(overrideScore) : 0);
  let level = score >= 16 ? "exceptional" : score >= 12 ? "recovery" : score >= 8 ? "critical" : score >= 4 ? "difficult" : "base";
  if (["base", "difficult", "critical", "recovery", "exceptional"].includes(overrideLevel)) {
    level = overrideLevel;
    state.reasons.push({ code: "human_override", points: 0, detail: `A human set the level to ${level}.`, source: "assignment" });
  }
  const requirements = {
    base: { modelClass: "balanced", effortClass: "medium", humanApprovalRequired: false },
    difficult: { modelClass: "balanced", effortClass: "high", humanApprovalRequired: false },
    critical: { modelClass: "frontier", effortClass: "high", humanApprovalRequired: false },
    recovery: { modelClass: "frontier", effortClass: "extra_high", humanApprovalRequired: false },
    exceptional: { modelClass: "frontier", effortClass: "maximum", humanApprovalRequired: true },
  }[level];
  return { policyVersion: COMPLEXITY_POLICY_VERSION, evidenceHash: hash, score, level, reasons: state.reasons, requirements };
}
