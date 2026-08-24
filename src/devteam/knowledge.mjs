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
const MAX_NOTE_BODY = 24_000;
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
    const sourceAssignmentId = parseJson(note.source_metadata, {})?.assignmentId || null;
    return { ...note, relevanceScore: score, whyIncluded: why.slice(0, 5).join(", "), sourceAssignmentId };
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
    ]) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE knowledge_notes ADD COLUMN ${column} ${ddl}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_project_status
        ON knowledge_notes(project_id, status, updated_at DESC);
    `);
  }

  initializeProject(projectId) {
    if (!this.enabled) return null;
    this.db.prepare("INSERT OR IGNORE INTO knowledge_state (project_id, last_event_id) VALUES (?, 0)").run(projectId);
    this.#importLegacy(projectId);
    this.#syncProjectEvents(projectId);
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
    return this.exportProject(task.project_id);
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
      const checks = Array.isArray(metadata.checks) ? metadata.checks.map((item) => clip(item, 500)).filter(Boolean).slice(0, 50) : [];
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
    const id = createHash("sha256").update(`${note.projectId}:${note.category}:${note.slug}`).digest("hex").slice(0, 24);
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
    this.#reconcileGeneratedFiles(vault, expected);
    this.db.prepare("UPDATE knowledge_state SET exported_at = ? WHERE project_id = ?").run(new Date().toISOString(), projectId);
    return { path: vault, noteCount: notes.length, updatedAt: new Date().toISOString() };
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

  relevant(projectId, taskId, limit = 12, context = {}) {
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
    return rankKnowledgeNotes(candidates, { ...context, taskId }, Math.max(1, Math.min(30, Number(limit) || 12))).map((note) => ({
      ...note, title: short(note.title, 200), body: clip(note.body, 1_200), relatedFiles: parseJson(note.related_files, []), related_files: undefined,
      source_metadata: undefined, sourceAssignmentId: undefined,
      link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
    }));
  }

  search(projectId, taskId, { query = "", category = null, status = null, limit = 20 } = {}) {
    const clauses = ["project_id = ?"];
    const args = [projectId];
    if (category) { clauses.push("category = ?"); args.push(category); }
    if (status) { clauses.push("status = ?"); args.push(status); }
    else clauses.push("status IN ('verified', 'inferred')");
    const cleanQuery = String(query || "").trim();
    if (cleanQuery) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR related_files LIKE ? ESCAPE '\\')");
      const escaped = cleanQuery.replace(/[\\%_]/g, (match) => `\\${match}`);
      args.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    args.push(taskId, Math.max(1, Math.min(50, Number(limit) || 20)));
    const rows = this.db.prepare(`
      SELECT id, category, slug, title, body, status, confidence, source_task_id, source_event_id,
             source_author, related_files, updated_at, verified_at, revision,
             superseded_by, stale_reason, status_changed_at, last_validated_at, last_validated_version
      FROM knowledge_notes WHERE ${clauses.join(" AND ")}
      ORDER BY CASE WHEN source_task_id = ? THEN 0 ELSE 1 END, verified_at IS NULL, updated_at DESC
      LIMIT ?
    `).all(...args);
    return rows.map((note) => ({
      ...note, title: short(note.title, 200), body: clip(note.body, 4_000), relatedFiles: parseJson(note.related_files, []), related_files: undefined,
      link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
    }));
  }
}
