import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

// What an agent can be run as, in that agent's own words, ordered weakest to strongest.
//
// DevTeam scores every assignment into a class — `balanced`/`frontier`, `medium`…`maximum` — and has
// always known that a given piece of work needs a frontier model at high effort. What it never knew
// was what *your* models are called, so it could not say "this needs Opus 5" and could not tell
// whether the session in front of it was strong enough. The old answer was a dialog asking the human
// to hand-build a catalogue: provider ids, switch modes, a model/effort matrix. Nobody filled it in,
// which is why 27 assignments scored difficult-or-worse and not one produced a word of advice.
//
// So the ladder is reported by the agent instead, because the agent is the only party that actually
// knows, and it is cached here so a second session does not have to be asked again. It goes stale on
// purpose: models change, and a list written once in March is wrong by June.
//
// The one thing DevTeam will not do is rank across providers. Whether Opus outranks some other
// vendor's flagship is not a question this file can answer honestly, so a ladder belongs to one
// provider and is only ever compared with itself.
export const MODELS_CONFIG_PATH = path.join(".devteam", "models.json");

// A week. Long enough that agents are not re-interrogated every session, short enough that a new
// model release shows up without anyone remembering to do anything.
export const LADDER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const clean = (value, max = 80) => String(value ?? "").trim().replace(/\s+/gu, " ").slice(0, max);

// Ordered weakest to strongest, deduplicated, and capped: a ladder is a handful of rungs, and an
// agent that reports forty of them has misunderstood the question.
export function normalizeLadder(raw) {
  if (!Array.isArray(raw)) return [];
  const rungs = [];
  const seen = new Set();
  for (const entry of raw) {
    const model = clean(entry?.model);
    const effort = clean(entry?.effort, 40);
    if (!model) continue;
    const key = `${model.toLowerCase()}|${effort.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rungs.push({ model, effort: effort || null });
    if (rungs.length >= 12) break;
  }
  return rungs;
}

// Which rung a piece of work needs. The assessment's level is DevTeam's own ordered vocabulary, so
// the mapping is proportional rather than a table of names: ordinary work wants the bottom rung, the
// hardest work wants the top, and everything between is spread across whatever rungs exist. A
// two-rung ladder and a five-rung ladder both work, and neither needs DevTeam to know any model.
export const LEVEL_ORDER = ["base", "difficult", "critical", "recovery", "exceptional"];

export function requiredRung(level, ladderLength) {
  if (!ladderLength) return 0;
  const index = LEVEL_ORDER.indexOf(String(level || "base"));
  if (index <= 0) return 0;
  const share = index / (LEVEL_ORDER.length - 1);
  return Math.min(ladderLength - 1, Math.round(share * (ladderLength - 1)));
}

// Where the agent currently sits on its own ladder. An unrecognised current model is -1, which reads
// as "cannot judge" everywhere it is used — never as "too weak".
export function currentRung(ladder, model, effort) {
  const wantedModel = clean(model).toLowerCase();
  const wantedEffort = clean(effort, 40).toLowerCase();
  if (!wantedModel) return -1;
  const exact = ladder.findIndex((rung) => rung.model.toLowerCase() === wantedModel
    && (rung.effort || "").toLowerCase() === wantedEffort);
  if (exact >= 0) return exact;
  // Same model, effort we were not told about: take its lowest rung rather than assuming the best.
  return ladder.findIndex((rung) => rung.model.toLowerCase() === wantedModel);
}

export const rungLabel = (rung) => (rung ? `${rung.model}${rung.effort ? ` · ${rung.effort}` : ""}` : null);

export function loadLadders(projectRoot) {
  const file = path.join(projectRoot, MODELS_CONFIG_PATH);
  let stat;
  try { stat = statSync(file); } catch { return { providers: {}, source: "none", file }; }
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { return { providers: {}, source: "invalid", file, error: `Could not parse ${MODELS_CONFIG_PATH}: ${error.message}` }; }
  // Ownership set at the top of the file covers everything in it. Writing `"source": "human"` once
  // and finding half the entries still rewritten would make the setting worthless.
  const fileOwnedByHuman = parsed?.source === "human";
  const providers = {};
  for (const [provider, entry] of Object.entries(parsed?.providers || {})) {
    const ladder = normalizeLadder(entry?.ladder);
    if (!ladder.length) continue;
    providers[clean(provider, 120)] = {
      ladder,
      reportedBy: clean(entry?.reportedBy, 120) || null,
      reportedAt: clean(entry?.reportedAt, 40) || null,
      source: fileOwnedByHuman || entry?.source === "human" ? "human" : "agent",
    };
  }
  return { providers, source: parsed?.source === "human" ? "human" : "agent", file };
}

// Cache a freshly reported ladder. A file the human has taken ownership of is never overwritten —
// the whole point of writing it down is that you can correct it, and a correction that survives
// until the next agent connects is not a correction.
export function saveLadder(projectRoot, provider, { ladder, reportedBy }) {
  const rungs = normalizeLadder(ladder);
  if (!rungs.length) return { written: false, reason: "empty" };
  const existing = loadLadders(projectRoot);
  if (existing.source === "human" || existing.providers[provider]?.source === "human") {
    return { written: false, reason: "human-owned" };
  }
  const providers = Object.fromEntries(Object.entries(existing.providers).map(([name, entry]) => [name, {
    ladder: entry.ladder, reportedBy: entry.reportedBy, reportedAt: entry.reportedAt, source: entry.source,
  }]));
  providers[provider] = { ladder: rungs, reportedBy: reportedBy || null, reportedAt: new Date().toISOString(), source: "agent" };
  const file = path.join(projectRoot, MODELS_CONFIG_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({
    note: "What each agent reports it can be run as, weakest first. Refreshed weekly from whoever connects. Set \"source\": \"human\" at the top level to take ownership and stop DevTeam rewriting it.",
    agentAsserted: true,
    providers,
  }, null, 2)}\n`, "utf8");
  return { written: true, rungs: rungs.length };
}

// Whether this provider's ladder is missing or old enough to ask about again.
export function ladderIsStale(entry, now = Date.now()) {
  if (!entry?.ladder?.length) return true;
  if (entry.source === "human") return false;
  const at = Date.parse(entry.reportedAt || "");
  if (!Number.isFinite(at)) return true;
  return now - at > LADDER_MAX_AGE_MS;
}
