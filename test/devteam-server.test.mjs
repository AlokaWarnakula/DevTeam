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
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const home = await fetch(instance.url);
  assert.equal(home.status, 200);
  const homeHtml = await home.text();
  assert.match(homeHtml, /DevTeam/);
  assert.match(homeHtml, /Memory health/);
  assert.match(homeHtml, /knowledge-filter/);
  assert.match(homeHtml, /role="log" aria-label="Team chat history"/, "chat history has accessible log semantics");
  assert.match(homeHtml, /Shift \+ Enter<\/kbd> new line/, "multiline drafting shortcut is visible");
  assert.match(homeHtml, /id="task-brief-dialog"/, "long task briefs have a dedicated dialog");
  assert.match(homeHtml, /data-timeline-filter="decisions"/, "timeline categories are directly filterable");
  assert.match(homeHtml, /data-resize-panel="sidebar"/, "workspace panels expose an accessible resize separator");
  assert.match(homeHtml, /id="search-dialog"/, "workspace search is available from the dashboard");
  const dashboardScript = await fetch(`${instance.url}/app.js`).then((response) => response.text());
  const dashboardStyles = await fetch(`${instance.url}/overrides.css`).then((response) => response.text());
  const dashboardUtilities = await fetch(`${instance.url}/ui-utils.js`).then((response) => response.text());
  assert.match(dashboardScript, /function resizeMessageField\(/, "the message composer grows with multiline drafts");
  assert.match(dashboardScript, /!event\.isComposing/, "IME composition does not submit a partial message");
  assert.match(dashboardScript, /if \(messageSending\)/, "duplicate sends are guarded while a post is in flight");
  assert.match(dashboardScript, /Draft saved locally/, "per-task draft recovery is wired into chat");
  assert.match(dashboardScript, /data-retry-send/, "failed optimistic sends expose retry state");
  assert.match(dashboardScript, /if \(narrow\)[\s\S]*sidebar-collapsed", "panel-collapsed/, "narrow screens start with both overlay drawers closed");
  assert.match(dashboardScript, /window\.innerWidth - peerWidth - 460/, "panel resizing preserves usable chat width");
  assert.match(dashboardUtilities, /export function renderSafeMarkdown/, "safe message formatting ships as a testable module");
  assert.match(dashboardStyles, /#task-description[\s\S]*white-space: break-spaces;/, "task descriptions preserve authored whitespace");
  assert.match(dashboardStyles, /\.task-brief-content[\s\S]*overflow: auto;/, "long briefs stay bounded and scrollable in the dialog");
  assert.match(dashboardStyles, /@media \(max-width: 1050px\)[\s\S]*\.panel-resizer \{ display: none;/, "resize handles are removed when panels become narrow-screen drawers");
  const config = await fetch(`${instance.url}/api/config`).then((response) => response.json());
  assert.equal(config.mcpUrl, instance.mcpUrl);
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  assert.equal(state.projects.length, 1);

  const unauthorized = await fetch(instance.mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  assert.equal(unauthorized.status, 401);

  const taskResponse = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "MCP integration", description: "Claim this through MCP.", requiredApprovals: 1 }),
  });
  assert.equal(taskResponse.status, 201);
  const createdTask = await taskResponse.json();
  const search = await fetch(`${instance.url}/api/search?q=MCP%20integration`).then((response) => response.json());
  assert.ok(search.results.some((result) => result.kind === "task" && result.task_id === createdTask.id), "workspace search finds persisted task content");

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "devteam_join"));
  assert.ok(tools.tools.some((tool) => tool.name === "devteam_next"));

  const connected = await client.callTool({ name: "devteam_join", arguments: { name: "Integration Agent", provider: "test", capabilities: ["planning"], taskId: createdTask.id } });
  const agentId = connected.structuredContent.agent.id;
  const waiting = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(waiting.structuredContent.status, "assigned");
  assert.equal(waiting.structuredContent.assignment.role, "planner");
  const healthState = await fetch(`${instance.url}/api/state?taskId=${createdTask.id}`).then((response) => response.json());
  assert.equal(healthState.selectedTask.memoryHealth.brief.bytes, waiting.structuredContent.briefMeta.bytes);
  assert.equal(healthState.selectedTask.memoryHealth.brief.limitBytes, 32 * 1024);
  const disconnected = await client.callTool({ name: "devteam_leave", arguments: { agentId, summary: "Integration verified." } });
  assert.equal(disconnected.structuredContent.disconnected, true);

  const explicitEmptyState = await fetch(`${instance.url}/api/state?taskId=`).then((response) => response.json());
  assert.equal(explicitEmptyState.selectedTask, null);

  const wrongConfirmation = await fetch(`${instance.url}/api/tasks/${createdTask.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ confirmTaskId: "not-the-task" }),
  });
  assert.equal(wrongConfirmation.status, 400);
  const deleteTask = await fetch(`${instance.url}/api/tasks/${createdTask.id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ confirmTaskId: createdTask.id }),
  });
  assert.equal(deleteTask.status, 200);
  assert.equal((await deleteTask.json()).filesDeleted, false);

  const deleteProject = await fetch(`${instance.url}/api/projects/${state.projects[0].id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ confirmName: state.projects[0].name }),
  });
  assert.equal(deleteProject.status, 200);
  assert.equal((await deleteProject.json()).filesDeleted, false);
});

test("an unscoped MCP agent on a multi-task server receives room choices instead of false idle", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-room-required-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const auth = { authorization: `Bearer ${instance.store.token}`, "content-type": "application/json" };
  const create = (title) => fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ projectId: state.projects[0].id, title, description: `${title} room.` }),
  }).then((response) => response.json());
  const [first, second] = await Promise.all([create("First task"), create("Second task")]);

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-room-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const connected = await client.callTool({ name: "devteam_join", arguments: { name: "Roomless Agent", provider: "test" } });
  const result = connected.structuredContent;
  assert.equal(result.roomRequired, true);
  assert.deepEqual(new Set(result.availableTasks.map((task) => task.id)), new Set([first.id, second.id]));
  const waiting = await client.callTool({ name: "devteam_next", arguments: { agentId: result.agent.id, timeoutSeconds: 1 } });
  assert.equal(waiting.structuredContent.status, "room_required");
  assert.equal(waiting.structuredContent.keepWaiting, false);
  assert.match(waiting.structuredContent.next, /devteam_join/);

  const joined = await client.callTool({ name: "devteam_join", arguments: { agentId: result.agent.id, taskId: first.id, role: "contributor" } });
  assert.equal(joined.structuredContent.joined, true);
  const assigned = await client.callTool({ name: "devteam_next", arguments: { agentId: result.agent.id, timeoutSeconds: 1 } });
  assert.equal(assigned.structuredContent.status, "assigned");
  assert.equal(assigned.structuredContent.assignment.task_id, first.id);
});

test("MCP assignment dependencies sequence work and devteam_brief stays compact", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-dependency-mcp-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${instance.store.token}`, "content-type": "application/json" },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Dependency MCP", description: "Sequence work." }),
  }).then((response) => response.json());
  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-dependency-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const connected = await client.callTool({ name: "devteam_join", arguments: { name: "Worker", provider: "test", taskId: task.id } });
  const agentId = connected.structuredContent.agent.id;
  const planner = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(planner.structuredContent.briefMeta.bytes, Buffer.byteLength(JSON.stringify(planner.structuredContent), "utf8"));
  assert.ok(planner.structuredContent.briefMeta.bytes <= 32 * 1024, "automatic assignment context obeys the same hard budget");
  const parent = await client.callTool({ name: "devteam_plan", arguments: { agentId, taskId: task.id, title: "Parent", description: "First." } });
  const child = await client.callTool({ name: "devteam_plan", arguments: { agentId, taskId: task.id, title: "Child", description: "Second.", dependsOn: [parent.structuredContent.id] } });
  instance.store.humanMessage(task.id, "😀".repeat(50_000), "Worker");
  const brief = await client.callTool({ name: "devteam_next", arguments: { agentId, want: "brief", taskId: task.id } });
  assert.equal(brief.structuredContent.briefMeta.bytes, Buffer.byteLength(JSON.stringify(brief.structuredContent), "utf8"));
  assert.ok(brief.structuredContent.briefMeta.bytes <= 32 * 1024, "pending live messages remain inside the brief budget");
  assert.equal(brief.structuredContent.pendingMessages.length, 1);
  assert.ok(Buffer.byteLength(brief.structuredContent.pendingMessages[0].message, "utf8") <= 1_200);
  assert.equal(brief.structuredContent.currentAssignment.id, planner.structuredContent.assignment.id);
  assert.deepEqual(brief.structuredContent.openAssignments.find((item) => item.id === child.structuredContent.id).dependsOn, [parent.structuredContent.id]);
  assert.equal(Object.hasOwn(brief.structuredContent, "agents"), false);

  await client.callTool({ name: "devteam_report", arguments: { agentId, assignmentId: planner.structuredContent.assignment.id, claimToken: planner.structuredContent.assignment.claimToken, message: "Planned." } });
  const parentClaim = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(parentClaim.structuredContent.assignment.id, parent.structuredContent.id);
  // A check with an explicit `command: null` means "this one is an assertion". The schema used to
  // reject it outright — `Invalid input at checks[1]` — and the only way to find that out was to
  // have a report refused mid-session and guess that a bare string was the shape it wanted.
  const asserted = await client.callTool({ name: "devteam_report", arguments: { agentId, assignmentId: parent.structuredContent.id, claimToken: parentClaim.structuredContent.assignment.claimToken, message: "Parent done.", checks: [{ label: "Reviewed by hand", command: null }] } });
  assert.equal(asserted.isError ?? false, false, "an explicit null command is an assertion, not a validation error");
  assert.equal(asserted.structuredContent.checks[0].status, "asserted");
  const childClaim = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 1 } });
  assert.equal(childClaim.structuredContent.assignment.id, child.structuredContent.id);
});

