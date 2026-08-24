import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevTeamServer } from "../src/devteam/server.mjs";

async function connectClient(instance, name) {
  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("MCP and dashboard checkpoint workflows preserve auth, one-time takeover, and fencing", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checkpoint-server-"));
  const instance = await startDevTeamServer({
    port: 0,
    dataDir,
    workspaceRoot: process.cwd(),
    knowledge: { enabled: false },
    codegraph: { enabled: false },
  });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const authHeaders = { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` };
  const home = await fetch(instance.url).then((response) => response.text());
  assert.match(home, /Session handoffs/);
  assert.match(home, /Create checkpoint & invitation/);
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const taskResponse = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Checkpoint integration", description: "Transfer through MCP.", requiredApprovals: 1 }),
  });
  const task = await taskResponse.json();

  const oldClient = await connectClient(instance, "old-session");
  const freshClient = await connectClient(instance, "fresh-session");
  t.after(async () => { await Promise.allSettled([oldClient.close(), freshClient.close()]); });
  const tools = await oldClient.listTools();
  for (const name of ["devteam_session_checkpoint", "devteam_session_checkpoint_get", "devteam_session_takeover", "devteam_session_checkpoint_cancel"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `${name} is registered`);
  }

  const oldConnect = await oldClient.callTool({ name: "devteam_connect", arguments: { name: "Old MCP", provider: "test", taskId: task.id } });
  const oldAgentId = oldConnect.structuredContent.agent.id;
  const claimed = await oldClient.callTool({ name: "devteam_wait", arguments: { agentId: oldAgentId, timeoutSeconds: 1 } });
  const oldAssignment = claimed.structuredContent.assignment;
  const created = await oldClient.callTool({
    name: "devteam_session_checkpoint",
    arguments: {
      agentId: oldAgentId,
      taskId: task.id,
      assignmentId: oldAssignment.id,
      decisions: ["Keep the transaction atomic."],
      checks: ["node --test focused"],
      nextAction: "Verify the repository, then continue.",
    },
  });
  assert.equal(created.isError, undefined);
  const checkpoint = created.structuredContent;
  assert.ok(checkpoint.handoffToken);
  assert.equal(JSON.stringify(checkpoint).includes("handoff_token_hash"), false);
  assert.ok(checkpoint.checkpoint.capsule.capsuleMeta.bytes <= 16_384);

  const freshConnect = await freshClient.callTool({ name: "devteam_connect", arguments: { name: "Fresh MCP", provider: "test", taskId: task.id } });
  const freshAgentId = freshConnect.structuredContent.agent.id;
  const bad = await freshClient.callTool({
    name: "devteam_session_takeover",
    arguments: { agentId: freshAgentId, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: "wrong-token-wrong-token" },
  });
  assert.equal(bad.isError, true);
  const takeover = await freshClient.callTool({
    name: "devteam_session_takeover",
    arguments: { agentId: freshAgentId, taskId: task.id, checkpointId: checkpoint.checkpoint.id, handoffToken: checkpoint.handoffToken },
  });
  assert.equal(takeover.isError, undefined);
  assert.equal(takeover.structuredContent.takenOver, true);
  assert.ok(takeover.structuredContent.assignment.claimToken);

  const staleReport = await oldClient.callTool({
    name: "devteam_report",
    arguments: {
      agentId: oldAgentId,
      assignmentId: oldAssignment.id,
      claimToken: oldAssignment.claimToken,
      message: "This report is stale.",
    },
  });
  assert.equal(staleReport.structuredContent.completed, false);
  assert.equal(staleReport.structuredContent.claimConflict.currentOwner, "Fresh MCP");

  const unauthenticatedCapsule = await fetch(`${instance.url}/api/tasks/${task.id}/checkpoints/${checkpoint.checkpoint.id}`);
  assert.equal(unauthenticatedCapsule.status, 401);
  const authorizedCapsule = await fetch(`${instance.url}/api/tasks/${task.id}/checkpoints/${checkpoint.checkpoint.id}`, {
    headers: { authorization: `Bearer ${instance.store.token}` },
  });
  assert.equal(authorizedCapsule.status, 200);
  assert.equal(JSON.stringify(await authorizedCapsule.json()).includes("handoff_token_hash"), false);

  const dashboardCheckpointResponse = await fetch(`${instance.url}/api/tasks/${task.id}/checkpoints`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ assignmentId: oldAssignment.id, nextAction: "Continue from the dashboard invitation." }),
  });
  assert.equal(dashboardCheckpointResponse.status, 201);
  const dashboardCheckpoint = await dashboardCheckpointResponse.json();
  assert.match(dashboardCheckpoint.invitation, new RegExp(dashboardCheckpoint.checkpoint.id));
  assert.match(dashboardCheckpoint.invitation, new RegExp(dashboardCheckpoint.handoffToken));
  assert.equal(dashboardCheckpoint.invitation.includes(instance.store.token), false);
  assert.doesNotMatch(dashboardCheckpoint.invitation, /resumeToken|claimToken|handoff_token_hash/);

  const hostileOrigin = await fetch(`${instance.url}/api/tasks/${task.id}/checkpoints/${dashboardCheckpoint.checkpoint.id}/cancel`, {
    method: "POST",
    headers: { ...authHeaders, origin: "https://attacker.example" },
    body: JSON.stringify({}),
  });
  assert.equal(hostileOrigin.status, 403);
  const cancelled = await fetch(`${instance.url}/api/tasks/${task.id}/checkpoints/${dashboardCheckpoint.checkpoint.id}/cancel`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ reason: "Integration cancellation." }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, "cancelled");

  const detail = await fetch(`${instance.url}/api/tasks/${task.id}`).then((response) => response.json());
  assert.ok(detail.sessionCheckpoints.some((item) => item.id === checkpoint.checkpoint.id && item.status === "claimed"));
  assert.equal(JSON.stringify(detail).includes("handoff_token_hash"), false);
});
