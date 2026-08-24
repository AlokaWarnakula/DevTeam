import { createHash } from "node:crypto";

export const RUNTIME_SCHEMA_VERSION = 1;
export const COMPLEXITY_POLICY_VERSION = 1;

export const MODEL_CLASSES = ["economy", "balanced", "strong", "frontier", "specialized", "unknown"];
export const EFFORT_CLASSES = ["light", "medium", "high", "extra_high", "maximum", "unknown"];
export const SWITCH_MODES = ["automatic", "user_required", "unsupported", "unknown"];
export const RUNTIME_SOURCES = ["host", "adapter", "user", "agent_estimate"];

const MODEL_RANK = new Map([["unknown", -1], ["economy", 0], ["balanced", 1], ["strong", 2], ["frontier", 3]]);
const EFFORT_RANK = new Map([["unknown", -1], ["light", 0], ["medium", 1], ["high", 2], ["extra_high", 3], ["maximum", 4]]);
const SOURCE_CONFIDENCE = { host: 1, adapter: 0.85, user: 0.7, agent_estimate: 0.25 };
const SOURCE_TTL_MS = {
  host: 6 * 60 * 60 * 1000,
  adapter: 2 * 60 * 60 * 1000,
  user: 24 * 60 * 60 * 1000,
  agent_estimate: 15 * 60 * 1000,
};

const clean = (value, max = 200) => String(value ?? "").trim().slice(0, max);
const oneOf = (value, values, fallback = "unknown") => values.includes(value) ? value : fallback;
const iso = (value, fallback = new Date().toISOString()) => {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
};

function normalizeEffort(value) {
  if (typeof value === "string") {
    const id = clean(value, 120);
    return { id, label: id, class: oneOf(id, EFFORT_CLASSES) };
  }
  const id = clean(value?.id, 120);
  if (!id) return null;
  return { id, label: clean(value.label || id, 160), class: oneOf(value.class, EFFORT_CLASSES) };
}

export function normalizeRuntimeProfile(input, { observedAt, ttlMs } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Runtime profile must be an object.");
  const source = oneOf(input.source, RUNTIME_SOURCES);
  if (source === "unknown") throw new Error("Runtime profile source must be host, adapter, user, or agent_estimate.");
  const providerId = clean(input.providerId, 120);
  if (!providerId) throw new Error("Runtime profile providerId is required.");
  const seenAt = iso(input.observedAt || observedAt);
  const models = (Array.isArray(input.availableModels) ? input.availableModels : []).slice(0, 100).map((model) => {
    const id = clean(model?.id, 160);
    if (!id) return null;
    const efforts = (Array.isArray(model.efforts) ? model.efforts : []).slice(0, 30).map(normalizeEffort).filter(Boolean);
    return {
      id,
      label: clean(model.label || id, 200),
      class: oneOf(model.class, MODEL_CLASSES),
      efforts,
    };
  }).filter(Boolean);
  const uniqueModels = [...new Map(models.map((model) => [model.id, model])).values()];
  const expiresAt = iso(input.expiresAt || new Date(Date.parse(seenAt) + Math.max(60_000, Number(ttlMs) || SOURCE_TTL_MS[source])).toISOString());
  const currentModel = clean(input.currentModel, 160) || null;
  const currentEffort = clean(input.currentEffort, 120) || null;
  const advertisedCurrentModel = uniqueModels.find((model) => model.id === currentModel);
  const advertisedCurrentEffort = advertisedCurrentModel?.efforts.find((effort) => effort.id === currentEffort);
  const suppliedModelClass = oneOf(input.currentModelClass, MODEL_CLASSES);
  const suppliedEffortClass = oneOf(input.currentEffortClass, EFFORT_CLASSES);
  const validationIssues = [];
  if (uniqueModels.length && currentModel && !advertisedCurrentModel) validationIssues.push("current_model_not_advertised");
  if (advertisedCurrentModel && currentEffort && !advertisedCurrentEffort) validationIssues.push("current_effort_not_advertised");
  if (advertisedCurrentModel && suppliedModelClass !== "unknown" && suppliedModelClass !== advertisedCurrentModel.class) {
    validationIssues.push("current_model_class_mismatch");
  }
  if (advertisedCurrentEffort && suppliedEffortClass !== "unknown" && suppliedEffortClass !== advertisedCurrentEffort.class) {
    validationIssues.push("current_effort_class_mismatch");
  }
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    providerId,
    currentModel,
    currentEffort,
    currentModelClass: advertisedCurrentModel?.class || suppliedModelClass,
    currentEffortClass: advertisedCurrentEffort?.class || suppliedEffortClass,
    availableModels: uniqueModels,
    switchMode: oneOf(input.switchMode, SWITCH_MODES),
    source,
    confidence: SOURCE_CONFIDENCE[source],
    observedAt: seenAt,
    expiresAt,
    validationIssues,
  };
}

