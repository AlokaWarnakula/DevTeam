import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClaudeCliRuntimeAdapter,
  CodexCliRuntimeAdapter,
  GenericCommandRuntimeAdapter,
  ManagedRuntimeSupervisor,
} from "../src/devteam/runtime/managed.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";

test("managed adapters build argument arrays from supplied selections without shell interpolation", () => {
  const selection = { modelId: "host-model;echo injected", effortId: "host-effort && stop" };
  const invite = "Join task\ncheckpoint token";
  const codex = new CodexCliRuntimeAdapter({ command: "fixture-codex" });
  const codexArgs = codex.buildLaunchArgs(selection, invite, { projectRoot: "C:/project" });
  assert.ok(Array.isArray(codexArgs));
  assert.ok(codexArgs.includes(selection.modelId));
  assert.ok(codexArgs.includes(invite));
  assert.equal(codexArgs.some((arg) => arg === "echo" || arg === "injected"), false);
  const claude = new ClaudeCliRuntimeAdapter({ command: "fixture-claude", effortArgs: ["--host-effort", "{effort}"] });
  assert.ok(claude.buildLaunchArgs(selection, invite, { projectRoot: "C:/project" }).includes(selection.effortId));
  const generic = new GenericCommandRuntimeAdapter({ command: "fixture", args: ["--model", "{model}", "--effort", "{effort}", "{invite}"] });
  assert.deepEqual(generic.buildLaunchArgs({ modelId: "m", effortId: "e" }, "invite", { projectRoot: "C:/p" }), ["--model", "m", "--effort", "e", "invite"]);
});

test("managed supervision is opt-in, uses shell false, and reports launch failure without claiming success", async () => {
  const adapter = new GenericCommandRuntimeAdapter({ id: "fake", command: "fake", args: ["{model}", "{effort}", "{invite}"] });
  await assert.rejects(() => new ManagedRuntimeSupervisor({ adapters: [adapter] }).launch({ adapterId: "fake", selection: { modelId: "m", effortId: "e" }, taskInvite: "invite", projectRoot: "C:/p" }), /disabled/);
  let observed;
  const okSupervisor = new ManagedRuntimeSupervisor({ enabled: true, adapters: [adapter], spawnProcess(command, args, options) {
    observed = { command, args, options };
    const child = new EventEmitter(); child.pid = 42; child.kill = () => true;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  } });
  const launched = await okSupervisor.launch({ adapterId: "fake", selection: { modelId: "m", effortId: "e" }, taskInvite: "invite", projectRoot: "C:/p" });
  assert.equal(launched.pid, 42);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  okSupervisor.stopAll();
  const failing = new ManagedRuntimeSupervisor({ enabled: true, adapters: [adapter], spawnProcess() {
    const child = new EventEmitter(); child.kill = () => true;
    queueMicrotask(() => child.emit("error", new Error("launch unavailable")));
    return child;
  } });
  await assert.rejects(() => failing.launch({ adapterId: "fake", selection: { modelId: "m", effortId: "e" }, taskInvite: "invite", projectRoot: "C:/p" }), /launch unavailable/);
});

test("managed launch failure cancels its checkpoint and preserves the old claim", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-managed-server-"));
  const adapter = new GenericCommandRuntimeAdapter({ id: "failing", command: "missing", args: ["{model}", "{effort}", "{invite}"] });
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false }, codegraph: { enabled: false }, managed: {
    enabled: true, adapters: [adapter], spawnProcess() { const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit("error", new Error("cannot launch"))); return child; },
  } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const task = instance.store.createTask({ projectId: instance.store.listProjects()[0].id, title: "Managed failure", description: "Small scoped work." });
  const runtimeProfile = { providerId: "managed-fixture", currentModel: "m", currentEffort: "e", currentModelClass: "balanced", currentEffortClass: "medium", availableModels: [{ id: "m", class: "balanced", efforts: [{ id: "e", class: "medium" }] }], switchMode: "automatic", source: "adapter", observedAt: new Date().toISOString() };
  const agent = instance.store.connectAgent({ name: "Managed", provider: "fixture", runtimeProfile, freshTaskId: task.id });
  const claim = instance.store.claimNextAssignment(agent.id);
  const response = await fetch(`${instance.url}/api/tasks/${task.id}/managed-launch`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` }, body: JSON.stringify({ agentId: agent.id, assignmentId: claim.id, adapterId: "failing", modelId: "m", effortId: "e" }) });
  assert.equal(response.status, 400);
  const row = instance.store.db.prepare("SELECT status, agent_id FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(row.status, "claimed");
  assert.equal(row.agent_id, agent.id);
  assert.equal(instance.store.db.prepare("SELECT status FROM session_checkpoints ORDER BY created_at DESC LIMIT 1").get().status, "cancelled");
});