test("a human message wakes a waiting agent through MCP and records delivery", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-wake-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Live chat", description: "Talk to a connected agent.", requiredApprovals: 1 }),
  }).then((response) => response.json());

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-message-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const connected = await client.callTool({ name: "devteam_join", arguments: { name: "Codex", provider: "test", capabilities: ["coding"], taskId: task.id } });
  const agentId = connected.structuredContent.agent.id;

  const authoredMessage = "Codex,\n\nplease   prioritise security.";
  await fetch(`${instance.url}/api/tasks/${task.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ message: authoredMessage, target: "Codex" }),
  });

  const waking = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 5 } });
  assert.equal(waking.structuredContent.status, "message", "a pending message is returned before any assignment");
  assert.match(waking.structuredContent.messages[0].message, /prioritise security/);
  assert.equal(waking.structuredContent.keepWaiting, true);

  const detail = await fetch(`${instance.url}/api/tasks/${task.id}`).then((response) => response.json());
  const humanEvent = detail.events.find((event) => event.type === "human.message");
  assert.equal(humanEvent.message, authoredMessage, "internal line breaks and repeated spaces survive the chat pipeline");
  assert.ok(humanEvent.receipts.some((receipt) => receipt.agent_name === "Codex" && receipt.delivered_at), "delivery is recorded for the dashboard");

  const nextWait = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 5 } });
  assert.equal(nextWait.structuredContent.status, "assigned", "after messages drain, queued work is claimed");
  assert.equal(nextWait.structuredContent.assignment.role, "planner");
});

test("an MCP session cannot act as an agent it did not connect as", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-identity-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const connect = async (name) => {
    const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
    });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(transport);
    t.after(() => client.close());
    const result = await client.callTool({ name: "devteam_join", arguments: { name, provider: "test" } });
    return { client, agentId: result.structuredContent.agent.id };
  };

  const alpha = await connect("Alpha");
  const beta = await connect("Beta");

  // Beta tries to act as Alpha by passing Alpha's agentId.
  const spoof = await beta.client.callTool({ name: "devteam_leave", arguments: { agentId: alpha.agentId, summary: "spoofed" } });
  assert.equal(spoof.isError, true, "acting as another agent is rejected");

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const alphaState = state.agents.find((agent) => agent.id === alpha.agentId);
  assert.ok(alphaState && alphaState.status !== "disconnected", "the impersonated agent is untouched");
});

test("mutating API rejects cross-origin and non-local requests", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-origin-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const body = JSON.stringify({ projectId: state.projects[0].id, title: "From a web page", description: "Injected." });

  const crossOrigin = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://evil.example" },
    body,
  });
  assert.equal(crossOrigin.status, 403, "a foreign Origin is blocked");

  // Same-origin but without a credential is now also rejected: the control plane needs the
  // dashboard session cookie or the bearer token, not merely a loopback origin.
  const noCredential = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: instance.url },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "No credential", description: "Rejected." }),
  });
  assert.equal(noCredential.status, 401, "a same-origin request without a credential is rejected");

  // The routine config no longer leaks the bearer token; it is only served behind the credential.
  const config = await fetch(`${instance.url}/api/config`).then((response) => response.json());
  assert.equal(config.token, undefined, "the config endpoint no longer returns the bearer token");
  const setupNoAuth = await fetch(`${instance.url}/api/setup`);
  assert.equal(setupNoAuth.status, 401, "the setup/token endpoint requires a credential");
  const setup = await fetch(`${instance.url}/api/setup`, { headers: { authorization: `Bearer ${instance.store.token}` } }).then((r) => r.json());
  assert.equal(setup.token, instance.store.token, "with the bearer token, setup returns the connection details");

  const sameOrigin = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: instance.url, authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "From the dashboard", description: "Allowed." }),
  });
  assert.equal(sameOrigin.status, 201, "the same-origin dashboard with a credential is allowed");
});

test("a busy agent is reached with pending messages on its next action", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-reach-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Reach me", description: "Message a busy agent.", requiredApprovals: 1 }),
  }).then((response) => response.json());

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-reach-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const connected = await client.callTool({ name: "devteam_join", arguments: { name: "Worker", provider: "test", taskId: task.id } });
  const agentId = connected.structuredContent.agent.id;
  const assigned = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 2 } });
  assert.equal(assigned.structuredContent.status, "assigned", "the agent is now busy on the planner assignment");

  // The human reaches the agent while it is busy (not sitting in devteam_wait).
  await fetch(`${instance.url}/api/tasks/${task.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ message: "Please pause and check the spec.", target: "Worker" }),
  });

  const inspected = await client.callTool({ name: "devteam_next", arguments: { agentId, want: "state", taskId: task.id } });
  assert.ok(Array.isArray(inspected.structuredContent.pendingMessages), "an ordinary action carries the agent's inbox");
  assert.match(inspected.structuredContent.pendingMessages[0].message, /check the spec/);
});

