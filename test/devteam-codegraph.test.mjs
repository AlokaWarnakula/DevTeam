import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";

async function put(root, relative, content = "") {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function fixture(t, files = {}, codegraph = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-project-"));
  for (const [relative, content] of Object.entries(files)) await put(projectRoot, relative, content);
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: true, ...codegraph } });
  const project = store.ensureProject("Graph project", projectRoot);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  return { dataDir, projectRoot, store, project };
}

function modules(store, projectId) {
  return store.db.prepare("SELECT * FROM code_modules WHERE project_id = ? ORDER BY path").all(projectId);
}

function edges(store, projectId) {
  return store.db.prepare("SELECT from_path, to_path FROM code_edges WHERE project_id = ? ORDER BY from_path, to_path").all(projectId)
    .map((row) => ({ from_path: row.from_path, to_path: row.to_path }));
}

test("CodeGraph parses bounded ESM, CJS, and TypeScript structure and resolves cross-extension imports", async (t) => {
  const { store, project } = await fixture(t, {
    "src/a.js": "import value from './b'; import pkg from 'bare-package'; export { value as renamed } from './b'; export default value;",
    "src/b.ts": "export function value() {}\nexport interface Shape {}\nexport type Name = string;\nexport enum Kind { A }",
    "src/c.cjs": "const b = require('./b'); module.exports.extra = b; exports.other = b; module.exports = { finalValue: b };",
    "src/config.json": "{\"ok\":true}",
    "src/json-user.mjs": "import config from './config.json'; export const ok = config.ok;",
  });
  assert.deepEqual(edges(store, project.id), [
    { from_path: "src/a.js", to_path: "src/b.ts" },
    { from_path: "src/c.cjs", to_path: "src/b.ts" },
    { from_path: "src/json-user.mjs", to_path: "src/config.json" },
  ]);
  const rows = new Map(modules(store, project.id).map((row) => [row.path, row]));
  assert.deepEqual(JSON.parse(rows.get("src/a.js").dependencies), ["bare-package"]);
  assert.deepEqual(JSON.parse(rows.get("src/a.js").exports), ["default", "renamed"]);
  assert.deepEqual(JSON.parse(rows.get("src/b.ts").exports), ["Kind", "Name", "Shape", "value"]);
  assert.deepEqual(JSON.parse(rows.get("src/c.cjs").exports), ["extra", "finalValue", "other"]);
  assert.deepEqual(JSON.parse(rows.get("src/config.json").exports), []);
});

test("safe discovery skips ignored, secret, oversized, binary, and linked files and rejects escaped reports", async (t) => {
  const { store, project, projectRoot } = await fixture(t, {
    "src/good.js": "export const good = true;",
    "node_modules/pkg/index.js": "export const ignored = true;",
    ".hidden/file.js": "export const ignored = true;",
    "dist/bundle.js": "export const ignored = true;",
    ".env.js": "export const secret = 'x';",
    "secrets/token.js": "export const token = 'x';",
  });
  await put(projectRoot, "src/large.js", Buffer.alloc(256 * 1024 + 1, 65));
  await put(projectRoot, "src/binary.js", Buffer.from([0, 1, 2, 3]));
  let linked = false;
  try {
    await symlink(path.join(projectRoot, "src", "good.js"), path.join(projectRoot, "src", "linked.js"), "file");
    linked = true;
  } catch { /* Windows may not permit symlink creation in this environment. */ }
  store.codegraph.reconcileProject(project.id, { force: true });
  assert.deepEqual(modules(store, project.id).map((row) => row.path), ["src/good.js"]);
  if (linked) assert.ok(!modules(store, project.id).some((row) => row.path === "src/linked.js"));

  const task = store.createTask({ projectId: project.id, title: "Reject escapes", description: "Do not index outside paths." });
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const claim = store.claimNextAssignment(agent.id);
  const outside = path.join(path.dirname(projectRoot), "outside-codegraph.js");
  await writeFile(outside, "export const escaped = true;");
  t.after(() => rm(outside, { force: true }));
  await store.completeAssignment({
    agentId: agent.id,
    assignmentId: claim.id,
    message: "Reported unsafe paths for validation.",
    changedFiles: ["..\\outside-codegraph.js", outside, "C:\\Windows\\system.js"],
  });
  assert.deepEqual(modules(store, project.id).map((row) => row.path), ["src/good.js"]);
});

