import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  initProject,
  parseAgentResponse,
  pathsFor,
  runBridge,
  setTask,
  submitTask,
  queuedTasks,
  watchBridge,
} from "../src/core.mjs";

async function tempProject() {
  return mkdtemp(path.join(os.tmpdir(), "agent-bridge-test-"));
}

test("init creates state without overwriting configuration", async () => {
  const project = await tempProject();
  const first = await initProject(project);
  assert.ok(first.created.includes("bridge.config.json"));
  const configPath = pathsFor(project).config;
  await writeFile(configPath, "{\"custom\":true}\n", "utf8");
  const second = await initProject(project);
  assert.equal(await readFile(configPath, "utf8"), "{\"custom\":true}\n");
  assert.equal(second.created.length, 0);
});

test("parser accepts envelopes and safely handles plain text", () => {
  assert.deepEqual(
    parseAgentResponse('noise\n<<<BRIDGE_RESPONSE>>>\n{"status":"done","message":"checked"}\n<<<END_BRIDGE_RESPONSE>>>'),
    { status: "done", message: "checked" },
  );
  const fallback = parseAgentResponse("plain response");
  assert.equal(fallback.status, "continue");
  assert.match(fallback.message, /unstructured/);
});

test("two mock agents reach consensus and produce an accepted final", async () => {
  const project = await tempProject();
  await initProject(project);
  const mock = path.resolve("fixtures/mock-agent.mjs");
  const config = {
    ...DEFAULT_CONFIG,
    minAgents: 2,
    maxRounds: 3,
    agents: ["Alpha", "Beta"].map((name) => ({
      name,
      role: "test agent",
      command: process.execPath,
      args: [mock, name],
      input: "stdin",
      enabled: true,
    })),
  };
  await writeFile(pathsFor(project).config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await setTask(project, "Prove the orchestrator reaches consensus");
  const result = await runBridge(project);
  assert.equal(result.status, "accepted");
  assert.deepEqual(result.approvals, ["Alpha", "Beta"]);
  assert.match(await readFile(pathsFor(project).connection, "utf8"), /### Alpha/);
  assert.match(await readFile(pathsFor(project).final, "utf8"), /status: accepted/);
});

test("submit creates a queued inbox task", async () => {
  const project = await tempProject();
  const file = await submitTask(project, "Review the project");
  assert.equal((await readFile(file, "utf8")).trim(), "Review the project");
  assert.equal((await queuedTasks(project)).length, 1);
});

test("watcher sleeps until a submitted task arrives, then processes it", async () => {
  const project = await tempProject();
  await initProject(project);
  const mock = path.resolve("fixtures/mock-agent.mjs");
  const config = {
    ...DEFAULT_CONFIG,
    minAgents: 2,
    maxRounds: 3,
    pollMs: 10,
    agents: ["Alpha", "Beta"].map((name) => ({
      name,
      role: "test agent",
      command: process.execPath,
      args: [mock, name],
      input: "stdin",
      enabled: true,
    })),
  };
  await writeFile(pathsFor(project).config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const controller = new AbortController();
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const watcher = watchBridge(project, {
    signal: controller.signal,
    onResult: (_name, result) => {
      controller.abort();
      finish(result);
    },
  });
  await submitTask(project, "Process this queued task");
  const result = await finished;
  await watcher;
  assert.equal(result.status, "accepted");
  assert.equal((await queuedTasks(project)).length, 0);
});