test("shared blackboard round-trips over MCP and a stuck write lease can be force-released via REST", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-hive-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((r) => r.json());
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Hive features", description: "Blackboard + force-release.", requiredApprovals: 1 }),
  }).then((r) => r.json());

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "devteam-hive-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const connected = await client.callTool({ name: "devteam_join", arguments: { name: "Worker", provider: "test", taskId: task.id } });
  const agentId = connected.structuredContent.agent.id;

  // Shared memory writes and reads back over MCP with provenance.
  await client.callTool({ name: "devteam_memory", arguments: { agentId, taskId: task.id, action: "set", key: "world", value: "goal: ship it" } });
  const got = await client.callTool({ name: "devteam_memory", arguments: { agentId, taskId: task.id, action: "get", key: "world" } });
  assert.equal(got.structuredContent.value, "goal: ship it");
  assert.equal(got.structuredContent.version, 1);
  assert.equal(got.structuredContent.scope, "task");

  await client.callTool({ name: "devteam_memory", arguments: { agentId, taskId: task.id, action: "set", scope: "project", key: "architecture", value: "local-first" } });
  const projectNote = await client.callTool({ name: "devteam_memory", arguments: { agentId, taskId: task.id, action: "get", scope: "project", key: "architecture" } });
  assert.equal(projectNote.structuredContent.scope, "project");
  assert.equal(projectNote.structuredContent.value, "local-first");
  const projectKeys = await client.callTool({ name: "devteam_memory", arguments: { agentId, taskId: task.id, action: "get", scope: "project" } });
  assert.equal(projectKeys.structuredContent.scope, "project");
  assert.deepEqual(projectKeys.structuredContent.keys.map((item) => item.key), ["architecture"]);
  assert.equal(instance.store.taskDetail(task.id).projectBlackboard[0].value, "local-first");

  // Claim the planner assignment, then delegate a write assignment and claim it to hold a lease.
  await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 2 } });
  const plannerId = instance.store.taskDetail(task.id).assignments.find((a) => a.role === "planner").id;
  await client.callTool({ name: "devteam_report", arguments: { agentId, assignmentId: plannerId, message: "Planned." } });
  const write = instance.store.createAssignment({ taskId: task.id, title: "Do the write", description: "Edit files.", requiresWrite: true, targetAgentName: "Worker" });
  const claimed = await client.callTool({ name: "devteam_next", arguments: { agentId, timeoutSeconds: 2 } });
  assert.equal(claimed.structuredContent.assignment.id, write.id);
  assert.ok(claimed.structuredContent.assignment.claimToken, "the claim carries a fencing token");

  // Wrong title is refused; the exact title force-releases the lease back to the queue.
  const wrong = await fetch(`${instance.url}/api/assignments/${write.id}/force-release`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` }, body: JSON.stringify({ confirmTitle: "nope" }),
  });
  assert.equal(wrong.status, 400);
  const released = await fetch(`${instance.url}/api/assignments/${write.id}/force-release`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` }, body: JSON.stringify({ confirmTitle: "Do the write" }),
  });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);
  assert.equal(instance.store.taskDetail(task.id).assignments.find((a) => a.id === write.id).status, "queued");
});

