import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startDevTeamServer } from "../src/devteam/server.mjs";

const profile = {
  providerId: "server-fixture",
  currentModel: "balanced-fixture",
  currentEffort: "medium-fixture",
  currentModelClass: "balanced",
  currentEffortClass: "medium",
  availableModels: [
    { id: "balanced-fixture", class: "balanced", efforts: [{ id: "medium-fixture", class: "medium" }] },
    { id: "frontier-fixture", class: "frontier", efforts: [{ id: "high-fixture", class: "high" }] },
  ],
  switchMode: "user_required",
  source: "host",
  observedAt: new Date().toISOString(),
};

test("runtime MCP, REST authorization, pre-claim gate, decisions, and dashboard surface work together", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-runtime-server-"));
  const instance = await startDevTeamServer({
    port: 0, dataDir, workspaceRoot: process.cwd(),
    knowledge: { enabled: false }, codegraph: { enabled: false },
  });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const auth = { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` };
  const html = await fetch(instance.url).then((response) => response.text());
  assert.match(html, /Switch recommended/);
  assert.match(html, /Continue anyway/);
  assert.match(html, /Reassign/);
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Runtime server", description: "Test authenticated runtime APIs.", requiredApprovals: 1 }),
  }).then((response) => response.json());
  const planner = instance.store.db.prepare("SELECT id FROM assignments WHERE task_id = ?").get(task.id);
  instance.store.setAssignmentComplexityOverride({ assignmentId: planner.id, override: { level: "critical" } });

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "runtime-server-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const toolNames = new Set((await client.listTools()).tools.map((tool) => tool.name));
  for (const name of ["devteam_runtime_update", "devteam_runtime_decision", "devteam_assignment_assessment"]) assert.ok(toolNames.has(name));
  const connected = await client.callTool({ name: "devteam_connect", arguments: { name: "Runtime MCP", provider: "fixture", taskId: task.id, runtimeProfile: profile } });
  const agentId = connected.structuredContent.agent.id;
  const gate = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(gate.structuredContent.status, "runtime_action_required");
  assert.equal(gate.structuredContent.leaseAcquired, false);
  assert.equal(instance.store.db.prepare("SELECT status FROM assignments WHERE id = ?").get(planner.id).status, "queued");

  const unauthorizedProfile = await fetch(`${instance.url}/api/agents/${agentId}/runtime`);
  assert.equal(unauthorizedProfile.status, 401);
  const authorizedProfile = await fetch(`${instance.url}/api/agents/${agentId}/runtime`, { headers: auth });
  assert.equal(authorizedProfile.status, 200);
  const assessment = await client.callTool({ name: "devteam_assignment_assessment", arguments: { agentId, assignmentId: planner.id } });
  assert.equal(assessment.structuredContent.level, "critical");
  const continued = await fetch(`${instance.url}/api/assignments/${planner.id}/runtime-decisions`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ agentId, assessmentId: gate.structuredContent.assessment.id, choice: "continue", reason: "Human accepts continuity risk." }),
  });
  assert.equal(continued.status, 201);
  const assigned = await client.callTool({ name: "devteam_wait", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(assigned.structuredContent.status, "assigned");
  assert.equal(assigned.structuredContent.assignment.id, planner.id);

  const events = instance.store.db.prepare("SELECT type FROM events WHERE task_id = ?").all(task.id).map((row) => row.type);
  for (const type of ["runtime.profile_updated", "assignment.complexity_assessed", "runtime.switch_recommended", "runtime.decision_recorded"]) assert.ok(events.includes(type), `${type} recorded`);
});
