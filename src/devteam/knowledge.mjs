import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
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

function categoryForKey(key) {
  const value = String(key || "").toLowerCase();
  if (/architect|design|system/.test(value)) return "architecture";
  if (/decision|adr|choice/.test(value)) return "decisions";
  if (/component|module|service|package/.test(value)) return "components";
  if (/pitfall|risk|bug|warning|gotcha/.test(value)) return "pitfalls";
  if (/workflow|process|test|release|deploy/.test(value)) return "workflows";
  return "conventions";
}

function frontmatter(note) {
  const files = parseJson(note.related_files, []);
  const provenance = parseJson(note.provenance, []);
  return [
    "---",
    `title: ${yamlString(short(note.title, 200))}`,
    `category: ${note.category}`,
    `status: ${note.status}`,
    `confidence: ${note.confidence}`,
    `created: ${yamlString(note.created_at)}`,
    `updated: ${yamlString(note.updated_at)}`,
    `verified: ${note.verified_at ? yamlString(note.verified_at) : "null"}`,
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
      const changedFiles = safeFiles(metadata.changedFiles);
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
      this.#upsert({ ...common, category, slug: `${blocked ? "blocker" : "work"}-${event.id}-${slugify(assignment?.title || role)}`,
        title: assignment?.title || `${role} ${blocked ? "blocker" : "result"}`, body: clip(body),
        status: blocked ? "disputed" : "verified", confidence: blocked ? "medium" : "high",
        relatedFiles: changedFiles, verifiedAt: blocked ? null : event.created_at });
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
        source_event_id, source_author, related_files, provenance, created_at, updated_at, verified_at, revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, body = excluded.body, status = excluded.status, confidence = excluded.confidence,
        source_task_id = excluded.source_task_id, source_event_id = excluded.source_event_id,
        source_author = excluded.source_author, related_files = excluded.related_files,
        provenance = excluded.provenance, updated_at = excluded.updated_at,
        verified_at = COALESCE(excluded.verified_at, knowledge_notes.verified_at), revision = knowledge_notes.revision + 1
    `).run(id, note.projectId, note.category, note.slug, short(note.title, 200), clip(note.body), note.status,
      note.confidence, note.sourceTaskId || null, note.sourceEventId ?? null, note.sourceAuthor || "system",
      JSON.stringify(relatedFiles), JSON.stringify(provenance), existing?.created_at || note.createdAt,
      note.createdAt, note.verifiedAt || null);
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
      atomicWrite(path.join(vault, folder, `${note.slug}.md`), content);
    }
    this.#writeCurrent(project, vault);
    this.#writeIndex(project, vault, notes);
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
    for (const task of tasks) {
      const events = this.db.prepare("SELECT type, message, created_at FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 30").all(task.id).reverse();
      const content = [
        "---", `task_id: ${yamlString(task.id)}`, `status: ${task.status}`, `version: ${task.version}`,
        `updated: ${yamlString(task.updated_at)}`, "generated_by: DevTeam", "---", "", `# ${task.title}`, "", task.description, "",
        "## Timeline summary", "", ...events.map((event) => `- ${event.created_at} · **${event.type}** · ${clip(event.message, 500)}`), "",
      ].join("\n");
      atomicWrite(path.join(vault, "sessions", `${stampDate(task.created_at)}-${slugify(task.title)}-${task.id.slice(0, 8)}.md`), content);
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
             source_author, related_files, created_at, updated_at, verified_at, revision
      FROM knowledge_notes WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?
    `).all(projectId, Math.max(1, Math.min(100, Number(limit) || 20))).map((note) => ({
      ...note, title: short(note.title, 200), relatedFiles: parseJson(note.related_files, []), related_files: undefined,
      link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
    }));
  }

  relevant(projectId, taskId, limit = 12) {
    const rows = this.db.prepare(`
      SELECT id, category, slug, title, body, status, confidence, source_task_id, source_event_id,
             source_author, related_files, updated_at, verified_at, revision
      FROM knowledge_notes WHERE project_id = ?
      ORDER BY CASE WHEN source_task_id = ? THEN 0 ELSE 1 END, verified_at IS NULL, updated_at DESC
      LIMIT ?
    `).all(projectId, taskId, Math.max(1, Math.min(30, Number(limit) || 12)));
    return rows.map((note) => ({
      ...note, title: short(note.title, 200), body: clip(note.body, 1_200), relatedFiles: parseJson(note.related_files, []), related_files: undefined,
      link: `[[${note.status === "archived" || note.category === "archive" ? "archive" : note.category}/${note.slug}]]`,
    }));
  }

  search(projectId, taskId, { query = "", category = null, status = null, limit = 20 } = {}) {
    const clauses = ["project_id = ?"];
    const args = [projectId];
    if (category) { clauses.push("category = ?"); args.push(category); }
    if (status) { clauses.push("status = ?"); args.push(status); }
    const cleanQuery = String(query || "").trim();
    if (cleanQuery) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR related_files LIKE ? ESCAPE '\\')");
      const escaped = cleanQuery.replace(/[\\%_]/g, (match) => `\\${match}`);
      args.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    args.push(taskId, Math.max(1, Math.min(50, Number(limit) || 20)));
    const rows = this.db.prepare(`
      SELECT id, category, slug, title, body, status, confidence, source_task_id, source_event_id,
             source_author, related_files, updated_at, verified_at, revision
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
