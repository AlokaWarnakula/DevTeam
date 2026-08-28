import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { atomicWrite, redact, secretLike, slugify, vaultOwner } from "./knowledge.mjs";
import { buildParserRegistry, MAX_EXPORTS, MAX_IMPORTS, MAX_SPECIFIER_LENGTH, MAX_SYMBOL_LENGTH } from "./parsers.mjs";

// Which file types are artifacts, and how each is read, now comes from the parser registry rather
// than a JS/TS list here. See parsers.mjs for the interface and why every parser is a bounded regex.
const REGISTRY = buildParserRegistry((value, max) => safeString(value, max));
const SOURCE_EXTENSIONS = REGISTRY.extensions;
const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".cache", ".turbo", "knowledge",
]);
const MAX_FILE_BYTES = 256 * 1024;
const GENERATED_MARKER = "generated_by: DevTeam CodeGraph";

const now = () => new Date().toISOString();
const parseJson = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const uniqueSorted = (values, limit = Infinity) => [...new Set(values)].sort().slice(0, limit);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const posix = (value) => String(value || "").replace(/\\/g, "/");
const safeString = (value, max) => redact(String(value || "").trim()).slice(0, max);

function languageFor(file) {
  return REGISTRY.for(file)?.language(file) || null;
}

// Kept only so the existing JS/TS unit expectations keep a name to call. New work should go through
// the registry, which is what the scanner uses.
function parseSource(source, filePath = "file.mjs") {
  const parser = REGISTRY.for(filePath);
  if (!parser) return { exports: [], imports: [], dependencies: [] };
  const parsed = parser.parse(source, filePath);
  return {
    exports: parsed.exports,
    imports: parsed.imports,
    // What counts as "outside the project" is the parser's call: `./x` in JavaScript, a leading dot
    // in Python, and nothing at all in prose, where every specifier is a path.
    dependencies: parsed.imports.filter((specifier) => parser.external(specifier)),
  };
}


