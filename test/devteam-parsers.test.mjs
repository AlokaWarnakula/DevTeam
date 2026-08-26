import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { buildParserRegistry } from "../src/devteam/parsers.mjs";

const clean = (value, max) => String(value || "").trim().slice(0, max);
const registry = buildParserRegistry(clean);

test("every artifact type gets a parser, and non-artifacts get none", () => {
  assert.equal(registry.for("src/a.ts").id, "javascript");
  assert.equal(registry.for("pkg/mod.py").id, "python");
  assert.equal(registry.for("docs/plan.md").id, "markdown");
  assert.equal(registry.for("data/rows.csv").id, "opaque");
  assert.equal(registry.for("notes/spec.txt").id, "reference");
  assert.equal(registry.for("main.go").id, "reference", "a language with no parser still gets the link fallback");
  assert.equal(registry.for("logo.png"), null, "a binary is not an artifact");
  assert.equal(registry.for("archive.zip"), null);
});

test("the Python parser reads imports and the module's own surface", () => {
  const parsed = registry.for("a.py").parse([
    "import os",
    "import json, re",
    "import numpy as np",
    "from .helpers import shape",
    "from ..shared.util import thing",
    "from mypkg.core import Engine",
    "",
    "__all__ = ['Engine', 'run']",
    "",
    "def run(x):",
    "    def inner():",
    "        pass",
    "    return inner",
    "",
    "class Engine:",
    "    def method(self):",
    "        pass",
  ].join("\n"), "a.py");

  assert.ok(parsed.imports.includes("os"));
  assert.ok(parsed.imports.includes("json"), "a comma-separated import names each module");
  assert.ok(parsed.imports.includes("re"));
  assert.ok(parsed.imports.includes("numpy"), "an `as` alias does not change what was imported");
  assert.ok(parsed.imports.includes(".helpers"));
  assert.ok(parsed.imports.includes("..shared.util"));
  assert.ok(parsed.imports.includes("mypkg.core"));

  assert.ok(parsed.exports.includes("run"));
  assert.ok(parsed.exports.includes("Engine"));
  assert.equal(parsed.exports.includes("inner"), false, "a nested def is not the module's surface");
  assert.equal(parsed.exports.includes("method"), false, "nor is a method");
});

test("Python relative imports resolve the way Python resolves them", () => {
  const python = registry.for("x.py");
  assert.deepEqual(python.resolve(".helpers", "pkg/mod.py"), ["pkg/helpers.py", "pkg/helpers.pyi", "pkg/helpers/__init__.py"]);
  assert.deepEqual(python.resolve("..shared", "pkg/sub/mod.py"), ["pkg/shared.py", "pkg/shared.pyi", "pkg/shared/__init__.py"]);
  // An absolute-looking import may still be intra-project.
  assert.ok(python.resolve("mypkg.core", "app/main.py").includes("mypkg/core.py"));
  assert.ok(python.resolve("mypkg.core", "app/main.py").includes("mypkg/core/__init__.py"));
});

test("the Markdown parser treats links as edges and headings as the document's surface", () => {
  const parsed = registry.for("doc.md").parse([
    "# Migration plan",
    "",
    "See [the schema](./schema.sql) and [the runbook](runbooks/deploy.md).",
    "Read [the site](https://example.com/page) too, and [an anchor](#later).",
    "Also [[decisions/use-one-exporter]] and [[architecture/runtime|the runtime]].",
    "",
    "## Rollback",
    "### Step one",
    "#### Too deep to be a landmark",
  ].join("\n"), "doc.md");

  assert.ok(parsed.imports.includes("./schema.sql"));
  assert.ok(parsed.imports.includes("./runbooks/deploy.md"), "a bare relative link is still a link");
  assert.ok(parsed.imports.includes("./decisions/use-one-exporter"));
  assert.ok(parsed.imports.includes("./architecture/runtime"), "the |label form is the same edge");
  assert.equal(parsed.imports.some((item) => item.includes("example.com")), false, "an external URL is not a project edge");
  assert.equal(parsed.imports.some((item) => item.includes("#later")), false, "nor is an anchor");

  assert.deepEqual(parsed.exports.sort(), ["Migration plan", "Rollback", "Step one"],
    "headings down to h3 are what another document links to");
});