test("incremental edits, deletions, unresolved targets, and renames rebuild derived edges correctly", async (t) => {
  const { store, project, projectRoot } = await fixture(t, {
    "src/a.js": "import './missing'; import './old';",
    "src/old.ts": "export const old = true;",
    "src/other.ts": "export const other = true;",
  });
  const originalA = modules(store, project.id).find((row) => row.path === "src/a.js");
  assert.deepEqual(edges(store, project.id), [{ from_path: "src/a.js", to_path: "src/old.ts" }]);
  const task = store.createTask({ projectId: project.id, title: "Increment graph", description: "Exercise incremental updates." });
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);

  await put(projectRoot, "src/missing.ts", "export const later = true;");
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Added the missing target.", changedFiles: ["src/missing.ts"] });
  assert.deepEqual(edges(store, project.id), [
    { from_path: "src/a.js", to_path: "src/missing.ts" },
    { from_path: "src/a.js", to_path: "src/old.ts" },
  ]);
  assert.equal(modules(store, project.id).find((row) => row.path === "src/a.js").updated_at, originalA.updated_at, "the importer was not reparsed");

  const edit = store.createAssignment({ taskId: task.id, title: "Edit imports", description: "Change the edge.", requiresWrite: true, targetAgentName: "Worker" });
  const editClaim = store.claimNextAssignment(agent.id);
  await put(projectRoot, "src/a.js", "import './other';");
  await store.completeAssignment({ agentId: agent.id, assignmentId: editClaim.id, message: "Changed imports.", changedFiles: ["src/a.js"] });
  assert.deepEqual(edges(store, project.id), [{ from_path: "src/a.js", to_path: "src/other.ts" }]);

  const move = store.createAssignment({ taskId: task.id, title: "Rename module", description: "Move the file.", requiresWrite: true, targetAgentName: "Worker" });
  const moveClaim = store.claimNextAssignment(agent.id);
  await rename(path.join(projectRoot, "src", "other.ts"), path.join(projectRoot, "src", "renamed.ts"));
  await put(projectRoot, "src/a.js", "import './renamed';");
  await store.completeAssignment({ agentId: agent.id, assignmentId: moveClaim.id, message: "Renamed module.", changedFiles: ["src/other.ts", "src/renamed.ts", "src/a.js"] });
  assert.ok(!modules(store, project.id).some((row) => row.path === "src/other.ts"));
  assert.ok(modules(store, project.id).some((row) => row.path === "src/renamed.ts"));
  assert.deepEqual(edges(store, project.id), [{ from_path: "src/a.js", to_path: "src/renamed.ts" }]);

  const remove = store.createAssignment({ taskId: task.id, title: "Delete module", description: "Remove the target.", requiresWrite: true, targetAgentName: "Worker" });
  const removeClaim = store.claimNextAssignment(agent.id);
  await rm(path.join(projectRoot, "src", "renamed.ts"));
  await store.completeAssignment({ agentId: agent.id, assignmentId: removeClaim.id, message: "Deleted module.", changedFiles: ["src/renamed.ts"] });
  assert.ok(!modules(store, project.id).some((row) => row.path === "src/renamed.ts"));
  assert.deepEqual(edges(store, project.id), []);
});

test("bounded reconciliation catches manual drift and initialized state does not trigger another full scan", async (t) => {
  const { store, project, projectRoot } = await fixture(t, { "src/a.js": "export const before = true;" }, { reconcileThrottleMs: 60_000 });
  const stateBefore = store.db.prepare("SELECT * FROM code_graph_state WHERE project_id = ?").get(project.id);
  assert.equal(stateBefore.initialized, 1);
  await put(projectRoot, "src/a.js", "export const after = true;\nexport const more = true;");
  const task = store.createTask({ projectId: project.id, title: "Manual drift", description: "Reconcile an unreported edit." });
  const agent = store.connectAgent({ name: "Reader", provider: "test", freshTaskId: task.id });
  const claim = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, message: "Changed manually but omitted changedFiles." });
  store.taskBrief(agent.id, task.id);
  assert.deepEqual(JSON.parse(modules(store, project.id).find((row) => row.path === "src/a.js").exports), ["after", "more"]);

  store.db.prepare("UPDATE code_graph_state SET last_event_id = 0 WHERE project_id = ?").run(project.id);
  await put(projectRoot, "src/new.js", "export const newFile = true;");
  store.codegraph.initializeProject(project.id);
  const stateAfter = store.db.prepare("SELECT * FROM code_graph_state WHERE project_id = ?").get(project.id);
  assert.equal(stateAfter.last_full_scan_at, stateBefore.last_full_scan_at, "initialized=1 avoids a redundant full scan even with event cursor zero");
  assert.ok(modules(store, project.id).some((row) => row.path === "src/new.js"), "light reconciliation still notices inventory drift");
});