export function runtimeProfileState(profile, at = Date.now()) {
  if (!profile) return { usable: false, stale: false, reason: "No runtime profile has been supplied for this agent session." };
  if (Date.parse(profile.expiresAt) <= at) return { usable: false, stale: true, reason: "The runtime profile expired and must be confirmed or refreshed." };
  if (profile.source === "agent_estimate") return { usable: false, stale: false, reason: "An agent-estimated runtime profile requires host, adapter, or user confirmation." };
  if (profile.validationIssues?.length) {
    return { usable: false, stale: false, reason: `The advertised runtime profile is internally inconsistent (${profile.validationIssues.join(", ")}).` };
  }
  if (!profile.currentModel || !profile.currentEffort || profile.currentModelClass === "unknown" || profile.currentEffortClass === "unknown") {
    return { usable: false, stale: false, reason: "The current model or effort is not authoritatively mapped to normalized capability classes." };
  }
  return { usable: true, stale: false, reason: null };
}

const contains = (text, expression) => expression.test(text);
const addReason = (state, points, code, detail) => {
  state.score += points;
  state.reasons.push({ code, points, detail });
};

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
  const text = `${evidence.title}\n${evidence.description}\n${evidence.taskTitle}\n${evidence.taskDescription}`.toLowerCase();
  const distinctRoots = new Set(evidence.paths.map((item) => item.replace(/\\/g, "/").split("/")[0])).size;
  if (evidence.paths.length >= 2) addReason(state, 1, "multi_path", `${evidence.paths.length} declared paths.`);
  if (evidence.paths.length >= 6 || distinctRoots >= 3) addReason(state, 2, "broad_scope", `Work spans ${evidence.paths.length} paths across ${distinctRoots} roots.`);
  if (["reviewer", "tester"].includes(evidence.role)) addReason(state, 1, "verification_role", `${evidence.role} work requires independent evidence.`);
  if (evidence.role === "security-reviewer") addReason(state, 5, "security_role", "Security review requires critical-risk capability.");
  if (contains(text, /\b(auth(?:entication|orization)?|permission|secret|cryptograph|credential|csrf|origin|token)\b/)) addReason(state, 5, "security_scope", "Authentication, authorization, secrets, or cryptography are in scope.");
  if (contains(text, /\b(database|schema|migration|rollback|destructive|data loss)\b/)) addReason(state, 5, "migration_risk", "Database/schema migration or destructive-data risk is in scope.");
  if (contains(text, /\b(concurren|distributed|atomic|lease|fencing|race condition|takeover|recovery)\b/)) addReason(state, 4, "concurrency_recovery", "Concurrency, distributed state, leases, or recovery behavior is in scope.");
  if (contains(text, /\b(architecture-wide|cross-project|cross project|system-wide|system wide)\b/)) addReason(state, 3, "architecture_breadth", "Cross-project or architecture-wide behavior is in scope.");
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
    state.reasons.push({ code: "human_override", points: 0, detail: `A human set the level to ${level}.` });
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

const modelSatisfies = (actual, required) => actual === "specialized" ? required === "specialized" : (MODEL_RANK.get(actual) ?? -1) >= (MODEL_RANK.get(required) ?? 99);
const effortSatisfies = (actual, required) => (EFFORT_RANK.get(actual) ?? -1) >= (EFFORT_RANK.get(required) ?? 99);

export function resolveRuntimeRequirement(requirement, profile) {
  const profileState = runtimeProfileState(profile);
  if (!profileState.usable) return { satisfied: false, confirmationRequired: true, reason: profileState.reason, current: null, recommendation: null };
  const current = {
    modelId: profile.currentModel,
    effortId: profile.currentEffort,
    modelClass: profile.currentModelClass,
    effortClass: profile.currentEffortClass,
  };
  const satisfied = modelSatisfies(current.modelClass, requirement.modelClass) && effortSatisfies(current.effortClass, requirement.effortClass);
  if (satisfied) return { satisfied: true, confirmationRequired: false, current, recommendation: current, reason: "Current normalized capabilities satisfy the assignment requirement." };
  let recommendation = null;
  for (const model of profile.availableModels) {
    if (!modelSatisfies(model.class, requirement.modelClass)) continue;
    for (const effort of model.efforts) {
      if (!effortSatisfies(effort.class, requirement.effortClass)) continue;
      const candidate = { modelId: model.id, modelLabel: model.label, modelClass: model.class, effortId: effort.id, effortLabel: effort.label, effortClass: effort.class };
      if (!recommendation || (MODEL_RANK.get(candidate.modelClass) < MODEL_RANK.get(recommendation.modelClass))
        || (candidate.modelClass === recommendation.modelClass && EFFORT_RANK.get(candidate.effortClass) < EFFORT_RANK.get(recommendation.effortClass))) recommendation = candidate;
    }
  }
  return {
    satisfied: false,
    confirmationRequired: !recommendation,
    current,
    recommendation,
    reason: recommendation
      ? "A stronger advertised runtime profile is recommended before claiming this assignment."
      : "No advertised model/effort combination is authoritatively known to satisfy this requirement.",
  };
}

export class GenericManualRuntimeAdapter {
  constructor(profile = null) { this.profile = profile; }
  probe() { return this.profile; }
  normalizeCapabilities(raw) { return normalizeRuntimeProfile({ ...raw, switchMode: raw?.switchMode || "user_required" }); }
  resolveProfile(requirement, capabilities) { return resolveRuntimeRequirement(requirement, capabilities); }
  buildLaunchArgs() { return null; }
  verifyCurrent(selection) {
    const profile = normalizeRuntimeProfile(this.profile);
    return profile.currentModel === selection?.modelId && profile.currentEffort === selection?.effortId;
  }
}
