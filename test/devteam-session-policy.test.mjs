import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

test("new tasks default per-task while migrated/defaulted rows remain manual", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-session-policy-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "devteam-session-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { try { store.close(); } catch {} await rm(dataDir, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); });
  const project = store.ensureProject("Sessions", root);
  const fresh = store.createTask({ projectId: project.id, title: "Fresh", description: "New policy default." });
  assert.equal(fresh.session_policy, "per_task");
  const stamp = new Date().toISOString();
  const legacyId = crypto.randomUUID();
  store.db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, version, required_approvals, created_at, updated_at)
    VALUES (?, ?, 'Legacy', 'Migrated policy default.', 'planning', 1, 1, ?, ?)`).run(legacyId, project.id, stamp, stamp);
  assert.equal(store.getTask(legacyId).session_policy, "manual");
  assert.equal(store.updateTask(fresh.id, { sessionPolicy: "adaptive" }).session_policy_version, 2);
});