test("task attachments validate content, size, paths, and serve safe previews", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-attachments-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const auth = { authorization: `Bearer ${instance.store.token}` };
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Attach evidence", description: "Share an image safely." }),
  }).then((response) => response.json());
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  const noCredential = await fetch(`${instance.url}/api/tasks/${task.id}/attachments`, {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-file-type": "image/png", "x-file-name": "image.png" }, body: png,
  });
  assert.equal(noCredential.status, 401);

  const uploaded = await fetch(`${instance.url}/api/tasks/${task.id}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-type": "image/png", "x-file-name": encodeURIComponent("../evidence.png"), ...auth },
    body: png,
  });
  assert.equal(uploaded.status, 201);
  const attachment = await uploaded.json();
  assert.equal(attachment.name, "evidence.png", "display names cannot retain traversal segments");
  assert.equal(path.relative(path.join(dataDir, "attachments", task.id), attachment.path).startsWith(".."), false, "stored files stay in the task directory");
  const preview = await fetch(`${instance.url}${attachment.previewUrl}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);

  const spoofed = await fetch(`${instance.url}/api/tasks/${task.id}/attachments`, {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-file-type": "application/pdf", "x-file-name": "fake.pdf", ...auth }, body: png,
  });
  assert.equal(spoofed.status, 400, "declared MIME must match the file signature");

  const oversized = await fetch(`${instance.url}/api/tasks/${task.id}/attachments`, {
    method: "POST", headers: { "content-type": "application/octet-stream", "x-file-type": "image/png", "x-file-name": "huge.png", ...auth }, body: Buffer.alloc(10 * 1024 * 1024 + 1, 0x89),
  });
  assert.equal(oversized.status, 400, "the per-file upload limit is enforced");
});

