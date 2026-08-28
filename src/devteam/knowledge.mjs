import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const CATEGORIES = ["architecture", "decisions", "components", "conventions", "pitfalls", "workflows"];
// Which DevTeam project a vault on disk belongs to. Every generated note carries the same
// `generated_by: DevTeam` header, and the exporter deletes any such file its own database does not
// account for — so two databases pointed at one project root meant the second export silently
// deleted everything the first had written. The easy way to arrange that is not exotic: a test whose
// project root is `process.cwd()` is a second database pointed at the repository, and running the
// suite wiped this repository's own vault of 64 notes.
const VAULT_MARKER = ".devteam-vault";

// Who a vault on disk belongs to, or null for one nobody has claimed yet. Exported because CodeGraph
// writes into the same `knowledge/` tree and has to honour the same claim — it reconciles by
// deleting too, and its notes are named from a hash of the project id, so a foreign project does not
// merely add files, it renames all of them.
//
// An unreadable or hand-edited marker reads as unclaimed rather than as an error: this exists to
// prevent a deletion, and a broken marker must never turn into a failed export.
export function vaultOwner(vaultRoot) {
  const file = path.join(vaultRoot, VAULT_MARKER);
  if (!existsSync(file)) return null;
  try {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    return owner && typeof owner.projectId === "string" ? owner : null;
  } catch {
    return null;
  }
}
const MAX_NOTE_BODY = 24_000;
// `conventions/` had no automatic source: every generated note came from the event stream, which can
// only ever say what was *done*. A convention is different — it is something the project keeps
// having to be told, and the honest evidence for it is a reviewer saying the same thing on separate
// pieces of work.
//
// The source is `assignment_findings` — the structured findings attached to a request for changes —
// and deliberately NOT `agent.finding` events, which look like a bigger corpus (102 of them) but are
// free-form narrative: status reports, handoff checklists, arguments between agents. Clustering
// those produces confident nonsense, which is worse than an empty folder.
//
// The thresholds below are meant to under-fire. Three findings is not much, but requiring two
// distinct tasks is the part that matters: three bullets in one review is one reviewer being
// thorough, whereas the same objection raised on separate work is a rule the project has and has
// never written down.
const CONVENTION_MIN_FINDINGS = 3;
const CONVENTION_MIN_TASKS = 2;
const CONVENTION_SIGNATURE_WORDS = 6;
const CONVENTION_MIN_SIGNATURE_WORDS = 3;
// Words that carry no subject matter. Kept small on purpose: an aggressive list starts deciding what
// a finding is about, and that judgement is the thing this feature must not make.
const FINDING_STOPWORDS = new Set([
  "this", "that", "these", "those", "there", "then", "than", "with", "without", "from", "into",
  "have", "has", "had", "been", "being", "does", "did", "not", "but", "and", "the", "for", "are",
  "was", "were", "will", "would", "should", "could", "must", "can", "should", "when", "what",
  "which", "while", "here", "still", "also", "only", "just", "very", "more", "most", "some", "any",
  "each", "every", "your", "you", "its", "it", "they", "them", "their", "please", "needs", "need",
]);

// Crude stemming, and crude on purpose: `clamp` and `clamped` are the same objection, and a real
// stemmer is a dependency and a whole class of surprises for a gain of one word ending.
const stem = (word) => word.replace(/(ing|ed|es|s)$/u, "") || word;