test("exports are deterministic, collision-safe, self-owned, capped, and churn-free", async (t) => {
  const { store, project, projectRoot } = await fixture(t, {
    "src/a-b.js": "export const one = true;",
    "src/a_b.js": "export const two = true;",
  });
  const graphRoot = path.join(projectRoot, "knowledge", "graph");
  const notes = (await readdir(graphRoot)).filter((file) => file.endsWith(".md") && file !== "INDEX.md");
  assert.equal(notes.length, 2);
  assert.equal(new Set(notes).size, 2, "module-id suffixes disambiguate colliding slugs");
  await put(graphRoot, "stale-owned.md", "---\ngenerated_by: DevTeam CodeGraph\n---\nold");
  await put(graphRoot, "keep-me.md", "human note");
  await put(path.join(projectRoot, "knowledge"), "keep-sibling.md", "sibling vault note");
  const graphPath = path.join(graphRoot, "graph.json");
  const notePath = path.join(graphRoot, notes[0]);
  const beforeGraph = await stat(graphPath);
  const beforeNote = await stat(notePath);
  await new Promise((resolve) => setTimeout(resolve, 15));
  store.codegraph.reconcileProject(project.id, { force: true });
  assert.rejects(readFile(path.join(graphRoot, "stale-owned.md"), "utf8"));
  assert.equal(await readFile(path.join(graphRoot, "keep-me.md"), "utf8"), "human note");
  assert.equal(await readFile(path.join(projectRoot, "knowledge", "keep-sibling.md"), "utf8"), "sibling vault note");
  assert.equal((await stat(graphPath)).mtimeMs, beforeGraph.mtimeMs, "semantic graph no-op does not rewrite graph.json");
  assert.equal((await stat(notePath)).mtimeMs, beforeNote.mtimeMs, "semantic note no-op does not rewrite module notes");

  const capData = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-cap-data-"));
  const capRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-cap-root-"));
  for (let start = 0; start < 3001; start += 200) {
    await Promise.all(Array.from({ length: Math.min(200, 3001 - start) }, (_, offset) => {
      const index = start + offset;
      return put(capRoot, `src/file-${String(index).padStart(4, "0")}.js`, `export const n${index} = ${index};`);
    }));
  }
  const capStore = new DevTeamStore(capData, { codegraph: { enabled: true }, knowledge: { enabled: false } });
  t.after(async () => { capStore.close(); await rm(capData, { recursive: true, force: true }); await rm(capRoot, { recursive: true, force: true }); });
  const capProject = capStore.ensureProject("Cap", capRoot);
  const capState = capStore.codegraph.projectState(capProject.id);
  assert.equal(capState.moduleCount, 3000);
  assert.equal(capState.truncated, true);
  assert.equal(modules(capStore, capProject.id)[0].path, "src/file-0000.js");
  assert.equal(modules(capStore, capProject.id).at(-1).path, "src/file-2999.js");
});

test("directory and whole-project scopes produce bounded automatic code context", async (t) => {
  const files = {
    "src/feature/a.js": "import './b'; " + Array.from({ length: 14 }, (_, index) => `export const value${index} = ${index};`).join("\n"),
    "src/feature/b.js": "export const b = true;",
    "src/other/c.js": "import '../feature/a'; export const c = true;",
  };
  for (let index = 0; index < 12; index += 1) files[`src/extra/m${index}.js`] = "export const x = true;";
  const { store, project } = await fixture(t, files);
  const task = store.createTask({ projectId: project.id, title: "Context", description: "Bound the graph context." });
  const agent = store.connectAgent({ name: "Context Agent", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned." });
  const directory = store.codegraph.codeContext(task.id, { scopes: ["src/feature/**"] });
  assert.ok(directory.some((item) => item.path === "src/feature/a.js"));
  assert.ok(directory.some((item) => item.path === "src/feature/b.js"));
  assert.ok(directory.some((item) => item.path === "src/other/c.js"), "one-hop imported-by neighbor is included");
  // What the brief pushes is the part that cannot be read off a file: who imports this module. The
  // exports, imports and dependency lists sit in the first lines of the file the agent is about to
  // open, and pushing them was 44% of the largest section of every brief.
  const pushed = directory.find((item) => item.path === "src/feature/a.js");
  assert.equal(pushed.exports, undefined, "exports are not pushed; they are in the file");
  assert.equal(pushed.imports, undefined);
  assert.equal(pushed.dependencies, undefined);
  assert.ok(Array.isArray(pushed.importedBy), "reverse dependencies are pushed; a grep for them is not cheap");

  // And nothing is lost: an agent that asks about a module still gets everything.
  const pulled = store.codegraph.neighborhood(task.id, "src/feature/a.js");
  assert.equal(pulled.module.exports.length, 10, "the pull path still carries exports");
  assert.equal(pulled.module.truncated.exports, true);

  const whole = store.codegraph.codeContext(task.id, { scopes: [""] });
  assert.ok(whole.length > 0 && whole.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(whole), "utf8") <= 8 * 1024);

  const exact = store.createAssignment({ taskId: task.id, title: "Exact file", description: "Edit one file.", requiresWrite: true, targetAgentName: "Context Agent", paths: ["src/feature/a.js"] });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim.id, exact.id);
  const brief = store.taskBrief(agent.id, task.id);
  assert.equal(brief.codeContext[0].path, "src/feature/a.js");
  assert.ok(Buffer.byteLength(JSON.stringify(brief.codeContext), "utf8") <= 8 * 1024);
});

