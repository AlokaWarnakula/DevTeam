import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBudgetedBrief, clipUtf8, jsonBytes } from "../src/devteam/brief.mjs";
import { DevTeamStore } from "../src/devteam/store.mjs";

test("UTF-8 clipping preserves complete code points and obeys its byte ceiling", () => {
  const clipped = clipUtf8("alpha😀😀😀omega", 15);
  assert.equal(clipped.truncated, true);
  assert.ok(Buffer.byteLength(clipped.value, "utf8") <= 15);
  assert.doesNotMatch(clipped.value, /�/);
  assert.match(clipped.value, /…$/);
});

test("BriefBudget measures the final serialized object and reports deterministic omissions", () => {
  const input = Array.from({ length: 30 }, (_, index) => ({
    id: index,
    text: `item-${index}-😀-${"\\\"".repeat(100)}`,
  }));
  const make = () => buildBudgetedBrief({
    core: { task: { id: "task", title: "Escaped UTF-8" }, currentAssignment: null },
    budget: { totalBytes: 2_048 },
    sections: [
      { key: "items", group: "items", items: input, totalCount: input.length, maxItems: 30, maxBytes: 1_400 },
    ],
  });
  const first = make();
  const second = make();
  assert.deepEqual(first, second);
  assert.equal(first.briefMeta.bytes, jsonBytes(first));
  assert.ok(first.briefMeta.bytes <= 2_048);
  assert.equal(first.briefMeta.omitted.items, input.length - first.briefMeta.included.items);
  assert.equal(first.briefMeta.truncated, true);
});

test("extreme blackboards still produce a deterministic 32 KiB brief with mandatory claim context", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-brief-stress-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Brief stress", process.cwd());
  const task = store.createTask({
    projectId: project.id,
    title: "Keep the mandatory core",
    description: "😀".repeat(20_000),
  });
  const agent = store.connectAgent({ name: "Stress agent", provider: "test", freshTaskId: task.id });
  const claim = store.claimNextAssignment(agent.id);
  const huge = `${"x".repeat(99_900)}😀${"\\\"".repeat(40)}`;
  const insertTask = store.db.prepare(`
    INSERT INTO blackboard (task_id, key, value, version, updated_by_name, updated_at)
    VALUES (?, ?, ?, 1, 'stress', '2026-08-24T00:00:00.000Z')
  `);
  const insertProject = store.db.prepare(`
    INSERT INTO project_blackboard (project_id, key, value, version, updated_by_name, updated_at)
    VALUES (?, ?, ?, 1, 'stress', '2026-08-24T00:00:00.000Z')
  `);
  for (let index = 0; index < 110; index += 1) {
    insertTask.run(task.id, `task-${String(index).padStart(3, "0")}`, huge);
    insertProject.run(project.id, `project-${String(index).padStart(3, "0")}`, huge);
  }
  const first = store.taskBrief(agent.id, task.id, { currentAssignment: claim });
  const second = store.taskBrief(agent.id, task.id, { currentAssignment: claim });
  assert.deepEqual(first, second);
  assert.equal(first.briefMeta.bytes, jsonBytes(first));
  assert.ok(first.briefMeta.bytes <= 32_768);
  assert.equal(first.task.id, task.id);
  assert.equal(first.task.project.root, path.resolve(process.cwd()));
  assert.equal(first.currentAssignment.id, claim.id);
  assert.equal(first.currentAssignment.role, "planner");
  assert.equal(first.currentAssignment.claimToken, claim.claimToken);
  assert.ok(Array.isArray(first.currentAssignment.checklist));
  assert.ok(Array.isArray(first.currentAssignment.writeScope));
  assert.equal(first.codeContext, null, "disabled CodeGraph preserves the existing no-op shape");
  assert.equal(first.briefMeta.omitted.taskMemory, 110 - first.briefMeta.included.taskMemory);
  assert.equal(first.briefMeta.omitted.projectMemory, 110 - first.briefMeta.included.projectMemory);
  assert.equal(first.briefMeta.truncated, true);
  assert.equal(JSON.stringify(first).includes("resume_token_hash"), false);
});
