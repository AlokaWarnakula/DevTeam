import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevTeamServer } from "../src/devteam/server.mjs";

test("dashboard API and authenticated MCP endpoint work together", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-server-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd() });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const home = await fetch(instance.url);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /DevTeam/);
  const config = await fetch(`${instance.url}/api/config`).then((response) => response.json());
  assert.equal(config.mcpUrl, instance.mcpUrl);
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  assert.equal(state.projects.length, 1);

  const unauthorized = await fetch(instance.mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert.equal(unauthorized.status, 401);

  const taskResponse = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "MCP integration", description: "Claim this through MCP.", requiredApprovals: 1 }),
  });
  assert.equal(taskResponse.status, 201);
  const createdTask = await taskResponse.json();

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "devteam_connect"));
  assert.ok(tools.tools.some((tool) => tool.name === "devteam_wait"));

  const connected = await client.callTool({ name: "devteam_connect", arguments: { name: "Integration Agent", provider: "test", capabilities: ["planning"] } });
  const agentId = connected.structuredContent.agent.id;
  const waiting = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(waiting.structuredContent.status, "assigned");
  assert.equal(waiting.structuredContent.assignment.role, "planner");
  const disconnected = await client.callTool({ name: "devteam_disconnect", arguments: { agentId, summary: "Integration verified." } });
  assert.equal(disconnected.structuredContent.disconnected, true);

  const explicitEmptyState = await fetch(`${instance.url}/api/state?taskId=`).then((response) => response.json());
  assert.equal(explicitEmptyState.selectedTask, null);

  const wrongConfirmation = await fetch(`${instance.url}/api/tasks/${createdTask.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmTaskId: "not-the-task" }),
  });
  assert.equal(wrongConfirmation.status, 400);
  const deleteTask = await fetch(`${instance.url}/api/tasks/${createdTask.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmTaskId: createdTask.id }),
  });
  assert.equal(deleteTask.status, 200);
  assert.equal((await deleteTask.json()).filesDeleted, false);

  const deleteProject = await fetch(`${instance.url}/api/projects/${state.projects[0].id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmName: state.projects[0].name }),
  });
  assert.equal(deleteProject.status, 200);
  assert.equal((await deleteProject.json()).filesDeleted, false);
});

test("a human message wakes a waiting agent through MCP and records delivery", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-wake-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd() });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Live chat", description: "Talk to a connected agent.", requiredApprovals: 1 }),
  }).then((response) => response.json());

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-message-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const connected = await client.callTool({ name: "devteam_connect", arguments: { name: "Codex", provider: "test", capabilities: ["coding"] } });
  const agentId = connected.structuredContent.agent.id;

  await fetch(`${instance.url}/api/tasks/${task.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Codex, please prioritise security.", target: "Codex" }),
  });

  const waking = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 5 } });
  assert.equal(waking.structuredContent.status, "message", "a pending message is returned before any assignment");
  assert.match(waking.structuredContent.messages[0].message, /prioritise security/);
  assert.equal(waking.structuredContent.keepWaiting, true);

  const detail = await fetch(`${instance.url}/api/tasks/${task.id}`).then((response) => response.json());
  const humanEvent = detail.events.find((event) => event.type === "human.message");
  assert.ok(humanEvent.receipts.some((receipt) => receipt.agent_name === "Codex" && receipt.delivered_at), "delivery is recorded for the dashboard");

  const nextWait = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 5 } });
  assert.equal(nextWait.structuredContent.status, "assigned", "after messages drain, queued work is claimed");
  assert.equal(nextWait.structuredContent.assignment.role, "planner");
});

test("an MCP session cannot act as an agent it did not connect as", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-identity-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd() });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const connect = async (name) => {
    const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    t.after(() => client.close());
    const result = await client.callTool({ name: "devteam_connect", arguments: { name, provider: "test" } });
    return { client, agentId: result.structuredContent.agent.id };
  };

  const alpha = await connect("Alpha");
  const beta = await connect("Beta");

  // Beta tries to act as Alpha by passing Alpha's agentId.
  const spoof = await beta.client.callTool({ name: "devteam_disconnect", arguments: { agentId: alpha.agentId, summary: "spoofed" } });
  assert.equal(spoof.isError, true, "acting as another agent is rejected");

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const alphaState = state.agents.find((agent) => agent.id === alpha.agentId);
  assert.ok(alphaState && alphaState.status !== "disconnected", "the impersonated agent is untouched");
});

test("mutating API rejects cross-origin and non-local requests", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-origin-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd() });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const body = JSON.stringify({ projectId: state.projects[0].id, title: "From a web page", description: "Injected." });

  const crossOrigin = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body,
  });
  assert.equal(crossOrigin.status, 403, "a foreign Origin is blocked");

  const sameOrigin = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: instance.url },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "From the dashboard", description: "Allowed." }),
  });
  assert.equal(sameOrigin.status, 201, "the same-origin dashboard is allowed");
});

test("a busy agent is reached with pending messages on its next action", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-reach-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd() });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Reach me", description: "Message a busy agent.", requiredApprovals: 1 }),
  }).then((response) => response.json());

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-reach-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const connected = await client.callTool({ name: "devteam_connect", arguments: { name: "Worker", provider: "test" } });
  const agentId = connected.structuredContent.agent.id;
  const assigned = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 2 } });
  assert.equal(assigned.structuredContent.status, "assigned", "the agent is now busy on the planner assignment");

  // The human reaches the agent while it is busy (not sitting in devteam_wait).
  await fetch(`${instance.url}/api/tasks/${task.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Please pause and check the spec.", target: "Worker" }),
  });

  const inspected = await client.callTool({ name: "devteam_state", arguments: { agentId, taskId: task.id } });
  assert.ok(Array.isArray(inspected.structuredContent.pendingMessages), "an ordinary action carries the agent's inbox");
  assert.match(inspected.structuredContent.pendingMessages[0].message, /check the spec/);
});