test("disabled mode is a clean no-op and CodeGraph failures never break assignment completion", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-disabled-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-disabled-root-"));
  await put(projectRoot, "src/a.js", "export const a = true;");
  const store = new DevTeamStore(dataDir, { codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  const project = store.ensureProject("Disabled", projectRoot);
  assert.equal(store.codegraph.initializeProject(project.id), null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM code_graph_state").get().count, 0);
  assert.equal(await readFile(path.join(projectRoot, "src", "a.js"), "utf8"), "export const a = true;");
  assert.rejects(readFile(path.join(projectRoot, "knowledge", "graph", "graph.json"), "utf8"));

  store.codegraph.enabled = true;
  store.codegraph.initializeProject(project.id);
  const task = store.createTask({ projectId: project.id, title: "Error isolation", description: "Graph errors are non-fatal." });
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const claim = store.claimNextAssignment(agent.id);
  store.codegraph.syncTask = () => { throw new Error("synthetic graph failure"); };
  const result = await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, message: "Coordination still completes.", changedFiles: ["src/a.js"] });
  assert.equal(result.completed, true);
  assert.match(store.taskDetail(task.id).codeGraph.error.message, /synthetic graph failure/);
});

test("devteam_wait automatically delivers the same bounded code context and Knowledge Vault remains independent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-mcp-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-codegraph-mcp-root-"));
  await put(projectRoot, "src/a.js", "import './b'; export const a = true;");
  await put(projectRoot, "src/b.js", "export const b = true;");
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: projectRoot, knowledge: { enabled: true }, codegraph: { enabled: true } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  const project = instance.store.listProjects()[0];
  const task = instance.store.createTask({ projectId: project.id, title: "MCP context", description: "Deliver graph context." });
  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } } });
  const client = new Client({ name: "codegraph-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const connected = await client.callTool({ name: "devteam_connect", arguments: { name: "Graph Agent", provider: "test", taskId: task.id } });
  const agentId = connected.structuredContent.agent.id;
  const assigned = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(assigned.structuredContent.status, "assigned");
  assert.ok(Array.isArray(assigned.structuredContent.codeContext));
  assert.deepEqual(assigned.structuredContent.codeContext, instance.store.taskBrief(agentId, task.id).codeContext);
  assert.ok(Buffer.byteLength(JSON.stringify(assigned.structuredContent.codeContext), "utf8") <= 8 * 1024);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "devteam_codegraph"));
  const neighborhood = await client.callTool({ name: "devteam_codegraph", arguments: { agentId, taskId: task.id, path: "src/a.js" } });
  assert.equal(neighborhood.structuredContent.module.path, "src/a.js");
  assert.equal(Object.hasOwn(neighborhood.structuredContent.module, "source"), false);
  assert.equal(instance.store.taskDetail(task.id).knowledgeVault.automated, true);
  assert.equal(instance.store.taskDetail(task.id).codeGraph.automated, true);
});

test("the graph will not write into a knowledge vault another project has claimed", async (t) => {
  // Graph notes are named from a hash of the project id, so a second project pointed at the same
  // root does not add a few stray files — it writes a complete duplicate set under different names
  // and its reconciler deletes the originals. That is what renamed all 52 of this repository's graph
  // notes on every `npm test`, because server tests use process.cwd() as their workspace root.
  const { store, project, projectRoot } = await fixture(t, { "src/app.mjs": "export const app = 1;\n" });
  store.codegraph.fullReconcile(project.id);
  const first = store.codegraph.exportProject(project.id);
  assert.ok(first.path, "the first project exports normally");
  const before = await readdir(path.join(projectRoot, "knowledge", "graph"));
  assert.ok(before.length > 0);

  // Hand the vault to somebody else, exactly as the knowledge exporter would have.
  await writeFile(path.join(projectRoot, "knowledge", ".devteam-vault"),
    JSON.stringify({ projectId: "a-different-project", project: "Somebody else" }), "utf8");

  const second = store.codegraph.exportProject(project.id);
  assert.equal(second.skipped, "foreign-vault", "the export stands down rather than renaming someone's notes");
  assert.equal(second.vaultOwner, "Somebody else", "and names who it stood down for");
  assert.deepEqual(await readdir(path.join(projectRoot, "knowledge", "graph")), before, "nothing on disk moved");
});