export class CodeGraph {
  constructor(db, {
    enabled = false,
    maxModules = 3000,
    reconcileThrottleMs = 7_500,
    maxReconcileCandidates = 200,
    maxContextBytes = 7_168,
  } = {}) {
    this.db = db;
    this.enabled = Boolean(enabled);
    this.maxModules = Math.max(1, Number(maxModules) || 3000);
    this.reconcileThrottleMs = Math.max(0, Number(reconcileThrottleMs) || 0);
    this.maxReconcileCandidates = Math.max(1, Number(maxReconcileCandidates) || 200);
    this.maxContextBytes = Math.max(1024, Number(maxContextBytes) || 7_168);
    this.inFlight = new Set();
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_modules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        mtime_ms INTEGER NOT NULL DEFAULT 0,
        exports TEXT NOT NULL,
        dependencies TEXT NOT NULL,
        loc INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, path)
      );
      CREATE TABLE IF NOT EXISTS code_imports (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_path TEXT NOT NULL,
        specifier TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'import',
        is_bare INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, from_path, specifier, kind)
      );
      CREATE TABLE IF NOT EXISTS code_edges (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_path TEXT NOT NULL,
        to_path TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'import',
        PRIMARY KEY (project_id, from_path, to_path, kind)
      );
      CREATE TABLE IF NOT EXISTS code_graph_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        last_event_id INTEGER NOT NULL DEFAULT 0,
        initialized INTEGER NOT NULL DEFAULT 0,
        dirty INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT,
        reconciled_at TEXT,
        last_full_scan_at TEXT,
        module_count INTEGER NOT NULL DEFAULT 0,
        edge_count INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_code_modules_project ON code_modules(project_id, path);
      CREATE INDEX IF NOT EXISTS idx_code_imports_project ON code_imports(project_id, from_path);
      CREATE INDEX IF NOT EXISTS idx_code_edges_from ON code_edges(project_id, from_path);
      CREATE INDEX IF NOT EXISTS idx_code_edges_to ON code_edges(project_id, to_path);
    `);
    const moduleColumns = new Set(this.db.prepare("PRAGMA table_info(code_modules)").all().map((column) => column.name));
    for (const [name, ddl] of [["size", "INTEGER NOT NULL DEFAULT 0"], ["mtime_ms", "INTEGER NOT NULL DEFAULT 0"]]) {
      if (!moduleColumns.has(name)) this.db.exec(`ALTER TABLE code_modules ADD COLUMN ${name} ${ddl}`);
    }
    const columns = new Set(this.db.prepare("PRAGMA table_info(code_graph_state)").all().map((column) => column.name));
    for (const [name, ddl] of [
      ["last_event_id", "INTEGER NOT NULL DEFAULT 0"], ["initialized", "INTEGER NOT NULL DEFAULT 0"],
      ["dirty", "INTEGER NOT NULL DEFAULT 0"], ["indexed_at", "TEXT"], ["reconciled_at", "TEXT"],
      ["last_full_scan_at", "TEXT"], ["module_count", "INTEGER NOT NULL DEFAULT 0"],
      ["edge_count", "INTEGER NOT NULL DEFAULT 0"], ["truncated", "INTEGER NOT NULL DEFAULT 0"],
    ]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE code_graph_state ADD COLUMN ${name} ${ddl}`);
    }
  }

  #transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #ensureState(projectId) {
    this.db.prepare("INSERT OR IGNORE INTO code_graph_state (project_id) VALUES (?)").run(projectId);
    return this.db.prepare("SELECT * FROM code_graph_state WHERE project_id = ?").get(projectId);
  }

  #projectRoot(projectId) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("CodeGraph project not found.");
    const realRoot = realpathSync(path.resolve(project.root));
    if (!lstatSync(realRoot).isDirectory()) throw new Error("CodeGraph project root is not a directory.");
    return { project, realRoot };
  }

  #insideRoot(realRoot, absolute) {
    const relative = path.relative(realRoot, absolute);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  #normalizeChanged(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 500 || path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return null;
    const normalized = path.posix.normalize(posix(raw).replace(/^\.\//, ""));
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return null;
    return secretLike(normalized) ? null : normalized;
  }

  #inventory(projectId) {
    const { project, realRoot } = this.#projectRoot(projectId);
    const files = [];
    const visited = new Set([realRoot]);
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
          let realDirectory;
          try { realDirectory = realpathSync(absolute); } catch { continue; }
          if (!this.#insideRoot(realRoot, realDirectory) || visited.has(realDirectory)) continue;
          visited.add(realDirectory);
          walk(realDirectory);
          continue;
        }
        if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        let info;
        try { info = lstatSync(absolute); } catch { continue; }
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) continue;
        let realFile;
        try { realFile = realpathSync(absolute); } catch { continue; }
        if (!this.#insideRoot(realRoot, realFile)) continue;
        const relative = posix(path.relative(realRoot, realFile));
        if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative) || secretLike(relative)) continue;
        files.push({ path: relative, absolute: realFile, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) });
      }
    };
    walk(realRoot);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { project, realRoot, files, truncated: files.length > this.maxModules };
  }

  #readCandidate(item, existing = null) {
    let body;
    try { body = readFileSync(item.absolute); } catch { return { invalid: true, path: item.path }; }
    if (body.length > MAX_FILE_BYTES || body.includes(0)) return { invalid: true, path: item.path };
    let source;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { return { invalid: true, path: item.path }; }
    if (source.includes("\uFFFD")) return { invalid: true, path: item.path };
    const hash = sha(body);
    if (existing?.hash === hash) return { unchanged: true, path: item.path, size: item.size, mtimeMs: item.mtimeMs };
    const parsed = parseSource(source, item.path);
    return {
      id: sha(`${item.projectId}:${item.path}`).slice(0, 24),
      path: safeString(item.path, 500),
      language: languageFor(item.path),
      hash,
      size: item.size,
      mtimeMs: item.mtimeMs,
      exports: parsed.exports,
      dependencies: parsed.dependencies,
      imports: parsed.imports,
      loc: source.length ? source.split(/\r?\n/).length : 0,
      updatedAt: now(),
    };
  }

  #upsertModule(projectId, module) {
    this.db.prepare(`
      INSERT INTO code_modules (id, project_id, path, language, hash, size, mtime_ms, exports, dependencies, loc, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET id = excluded.id, language = excluded.language,
        hash = excluded.hash, size = excluded.size, mtime_ms = excluded.mtime_ms, exports = excluded.exports,
        dependencies = excluded.dependencies, loc = excluded.loc, updated_at = excluded.updated_at
    `).run(module.id, projectId, module.path, module.language, module.hash, module.size, module.mtimeMs,
      JSON.stringify(module.exports), JSON.stringify(module.dependencies), module.loc, module.updatedAt);
    this.db.prepare("DELETE FROM code_imports WHERE project_id = ? AND from_path = ?").run(projectId, module.path);
    const insert = this.db.prepare("INSERT OR IGNORE INTO code_imports (project_id, from_path, specifier, kind, is_bare) VALUES (?, ?, ?, 'import', ?)");
    for (const specifier of module.imports) insert.run(projectId, module.path, specifier, specifier.startsWith("./") || specifier.startsWith("../") ? 0 : 1);
  }

  #deleteModule(projectId, modulePath) {
    this.db.prepare("DELETE FROM code_imports WHERE project_id = ? AND from_path = ?").run(projectId, modulePath);
    this.db.prepare("DELETE FROM code_edges WHERE project_id = ? AND (from_path = ? OR to_path = ?)").run(projectId, modulePath, modulePath);
    this.db.prepare("DELETE FROM code_modules WHERE project_id = ? AND path = ?").run(projectId, modulePath);
  }

  // Resolution belongs to the parser: `./util` means util.ts in JavaScript, `from .util import x`
  // means util/__init__.py in Python, and `[[decisions/x]]` in prose means a Markdown file. Each
  // parser proposes candidates in preference order and the first one that actually exists wins, so
  // a parser may guess freely — a wrong guess costs an edge, never a wrong edge.
  #resolveImport(fromPath, specifier, inventory) {
    const parser = REGISTRY.for(fromPath);
    if (!parser) return null;
    for (const candidate of parser.resolve(specifier, fromPath).slice(0, 20)) {
      const normalized = path.posix.normalize(candidate);
      if (normalized && !normalized.startsWith("..") && inventory.has(normalized)) return normalized;
    }
    return null;
  }

  #rebuildEdges(projectId) {
    const inventory = new Set(this.db.prepare("SELECT path FROM code_modules WHERE project_id = ?").all(projectId).map((row) => row.path));
    // Every recorded import is offered for resolution, not just the ones classified as intra-project.
    // Python's `from mypkg.core import x` is "bare" by its parser's externality rule and still names a
    // file in this repo; resolution is what decides, and it only ever answers with a file that exists.
    const imports = this.db.prepare("SELECT from_path, specifier, kind FROM code_imports WHERE project_id = ? ORDER BY from_path, specifier").all(projectId);
    this.db.prepare("DELETE FROM code_edges WHERE project_id = ?").run(projectId);
    const insert = this.db.prepare("INSERT OR IGNORE INTO code_edges (project_id, from_path, to_path, kind) VALUES (?, ?, ?, ?)");
    for (const item of imports) {
      if (!inventory.has(item.from_path)) continue;
      const target = this.#resolveImport(item.from_path, item.specifier, inventory);
      if (target) insert.run(projectId, item.from_path, target, item.kind);
    }
  }

  #counts(projectId) {
    return {
      moduleCount: Number(this.db.prepare("SELECT COUNT(*) AS count FROM code_modules WHERE project_id = ?").get(projectId).count),
      edgeCount: Number(this.db.prepare("SELECT COUNT(*) AS count FROM code_edges WHERE project_id = ?").get(projectId).count),
    };
  }

  #maxProjectEvent(projectId) {
    return Number(this.db.prepare(`SELECT COALESCE(MAX(e.id), 0) AS id FROM events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ?`).get(projectId).id);
  }

  initializeProject(projectId) {
    if (!this.enabled) return null;
    const state = this.#ensureState(projectId);
    return state.initialized ? this.reconcileProject(projectId, { force: true }) : this.fullReconcile(projectId);
  }

  fullReconcile(projectId) {
    if (!this.enabled) return null;
    if (this.inFlight.has(projectId)) return this.projectState(projectId);
    this.inFlight.add(projectId);
    try {
      this.#ensureState(projectId);
      const inventory = this.#inventory(projectId);
      const existing = new Map(this.db.prepare("SELECT * FROM code_modules WHERE project_id = ?").all(projectId).map((row) => [row.path, row]));
      const selectedPaths = new Set();
      const results = [];
      for (const inventoryItem of inventory.files) {
        if (selectedPaths.size >= this.maxModules) break;
        const item = { ...inventoryItem, projectId };
        const stored = existing.get(item.path);
        if (stored && stored.size === item.size && stored.mtime_ms === item.mtimeMs) {
          selectedPaths.add(item.path);
          continue;
        }
        const result = this.#readCandidate(item, stored);
        results.push(result);
        if (!result.invalid) selectedPaths.add(item.path);
      }
      const stamp = now();
      this.#transaction(() => {
        for (const result of results) {
          if (result.invalid) this.#deleteModule(projectId, result.path);
          else if (result.unchanged) this.db.prepare("UPDATE code_modules SET size = ?, mtime_ms = ? WHERE project_id = ? AND path = ?")
            .run(result.size, result.mtimeMs, projectId, result.path);
          else this.#upsertModule(projectId, result);
        }
        for (const storedPath of existing.keys()) if (!selectedPaths.has(storedPath)) this.#deleteModule(projectId, storedPath);
        this.#rebuildEdges(projectId);
        const counts = this.#counts(projectId);
        this.db.prepare(`
          UPDATE code_graph_state SET last_event_id = ?, initialized = 1, dirty = 0, indexed_at = ?,
            reconciled_at = ?, last_full_scan_at = ?, module_count = ?, edge_count = ?, truncated = ?
          WHERE project_id = ?
        `).run(this.#maxProjectEvent(projectId), stamp, stamp, stamp, counts.moduleCount, counts.edgeCount, inventory.truncated ? 1 : 0, projectId);
      });
      this.exportProject(projectId);
      return this.projectState(projectId);
    } finally {
      this.inFlight.delete(projectId);
    }
  }

  #explicitItem(realRoot, projectId, relative) {
    const absolute = path.resolve(realRoot, ...relative.split("/"));
    if (!this.#insideRoot(realRoot, absolute)) return null;
    const info = statSync(absolute, { throwIfNoEntry: false });
    if (!info) return { missing: true, path: relative };
    let lexicalInfo;
    try { lexicalInfo = lstatSync(absolute); } catch { return { missing: true, path: relative }; }
    if (!lexicalInfo.isFile() || lexicalInfo.isSymbolicLink() || lexicalInfo.size > MAX_FILE_BYTES || !SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase())) {
      return { invalid: true, path: relative };
    }
    let realFile;
    try { realFile = realpathSync(absolute); } catch { return { invalid: true, path: relative }; }
    if (!this.#insideRoot(realRoot, realFile)) return { invalid: true, path: relative };
    return { path: relative, absolute: realFile, size: lexicalInfo.size, mtimeMs: Math.trunc(lexicalInfo.mtimeMs), projectId };
  }

  syncTask(taskId) {
    if (!this.enabled || !taskId) return null;
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) return null;
    const state = this.#ensureState(task.project_id);
    if (!state.initialized) return this.fullReconcile(task.project_id);
    const events = this.db.prepare(`
      SELECT e.id, e.type, e.metadata FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE t.project_id = ? AND e.id > ? ORDER BY e.id ASC
    `).all(task.project_id, state.last_event_id || 0);
    const changed = [];
    let lastEventId = state.last_event_id || 0;
    let sawAssignmentResult = false;
    for (const event of events) {
      lastEventId = Math.max(lastEventId, event.id);
      if (!['assignment.completed', 'assignment.blocked'].includes(event.type)) continue;
      sawAssignmentResult = true;
      const metadata = parseJson(event.metadata, {});
      for (const file of Array.isArray(metadata.changedFiles) ? metadata.changedFiles : []) {
        const normalized = this.#normalizeChanged(file);
        if (normalized) changed.push(normalized);
      }
    }
    const paths = uniqueSorted(changed);
    if (!paths.length) {
      this.db.prepare("UPDATE code_graph_state SET last_event_id = ?, dirty = CASE WHEN ? THEN 1 ELSE dirty END WHERE project_id = ?")
        .run(lastEventId, sawAssignmentResult ? 1 : 0, task.project_id);
      return this.projectState(task.project_id);
    }
    const { realRoot } = this.#projectRoot(task.project_id);
    const existing = new Map(this.db.prepare("SELECT * FROM code_modules WHERE project_id = ?").all(task.project_id).map((row) => [row.path, row]));
    const results = paths.map((file) => this.#explicitItem(realRoot, task.project_id, file))
      .filter(Boolean).map((item) => item.missing || item.invalid ? item : this.#readCandidate(item, existing.get(item.path)));
    const stamp = now();
    this.#transaction(() => {
      for (const result of results) {
        if (result.missing || result.invalid) this.#deleteModule(task.project_id, result.path);
        else if (result.unchanged) this.db.prepare("UPDATE code_modules SET size = ?, mtime_ms = ? WHERE project_id = ? AND path = ?")
          .run(result.size, result.mtimeMs, task.project_id, result.path);
        else this.#upsertModule(task.project_id, result);
      }
      this.#rebuildEdges(task.project_id);
      const counts = this.#counts(task.project_id);
      this.db.prepare(`UPDATE code_graph_state SET last_event_id = ?, dirty = 1, indexed_at = ?, module_count = ?, edge_count = ? WHERE project_id = ?`)
        .run(lastEventId, stamp, counts.moduleCount, counts.edgeCount, task.project_id);
    });
    this.exportProject(task.project_id);
    return this.projectState(task.project_id);
  }

  reconcileProject(projectId, { force = false, maxCandidates = this.maxReconcileCandidates } = {}) {
    if (!this.enabled) return null;
    const state = this.#ensureState(projectId);
    if (!state.initialized) return this.fullReconcile(projectId);
    const reconciledAt = Date.parse(state.reconciled_at || 0);
    if (!force && !state.dirty && Number.isFinite(reconciledAt) && Date.now() - reconciledAt < this.reconcileThrottleMs) return this.projectState(projectId);
    if (this.inFlight.has(projectId)) return this.projectState(projectId);
    this.inFlight.add(projectId);
    try {
      const inventory = this.#inventory(projectId);
      const selected = inventory.files.slice(0, this.maxModules).map((item) => ({ ...item, projectId }));
      const selectedByPath = new Map(selected.map((item) => [item.path, item]));
      const existing = new Map(this.db.prepare("SELECT * FROM code_modules WHERE project_id = ?").all(projectId).map((row) => [row.path, row]));
      const candidates = [];
      for (const item of selected) {
        const stored = existing.get(item.path);
        if (!stored || stored.size !== item.size || stored.mtime_ms !== item.mtimeMs) candidates.push({ type: "file", path: item.path, item });
      }
      for (const storedPath of existing.keys()) if (!selectedByPath.has(storedPath)) candidates.push({ type: "missing", path: storedPath });
      candidates.sort((a, b) => a.path.localeCompare(b.path));
      const work = candidates.slice(0, Math.max(1, Number(maxCandidates) || this.maxReconcileCandidates));
      const results = work.map((candidate) => candidate.type === "missing"
        ? { missing: true, path: candidate.path }
        : this.#readCandidate(candidate.item, existing.get(candidate.path)));
      const stamp = now();
      this.#transaction(() => {
        for (const result of results) {
          if (result.missing || result.invalid) this.#deleteModule(projectId, result.path);
          else if (result.unchanged) this.db.prepare("UPDATE code_modules SET size = ?, mtime_ms = ? WHERE project_id = ? AND path = ?")
            .run(result.size, result.mtimeMs, projectId, result.path);
          else this.#upsertModule(projectId, result);
        }
        if (results.length) this.#rebuildEdges(projectId);
        const counts = this.#counts(projectId);
        this.db.prepare(`
          UPDATE code_graph_state SET dirty = ?, indexed_at = COALESCE(?, indexed_at), reconciled_at = ?,
            module_count = ?, edge_count = ?, truncated = ? WHERE project_id = ?
        `).run(candidates.length > work.length ? 1 : 0, results.length ? stamp : null, stamp,
          counts.moduleCount, counts.edgeCount, inventory.truncated ? 1 : 0, projectId);
      });
      this.exportProject(projectId);
      return this.projectState(projectId);
    } finally {
      this.inFlight.delete(projectId);
    }
  }

  reconcileTask(taskId, options = {}) {
    if (!this.enabled) return null;
    const task = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId);
    return task ? this.reconcileProject(task.project_id, options) : null;
  }

  projectState(projectId) {
    if (!this.enabled) return null;
    const state = this.#ensureState(projectId);
    return {
      initialized: Boolean(state.initialized),
      moduleCount: Number(state.module_count || 0),
      edgeCount: Number(state.edge_count || 0),
      truncated: Boolean(state.truncated),
      indexedAt: state.indexed_at || null,
      reconciledAt: state.reconciled_at || null,
      lastFullScanAt: state.last_full_scan_at || null,
      dirty: Boolean(state.dirty),
    };
  }

  #graphRows(projectId) {
    const modules = this.db.prepare("SELECT * FROM code_modules WHERE project_id = ? ORDER BY path ASC").all(projectId);
    const edges = this.db.prepare("SELECT from_path, to_path, kind FROM code_edges WHERE project_id = ? ORDER BY from_path, to_path, kind").all(projectId);
    const outgoing = new Map();
    const incoming = new Map();
    for (const module of modules) { outgoing.set(module.path, []); incoming.set(module.path, []); }
    for (const edge of edges) {
      outgoing.get(edge.from_path)?.push(edge.to_path);
      incoming.get(edge.to_path)?.push(edge.from_path);
    }
    return { modules, edges, outgoing, incoming };
  }

  exportProject(projectId) {
    if (!this.enabled) return null;
    const { project, realRoot } = this.#projectRoot(projectId);
    // The graph shares the knowledge vault's directory, so it honours the vault's claim. Skipping
    // entirely rather than writing-without-deleting, which is what the knowledge exporter does: every
    // graph note is named from a hash of the project id, so a second project does not add a few
    // stray files, it writes a complete duplicate set under different names. And unlike knowledge,
    // nothing here is lost by skipping — the graph is derived from the code and rebuilds on demand.
    const owner = vaultOwner(path.join(realRoot, "knowledge"));
    if (owner && owner.projectId !== projectId) {
      return { path: null, skipped: "foreign-vault", vaultOwner: owner.project || owner.projectId };
    }
    const graphRoot = path.join(realRoot, "knowledge", "graph");
    mkdirSync(graphRoot, { recursive: true });
    const state = this.#ensureState(projectId);
    const { modules, edges, outgoing, incoming } = this.#graphRows(projectId);
    const filenames = new Map(modules.map((module) => [module.path, `${slugify(module.path)}-${module.id.slice(0, 8)}.md`]));
    const wiki = (modulePath) => `[[graph/${filenames.get(modulePath)?.replace(/\.md$/i, "")}|${modulePath}]]`;
    const semantic = {
      project: project.name,
      generatedBy: "DevTeam CodeGraph",
      truncated: Boolean(state.truncated),
      modules: modules.map((module) => ({
        path: module.path,
        language: module.language,
        exports: uniqueSorted(parseJson(module.exports, [])),
        dependencies: uniqueSorted(parseJson(module.dependencies, [])),
        imports: uniqueSorted(outgoing.get(module.path) || []),
        importedBy: uniqueSorted(incoming.get(module.path) || []),
      })),
      edges: edges.map((edge) => ({ from: edge.from_path, to: edge.to_path, kind: edge.kind })),
    };
    const graphPath = path.join(graphRoot, "graph.json");
    let previous = null;
    try { previous = JSON.parse(readFileSync(graphPath, "utf8")); } catch { previous = null; }
    const previousSemantic = previous ? { ...previous } : null;
    if (previousSemantic) delete previousSemantic.updated;
    if (JSON.stringify(previousSemantic) !== JSON.stringify(semantic)) {
      atomicWrite(graphPath, `${JSON.stringify({ ...semantic, updated: now() }, null, 2)}\n`);
    }

    const expectedNotes = new Set();
    for (const module of semantic.modules) {
      const filename = filenames.get(module.path);
      expectedNotes.add(filename);
      const lines = [
        "---", `path: ${JSON.stringify(module.path)}`, `language: ${module.language}`, GENERATED_MARKER, "---", "",
        `# ${module.path}`, "", "## Imports", "",
        ...(module.imports.length ? module.imports.map((item) => `- ${wiki(item)}`) : ["- None."]),
        "", "## Imported by", "",
        ...(module.importedBy.length ? module.importedBy.map((item) => `- ${wiki(item)}`) : ["- None."]),
        "", "## Exports", "", ...(module.exports.length ? module.exports.map((item) => `- \`${item}\``) : ["- None."]),
        "", "## External dependencies", "", ...(module.dependencies.length ? module.dependencies.map((item) => `- \`${item}\``) : ["- None."]), "",
      ];
      const content = lines.join("\n");
      const notePath = path.join(graphRoot, filename);
      let current = null;
      try { current = readFileSync(notePath, "utf8"); } catch { current = null; }
      if (current !== content) atomicWrite(notePath, content);
    }

    for (const filename of readdirSync(graphRoot).filter((file) => file.toLowerCase().endsWith(".md") && file !== "INDEX.md")) {
      if (expectedNotes.has(filename)) continue;
      const notePath = path.join(graphRoot, filename);
      let content = "";
      try { content = readFileSync(notePath, "utf8"); } catch { continue; }
      const frontmatterEnd = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
      if (frontmatterEnd !== -1 && content.slice(0, frontmatterEnd).includes(GENERATED_MARKER)) unlinkSync(notePath);
    }

    const hubs = semantic.modules.slice().sort((a, b) => b.importedBy.length - a.importedBy.length || a.path.localeCompare(b.path)).slice(0, 10);
    const indexContent = [
      "---", GENERATED_MARKER, `project: ${JSON.stringify(project.name)}`, "---", "", `# ${project.name} code graph`, "",
      "## Modules", "", ...(semantic.modules.length ? semantic.modules.map((module) => `- ${wiki(module.path)}`) : ["- No indexed modules."]),
      "", "## Hubs", "", ...(hubs.length ? hubs.map((module) => `- ${wiki(module.path)} — ${module.importedBy.length} importer${module.importedBy.length === 1 ? "" : "s"}`) : ["- No hubs yet."]), "",
    ].join("\n");
    const indexPath = path.join(graphRoot, "INDEX.md");
    let oldIndex = null;
    try { oldIndex = readFileSync(indexPath, "utf8"); } catch { oldIndex = null; }
    if (oldIndex !== indexContent) atomicWrite(indexPath, indexContent);
    return { path: graphRoot, moduleCount: modules.length, edgeCount: edges.length, truncated: Boolean(state.truncated), indexedAt: state.indexed_at || null };
  }

  #assignmentScopes(assignmentId) {
    if (!assignmentId) return [];
    const assignment = this.db.prepare("SELECT requires_write FROM assignments WHERE id = ?").get(assignmentId);
    if (!assignment?.requires_write) return [];
    const row = this.db.prepare("SELECT paths FROM assignment_write_scopes WHERE assignment_id = ?").get(assignmentId);
    const declared = parseJson(row?.paths, []);
    return Array.isArray(declared) && declared.length ? declared.map((item) => String(item)) : [""];
  }

  // `lean` is the difference between what is pushed and what is pulled.
  //
  // Measured on a real brief: codeContext was 5,931 bytes — 35%, the largest section, more than the
  // knowledge vault got. Of that, `exports`, `imports` and `dependencies` came to 2,618 bytes, and
  // every one of them is visible in the first twenty lines of the file the agent is about to open
  // anyway. `importedBy` is the one that is genuinely expensive to derive: reverse dependencies need
  // a search across the whole project, and that is what a graph is for.
  //
  // So the brief carries the part that cannot be read off a file, and `devteam_next with want=module` returns
  // everything when an agent asks about a specific module. Push what cannot be derived, pull what
  // can — the same rule the knowledge vault now follows.
  #moduleContext(modulePath, modulesByPath, outgoing, incoming, { lean = false } = {}) {
    const module = modulesByPath.get(modulePath);
    if (!module) return null;
    const exports = uniqueSorted(parseJson(module.exports, []));
    const imports = uniqueSorted(outgoing.get(modulePath) || []);
    const importedBy = uniqueSorted(incoming.get(modulePath) || []);
    if (lean) {
      return {
        path: module.path,
        language: module.language || null,
        importedBy: importedBy.slice(0, 10),
        truncated: { importedBy: importedBy.length > 10 },
      };
    }
    return {
      path: module.path,
      // The graph is no longer single-language, so what kind of artifact this is has become part of
      // the answer: "python" and "markdown" tell an agent how to read it before it opens the file.
      language: module.language || null,
      exports: exports.slice(0, 10),
      dependencies: uniqueSorted(parseJson(module.dependencies, [])).slice(0, 10),
      imports: imports.slice(0, 10),
      importedBy: importedBy.slice(0, 10),
      truncated: { exports: exports.length > 10, imports: imports.length > 10, importedBy: importedBy.length > 10 },
    };
  }

  codeContext(taskId, { assignmentId = null, scopes = null, maxBytes = this.maxContextBytes } = {}) {
    if (!this.enabled) return null;
    const task = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId);
    if (!task) return [];
    const { modules, outgoing, incoming } = this.#graphRows(task.project_id);
    const modulesByPath = new Map(modules.map((module) => [module.path, module]));
    const ordered = [];
    const seen = new Set();
    const add = (modulePath) => {
      if (modulesByPath.has(modulePath) && !seen.has(modulePath)) { seen.add(modulePath); ordered.push(modulePath); }
    };
    const assignmentScopes = Array.isArray(scopes) ? scopes : this.#assignmentScopes(assignmentId);
    const directories = [];
    for (const rawScope of assignmentScopes) {
      let scope = posix(rawScope).trim().replace(/^\.\//, "").replace(/\/{0,1}\*+$/, "").replace(/\/$/, "");
      if (!scope || scope === ".") { directories.push(""); continue; }
      scope = path.posix.normalize(scope);
      if (modulesByPath.has(scope)) add(scope);
      else if (!scope.startsWith("../") && !scope.startsWith("/")) directories.push(scope);
    }
    const recentFiles = [];
    for (const event of this.db.prepare("SELECT metadata FROM events WHERE task_id = ? AND type IN ('assignment.completed','assignment.blocked') ORDER BY id DESC LIMIT 30").all(taskId)) {
      const metadata = parseJson(event.metadata, {});
      for (const file of Array.isArray(metadata.changedFiles) ? metadata.changedFiles : []) {
        const normalized = this.#normalizeChanged(file);
        if (normalized) recentFiles.push(normalized);
      }
    }
    for (const file of recentFiles) add(file);
    for (const directory of directories) {
      for (const module of modules) if (!directory || module.path === directory || module.path.startsWith(`${directory}/`)) add(module.path);
    }
    const primary = ordered.slice();
    for (const modulePath of primary) {
      for (const neighbor of outgoing.get(modulePath) || []) add(neighbor);
      for (const neighbor of incoming.get(modulePath) || []) add(neighbor);
    }
    if (!ordered.length) {
      for (const module of modules.slice().sort((a, b) => (incoming.get(b.path)?.length || 0) - (incoming.get(a.path)?.length || 0) || a.path.localeCompare(b.path))) add(module.path);
    }
    const context = [];
    const byteLimit = Math.max(1024, Math.min(8 * 1024, Number(maxBytes) || this.maxContextBytes));
    for (const modulePath of ordered) {
      // Was 8. A lean module costs roughly a quarter of a detailed one, so the same budget carries a
      // far wider map — and a map's whole value is breadth. The byte limit below is still the real
      // guard; this only stops one enormous project from filling the brief with neighbours.
      if (context.length >= 24) break;
      const item = this.#moduleContext(modulePath, modulesByPath, outgoing, incoming, { lean: true });
      if (!item) continue;
      const candidate = [...context, item];
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > byteLimit) break;
      context.push(item);
    }
    return context;
  }

  neighborhood(taskId, modulePath) {
    if (!this.enabled) return null;
    const normalized = this.#normalizeChanged(modulePath);
    if (!normalized) return { module: null, neighbors: [] };
    const task = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId);
    if (!task) return { module: null, neighbors: [] };
    const { modules, outgoing, incoming } = this.#graphRows(task.project_id);
    const modulesByPath = new Map(modules.map((module) => [module.path, module]));
    const module = this.#moduleContext(normalized, modulesByPath, outgoing, incoming);
    if (!module) return { module: null, neighbors: [] };
    const neighbors = uniqueSorted([...(outgoing.get(normalized) || []), ...(incoming.get(normalized) || [])])
      .slice(0, 8).map((item) => this.#moduleContext(item, modulesByPath, outgoing, incoming)).filter(Boolean);
    return { module, neighbors };
  }
}