test("the reference fallback finds real filenames in arbitrary text and invents nothing", () => {
  const parsed = registry.for("spec.txt").parse([
    "The importer reads data/customers.csv and writes reports/summary.json.",
    'It is configured by "config/settings.toml".',
    "Version 1.24 of the tool is required.",
    "Contact ops@example.com about it.",
    "See [[runbooks/import]] for the procedure.",
  ].join("\n"), "spec.txt");

  assert.ok(parsed.imports.includes("./data/customers.csv"));
  assert.ok(parsed.imports.includes("./reports/summary.json"));
  assert.ok(parsed.imports.includes("./config/settings.toml"));
  assert.ok(parsed.imports.includes("./runbooks/import"));
  assert.equal(parsed.imports.some((item) => item.includes("1.24")), false, "a version number is not a path");
});

test("a data project gets a real graph: Python, notebooks, SQL and prose all connected", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-artifact-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-artifact-project-"));
  t.after(async () => {
    try { store.close(); } catch { /* closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(projectRoot, "pipeline"), { recursive: true });
  await mkdir(path.join(projectRoot, "sql"), { recursive: true });
  await mkdir(path.join(projectRoot, "docs"), { recursive: true });

  await writeFile(path.join(projectRoot, "pipeline", "__init__.py"), "", "utf8");
  await writeFile(path.join(projectRoot, "pipeline", "clean.py"),
    "import pandas as pd\n\n__all__ = ['clean']\n\ndef clean(frame):\n    return frame.dropna()\n", "utf8");
  await writeFile(path.join(projectRoot, "pipeline", "load.py"),
    "from .clean import clean\nfrom .transform import widen\n\ndef load(path):\n    return clean(widen(path))\n", "utf8");
  await writeFile(path.join(projectRoot, "pipeline", "transform.py"),
    "def widen(frame):\n    return frame\n", "utf8");
  await writeFile(path.join(projectRoot, "sql", "customers.sql"), "SELECT 1;\n", "utf8");
  await writeFile(path.join(projectRoot, "docs", "method.md"),
    "# Method\n\nWe load with [the loader](../pipeline/load.py) against [the query](../sql/customers.sql).\n\n## Caveats\n", "utf8");

  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: true } });
  const project = store.ensureProject("Data project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Analyse", description: "Not a JS project." });
  store.codegraph.fullReconcile(project.id);

  const agent = store.connectAgent({ name: "Analyst", provider: "test", freshTaskId: task.id });
  const loader = store.codeGraphSearch({ agentId: agent.id, taskId: task.id, path: "pipeline/load.py" });
  assert.equal(loader.module.language, "python");
  assert.ok(loader.module.imports.includes("pipeline/clean.py"), "a relative Python import resolves to a real file");
  assert.ok(loader.module.imports.includes("pipeline/transform.py"));
  assert.ok(loader.module.dependencies.length === 0 || !loader.module.dependencies.includes("pandas"),
    "load.py imports nothing external");

  const cleaner = store.codeGraphSearch({ agentId: agent.id, taskId: task.id, path: "pipeline/clean.py" });
  assert.ok(cleaner.module.exports.includes("clean"));
  assert.ok(cleaner.module.dependencies.includes("pandas"), "an external package is a dependency, not an edge");
  assert.ok(cleaner.module.importedBy.includes("pipeline/load.py"),
    "and the reverse edge is what tells an analyst what else this touches");

  // Prose is a first-class node: the method doc links code and SQL, so changing either is visible.
  const doc = store.codeGraphSearch({ agentId: agent.id, taskId: task.id, path: "docs/method.md" });
  assert.equal(doc.module.language, "markdown");
  assert.ok(doc.module.exports.includes("Method"));
  assert.ok(doc.module.imports.includes("pipeline/load.py"));
  assert.ok(doc.module.imports.includes("sql/customers.sql"));

  const sql = store.codeGraphSearch({ agentId: agent.id, taskId: task.id, path: "sql/customers.sql" });
  assert.ok(sql.module.importedBy.includes("docs/method.md"),
    "a SQL file knows the document that depends on it, which is the whole point for a data project");
});