test("dashboard can continue completed work inside the same task conversation", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-continue-api-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const auth = { authorization: `Bearer ${instance.store.token}`, "content-type": "application/json" };
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Continue here", description: "Keep one conversation." }),
  }).then((response) => response.json());
  instance.store.db.prepare("UPDATE assignments SET status = 'done' WHERE task_id = ?").run(task.id);
  instance.store.db.prepare("UPDATE tasks SET status = 'accepted' WHERE id = ?").run(task.id);

  const response = await fetch(`${instance.url}/api/tasks/${task.id}/messages`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ message: "Now add export support.", target: "all", continueTask: true }),
  });
  assert.equal(response.status, 201);
  const continued = await response.json();
  assert.equal(continued.taskId, task.id);
  assert.equal(continued.reopened, true);
  const detail = await fetch(`${instance.url}/api/tasks/${task.id}`).then((result) => result.json());
  assert.equal(detail.status, "planning");
  assert.equal(detail.version, 2);
  assert.ok(detail.events.some((event) => event.message === "Now add export support."));
  assert.ok(detail.assignments.some((assignment) => assignment.status === "queued" && assignment.role === "planner" && /follow-up/i.test(assignment.title)));
});

test("dashboard can resume blocked work and records human acceptance without forging consensus", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-human-controls-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const state = await fetch(`${instance.url}/api/state`).then((response) => response.json());
  const auth = { authorization: `Bearer ${instance.store.token}`, "content-type": "application/json" };
  const task = await fetch(`${instance.url}/api/tasks`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ projectId: state.projects[0].id, title: "Human controls", description: "Recover and accept.", requiredApprovals: 2 }),
  }).then((response) => response.json());

  const earlyAccept = await fetch(`${instance.url}/api/tasks/${task.id}/accept`, {
    method: "POST", headers: auth, body: JSON.stringify({ summary: "Too soon." }),
  });
  assert.equal(earlyAccept.status, 400);

  await fetch(`${instance.url}/api/tasks/${task.id}/block`, {
    method: "POST", headers: auth, body: JSON.stringify({ reason: "Pause for a choice." }),
  });
  const resumedResponse = await fetch(`${instance.url}/api/tasks/${task.id}/unblock`, {
    method: "POST", headers: auth, body: JSON.stringify({ reason: "Choice made." }),
  });
  assert.equal(resumedResponse.status, 200);
  const resumed = await resumedResponse.json();
  assert.equal(resumed.version, 2);

  instance.store.db.prepare("UPDATE assignments SET status = 'done' WHERE task_id = ? AND status IN ('queued', 'claimed')").run(task.id);
  instance.store.db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(task.id);
  const acceptedResponse = await fetch(`${instance.url}/api/tasks/${task.id}/accept`, {
    method: "POST", headers: auth, body: JSON.stringify({ summary: "The delivered result is good." }),
  });
  assert.equal(acceptedResponse.status, 200);
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.humanOverride, true);
  assert.equal(accepted.approvalCount, 0);
  const detail = await fetch(`${instance.url}/api/tasks/${task.id}`).then((response) => response.json());
  const event = detail.events.findLast((item) => item.type === "task.accepted");
  assert.equal(detail.status, "accepted");
  assert.equal(event.metadata.humanOverride, true);
  assert.match(event.message, /Human accepted/);
});