// A stable key for "the same objection". Two findings match only when their significant vocabulary
// matches exactly, which is strict — this is designed to miss real repetitions rather than to invent
// one. Returns null for anything too short to be about a subject at all.
export function findingSignature(detail) {
  const words = String(detail || "")
    .toLowerCase()
    .replace(/`[^`]*`/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^\p{L}\s]+/gu, " ")
    .split(/\s+/u)
    .map((word) => stem(word))
    .filter((word) => word.length > 3 && !FINDING_STOPWORDS.has(word));
  const unique = [...new Set(words)].sort();
  if (unique.length < CONVENTION_MIN_SIGNATURE_WORDS) return null;
  return unique.slice(0, CONVENTION_SIGNATURE_WORDS).join(" ");
}
const MAX_LEGACY_FILES = 20;
const MAX_LEGACY_BYTES = 100_000;

const parseJson = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

export const redact = (value) => String(value || "")
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
  .replace(/\b(gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED TOKEN]")
  .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");

const clip = (value, max = MAX_NOTE_BODY) => {
  const text = redact(value).trim();
  return text.length > max ? `${text.slice(0, max)}\n\n> Truncated by DevTeam knowledge safety limits.` : text;
};

const short = (value, max = 200) => {
  const text = redact(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
};

export const slugify = (value, fallback = "note") => {
  const slug = String(value || "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || fallback;
};

const yamlString = (value) => JSON.stringify(String(value ?? ""));
const stampDate = (value) => String(value || new Date().toISOString()).slice(0, 10);
export const secretLike = (file) => {
  const clean = String(file || "").replace(/\\/g, "/").toLowerCase();
  return clean === ".env" || clean.startsWith(".env.") || clean.includes("/.env")
    || /(^|\/)(credentials?|secrets?|tokens?|private[-_.]?keys?)(\/|\.|$)/.test(clean)
    || /\.(pem|p12|pfx|key|keystore)$/.test(clean);
};

function safeFiles(files) {
  return [...new Set((Array.isArray(files) ? files : []).map((item) => String(item).trim().replace(/\\/g, "/"))
    .filter((item) => item && item.length <= 500 && !secretLike(item)))].slice(0, 100);
}

function normalizeProjectFiles(projectRoot, files) {
  const root = realpathSync(path.resolve(projectRoot));
  const normalized = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const clean = String(raw || "").trim().replace(/\\/g, "/");
    if (!clean || clean.length > 500 || secretLike(clean) || path.isAbsolute(clean)) continue;
    const lexical = path.resolve(root, clean);
    const lexicalRelative = path.relative(root, lexical);
    if (!lexicalRelative || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) continue;
    let existing = lexical;
    const tail = [];
    while (!existsSync(existing) && existing !== root) {
      tail.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
    if (!existsSync(existing)) continue;
    const resolved = path.resolve(realpathSync(existing), ...tail);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    normalized.push(relative.replace(/\\/g, "/"));
  }
  return [...new Set(normalized)].slice(0, 100);
}

function pathsIntersect(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function categoryForKey(key) {
  const value = String(key || "").toLowerCase();
  if (/architect|design|system/.test(value)) return "architecture";
  if (/decision|adr|choice/.test(value)) return "decisions";
  if (/component|module|service|package/.test(value)) return "components";
  if (/pitfall|risk|bug|warning|gotcha/.test(value)) return "pitfalls";
  if (/workflow|process|test|release|deploy/.test(value)) return "workflows";
  return "conventions";
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "that", "the", "this", "to", "was", "we", "with", "work", "task", "change", "changes",
]);

function terms(value) {
  const matches = String(value || "").toLowerCase().normalize("NFKD").match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  return new Set(matches.filter((term) => !STOP_WORDS.has(term)).slice(0, 400));
}

function overlaps(left, right) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function normalizedPaths(values) {
  return new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean));
}

function categoryPreferences(role) {
  const value = String(role || "").toLowerCase();
  if (["reviewer", "security-reviewer"].includes(value)) return new Set(["architecture", "conventions", "pitfalls", "workflows"]);
  if (value === "tester") return new Set(["components", "pitfalls", "workflows"]);
  if (value === "planner") return new Set(["architecture", "decisions", "conventions"]);
  return new Set(["architecture", "components", "conventions"]);
}

export function rankKnowledgeNotes(notes, context = {}, limit = 12) {
  const queryTerms = terms([
    context.taskTitle, context.taskDescription, context.assignmentTitle, context.assignmentDescription,
    context.role, ...(context.checklist || []), ...(context.memoryKeys || []), ...(context.unresolvedQuestions || []),
    ...(context.blockers || []),
  ].filter(Boolean).join(" "));
  const declaredPaths = normalizedPaths(context.declaredPaths);
  const codePaths = normalizedPaths(context.codePaths);
  const preferredCategories = categoryPreferences(context.role);
  const currentVersion = Number(context.taskVersion) || null;
  const anchor = Date.parse(context.taskUpdatedAt || "")
    || Math.max(0, ...notes.map((note) => Date.parse(note.updated_at || "") || 0));
  const recentCutoff = anchor - 30 * 86_400_000;
  const ranked = notes.map((note) => {
    let score = 0;
    const why = [];
    if (note.source_task_id === context.taskId) {
      score += 90;
      why.push("same task");
      if (currentVersion && Number(note.last_validated_version) === currentVersion) {
        score += 30;
        why.push("current version");
      }
    }
    const related = normalizedPaths(note.relatedFiles);
    if ([...related].some((known) => [...declaredPaths].some((wanted) => pathsIntersect(known, wanted)))) {
      score += 100;
      why.push("declared path");
    }
    if ([...related].some((known) => [...codePaths].some((codePath) => pathsIntersect(known, codePath)))) {
      score += 80;
      why.push("CodeGraph path");
    }
    if (overlaps(terms(note.title), queryTerms)) {
      score += 50;
      why.push("title term");
    }
    if (overlaps(terms(note.body), queryTerms)) {
      score += 35;
      why.push("body term");
    }
    if (preferredCategories.has(note.category)) {
      score += 30;
      why.push(`${note.category} context`);
    }
    if (note.status === "verified") {
      score += 25;
      why.push("verified");
    } else if (note.status === "inferred") {
      score -= 80;
      why.push("unverified inference");
    } else {
      score -= 200;
      why.push(note.status);
    }
    const validatedAt = Date.parse(note.last_validated_at || note.verified_at || "");
    if (Number.isFinite(validatedAt) && validatedAt >= recentCutoff) {
      score += 15;
      why.push("recently validated");
    }
    // T3.5: age-weight what is left. A fact does not become false by getting old, but a note nobody
    // has confirmed in half a year is a weaker basis for acting than one confirmed last week, and
    // before this they scored identically. The weight decays from the last *confirmation*, not from
    // creation — so re-confirming an old note makes it current again, which is the honest rule.
    const lastConfirmed = note.verified_at || note.last_validated_at || note.updated_at;
    const ageWeight = KnowledgeVault.ageWeight(lastConfirmed, anchor || Date.now());
    // Applied as a bounded penalty rather than a multiplier: scaling the whole score would let age
    // erase a direct path match, and "old but exactly about this file" is still the right note.
    const agePenalty = Math.round((1 - ageWeight) * 40);
    if (agePenalty >= 20) why.push("unconfirmed for a long time");
    score -= agePenalty;
    const sourceAssignmentId = parseJson(note.source_metadata, {})?.assignmentId || null;
    return { ...note, relevanceScore: score, ageWeight, lastConfirmedAt: lastConfirmed, whyIncluded: why.slice(0, 5).join(", "), sourceAssignmentId };
  }).sort((left, right) => right.relevanceScore - left.relevanceScore
    || Number(right.source_task_id === context.taskId) - Number(left.source_task_id === context.taskId)
    || String(right.updated_at).localeCompare(String(left.updated_at))
    || String(left.id).localeCompare(String(right.id)));

  const strong = ranked.some((note) => note.relevanceScore >= 50);
  const ordered = strong ? ranked : ranked.slice().sort((left, right) => Number(right.status === "verified") - Number(left.status === "verified")
    || String(right.updated_at).localeCompare(String(left.updated_at)) || String(left.id).localeCompare(String(right.id)));
  const selected = [];
  const categoryCounts = new Map();
  const sourceCounts = new Map();
  const categoryLimit = Math.max(2, Math.ceil(Math.max(1, Number(limit) || 12) / 3));
  for (const note of ordered) {
    if (selected.length >= limit) break;
    if ((categoryCounts.get(note.category) || 0) >= categoryLimit) continue;
    if (note.sourceAssignmentId && (sourceCounts.get(note.sourceAssignmentId) || 0) >= 2) continue;
    selected.push(note);
    categoryCounts.set(note.category, (categoryCounts.get(note.category) || 0) + 1);
    if (note.sourceAssignmentId) sourceCounts.set(note.sourceAssignmentId, (sourceCounts.get(note.sourceAssignmentId) || 0) + 1);
  }
  return selected;
}

function frontmatter(note) {
  const files = parseJson(note.related_files, []);
  const provenance = parseJson(note.provenance, []);
  return [
    "---",
    "generated_by: DevTeam",
    `title: ${yamlString(short(note.title, 200))}`,
    `category: ${note.category}`,
    `status: ${note.status}`,
    `confidence: ${note.confidence}`,
    `created: ${yamlString(note.created_at)}`,
    `updated: ${yamlString(note.updated_at)}`,
    `verified: ${note.verified_at ? yamlString(note.verified_at) : "null"}`,
    `last_validated: ${note.last_validated_at ? yamlString(note.last_validated_at) : "null"}`,
    `last_validated_version: ${note.last_validated_version ?? "null"}`,
    `status_changed: ${note.status_changed_at ? yamlString(note.status_changed_at) : "null"}`,
    `stale_reason: ${note.stale_reason ? yamlString(note.stale_reason) : "null"}`,
    `superseded_by: ${note.superseded_by ? yamlString(note.superseded_by) : "null"}`,
    `revision: ${note.revision}`,
    `source_task: ${note.source_task_id ? yamlString(note.source_task_id) : "null"}`,
    `source_event: ${note.source_event_id ?? "null"}`,
    "related_files:",
    ...(files.length ? files.map((file) => `  - ${yamlString(file)}`) : ["  []"]),
    `provenance_count: ${provenance.length}`,
    "---",
  ].join("\n");
}

export function atomicWrite(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, filePath);
}

export class KnowledgeVault {
  constructor(db, { enabled = false } = {}) {
    this.db = db;
    this.enabled = Boolean(enabled);
    this.#migrate();
    this.#initFts();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_notes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source_task_id TEXT,
        source_event_id INTEGER,
        source_author TEXT,
        related_files TEXT NOT NULL,
        provenance TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(project_id, category, slug)
      );
      CREATE TABLE IF NOT EXISTS knowledge_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        legacy_imported_at TEXT,
        exported_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_project_updated
        ON knowledge_notes(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_source_event
        ON knowledge_notes(source_event_id);
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(knowledge_notes)").all().map((column) => column.name));
    for (const [column, ddl] of [
      ["superseded_by", "TEXT"],
      ["stale_reason", "TEXT"],
      ["status_changed_at", "TEXT"],
      ["last_validated_at", "TEXT"],
      ["last_validated_version", "INTEGER"],
      // T3.6: a lesson worth carrying to other projects. Opt-in per note and never the default —
      // this is the one place in DevTeam where one client's details could end up in another's
      // context, so it has to be a deliberate act rather than something that happens by inheritance.
      ["shared_scope", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE knowledge_notes ADD COLUMN ${column} ${ddl}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_project_status
        ON knowledge_notes(project_id, status, updated_at DESC);

      -- The vault has always emitted [[wikilinks]] but kept no index of them, so "what references
      -- this decision?" could only be answered by scanning every note's body. Maintained on write.
      --
      -- to_note_id is computed from the link target rather than looked up, because a note's id is a
      -- pure function of (project, category, slug). A link written before its target exists already
      -- points at the right id and simply starts resolving the moment that note is created — so a
      -- forward reference is an ordinary link rather than a dangling one that needs repairing.
      CREATE TABLE IF NOT EXISTS knowledge_links (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_note_id TEXT NOT NULL,
        target TEXT NOT NULL,
        to_note_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (from_note_id, target)
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_links_to ON knowledge_links(to_note_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_links_project ON knowledge_links(project_id);
    `);
  }

  // T3.3 — retrieval was substring matching plus recency, which is the mechanism that decides what an
  // agent knows, so its quality caps the whole system's. BM25 over FTS5 is a large improvement for no
  // new dependency: SQLite ships it, and the project's standing decision to avoid a vector store
  // stays intact. (`Don't add a vector store yet` — ROADMAP. FTS5 is what buys that time.)
  //
  // Built defensively: a SQLite build without FTS5 leaves `ftsEnabled` false and search falls back to
  // exactly the previous LIKE behaviour, rather than the vault becoming unsearchable.
  #initFts() {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
          note_id UNINDEXED, title, body, related, tokenize='porter unicode61'
        );
      `);
      this.ftsEnabled = true;
    } catch {
      this.ftsEnabled = false;
      return;
    }
    // Backfill once for a vault that predates the index. Guarded on emptiness rather than a flag:
    // the FTS table is derived data, so rebuilding it is always safe and never loses anything.
    try {
      const indexed = Number(this.db.prepare("SELECT COUNT(*) AS count FROM knowledge_fts").get().count);
      if (indexed === 0) {
        for (const note of this.db.prepare("SELECT id, title, body, related_files FROM knowledge_notes").all()) {
          this.#indexFts(note.id, note.title, note.body, note.related_files);
        }
      }
    } catch { /* a backfill failure must never stop the server starting */ }
  }

  #indexFts(noteId, title, body, relatedFiles) {
    if (!this.ftsEnabled) return;
    try {
      this.db.prepare("DELETE FROM knowledge_fts WHERE note_id = ?").run(noteId);
      this.db.prepare("INSERT INTO knowledge_fts (note_id, title, body, related) VALUES (?, ?, ?, ?)")
        .run(noteId, String(title || ""), String(body || ""),
          (Array.isArray(parseJson(relatedFiles, [])) ? parseJson(relatedFiles, []) : []).join(" "));
    } catch { /* indexing is best-effort; the note itself is already stored */ }
  }

  // Agent- and human-written queries are prose, and FTS5 MATCH is a small language with operators
  // (AND, OR, NOT, NEAR, *, ", ^, -). Passing prose straight in is both a syntax error waiting to
  // happen and a way for a stray `-` to silently invert a search. Every term is therefore quoted as a
  // literal phrase and joined with OR, so nothing in the text can be read as an operator, and bm25
  // does the ranking: a note matching four terms outranks one matching one.
  #ftsQuery(query) {
    const terms = String(query || "")
      .split(/[^\p{L}\p{N}_]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 12);
    if (!terms.length) return null;
    return terms.map((term) => `"${term.replace(/"/g, "")}"*`).join(" OR ");
  }

  // The id a note has, or would have. Pure function of where it lives, which is what lets a link be
  // resolved without the target existing yet.
  static noteId(projectId, category, slug) {
    return createHash("sha256").update(`${projectId}:${category}:${slug}`).digest("hex").slice(0, 24);
  }

  // Rewrite one note's outgoing links. Targets are taken as written: `[[category/slug]]`, with an
  // optional `|label` that is display only. A bare `[[architecture]]` names a category index rather
  // than a note, so it is recorded with a null target id — it is a real link, just not to a note.
  #indexLinks(projectId, noteId, body, stamp) {
    this.db.prepare("DELETE FROM knowledge_links WHERE from_note_id = ?").run(noteId);
    const seen = new Set();
    for (const match of String(body || "").matchAll(/\[\[([^\]|]{1,200})(?:\|[^\]]{0,200})?\]\]/g)) {
      const target = match[1].trim();
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const parts = target.split("/");
      const toNoteId = parts.length === 2 && parts[0] && parts[1]
        ? KnowledgeVault.noteId(projectId, parts[0], parts[1])
        : null;
      if (toNoteId === noteId) continue; // a note linking to itself is noise, not a backlink
      this.db.prepare(`
        INSERT INTO knowledge_links (project_id, from_note_id, target, to_note_id, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(from_note_id, target) DO NOTHING
      `).run(projectId, noteId, target, toNoteId, stamp);
    }
  }

  // What references this note. The whole point of T3.4: a decision can now be read together with
  // everything that depended on it, instead of looking equally isolated however load-bearing it is.
  backlinks(noteId, { limit = 20 } = {}) {
    return this.db.prepare(`
      SELECT source.id, source.category, source.slug, source.title, source.status, source.confidence, source.updated_at
      FROM knowledge_links link
      JOIN knowledge_notes source ON source.id = link.from_note_id
      WHERE link.to_note_id = ?
      ORDER BY source.updated_at DESC LIMIT ?
    `).all(noteId, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((note) => ({ ...note, link: `[[${note.category}/${note.slug}]]` }));
  }

  // Where this note points, with whether each target exists yet.
  outboundLinks(noteId, { limit = 40 } = {}) {
    return this.db.prepare(`
      SELECT link.target, link.to_note_id, target_note.title, target_note.status
      FROM knowledge_links link
      LEFT JOIN knowledge_notes target_note ON target_note.id = link.to_note_id
      WHERE link.from_note_id = ? ORDER BY link.target ASC LIMIT ?
    `).all(noteId, Math.max(1, Math.min(200, Number(limit) || 40)))
      .map((row) => ({ target: row.target, noteId: row.to_note_id, title: row.title || null, status: row.status || null, resolved: Boolean(row.title) }));
  }

  initializeProject(projectId) {
    if (!this.enabled) return null;
    this.db.prepare("INSERT OR IGNORE INTO knowledge_state (project_id, last_event_id) VALUES (?, 0)").run(projectId);
    this.#importLegacy(projectId);
    this.#syncProjectEvents(projectId);
    this.#syncConventions(projectId);
    return this.exportProject(projectId);
  }

  syncTask(taskId) {
    if (!this.enabled || !taskId) return null;
    const task = this.db.prepare(`
      SELECT t.*, p.root AS project_root FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?
    `).get(taskId);
    if (!task) return null;
    this.db.prepare("INSERT OR IGNORE INTO knowledge_state (project_id, last_event_id) VALUES (?, 0)").run(task.project_id);
    this.#importLegacy(task.project_id);
    this.#syncProjectEvents(task.project_id);
    this.#syncConventions(task.project_id);
    return this.exportProject(task.project_id);
  }

  // Recompute the whole project's recurring-finding conventions. Cheap enough to redo wholesale
  // rather than maintain incrementally: request-for-changes is a rare event, and recomputing means a
  // note can never drift from the findings that justify it — including downwards, when a note that
  // no longer clears the threshold is archived rather than left standing as a rule nobody agreed to.
  #syncConventions(projectId) {
    const rows = this.db.prepare(`
      SELECT f.id, f.detail, f.path, f.requested_by_name, f.created_at, f.task_id
      FROM assignment_findings f
      JOIN tasks t ON t.id = f.task_id
      WHERE t.project_id = ?
      ORDER BY f.created_at ASC
    `).all(projectId);
    const groups = new Map();
    for (const row of rows) {
      const signature = findingSignature(row.detail);
      if (!signature) continue;
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature).push(row);
    }
    for (const [signature, findings] of groups) {
      const slug = `recurring-${createHash("sha256").update(signature).digest("hex").slice(0, 10)}`;
      const distinctTasks = new Set(findings.map((finding) => finding.task_id)).size;
      const qualifies = findings.length >= CONVENTION_MIN_FINDINGS && distinctTasks >= CONVENTION_MIN_TASKS;
      const existing = this.db.prepare("SELECT id, status FROM knowledge_notes WHERE id = ?")
        .get(KnowledgeVault.noteId(projectId, "conventions", slug));
      if (!qualifies) {
        // Never invent a rule, and never leave one standing once its evidence stops meeting the bar.
        if (existing && existing.status !== "archived") {
          this.db.prepare("UPDATE knowledge_notes SET status = 'archived', status_changed_at = ? WHERE id = ?")
            .run(new Date().toISOString(), existing.id);
        }
        continue;
      }
      const latest = findings[findings.length - 1];
      // The body is quotation, not summary. DevTeam has no opinion about what the rule *is* — it
      // reports that the same objection keeps being raised and hands over the evidence, so a reader
      // draws the conclusion rather than trusting one this file invented.
      const quoted = findings.map((finding) => {
        const where = finding.path ? ` (\`${finding.path}\`)` : "";
        return `- “${short(String(finding.detail).replace(/\s+/gu, " "), 400)}”${where}\n  — ${finding.requested_by_name}, ${String(finding.created_at).slice(0, 10)}`;
      }).join("\n");
      const body = [
        `Reviewers have raised the same objection **${findings.length} times across ${distinctTasks} separate tasks**.`,
        "That makes it a convention this project has and has not written down.",
        "",
        "## The findings",
        "",
        quoted,
        "",
        "Recorded automatically from requests for changes. If this is not a real convention, dispute the note;",
        "if it is, writing it down properly here is better than being told again.",
      ].join("\n");
      this.#upsert({
        projectId, category: "conventions", slug,
        title: `Recurring review finding: ${signature}`,
        body, status: "proposed", confidence: "medium",
        sourceTaskId: latest.task_id, sourceEventId: null,
        sourceAuthor: "DevTeam (recurring review findings)",
        provenance: { type: "knowledge.recurring_finding", taskId: latest.task_id, at: latest.created_at },
        createdAt: findings[0].created_at,
        relatedFiles: findings.map((finding) => finding.path).filter(Boolean),
      });
    }
  }

  #syncProjectEvents(projectId) {
    const state = this.db.prepare("SELECT last_event_id FROM knowledge_state WHERE project_id = ?").get(projectId);
    const events = this.db.prepare(`
      SELECT e.*, a.name AS author_name, t.title AS task_title
      FROM events e
      JOIN tasks t ON t.id = e.task_id
      LEFT JOIN agents a ON a.id = e.agent_id
      WHERE t.project_id = ? AND e.id > ?
      ORDER BY e.id ASC
    `).all(projectId, state?.last_event_id || 0);
    let lastEventId = state?.last_event_id || 0;
    for (const event of events) {
      this.#ingestEvent(projectId, event);
      lastEventId = event.id;
    }
    this.db.prepare("UPDATE knowledge_state SET last_event_id = ? WHERE project_id = ?").run(lastEventId, projectId);
  }

  #ingestEvent(projectId, event) {
    const metadata = parseJson(event.metadata, {});
    const source = {
      taskId: event.task_id,
      eventId: event.id,
      type: event.type,
      author: event.author_name || "human",
      at: event.created_at,
    };
    const common = {
      projectId,
      sourceTaskId: event.task_id,
      sourceEventId: event.id,
      sourceAuthor: source.author,
      provenance: source,
      createdAt: event.created_at,
      validatedVersion: Number(metadata.version) || null,
    };

    if (event.type === "blackboard.updated" && metadata.scope === "project") {
      const memory = this.db.prepare("SELECT value FROM project_blackboard WHERE project_id = ? AND key = ?")
        .get(projectId, metadata.key);
      if (!memory) return;
      const category = categoryForKey(metadata.key);
      this.#upsert({ ...common, category, slug: `memory-${slugify(metadata.key)}`, title: metadata.key,
        body: clip(memory.value), status: "verified", confidence: "high", verifiedAt: event.created_at });
      return;
    }

    if (event.type === "proposal.adopted") {
      const proposal = metadata.proposalId
        ? this.db.prepare("SELECT summary, details, kind FROM proposals WHERE id = ?").get(metadata.proposalId)
        : null;
      const title = proposal?.summary || event.message.replace(/^Team adopted:\s*/i, "");
      this.#upsert({ ...common, category: "decisions", slug: `decision-${event.id}-${slugify(title)}`, title,
        body: clip([proposal?.details ? `Details: ${proposal.details}` : "", `Adopted by the DevTeam as a ${proposal?.kind || metadata.kind || "decision"}.`].filter(Boolean).join("\n\n")),
        status: "verified", confidence: "high", verifiedAt: event.created_at });
      return;
    }

    if (["assignment.completed", "assignment.blocked"].includes(event.type)) {
      const role = String(metadata.role || "contributor").toLowerCase();
      const project = this.db.prepare("SELECT root FROM projects WHERE id = ?").get(projectId);
      const changedFiles = project ? normalizeProjectFiles(project.root, metadata.changedFiles) : [];
      // Prefer the graded records over the bare labels. The vault is what agents read back as
      // ground truth and what gets exported into the repo, so it is the last place that should blur
      // "DevTeam ran this" into "an agent said this".
      const records = Array.isArray(metadata.checkRecords) ? metadata.checkRecords : null;
      const checks = records
        ? records.slice(0, 50).map((record) => {
          const label = clip(String(record?.label ?? ""), 500);
          if (!label) return "";
          if (record?.status === "passed") return `${label} — verified by DevTeam (exit 0)`;
          if (record?.status === "failed") return `${label} — verified failure${record.exitCode == null ? "" : ` (exit ${record.exitCode})`}`;
          if (record?.status === "unavailable") return `${label} — not run`;
          return `${label} — agent-asserted, unverified`;
        }).filter(Boolean)
        : (Array.isArray(metadata.checks) ? metadata.checks.map((item) => `${clip(item, 500)} — agent-asserted, unverified`).filter(Boolean).slice(0, 50) : []);
      // Note: the note's own status field is this vault's lifecycle state (verified / disputed /
      // superseded), which is a different question from whether a check was executed. That
      // distinction lives in the check lines above, where it belongs.
      const assignment = metadata.assignmentId
        ? this.db.prepare("SELECT title FROM assignments WHERE id = ?").get(metadata.assignmentId)
        : null;
      const blocked = event.type === "assignment.blocked";
      const category = blocked ? "pitfalls"
        : ["reviewer", "tester", "security-reviewer"].includes(role) ? "workflows"
          : changedFiles.length ? "components" : "workflows";
      const body = [
        event.message,
        changedFiles.length ? `## Related files\n\n${changedFiles.map((file) => `- \`${file}\``).join("\n")}` : "",
        checks.length ? `## Checks\n\n${checks.map((check) => `- ${check}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");
      const staleIds = changedFiles.length ? this.#staleFileLinkedNotes(projectId, event, changedFiles) : [];
      const noteId = this.#upsert({ ...common, category, slug: `${blocked ? "blocker" : "work"}-${event.id}-${slugify(assignment?.title || role)}`,
        title: assignment?.title || `${role} ${blocked ? "blocker" : "result"}`, body: clip(body),
        status: blocked ? "disputed" : "verified", confidence: blocked ? "medium" : "high",
        relatedFiles: changedFiles, verifiedAt: blocked ? null : event.created_at });
      if (staleIds.length) this.#recordLifecycleEvent(event, staleIds, !blocked && category === "components" ? noteId : null, changedFiles);
      return;
    }

    if (["task.blocked", "agent.finding"].includes(event.type)) {
      this.#upsert({ ...common, category: "pitfalls", slug: `${event.type.replace(".", "-")}-${event.id}`,
        title: event.type === "task.blocked" ? `Blocked: ${event.task_title}` : `Finding: ${short(event.message, 90)}`,
        body: clip(event.message), status: event.type === "task.blocked" ? "verified" : "inferred",
        confidence: event.type === "task.blocked" ? "high" : "medium", verifiedAt: event.type === "task.blocked" ? event.created_at : null });
      return;
    }

    if (event.type === "agent.decision") {
      this.#upsert({ ...common, category: "decisions", slug: `agent-decision-${event.id}`,
        title: `Proposed decision: ${short(event.message, 90)}`, body: clip(event.message), status: "inferred", confidence: "medium" });
    }
  }

  #staleFileLinkedNotes(projectId, event, changedFiles) {
    const project = this.db.prepare("SELECT root FROM projects WHERE id = ?").get(projectId);
    if (!project) return [];
    const rows = this.db.prepare(`
      SELECT id, related_files FROM knowledge_notes
      WHERE project_id = ? AND category = 'components' AND status NOT IN ('stale', 'archived')
        AND (source_event_id IS NULL OR source_event_id < ?)
      ORDER BY updated_at ASC, id ASC
    `).all(projectId, event.id);
    const affected = rows.filter((row) => {
      const related = normalizeProjectFiles(project.root, parseJson(row.related_files, []));
      return related.some((known) => changedFiles.some((changed) => pathsIntersect(known, changed)));
    });
    if (!affected.length) return [];
    const reason = clip(`Files changed in task event ${event.id}: ${changedFiles.join(", ")}`, 1_000);
    const update = this.db.prepare(`
      UPDATE knowledge_notes SET status = 'stale', stale_reason = ?, status_changed_at = ?,
        superseded_by = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?
    `);
    for (const row of affected) update.run(reason, event.created_at, event.created_at, row.id);
    return affected.map((row) => row.id);
  }

  #recordLifecycleEvent(sourceEvent, noteIds, supersededBy, relatedFiles) {
    if (supersededBy) {
      const link = this.db.prepare("UPDATE knowledge_notes SET superseded_by = ? WHERE id = ? AND status = 'stale'");
      for (const noteId of noteIds) link.run(supersededBy, noteId);
    }
    const type = supersededBy ? "knowledge.superseded" : "knowledge.staled";
    const message = supersededBy
      ? `${noteIds.length} earlier knowledge note${noteIds.length === 1 ? " was" : "s were"} superseded by current file evidence.`
      : `${noteIds.length} earlier knowledge note${noteIds.length === 1 ? " became" : "s became"} stale after file changes.`;
    this.db.prepare(`
      INSERT INTO events (task_id, agent_id, type, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sourceEvent.task_id, sourceEvent.agent_id || null, type, message, JSON.stringify({
      sourceEventId: sourceEvent.id,
      noteIds: noteIds.slice(0, 100),
      supersededBy: supersededBy || null,
      relatedFiles: relatedFiles.slice(0, 100),
    }), sourceEvent.created_at);
  }

  #upsert(note) {
    const id = KnowledgeVault.noteId(note.projectId, note.category, note.slug);
    const existing = this.db.prepare("SELECT * FROM knowledge_notes WHERE id = ?").get(id);
    const provenance = [...parseJson(existing?.provenance, []), note.provenance]
      .filter((item, index, all) => all.findIndex((other) => other.eventId === item.eventId && other.type === item.type) === index)
      .slice(-100);
    const relatedFiles = safeFiles([...(parseJson(existing?.related_files, [])), ...(note.relatedFiles || [])]);
    this.db.prepare(`
      INSERT INTO knowledge_notes (
        id, project_id, category, slug, title, body, status, confidence, source_task_id,
        source_event_id, source_author, related_files, provenance, created_at, updated_at, verified_at,
        superseded_by, stale_reason, status_changed_at, last_validated_at, last_validated_version, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, body = excluded.body, status = excluded.status, confidence = excluded.confidence,
        source_task_id = excluded.source_task_id, source_event_id = excluded.source_event_id,
        source_author = excluded.source_author, related_files = excluded.related_files,
        provenance = excluded.provenance, updated_at = excluded.updated_at,
        verified_at = COALESCE(excluded.verified_at, knowledge_notes.verified_at),
        superseded_by = excluded.superseded_by, stale_reason = excluded.stale_reason,
        status_changed_at = CASE WHEN knowledge_notes.status != excluded.status
          THEN excluded.status_changed_at ELSE knowledge_notes.status_changed_at END,
        last_validated_at = COALESCE(excluded.last_validated_at, knowledge_notes.last_validated_at),
        last_validated_version = COALESCE(excluded.last_validated_version, knowledge_notes.last_validated_version),
        revision = knowledge_notes.revision + 1
    `).run(id, note.projectId, note.category, note.slug, short(note.title, 200), clip(note.body), note.status,
      note.confidence, note.sourceTaskId || null, note.sourceEventId ?? null, note.sourceAuthor || "system",
      JSON.stringify(relatedFiles), JSON.stringify(provenance), existing?.created_at || note.createdAt,
      note.createdAt, note.verifiedAt || null, note.supersededBy || null, note.staleReason || null,
      note.statusChangedAt || note.createdAt, note.verifiedAt || null, note.validatedVersion || null);
    this.#indexLinks(note.projectId, id, note.body, note.createdAt);
    const stored = this.db.prepare("SELECT title, body, related_files FROM knowledge_notes WHERE id = ?").get(id);
    this.#indexFts(id, stored?.title, stored?.body, stored?.related_files);
    return id;
  }

  #projectRoot(projectId) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Knowledge project not found.");
    const lexicalRoot = path.resolve(project.root);
    const realRoot = realpathSync(lexicalRoot);
    if (!lstatSync(realRoot).isDirectory()) throw new Error("Knowledge project root is not a directory.");
    const vault = path.resolve(realRoot, "knowledge");
    const relative = path.relative(realRoot, vault);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe knowledge vault path.");
    return { project, realRoot, vault };
  }

  #importLegacy(projectId) {
    const state = this.db.prepare("SELECT legacy_imported_at FROM knowledge_state WHERE project_id = ?").get(projectId);
    if (state?.legacy_imported_at) return;
    const { realRoot } = this.#projectRoot(projectId);
    const memoryRoot = path.join(realRoot, "memory");
    if (existsSync(memoryRoot) && lstatSync(memoryRoot).isDirectory() && !lstatSync(memoryRoot).isSymbolicLink()) {
      const candidates = ["INDEX.md"];
      for (let index = 0; index < MAX_LEGACY_FILES - 1; index += 1) {
        const date = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
        candidates.push(`memory_${date}.md`);
      }
      for (const filename of [...new Set(candidates)].slice(0, MAX_LEGACY_FILES)) {
        const source = path.join(memoryRoot, filename);
        if (!existsSync(source)) continue;
        const info = lstatSync(source);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LEGACY_BYTES) continue;
        const body = readFileSync(source, "utf8");
        const at = info.mtime.toISOString();
        this.#upsert({ projectId, category: "archive", slug: `legacy-${slugify(filename.replace(/\.md$/i, ""))}`,
          title: `Legacy Shorekeeper: ${filename}`, body: clip(body), status: "archived", confidence: "medium",
          sourceTaskId: null, sourceEventId: null, sourceAuthor: "Shorekeeper import",
          provenance: { type: "legacy.memory", file: `memory/${filename}`, at }, createdAt: at,
          relatedFiles: [`memory/${filename}`] });
      }
    }
    this.db.prepare("UPDATE knowledge_state SET legacy_imported_at = ? WHERE project_id = ?")
      .run(new Date().toISOString(), projectId);
  }

  exportProject(projectId) {
    if (!this.enabled) return null;
    const { project, vault } = this.#projectRoot(projectId);
    for (const folder of [...CATEGORIES, "sessions", "archive"]) mkdirSync(path.join(vault, folder), { recursive: true });
    const notes = this.db.prepare("SELECT * FROM knowledge_notes WHERE project_id = ? ORDER BY updated_at DESC, title ASC")
      .all(projectId);
    const expected = new Set(["CURRENT.md", "INDEX.md"]);
    for (const note of notes) {
      const folder = note.status === "archived" || note.category === "archive" ? "archive" : note.category;
      const provenance = parseJson(note.provenance, []);
      const sourceLines = provenance.map((source) => {
        const parts = [source.type, source.taskId ? `task ${source.taskId}` : null,
          source.eventId ? `event ${source.eventId}` : null, source.author ? `by ${source.author}` : null,
          source.file || null, source.at].filter(Boolean);
        return `- ${parts.join(" · ")}`;
      });
      const content = `${frontmatter(note)}\n\n# ${short(note.title, 200)}\n\n${note.body}\n\n## Provenance\n\n${sourceLines.join("\n") || "- DevTeam automated knowledge"}\n`;
      const relative = `${folder}/${note.slug}.md`;
      expected.add(relative);
      atomicWrite(path.join(vault, ...relative.split("/")), content);
    }
    for (const relative of this.#writeCurrent(project, vault)) expected.add(relative);
    this.#writeIndex(project, vault, notes);
    // A vault belongs to exactly one project. When it belongs to somebody else, refreshing the notes
    // is still right — but deleting is not, because "this file is not in my database" no longer means
    // "this file is obsolete". Leaving a stale file behind is a far cheaper mistake than deleting
    // someone's memory, so an unowned vault loses only its cleanup.
    const owner = vaultOwner(vault);
    const ownsVault = !owner || owner.projectId === projectId;
    if (!owner) {
      atomicWrite(path.join(vault, VAULT_MARKER),
        `${JSON.stringify({ projectId, project: project.name, claimedAt: new Date().toISOString() }, null, 2)}\n`);
    }
    if (ownsVault) this.#reconcileGeneratedFiles(vault, expected);
    this.db.prepare("UPDATE knowledge_state SET exported_at = ? WHERE project_id = ?").run(new Date().toISOString(), projectId);
    return {
      path: vault,
      noteCount: notes.length,
      updatedAt: new Date().toISOString(),
      reconciled: ownsVault,
      ...(ownsVault ? {} : { foreignVault: { project: owner.project || null, projectId: owner.projectId || null } }),
    };
  }

  #writeCurrent(project, vault) {
    const tasks = this.db.prepare(`
      SELECT id, title, description, status, version, created_at, updated_at FROM tasks
      WHERE project_id = ? ORDER BY updated_at DESC LIMIT 12
    `).all(project.id);
    const active = tasks.filter((task) => !["accepted", "cancelled"].includes(task.status));
    const recent = this.db.prepare(`
      SELECT e.id, e.task_id, e.type, e.message, e.created_at
      FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE t.project_id = ? AND e.type IN ('human.message','assignment.completed','assignment.blocked','task.blocked','task.unblocked','task.accepted','proposal.adopted')
      ORDER BY e.id DESC LIMIT 12
    `).all(project.id);
    const lines = [
      "---", `project: ${yamlString(project.name)}`, "generated_by: DevTeam", `updated: ${yamlString(new Date().toISOString())}`, "---", "",
      `# Current — ${project.name}`, "", "> Automatically regenerated from DevTeam's transactional history. Do not store secrets here.", "",
      "## Active tasks", "",
      ...(active.length ? active.map((task) => `- **${task.title}** — ${task.status}, v${task.version} ([[sessions/${stampDate(task.created_at)}-${slugify(task.title)}-${task.id.slice(0, 8)}]])`) : ["- No active tasks."]),
      "", "## Recent verified activity", "",
      ...(recent.length ? recent.map((event) => `- ${event.created_at} · ${event.type} · ${clip(event.message, 300)}`) : ["- No recorded activity yet."]), "",
      "## Navigation", "", "- [[INDEX]]", "- [[architecture]]", "- [[decisions]]", "- [[components]]", "- [[conventions]]", "- [[pitfalls]]", "- [[workflows]]", "",
    ];
    atomicWrite(path.join(vault, "CURRENT.md"), lines.join("\n"));
    const generated = [];
    for (const task of tasks) {
      const events = this.db.prepare("SELECT type, message, created_at FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 30").all(task.id).reverse();
      const content = [
        "---", `task_id: ${yamlString(task.id)}`, `status: ${task.status}`, `version: ${task.version}`,
        `updated: ${yamlString(task.updated_at)}`, "generated_by: DevTeam", "---", "", `# ${task.title}`, "", task.description, "",
        "## Timeline summary", "", ...events.map((event) => `- ${event.created_at} · **${event.type}** · ${clip(event.message, 500)}`), "",
      ].join("\n");
      const relative = `sessions/${stampDate(task.created_at)}-${slugify(task.title)}-${task.id.slice(0, 8)}.md`;
      generated.push(relative);
      atomicWrite(path.join(vault, ...relative.split("/")), content);
    }
    return generated;
  }

  // T3.6 — cross-project memory.
  //
  // Knowledge is project-scoped, so a lesson learned in one project could not inform another: the
  // same pitfall got rediscovered per repository. Sharing is opt-in per note and deliberately not
  // inherited from anything, because this is the one place where one client's details could reach
  // another's context.
  //
  // Only `conventions` and `pitfalls` may be shared. An architecture note, a component description
  // or a decision is *about* a particular system and cannot be true elsewhere — offering it to
  // another project would be shipping a claim that does not apply. A convention ("we pin exact
  // versions") and a pitfall ("this vendor's API silently truncates at 1000") travel.
  static SHAREABLE_CATEGORIES = ["conventions", "pitfalls"];

  shareNote(projectId, noteId, { shared = true } = {}) {
    const note = this.db.prepare("SELECT id, category, title, body FROM knowledge_notes WHERE project_id = ? AND id = ?").get(projectId, noteId);
    if (!note) throw new Error("Note not found in this project.");
    if (shared && !KnowledgeVault.SHAREABLE_CATEGORIES.includes(note.category)) {
      throw new Error(`Only ${KnowledgeVault.SHAREABLE_CATEGORIES.join(" and ")} notes can be shared across projects — anything else is about this system in particular and cannot be true elsewhere.`);
    }
    // Re-redact on the way out. The note was already redacted when written, but sharing changes who
    // can read it, and a rule that only ran at write time would carry whatever it missed then.
    if (shared) {
      const carried = `${note.title}\n${note.body}`;
      if (redact(carried) !== carried) {
        throw new Error("This note contains something that looks like a credential or secret. It cannot be shared across projects.");
      }
    }
    this.db.prepare("UPDATE knowledge_notes SET shared_scope = ? WHERE id = ?").run(shared ? 1 : 0, noteId);
    return { noteId, shared: Boolean(shared), category: note.category };
  }

  // Shared notes from *other* projects. Never mixed into a project's own list silently: the caller
  // asks for them, and each one says where it came from, so an agent can weigh a borrowed lesson
  // differently from something learned here.
  sharedFromOtherProjects(projectId, { limit = 10, query = "" } = {}) {
    const clean = String(query || "").trim();
    const rows = this.db.prepare(`
      SELECT k.id, k.category, k.slug, k.title, k.body, k.confidence, k.updated_at, k.verified_at, p.name AS project_name
      FROM knowledge_notes k JOIN projects p ON p.id = k.project_id
      WHERE k.shared_scope = 1 AND k.project_id != ? AND k.status IN ('verified', 'inferred')
      ORDER BY COALESCE(k.verified_at, k.updated_at) DESC LIMIT 200
    `).all(projectId);
    const wanted = clean.toLowerCase();
    return rows
      .filter((row) => !wanted || `${row.title} ${row.body}`.toLowerCase().includes(wanted))
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
      .map((row) => ({
        id: row.id, category: row.category, title: short(row.title, 200), body: clip(row.body, 1_200),
        confidence: row.confidence, fromProject: row.project_name,
        ageWeight: KnowledgeVault.ageWeight(row.verified_at || row.updated_at),
        note: "Learned in another project. Confirm it applies here before acting on it.",
      }));
  }

  // T3.2 — contradiction detection.
  //
  // Notes carry status verified/disputed/superseded, but nothing ever *detected* that a new note
  // disagreed with an old one — superseding was triggered by files changing, not by meaning. So two
  // agents could hold opposing "verified" facts indefinitely, and whichever the ranker happened to
  // surface became what the next session believed.
  //
  // This does not try to understand the claims. It finds notes that are *about the same thing* — same
  // category and overlapping subject terms, or the same related files — and says "these two are
  // about one subject and say different things, someone should decide". Detection is cheap and
  // conservative; resolution is the team's job, which is what the proposal mechanism is already for.
  #conflictCandidates(projectId, note, noteId, limit = 5) {
    const subject = new Set(String(note.title || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));
    if (!subject.size) return [];
    const files = new Set((note.relatedFiles || []).map((file) => String(file)));
    const rows = this.db.prepare(`
      SELECT id, category, slug, title, body, status, confidence, related_files, updated_at
      FROM knowledge_notes
      WHERE project_id = ? AND id != ? AND category = ? AND status IN ('verified', 'inferred')
      ORDER BY updated_at DESC LIMIT 60
    `).all(projectId, noteId, note.category);
    const scored = [];
    for (const row of rows) {
      const otherSubject = new Set(String(row.title || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));
      const shared = [...subject].filter((word) => otherSubject.has(word));
      const sharedFiles = [...files].filter((file) => (parseJson(row.related_files, []) || []).includes(file));
      // Two independent ways of being about the same thing. Either alone is enough — notes about one
      // file often have unlike titles, and notes about one idea often touch no files at all.
      const overlap = shared.length / Math.max(2, Math.min(subject.size, otherSubject.size));
      if (overlap < 0.5 && !sharedFiles.length) continue;
      // Same subject, same words: this is a restatement, not a disagreement.
      if (String(row.body || "").trim() === String(note.body || "").trim()) continue;
      scored.push({
        id: row.id, category: row.category, slug: row.slug, title: row.title,
        status: row.status, confidence: row.confidence, updatedAt: row.updated_at,
        link: `[[${row.category}/${row.slug}]]`,
        sharedTerms: shared.slice(0, 8),
        sharedFiles: sharedFiles.slice(0, 8),
        score: Number((overlap + sharedFiles.length * 0.5).toFixed(2)),
      });
    }
    return scored.sort((left, right) => right.score - left.score).slice(0, limit);
  }

  // Mark two notes as disagreeing. Both are moved to `disputed`, which the ordinary brief and search
  // paths already exclude — so a contested fact stops being quietly served as truth the moment the
  // disagreement is noticed, rather than after someone resolves it.
  disputeNotes(projectId, noteIds, reason) {
    const stamp = new Date().toISOString();
    const ids = [...new Set(noteIds.filter(Boolean))].slice(0, 10);
    if (ids.length < 2) return { disputed: 0 };
    const placeholders = ids.map(() => "?").join(", ");
    const changes = this.db.prepare(`
      UPDATE knowledge_notes SET status = 'disputed', stale_reason = ?, status_changed_at = ?
      WHERE project_id = ? AND id IN (${placeholders}) AND status != 'disputed'
    `).run(String(reason || "Two notes about the same subject disagree.").slice(0, 500), stamp, projectId, ...ids).changes;
    for (const id of ids) {
      const note = this.db.prepare("SELECT title, body, related_files FROM knowledge_notes WHERE id = ?").get(id);
      if (note) this.#indexFts(id, note.title, note.body, note.related_files);
    }
    return { disputed: Number(changes) || 0, noteIds: ids };
  }

  // T3.5 — memory decay.
  //
  // Nothing aged. A `verified` note from six months and forty task versions ago read exactly like one
  // written this morning, so the ranker kept serving facts about a system that had moved on.
  //
  // This is scoring, not schema: `verifiedAt` already existed. Confidence decays with age from the
  // last time the fact was actually confirmed, which is what makes it honest — a note re-verified
  // yesterday is current however old it is, and one written confidently a year ago is not.
  static AGE_HALF_LIFE_DAYS = 120;

  static ageWeight(stamp, now = Date.now()) {
    const at = Date.parse(stamp || "");
    if (!Number.isFinite(at)) return 0.5;         // unknown age is neither fresh nor stale
    const days = Math.max(0, (now - at) / 86_400_000);
    return Number(Math.pow(0.5, days / KnowledgeVault.AGE_HALF_LIFE_DAYS).toFixed(4));
  }

  // Notes that have not been confirmed in a long time, worst first: a queue a maintainer agent can
  // work through. Deliberately a *queue* rather than an automatic downgrade — a fact does not become
  // false by being old, it becomes unconfirmed, and those are different claims.
  staleKnowledge(projectId, { olderThanDays = 90, limit = 20 } = {}) {
    const cutoff = new Date(Date.now() - Math.max(1, Number(olderThanDays) || 90) * 86_400_000).toISOString();
    return this.db.prepare(`
      SELECT id, category, slug, title, status, confidence, verified_at, updated_at, revision
      FROM knowledge_notes
      WHERE project_id = ? AND status IN ('verified', 'inferred')
        AND COALESCE(verified_at, updated_at) < ?
      ORDER BY COALESCE(verified_at, updated_at) ASC LIMIT ?
    `).all(projectId, cutoff, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((note) => ({
        ...note,
        link: `[[${note.category}/${note.slug}]]`,
        ageWeight: KnowledgeVault.ageWeight(note.verified_at || note.updated_at),
        lastConfirmedAt: note.verified_at || note.updated_at,
        next: "Confirm it against the project as it stands now, correct it, or supersede it.",
      }));
  }

  // Confirm a note is still true. This is what resets its age, and the only thing that should.
  confirmNote(projectId, noteId, { author = "agent" } = {}) {
    const stamp = new Date().toISOString();
    const changes = this.db.prepare(`
      UPDATE knowledge_notes SET verified_at = ?, last_validated_at = ?, source_author = ?
      WHERE project_id = ? AND id = ?
    `).run(stamp, stamp, String(author).slice(0, 120), projectId, noteId).changes;
    return { confirmed: Boolean(changes), noteId, confirmedAt: stamp };
  }

  // T3.1 — a first-class place for an agent to put something it *learned*.
  //
  // The vault was one-way: every note was derived from an event, so an agent that discovered "this
  // API rate-limits at 30/min" had nowhere to record it except prose in a report, where retrieval
  // would never find it as a fact. devteam_memory action=set exists but writes flat key/value notes outside
  // the vault's category/status/confidence model.
  //
  // A written note is subject to exactly the same rules as a derived one — same redaction, same
  // slug, same upsert, same link indexing — with two deliberate limits:
  //
  //   * status is never `verified`. An agent asserting something is `inferred`, however sure it
  //     sounds. `verified` means DevTeam watched it happen (a completed assignment, an adopted
  //     proposal), and letting an agent claim it would make the distinction worthless exactly where
  //     it matters most: deciding what to believe in the next session's briefing.
  //   * `sessions` and `archive` are not writable categories. They are DevTeam's own bookkeeping.
  write({ projectId, category, title, body, confidence = "medium", relatedFiles = [], author = "agent", taskId = null, eventId = null }) {
    if (!this.enabled) return { written: false, reason: "The knowledge vault is disabled for this server." };
    const cleanCategory = String(category || "").trim().toLowerCase();
    if (!CATEGORIES.includes(cleanCategory)) {
      throw new Error(`Unknown knowledge category "${category}". Use one of: ${CATEGORIES.join(", ")}.`);
    }
    const cleanTitle = String(title || "").trim();
    const cleanBody = String(body || "").trim();
    if (!cleanTitle) throw new Error("A knowledge note needs a title.");
    if (!cleanBody) throw new Error("A knowledge note needs a body — the fact you learned, in a sentence or two.");
    const cleanConfidence = ["low", "medium", "high"].includes(String(confidence).toLowerCase())
      ? String(confidence).toLowerCase() : "medium";
    const stamp = new Date().toISOString();
    const slug = slugify(cleanTitle);
    const id = this.#upsert({
      projectId, category: cleanCategory, slug,
      title: redact(cleanTitle), body: redact(cleanBody),
      status: "inferred",
      confidence: cleanConfidence,
      sourceTaskId: taskId, sourceEventId: eventId, sourceAuthor: author,
      relatedFiles, createdAt: stamp,
      provenance: { type: "agent.note", eventId: eventId ?? null, author, at: stamp },
    });
    const note = this.db.prepare("SELECT * FROM knowledge_notes WHERE id = ?").get(id);
    // T3.2: does this disagree with something the project already believes? Detected on write, while
    // the agent that wrote it is still here and can say which is right — not months later when a
    // briefing quietly serves one of two contradictory "verified" facts.
    const conflicts = this.#conflictCandidates(projectId, {
      category: cleanCategory, title: cleanTitle, body: cleanBody, relatedFiles,
    }, id);
    return {
      written: true,
      note: {
        id, category: cleanCategory, slug, title: note.title, status: note.status,
        confidence: note.confidence, revision: note.revision,
        link: `[[${cleanCategory}/${slug}]]`,
      },
      links: this.outboundLinks(id),
      backlinks: this.backlinks(id),
      ...(conflicts.length ? {
        possibleConflicts: conflicts,
        conflictNext: "These existing notes are about the same subject and say something different. If one is wrong, supersede it; if the team disagrees, raise it with devteam_propose — do not leave two contradictory facts standing.",
      } : {}),
      next: "Written as an inferred note. It becomes verified only when DevTeam observes it, not by asserting it.",
    };
  }

  #reconcileGeneratedFiles(vault, expected) {
    for (const folder of [...CATEGORIES, "sessions", "archive"]) {
      const directory = path.join(vault, folder);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const relative = `${folder}/${entry.name}`;
        if (expected.has(relative)) continue;
        const file = path.join(directory, entry.name);
        const info = lstatSync(file);
        if (info.isSymbolicLink() || info.size > 1_000_000) continue;
        const header = readFileSync(file, "utf8").slice(0, 4_096);
        if (/^generated_by:\s*DevTeam\s*$/m.test(header)) unlinkSync(file);
      }
    }
  }

  #writeIndex(project, vault, notes) {
    const lines = [
      "---", `project: ${yamlString(project.name)}`, "generated_by: DevTeam", `updated: ${yamlString(new Date().toISOString())}`, "---", "",
      `# ${project.name} knowledge`, "", "Start with [[CURRENT]]. This vault is maintained automatically from DevTeam events.", "",
    ];
    for (const category of [...CATEGORIES, "archive"]) {
      const categoryNotes = notes.filter((note) => (category === "archive" ? note.status === "archived" || note.category === "archive" : note.category === category && note.status !== "archived"));
      lines.push(`## ${category[0].toUpperCase()}${category.slice(1)}`, "");
      lines.push(...(categoryNotes.length
        ? categoryNotes.map((note) => `- [[${category}/${note.slug}|${short(note.title, 140)}]] — ${note.status}, ${note.confidence} confidence`)
        : ["- No notes yet."]));
      lines.push("");
    }
    atomicWrite(path.join(vault, "INDEX.md"), lines.join("\n"));
  }

  list(projectId, { limit = 20 } = {}) {
    return this.db.prepare(`
      SELECT id, category, slug, title, status, confidence, source_task_id, source_event_id,
             source_author, related_files, created_at, updated_at, verified_at, revision,
             superseded_by, stale_reason, status_changed_at, last_validated_at, last_validated_version
      FROM knowledge_notes WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?
    `).all(projectId, Math.max(1, Math.min(100, Number(limit) || 20))).map((note) => ({
      ...note, title: short(note.title, 200), relatedFiles: parseJson(note.related_files, []), related_files: undefined,
      link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
    }));
  }

  // The claim a note makes, taken from its own first sentence. Generated notes lead with their
  // conclusion — "Security review complete — do not approve v2 yet", "RESEARCH COMPLETE — ALG6
  // onboarding integration map" — so the first sentence is the note, and the rest is evidence for it.
  static headline(body) {
    for (const line of String(body || "").split(/\r?\n/u)) {
      const cleaned = line.trim().replace(/^#+\s*/u, "").replace(/^[-*]\s+/u, "").trim();
      if (!cleaned) continue;
      return short(cleaned.split(/(?<=[.!?])\s+/u)[0] || cleaned, 200);
    }
    return "";
  }

  // Headlines for breadth, bodies for the few that are almost certainly relevant.
  //
  // Measured before this existed: the ranker did the work of choosing the best 30 notes out of 626,
  // handed back 46 KB of them, and the brief's 6 KB knowledge budget admitted **three**. Twenty-seven
  // ranked notes were dropped for want of bytes, every single brief. Paying 1.5 KB per note to see
  // three of them is the least efficient possible use of that budget.
  //
  // A note's first sentence is its claim, and a claim is what tells an agent whether it needs the
  // rest. So the top few keep their bodies — that detail is worth pushing unasked — and the tail
  // arrives as one line each with its `[[wikilink]]`, which `devteam_memory` reads in full on
  // demand. Same budget, an order of magnitude more of the vault visible.
  relevant(projectId, taskId, limit = 12, context = {}, { bodyCount = 2, bodyBytes = 800 } = {}) {
    const rows = this.db.prepare(`
      SELECT notes.id, notes.category, notes.slug, notes.title, notes.body, notes.status, notes.confidence,
             notes.source_task_id, notes.source_event_id, notes.source_author, notes.related_files,
             notes.updated_at, notes.verified_at, notes.revision, notes.superseded_by, notes.stale_reason,
             notes.status_changed_at, notes.last_validated_at, notes.last_validated_version,
             source.metadata AS source_metadata
      FROM knowledge_notes notes LEFT JOIN events source ON source.id = notes.source_event_id
      WHERE notes.project_id = ? AND notes.status IN ('verified', 'inferred')
      ORDER BY CASE WHEN notes.source_task_id = ? THEN 0 ELSE 1 END, notes.updated_at DESC, notes.id ASC
      LIMIT 500
    `).all(projectId, taskId);
    const candidates = rows.map((note) => ({ ...note, relatedFiles: parseJson(note.related_files, []) }));
    const ranked = rankKnowledgeNotes(candidates, { ...context, taskId }, Math.max(1, Math.min(30, Number(limit) || 12)));
    return ranked.map((note, index) => {
      // Deliberately a small, fixed shape rather than the whole row. Revision counters, event ids,
      // validation stamps and status timestamps are bookkeeping the reader cannot act on, and they
      // were being charged to the same budget as the knowledge itself.
      const lean = {
        id: note.id,
        category: note.category,
        title: short(note.title, 200),
        headline: KnowledgeVault.headline(note.body),
        status: note.status,
        confidence: note.confidence,
        // A headline-only note is a pointer; four paths is plenty to judge relevance by, and the
        // full list comes with the body when the agent asks for it.
        relatedFiles: parseJson(note.related_files, []).slice(0, index < bodyCount ? 20 : 4),
        whyIncluded: note.whyIncluded,
        link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
      };
      if (index < bodyCount) lean.body = clip(note.body, bodyBytes);
      return lean;
    });
  }

  search(projectId, taskId, { query = "", category = null, status = null, limit = 20 } = {}) {
    const clauses = ["project_id = ?"];
    const args = [projectId];
    if (category) { clauses.push("category = ?"); args.push(category); }
    if (status) { clauses.push("status = ?"); args.push(status); }
    else clauses.push("status IN ('verified', 'inferred')");
    const cleanQuery = String(query || "").trim();
    const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
    const columns = `id, category, slug, title, body, status, confidence, source_task_id, source_event_id,
             source_author, related_files, updated_at, verified_at, revision,
             superseded_by, stale_reason, status_changed_at, last_validated_at, last_validated_version`;

    // Ranked retrieval when there is something to rank. Relevance leads, and the previous ordering —
    // this task's own notes first, then verified, then recent — breaks ties within it, so a note from
    // the task at hand still wins against an equally relevant one from somewhere else. Title is
    // weighted well above body: a note *about* a thing beats one that mentions it in passing.
    let rows = null;
    const matchExpression = cleanQuery && this.ftsEnabled ? this.#ftsQuery(cleanQuery) : null;
    if (matchExpression) {
      try {
        rows = this.db.prepare(`
          SELECT ${columns}
          FROM knowledge_notes
          JOIN knowledge_fts ON knowledge_fts.note_id = knowledge_notes.id
          WHERE ${clauses.join(" AND ")} AND knowledge_fts MATCH ?
          ORDER BY bm25(knowledge_fts, 6.0, 1.0, 2.0),
                   CASE WHEN source_task_id = ? THEN 0 ELSE 1 END, verified_at IS NULL, updated_at DESC
          LIMIT ?
        `).all(...args, matchExpression, taskId, bounded);
      } catch {
        rows = null; // a match expression SQLite refuses degrades to the fallback, never to an error
      }
    }

    // No query, no FTS5 in this SQLite build, or a ranked search that found nothing: fall back to
    // exactly the previous behaviour. The fallback earns its place — FTS matches whole tokens, so a
    // search for a fragment inside a word finds nothing until LIKE answers it.
    if (!rows || !rows.length) {
      const fallbackClauses = [...clauses];
      const fallbackArgs = [...args];
      if (cleanQuery) {
        fallbackClauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR related_files LIKE ? ESCAPE '\\')");
        const escaped = cleanQuery.replace(/[\\%_]/g, (match) => `\\${match}`);
        fallbackArgs.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
      }
      rows = this.db.prepare(`
        SELECT ${columns}
        FROM knowledge_notes WHERE ${fallbackClauses.join(" AND ")}
        ORDER BY CASE WHEN source_task_id = ? THEN 0 ELSE 1 END, verified_at IS NULL, updated_at DESC
        LIMIT ?
      `).all(...fallbackArgs, taskId, bounded);
    }
    return rows.map((note) => ({
      ...note, title: short(note.title, 200), body: clip(note.body, 4_000), relatedFiles: parseJson(note.related_files, []), related_files: undefined,
      link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
    }));
  }
}
