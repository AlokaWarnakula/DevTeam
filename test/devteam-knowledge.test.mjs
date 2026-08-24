import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rankKnowledgeNotes } from "../src/devteam/knowledge.mjs";
import { DevTeamStore } from "../src/devteam/store.mjs";

const base = {
  category: "components",
  body: "General implementation detail.",
  status: "verified",
  confidence: "high",
  source_task_id: "older-task",
  source_event_id: 1,
  relatedFiles: [],
  updated_at: "2026-08-01T00:00:00.000Z",
  verified_at: "2026-08-01T00:00:00.000Z",
  last_validated_at: "2026-08-01T00:00:00.000Z",
  last_validated_version: 1,
  source_metadata: "{}",
};

test("knowledge relevance prefers task paths and goals over unrelated recency", () => {
  const notes = [
    { ...base, id: "recent-unrelated", title: "Recent unrelated dashboard color", relatedFiles: ["public/theme.css"], updated_at: "2026-08-24T00:00:00.000Z" },
    { ...base, id: "older-relevant", title: "Authentication token validation", body: "Validate the session token before accepting a request.", relatedFiles: ["src/auth/session.mjs"], updated_at: "2026-06-01T00:00:00.000Z" },
    { ...base, id: "inferred", title: "Authentication guess", status: "inferred", relatedFiles: ["src/auth/session.mjs"] },
  ];
  const context = {
    taskId: "new-task",
    taskTitle: "Fix authentication session validation",
    taskDescription: "Correct token checks.",
    taskVersion: 1,
    taskUpdatedAt: "2026-08-24T00:00:00.000Z",
    assignmentTitle: "Repair auth session",
    role: "implementer",
    declaredPaths: ["src/auth/session.mjs"],
  };
  const first = rankKnowledgeNotes(notes, context, 3);
  const second = rankKnowledgeNotes(notes, context, 3);
  assert.deepEqual(first, second);
  assert.equal(first[0].id, "older-relevant");
  assert.match(first[0].whyIncluded, /declared path/);
  assert.ok(first.findIndex((note) => note.id === "inferred") > first.findIndex((note) => note.id === "older-relevant"));
});

test("knowledge selection limits one category and preserves useful diversity", () => {
  const components = Array.from({ length: 8 }, (_, index) => ({
    ...base,
    id: `component-${index}`,
    title: `Parser component ${index}`,
    body: "Parser implementation and validation.",
    relatedFiles: [`src/parser/${index}.mjs`],
  }));
  const diverse = [
    { ...base, id: "architecture", category: "architecture", title: "Parser boundaries" },
    { ...base, id: "conventions", category: "conventions", title: "Parser error conventions" },
    { ...base, id: "pitfall", category: "pitfalls", title: "Parser recursion pitfall" },
  ];
  const selected = rankKnowledgeNotes([...components, ...diverse], {
    taskId: "new-task",
    taskTitle: "Improve parser validation",
    role: "reviewer",
    taskUpdatedAt: "2026-08-24T00:00:00.000Z",
  }, 6);
  assert.ok(selected.filter((note) => note.category === "components").length <= 2);
  assert.ok(new Set(selected.map((note) => note.category)).size >= 3);
});

test("a new task briefing ranks older path-relevant project knowledge before newer noise", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-relevance-integration-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Relevance integration", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Fix authentication sessions", description: "Correct token validation." });
  const agent = store.connectAgent({ name: "Writer", provider: "test" });
  const planner = store.claimNextAssignment(agent.id);
  store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Repair session validation", description: "Edit the authentication session module.", role: "implementer", requiresWrite: true, paths: ["src/auth/session.mjs"] });
  store.completeAssignment({ agentId: agent.id, assignmentId: planner.id, claimToken: planner.claimToken, message: "Planned." });
  const claim = store.claimNextAssignment(agent.id);
  const insert = store.db.prepare(`
    INSERT INTO knowledge_notes (
      id, project_id, category, slug, title, body, status, confidence, source_task_id,
      source_event_id, source_author, related_files, provenance, created_at, updated_at,
      verified_at, revision, status_changed_at, last_validated_at, last_validated_version
    ) VALUES (?, ?, 'components', ?, ?, ?, 'verified', 'high', NULL, NULL, 'fixture', ?, '[]', ?, ?, ?, 1, ?, ?, 1)
  `);
  insert.run("auth-note", project.id, "auth-note", "Authentication session contract", "Validate session tokens before accepting requests.", JSON.stringify(["src/auth/session.mjs"]), "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
  insert.run("theme-note", project.id, "theme-note", "Dashboard color refresh", "Recent visual styling change.", JSON.stringify(["public/theme.css"]), "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  const brief = store.taskBrief(agent.id, task.id, { currentAssignment: claim });
  assert.equal(brief.projectKnowledge[0].id, "auth-note");
  assert.match(brief.projectKnowledge[0].whyIncluded, /declared path/);
});