test("the scheduler explains a held assignment over REST and over MCP", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-explain-server-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });

  const project = instance.store.ensureProject("Explain REST", process.cwd());
  const task = instance.store.createTask({ projectId: project.id, title: "Explain REST", description: "Exercise the explanation surface." });
  const agent = instance.store.connectAgent({ name: "Explainer", provider: "fixture", freshTaskId: task.id });
  const plan = instance.store.claimNextAssignment(agent.id);
  await instance.store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  instance.store.createAssignment({
    taskId: task.id, title: "Ship the feature", description: "Edit source.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const reviewer = instance.store.createAssignment({ taskId: task.id, title: "Review it", description: "Read the diff.", role: "reviewer" });

  // The dashboard asks agent-agnostically, on any queued assignment.
  const agnostic = await fetch(`${instance.url}/api/assignments/${reviewer.id}/why-not-claimable`).then((response) => response.json());
  assert.equal(agnostic.claimable, false);
  assert.equal(agnostic.reasons[0].code, "awaiting_writer");
  assert.match(agnostic.reasons[0].detail, /Ship the feature/);

  // Naming an agent sharpens it to "why can *that* teammate not take it".
  const forAgent = await fetch(`${instance.url}/api/assignments/${reviewer.id}/why-not-claimable?agentId=${agent.id}`)
    .then((response) => response.json());
  assert.equal(forAgent.agentName, "Explainer");
  assert.ok(forAgent.reasons.some((reason) => reason.code === "awaiting_writer"));

  const transport = new StreamableHTTPClientTransport(new URL(instance.mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${instance.store.token}` } },
  });
  const client = new Client({ name: "explain-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const connected = await call("devteam_join", { name: "McpExplainer", provider: "fixture", taskId: task.id });
  const board = await call("devteam_stuck", { agentId: connected.agent.id, kind: "why" });
  assert.equal(board.queuedCount, 2, "an idle agent gets the whole board it may see");
  assert.equal(board.claimable.length, 1, "the writer is claimable, the reviewer is not");
  const single = await call("devteam_stuck", { agentId: connected.agent.id, kind: "why", assignmentId: reviewer.id });
  assert.equal(single.claimable, false);
  assert.match(single.reasons.find((reason) => reason.code === "awaiting_writer").detail, /Ship the feature/);
});

test("the check-command allowlist is a credentialed human decision, not an agent-reachable one", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checks-server-"));
  const instance = await startDevTeamServer({ port: 0, dataDir, workspaceRoot: process.cwd(), knowledge: { enabled: false } });
  t.after(async () => { await instance.close(); await rm(dataDir, { recursive: true, force: true }); });
  const authed = { "content-type": "application/json", authorization: `Bearer ${instance.store.token}` };
  const project = instance.store.ensureProject("Checks REST", process.cwd());

  // Reading the allowlist discloses what this host is willing to run, so it needs the credential.
  assert.equal((await fetch(`${instance.url}/api/projects/${project.id}/check-commands`)).status, 401);
  const anonymousWrite = await fetch(`${instance.url}/api/projects/${project.id}/check-commands`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ commands: [{ name: "x", argv: ["node", "-v"] }] }),
  });
  assert.equal(anonymousWrite.status, 401, "nothing becomes executable without the dashboard session or bearer token");

  const before = await fetch(`${instance.url}/api/projects/${project.id}/check-commands`, { headers: authed }).then((response) => response.json());
  assert.equal(before.verificationEnabled, false, "a project verifies nothing until a human enables it");
  assert.ok(before.available.some((entry) => entry.name === "test"), "the human is shown what enabling would allow");

  // Omitting commands snapshots this project's own package.json scripts.
  const enabled = await fetch(`${instance.url}/api/projects/${project.id}/check-commands`, {
    method: "PUT", headers: authed, body: JSON.stringify({}),
  }).then((response) => response.json());
  assert.equal(enabled.verificationEnabled, true);
  assert.deepEqual(enabled.commands.find((entry) => entry.name === "test").argv, ["node", "--test"]);

  // An entry that would need a shell, or that points at a path, is refused where the human can see it.
  const refused = await fetch(`${instance.url}/api/projects/${project.id}/check-commands`, {
    method: "PUT", headers: authed, body: JSON.stringify({ commands: [{ name: "evil", argv: ["../../bin/sh", "-c", "echo"] }] }),
  });
  assert.equal(refused.status >= 400, true, "a path-qualified program is not accepted into the allowlist");
  const still = await fetch(`${instance.url}/api/projects/${project.id}/check-commands`, { headers: authed }).then((response) => response.json());
  assert.equal(still.commands.some((entry) => entry.name === "evil"), false, "and the refusal leaves the stored list untouched");
});
