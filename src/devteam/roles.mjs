import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Roles used to be a fixed list of software job titles, and the checklist attached to each was
// written for web software — a research, legal, analysis or writing task got asked about session
// fixation and httponly cookies. A project now declares its own roles in `.devteam/roles.json`.
//
// The important separation, and the reason this file exists rather than a bigger enum somewhere:
//
//   * A role NAME is domain vocabulary. `fact-checker`, `domain-expert`, `copy-editor`,
//     `structural-engineer` — DevTeam has no opinion about these and never should.
//   * A role BEHAVIOUR is scheduling semantics. There are exactly two, they are the only things the
//     scheduler understands, and adding a third is a real design decision rather than a config edit:
//       - `verifies`: this role reads the work rather than changing it, so it waits for pending
//         writers, its completion is what earns the right to approve or to request changes, and its
//         presence alone means the task is in review.
//       - `plans`: this role decides what the team does next, so an open one means the task is still
//         being planned, and it is what DevTeam seeds a new or resumed task with.
//
// A project maps its own vocabulary onto those two. `fact-checker` sets `verifies: true` and the
// review gate treats it exactly as `reviewer`, with no scheduler change and no new role name baked
// into any SQL.
//
// JSON rather than YAML deliberately: DevTeam has three runtime dependencies and a YAML parser would
// be a fourth, bought for one config file that is read once per project.

export const ROLES_CONFIG_PATH = path.join(".devteam", "roles.json");

// The software defaults, unchanged from when they were hardcoded, so an existing project that never
// writes a config file behaves exactly as it did before. These are also what `devteam roles --init`
// writes out, as a starting point to edit rather than a set of names to keep.
export const DEFAULT_ROLES = {
  planner: {
    plans: true,
    description: "Decides what the team does next and creates the assignments.",
    checklist: [],
  },
  implementer: {
    writes: true,
    description: "Produces the work product.",
    checklist: [],
  },
  researcher: {
    description: "Gathers and reports information the team needs before deciding.",
    checklist: [],
  },
  reviewer: {
    verifies: true,
    description: "Reads someone else's finished work and judges whether it is correct.",
    checklist: [
      "Correctness: does it do what the task asked?",
      "Edge cases and boundary conditions handled",
      "Error and failure paths are handled, not swallowed",
      "No dead code, debug logs, or leftover TODOs",
      "Readable and consistent with the surrounding code",
      "Tests cover the change and actually run",
    ],
  },
  "security-reviewer": {
    verifies: true,
    description: "Reviews the work specifically for security problems.",
    checklist: [
      "Authentication: no broken/missing auth on protected paths",
      "Session handling: fixation, regeneration, secure/httponly cookies",
      "Authorization: object-level and function-level access checks",
      "Input validation and injection (SQL/command/template/XSS)",
      "Secrets: none logged, committed, or returned in responses",
      "Rate limiting / abuse protection on sensitive endpoints",
      "Error handling does not leak stack traces or internals",
      "Dependencies: no known-vulnerable or unpinned additions",
    ],
  },
  tester: {
    verifies: true,
    description: "Exercises the work and reports what actually happened.",
    checklist: [
      "Happy path verified end to end",
      "Edge cases and invalid input covered",
      "Failure modes and error states exercised",
      "Regression: existing behaviour still passes",
      "Checks are reproducible and named in the report",
    ],
  },
};

export const ROLE_NAME_LIMIT = 40;
export const ROLE_COUNT_LIMIT = 30;
export const CHECKLIST_ITEM_LIMIT = 40;

// A role name has to survive being shown in a timeline, matched case-insensitively, and stored in a
// column the scheduler groups by. Anything else is refused on read rather than sanitized into
// something the project did not write.
const ROLE_NAME_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,39}$/;

export function normalizeRoleName(name) {
  const clean = String(name ?? "").trim().toLowerCase();
  return ROLE_NAME_PATTERN.test(clean) ? clean : null;
}

// Turn whatever is in the file into the shape the store relies on. Unknown keys are dropped rather
// than carried, so a typo in the config can never reach the scheduler as a truthy behaviour flag.
export function normalizeRoles(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw.roles ?? raw) : null;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Role config must be an object of role definitions, or { roles: { … } }.");
  }
  const entries = Object.entries(source).slice(0, ROLE_COUNT_LIMIT);
  const roles = {};
  for (const [rawName, rawDefinition] of entries) {
    const name = normalizeRoleName(rawName);
    if (!name) throw new Error(`"${rawName}" is not a usable role name. Use lowercase letters, digits, spaces, - or _, up to ${ROLE_NAME_LIMIT} characters.`);
    const definition = rawDefinition && typeof rawDefinition === "object" && !Array.isArray(rawDefinition) ? rawDefinition : {};
    const checklist = Array.isArray(definition.checklist)
      ? definition.checklist.map((item) => String(item).trim()).filter(Boolean).slice(0, CHECKLIST_ITEM_LIMIT)
      : [];
    roles[name] = {
      verifies: Boolean(definition.verifies),
      plans: Boolean(definition.plans),
      writes: Boolean(definition.writes),
      description: String(definition.description ?? "").trim().slice(0, 300),
      checklist,
    };
  }
  if (!Object.keys(roles).length) throw new Error("Role config defines no roles.");
  // A project with nothing that verifies can never earn an approval, and one with nothing that plans
  // gets a seeded assignment in a role it did not declare. Both are silent dead ends later, so they
  // are refused here where the person editing the file can still see why.
  if (!Object.values(roles).some((role) => role.verifies)) {
    throw new Error("At least one role must set \"verifies\": true — otherwise no work in this project can ever be reviewed or approved.");
  }
  if (!Object.values(roles).some((role) => role.plans)) {
    throw new Error("At least one role must set \"plans\": true — otherwise DevTeam has no role to open a new task with.");
  }
  return roles;
}

// Read a project's roles, or fall back to the software defaults. Never throws for a missing file:
// having no config is the normal case. A *malformed* file does surface, because silently falling
// back would run the project under roles nobody chose.
export function loadProjectRoles(projectRoot) {
  const file = path.join(projectRoot, ROLES_CONFIG_PATH);
  let stat;
  try { stat = statSync(file); } catch { return { roles: DEFAULT_ROLES, source: "default", file, mtimeMs: 0 }; }
  if (!stat.isFile()) return { roles: DEFAULT_ROLES, source: "default", file, mtimeMs: 0 };
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { return { roles: DEFAULT_ROLES, source: "invalid", file, mtimeMs: stat.mtimeMs, error: `Could not parse ${ROLES_CONFIG_PATH}: ${error.message}` }; }
  try { return { roles: normalizeRoles(parsed), source: "project", file, mtimeMs: stat.mtimeMs }; }
  catch (error) { return { roles: DEFAULT_ROLES, source: "invalid", file, mtimeMs: stat.mtimeMs, error: `${ROLES_CONFIG_PATH}: ${error.message}` }; }
}

// The behaviour of one role, for a role set. An unknown role name is not an error — a planner may
// invent a label mid-task — but it gets no behaviour: it writes nothing the scheduler keys off, so
// unknown work is ordinary work rather than accidentally counting as a review.
export function roleBehaviour(roles, name) {
  const key = normalizeRoleName(name);
  const definition = (key && roles[key]) || null;
  return {
    name: key || String(name ?? "").trim().toLowerCase().slice(0, ROLE_NAME_LIMIT),
    known: Boolean(definition),
    verifies: Boolean(definition?.verifies),
    plans: Boolean(definition?.plans),
    writes: Boolean(definition?.writes),
    checklist: definition?.checklist ?? [],
  };
}

// The role a new or resumed task's opening assignment is created in: whatever this project calls the
// role that plans. Falls back to "planner" so a project whose config omits one still works.
export function planningRole(roles) {
  const found = Object.entries(roles).find(([, definition]) => definition.plans);
  return found ? found[0] : "planner";
}
