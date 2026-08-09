import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

test("DevTeam coordinates plan, write lease, review, versioning, and consensus", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-store-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });

  const project = store.ensureProject("Test project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Ship a safe change", description: "Implement and review it.", requiredApprovals: 2 });
  const planner = store.connectAgent({ name: "Planner", provider: "Codex", capabilities: ["planning"] });
  const writer = store.connectAgent({ name: "Writer", provider: "Claude", capabilities: ["coding"] });
  const reviewerA = store.connectAgent({ name: "Reviewer A", provider: "Codex", capabilities: ["review"] });
  const reviewerB = store.connectAgent({ name: "Reviewer B", provider: "Claude", capabilities: ["review"] });

  const plan = store.claimNextAssignment(planner.id);
  assert.equal(plan.role, "planner");
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement", description: "Make the change.", role: "implementer", requiresWrite: true, targetAgentName: "Writer" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review A", description: "Review current version.", role: "reviewer", targetAgentName: "Reviewer A" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review B", description: "Review current version.", role: "reviewer", targetAgentName: "Reviewer B" });
  assert.equal(store.getTask(task.id).status, "planning", "review assignments do not prematurely move a planning task to review");
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan dispatched." });
  assert.equal(store.getTask(task.id).status, "active");

  const implementation = store.claimNextAssignment(writer.id);
  assert.equal(implementation.requires_write, 1);
  assert.equal(store.claimNextAssignment(reviewerA.id), null, "review waits until pending writes finish");
  assert.equal(store.claimNextAssignment(planner.id), null, "an untargeted agent cannot take targeted work");
  const completed = store.completeAssignment({ agentId: writer.id, assignmentId: implementation.id, message: "Implemented.", changedFiles: ["src/example.js"], checks: ["npm test"] });
  assert.equal(completed.version, 2);
  assert.equal(store.getTask(task.id).status, "review");

  const reviewOne = store.claimNextAssignment(reviewerA.id);
  store.completeAssignment({ agentId: reviewerA.id, assignmentId: reviewOne.id, message: "Looks correct.", checks: ["npm test"] });
  const firstApproval = store.approveTask({ agentId: reviewerA.id, taskId: task.id, summary: "Reviewed version 2." });
  assert.equal(firstApproval.accepted, false);

  const reviewTwo = store.claimNextAssignment(reviewerB.id);
  store.completeAssignment({ agentId: reviewerB.id, assignmentId: reviewTwo.id, message: "Independent review passed." });
  const secondApproval = store.approveTask({ agentId: reviewerB.id, taskId: task.id, summary: "Approved version 2." });
  assert.equal(secondApproval.accepted, true);
  assert.equal(store.getTask(task.id).status, "accepted");
  assert.equal(store.getAgent(reviewerA.id).status, "disconnected");
  assert.equal(store.taskDetail(task.id).events.at(-1).type, "task.accepted");
});

test("a file change invalidates approvals from the previous task version", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-version-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Test project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Version task", description: "Test approval invalidation.", requiredApprovals: 2 });
  const planner = store.connectAgent({ name: "Planner", provider: "Codex" });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "Claude" });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review version one.", role: "reviewer", targetAgentName: "Reviewer" });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan ready." });
  const review = store.claimNextAssignment(reviewer.id);
  store.completeAssignment({ agentId: reviewer.id, assignmentId: review.id, message: "Version one reviewed." });
  store.approveTask({ agentId: reviewer.id, taskId: task.id, summary: "Version one is fine." });
  const change = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Change", description: "Modify a file.", role: "implementer", requiresWrite: true, targetAgentName: "Planner" });
  const claimedChange = store.claimNextAssignment(planner.id);
  assert.equal(claimedChange.id, change.id);
  store.completeAssignment({ agentId: planner.id, assignmentId: claimedChange.id, message: "Updated plan file.", changedFiles: ["plan.md"] });
  const detail = store.taskDetail(task.id);
  assert.equal(detail.version, 2);
  assert.equal(detail.approvals.length, 0);
  assert.throws(() => store.approveTask({ agentId: reviewer.id, taskId: task.id, summary: "Stale review." }), /current task version/);
});

test("disconnecting during work releases the assignment for another agent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-release-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Test project", process.cwd());
  store.createTask({ projectId: project.id, title: "Recover work", description: "Release claimed work." });
  const first = store.connectAgent({ name: "First", provider: "Codex" });
  const second = store.connectAgent({ name: "Second", provider: "Claude" });
  const claimed = store.claimNextAssignment(first.id);
  store.disconnectAgent(first.id, "Desktop closed.");
  assert.equal(store.claimNextAssignment(second.id).id, claimed.id);
});

test("reconnecting the same agent identity releases its orphaned assignment", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-reconnect-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Reconnect project", process.cwd());
  store.createTask({ projectId: project.id, title: "Reconnect safely", description: "Do not orphan the plan." });
  const firstSession = store.connectAgent({ name: "Codex", provider: "OpenAI Codex Desktop" });
  const claimed = store.claimNextAssignment(firstSession.id);

  const replacement = store.connectAgent({ name: "Codex", provider: "OpenAI Codex Desktop" });

  assert.equal(store.getAgent(firstSession.id).status, "disconnected");
  assert.equal(store.getAgent(firstSession.id).current_task_id, null);
  assert.equal(store.claimNextAssignment(replacement.id).id, claimed.id);
});

test("a silent busy writer keeps its write lease; only explicit recovery transfers it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-stale-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Stale project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Protect the writer", description: "Silence must not steal a write lease." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  const write = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Write", description: "Change files.", requiresWrite: true });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan complete." });
  assert.equal(store.claimNextAssignment(planner.id).id, write.id);

  // The writer goes silent for a long time while it is actually still reasoning/editing.
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", planner.id);

  const replacement = store.connectAgent({ name: "Replacement", provider: "test" });
  assert.equal(store.claimNextAssignment(replacement.id), null, "silence alone must never transfer a write lease");
  assert.equal(store.getAgent(planner.id).status, "unresponsive", "the silent writer is flagged, not disconnected");
  assert.equal(store.taskDetail(task.id).assignments.find((a) => a.id === write.id).status, "claimed", "the writer still owns the work");

  // A human can deliberately reclaim the stuck lease (title confirmation required).
  assert.throws(() => store.forceReleaseAssignment({ assignmentId: write.id, confirmTitle: "wrong" }), /confirmation/);
  store.forceReleaseAssignment({ assignmentId: write.id, confirmTitle: "Write" });
  assert.equal(store.claimNextAssignment(replacement.id).id, write.id, "after force-release the work is claimable again");
});

test("write assignments with non-overlapping paths run in parallel; overlapping ones wait", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-parallel-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Parallel project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Build in parallel", description: "Two writers, different files." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const carol = store.connectAgent({ name: "Carol", provider: "test" });

  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Ocean", description: "Build ocean.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/ocean/**"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD", description: "Build HUD.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/hud"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Waves", description: "Ocean waves.", requiresWrite: true, targetAgentName: "Carol", paths: ["src/ocean/waves.js"] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const aWork = store.claimNextAssignment(alice.id);
  assert.equal(aWork.title, "Ocean");
  assert.deepEqual(aWork.writeScope, ["src/ocean"], "the claim reports its normalized write scope");
  const bWork = store.claimNextAssignment(bob.id);
  assert.equal(bWork && bWork.title, "HUD", "a non-overlapping writer claims in parallel");
  assert.equal(store.claimNextAssignment(carol.id), null, "an overlapping write waits for the lease to free");

  store.completeAssignment({ agentId: alice.id, assignmentId: aWork.id, message: "Ocean done.", changedFiles: ["src/ocean/index.js"] });
  const cWork = store.claimNextAssignment(carol.id);
  assert.equal(cWork && cWork.title, "Waves", "the overlapping writer proceeds once the lease frees");
});

test("a long-silent read-only claim is recovered automatically", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-readonly-recover-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Recover project", process.cwd());
  store.createTask({ projectId: project.id, title: "Recover a read-only claim", description: "Planner work is safe to requeue." });
  const worker = store.connectAgent({ name: "Worker", provider: "test" });
  const plan = store.claimNextAssignment(worker.id); // planner role: read-only
  assert.equal(plan.requires_write, 0);
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", worker.id);

  const replacement = store.connectAgent({ name: "Replacement", provider: "test" });
  assert.equal(store.claimNextAssignment(replacement.id).id, plan.id, "a long-silent read-only claim is safely recovered");
  assert.equal(store.getAgent(worker.id).status, "unresponsive");
});

test("claiming work repairs an assignment already orphaned by a disconnected agent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-orphan-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Orphan project", process.cwd());
  store.createTask({ projectId: project.id, title: "Recover orphan", description: "Repair old database state." });
  const original = store.connectAgent({ name: "Original", provider: "test" });
  const claimed = store.claimNextAssignment(original.id);
  store.db.prepare("UPDATE agents SET status = 'disconnected', disconnected_at = ? WHERE id = ?").run(new Date().toISOString(), original.id);

  const replacement = store.connectAgent({ name: "Replacement", provider: "test" });
  assert.equal(store.claimNextAssignment(replacement.id).id, claimed.id);
  const event = store.taskDetail(claimed.task_id).events.find((item) => item.type === "assignment.released");
  assert.match(event.message, /returned to the queue/);
});

test("work, messages, and proposals are scoped to an agent's task room", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-rooms-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-rooms-b"));
  const taskA = store.createTask({ projectId: projectA.id, title: "Task A", description: "Work A." });
  const taskB = store.createTask({ projectId: projectB.id, title: "Task B", description: "Work B." });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const carol = store.connectAgent({ name: "Carol", provider: "test" });

  store.joinTask(alice.id, taskA.id);
  store.joinTask(bob.id, taskB.id);

  // With two active tasks, an agent that joined nothing has no implicit room and claims nothing.
  assert.equal(store.claimNextAssignment(carol.id), null, "an unjoined agent cannot claim across a multi-task server");

  // Each agent only claims work from its own room.
  assert.equal(store.claimNextAssignment(alice.id).task_id, taskA.id);
  assert.equal(store.claimNextAssignment(bob.id).task_id, taskB.id);

  // A message in Task A reaches only Task A's members.
  store.humanMessage(taskA.id, "For room A only.", "all");
  assert.equal(store.deliverDirectedMessages(bob.id).length, 0, "a Task A message does not leak to a Task B member");
  const aliceInbox = store.deliverDirectedMessages(alice.id);
  assert.equal(aliceInbox.length, 1);
  assert.match(aliceInbox[0].message, /room A only/);

  // A proposal in Task A is only visible to Task A's members.
  const proposal = store.createProposal({ agentId: alice.id, taskId: taskA.id, kind: "decision", summary: "Decide A." });
  assert.equal(store.openProposalsForAgent(bob).some((p) => p.id === proposal.id), false, "a Task B member is not asked to vote on Task A");
});

test("blocking a task closes open assignments and frees the project write lease", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-block-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Blocked project", process.cwd());
  const blockedTask = store.createTask({ projectId: project.id, title: "Blocked", description: "Stop this work." });
  const writer = store.connectAgent({ name: "Writer", provider: "test" });
  const plan = store.claimNextAssignment(writer.id);
  const write = store.createAssignment({ agentId: writer.id, taskId: blockedTask.id, title: "Write", description: "Change files.", requiresWrite: true });
  store.completeAssignment({ agentId: writer.id, assignmentId: plan.id, message: "Plan complete." });
  store.claimNextAssignment(writer.id);
  store.blockTask({ taskId: blockedTask.id, reason: "Human stopped the task." });
  assert.equal(store.taskDetail(blockedTask.id).assignments.find((assignment) => assignment.id === write.id).status, "blocked");

  const nextTask = store.createTask({ projectId: project.id, title: "Next", description: "This task should proceed." });
  const nextAgent = store.connectAgent({ name: "Next", provider: "test" });
  const nextPlan = store.claimNextAssignment(nextAgent.id);
  const nextWrite = store.createAssignment({ agentId: nextAgent.id, taskId: nextTask.id, title: "Next write", description: "Proceed.", requiresWrite: true });
  store.completeAssignment({ agentId: nextAgent.id, assignmentId: nextPlan.id, message: "Plan complete." });
  assert.equal(store.claimNextAssignment(nextAgent.id).id, nextWrite.id);
});

test("task and project deletion remove DevTeam history without touching project files", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-delete-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-project-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Disposable project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Disposable task", description: "Delete this history." });
  const agent = store.connectAgent({ name: "Worker", provider: "test" });
  store.claimNextAssignment(agent.id);
  assert.throws(() => store.deleteTask(task.id, task.id), /Disconnect agents/);
  store.disconnectAgent(agent.id);
  assert.equal(store.deleteTask(task.id, task.id).filesDeleted, false);
  assert.equal(store.getTask(task.id), undefined);
  assert.throws(() => store.deleteProject(project.id, "Wrong name"), /confirmation/);
  assert.equal(store.deleteProject(project.id, project.name).filesDeleted, false);
  assert.equal(store.listProjects().some((item) => item.id === project.id), false);
});

test("directed and broadcast messages are delivered once, then marked seen when the agent acts", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-messages-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Message project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Talk to the team", description: "Exercise live messaging." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });

  // A broadcast reaches every connected agent exactly once.
  store.humanMessage(task.id, "Standup in five minutes.", "all");
  const codexBroadcast = store.deliverDirectedMessages(codex.id);
  assert.equal(codexBroadcast.length, 1);
  assert.equal(codexBroadcast[0].broadcast, true);
  assert.equal(store.deliverDirectedMessages(codex.id).length, 0, "a delivered message is not delivered again");
  assert.equal(store.deliverDirectedMessages(claude.id).length, 1, "the broadcast still reaches the other agent");

  // A directed message only reaches its target.
  store.humanMessage(task.id, "Codex, focus on the auth module.", "Codex");
  assert.equal(store.deliverDirectedMessages(claude.id).length, 0, "a directed message does not reach other agents");
  const directed = store.deliverDirectedMessages(codex.id);
  assert.equal(directed.length, 1);
  assert.match(directed[0].message, /auth module/);

  // Delivery and acknowledgement are visible to the dashboard.
  const beforeAck = store.taskDetail(task.id).events.filter((event) => event.type === "human.message");
  assert.ok(beforeAck.every((event) => event.receipts.some((receipt) => receipt.agent_name === "Codex" && receipt.delivered_at && !receipt.seen_at)));
  store.postMessage({ agentId: codex.id, taskId: task.id, message: "On it.", type: "agent.progress" });
  const afterAck = store.taskDetail(task.id).events.filter((event) => event.type === "human.message");
  assert.ok(afterAck.every((event) => event.receipts.some((receipt) => receipt.agent_name === "Codex" && receipt.seen_at)), "acting marks delivered messages as seen");
});

test("an agent can direct a message to a specific teammate", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-agent-dm-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("DM project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Coordinate directly", description: "Agent to agent." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const other = store.connectAgent({ name: "Other", provider: "test" });

  store.postMessage({ agentId: codex.id, taskId: task.id, message: "Claude, take the shader module.", type: "agent.progress", metadata: { target: "Claude" } });

  assert.equal(store.deliverDirectedMessages(other.id).length, 0, "a directed agent message does not reach uninvolved teammates");
  assert.equal(store.deliverDirectedMessages(codex.id).length, 0, "the sender does not receive their own message");
  const inbox = store.deliverDirectedMessages(claude.id);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].message, /shader module/);
  assert.equal(inbox[0].from, "Codex", "the recipient sees who sent it");
  assert.equal(store.deliverDirectedMessages(claude.id).length, 0, "a delivered message is not delivered again");

  // An undirected agent note stays a timeline broadcast, not a push.
  store.postMessage({ agentId: codex.id, taskId: task.id, message: "General progress note.", type: "agent.progress" });
  assert.equal(store.deliverDirectedMessages(claude.id).length, 0, "an undirected agent note is not pushed to teammates");
});

test("listAgents reports per-agent unread (undelivered) message counts", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-unread-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Unread project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Count unread", description: "Track undelivered messages." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });

  store.humanMessage(task.id, "Broadcast one.", "all");
  store.humanMessage(task.id, "Codex only.", "Codex");
  const unread = Object.fromEntries(store.listAgents().map((agent) => [agent.name, agent.pending_messages]));
  assert.equal(unread.Codex, 2, "Codex has the broadcast and the directed message pending");
  assert.equal(unread.Claude, 1, "Claude has only the broadcast pending");

  store.deliverDirectedMessages(codex.id);
  assert.equal(store.listAgents().find((agent) => agent.name === "Codex").pending_messages, 0, "delivery clears the unread count");
  assert.equal(store.listAgents().find((agent) => agent.name === "Claude").pending_messages, 1, "the other agent is unaffected");
});

test("messages posted before an agent's session are not live-delivered", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-message-floor-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Floor project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "History task", description: "Old messages stay history." });
  const old = store.humanMessage(task.id, "This predates the agent.", "all");
  store.db.prepare("UPDATE events SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(old.eventId);
  const late = store.connectAgent({ name: "Latecomer", provider: "test" });
  assert.equal(store.deliverDirectedMessages(late.id).length, 0);
});

test("teamActivity reports whether the room is still working", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-activity-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Activity project", process.cwd());
  assert.equal(store.teamActivity().active, false, "an empty room is quiet");
  const task = store.createTask({ projectId: project.id, title: "Busy task", description: "Keep the team assembled." });
  assert.equal(store.teamActivity().active, true, "a queued assignment keeps the room active");
  const agent = store.connectAgent({ name: "Worker", provider: "test" });
  const plan = store.claimNextAssignment(agent.id);
  assert.equal(store.teamActivity().busyAgents, 1, "a claimed assignment marks the agent busy");
  store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Plan done." });
  assert.equal(store.teamActivity().active, false, "with no open work and no busy agent the room is quiet again");
});

test("a role proposal is adopted by team agreement and creates the assignment", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-propose-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Propose project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Negotiate roles", description: "Let the team organise." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });

  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "role", summary: "Claude takes the security-reviewer role", details: { role: "security-reviewer", targetAgentName: "Claude", description: "Review auth and sessions." } });
  assert.equal(proposal.status, "open");
  // Claude must see it as an open proposal needing a vote.
  assert.equal(store.openProposalsForAgent(claude).some((p) => p.id === proposal.id), true);
  assert.equal(store.openProposalsForAgent(codex).length, 0, "the proposer is not asked to vote again");

  const outcome = store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" });
  assert.equal(outcome.status, "adopted");
  const created = store.taskDetail(task.id).assignments.find((a) => a.role === "security-reviewer" && a.target_agent_name === "Claude");
  assert.ok(created, "adoption created the security-reviewer assignment for Claude");
  assert.equal(created.status, "queued");
});

test("an objection declines a proposal and applies no change", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-object-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Object project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Contested", description: "Someone disagrees." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "role", summary: "Codex implements alone", details: { role: "implementer", targetAgentName: "Codex" } });
  const outcome = store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "object", comment: "We should pair-review." });
  assert.equal(outcome.status, "declined");
  assert.equal(store.taskDetail(task.id).assignments.some((a) => a.role === "implementer"), false, "a declined proposal creates no assignment");
});

test("a handoff proposal reassigns a claimed assignment on adoption", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-handoff-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Handoff project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Hand it over", description: "Move work between agents." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const plan = store.claimNextAssignment(codex.id);
  store.completeAssignment({ agentId: codex.id, assignmentId: plan.id, message: "Planned." });
  const work = store.createAssignment({ agentId: codex.id, taskId: task.id, title: "Build it", description: "Implement.", requiresWrite: true, targetAgentName: "Codex" });
  const claimed = store.claimNextAssignment(codex.id);
  assert.equal(claimed.id, work.id);
  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "handoff", summary: "Hand the build to Claude", details: { assignmentId: work.id, targetAgentName: "Claude" } });
  store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" });
  const reassigned = store.taskDetail(task.id).assignments.find((a) => a.id === work.id);
  assert.equal(reassigned.target_agent_name, "Claude");
  assert.equal(reassigned.status, "queued", "a claimed assignment is released so the new owner can take it");
  assert.equal(store.claimNextAssignment(claude.id).id, work.id, "Claude can now claim the handed-off work");
});

test("no dead-end: a solo agent can complete a task that nominally needs two approvals", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-solo-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Solo project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Solo run", description: "One agent, two approvals configured.", requiredApprovals: 2 });
  const solo = store.connectAgent({ name: "Solo", provider: "test" });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Self review", description: "Review current version.", role: "reviewer", targetAgentName: "Solo" });
  store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned." });
  const review = store.claimNextAssignment(solo.id);
  store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed, no changes." });
  const outcome = store.approveTask({ agentId: solo.id, taskId: task.id, summary: "Looks good." });
  assert.equal(outcome.accepted, true, "with only one participant, one approval is enough");
  assert.equal(outcome.requiredApprovals, 1);
  assert.equal(outcome.configuredApprovals, 2);
});

test("review assignments carry a checklist by default and can be overridden", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-checklist-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Checklist project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Cover blind spots", description: "Attach checklists." });

  const security = store.createAssignment({ taskId: task.id, title: "Security review", description: "Review auth.", role: "security-reviewer" });
  assert.ok(security.checklist.length >= 5, "a security review gets the default checklist");
  assert.ok(security.checklist.some((item) => /session/i.test(item)), "the checklist covers sessions");

  const custom = store.createAssignment({ taskId: task.id, title: "Custom review", description: "Focused.", role: "reviewer", checklist: ["only this point"] });
  assert.deepEqual(custom.checklist, ["only this point"], "an explicit checklist overrides the template");

  const none = store.createAssignment({ taskId: task.id, title: "No list", description: "Skip it.", role: "reviewer", checklist: [] });
  assert.equal(none.checklist.length, 0, "an empty checklist opts out");

  const implementer = store.createAssignment({ taskId: task.id, title: "Build", description: "Implement.", role: "implementer" });
  assert.equal(implementer.checklist.length, 0, "non-review roles get no checklist by default");

  const detail = store.taskDetail(task.id);
  assert.ok(detail.assignments.find((a) => a.id === security.id).checklist.length >= 5, "taskDetail exposes the checklist");
});

test("messages can reply to a specific timeline event (threads)", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-threads-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Thread project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Talk in threads", description: "Reply to messages." });
  const agent = store.connectAgent({ name: "Codex", provider: "OpenAI" });

  const question = store.humanMessage(task.id, "Per-IP or per-account rate limit?", "all");
  store.postMessage({ agentId: agent.id, taskId: task.id, message: "Per-IP for now.", type: "agent.decision", metadata: { replyTo: question.eventId } });
  const reply = store.taskDetail(task.id).events.find((event) => event.message === "Per-IP for now.");
  assert.equal(reply.metadata.replyTo, question.eventId, "an agent reply records its parent event");

  const humanReply = store.humanMessage(task.id, "Agreed.", "all", question.eventId);
  const hr = store.taskDetail(task.id).events.find((event) => event.id === humanReply.eventId);
  assert.equal(hr.metadata.replyTo, question.eventId, "a human reply records its parent event");
});

test("listAgents surfaces the assignment an agent is currently working on", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-activity-feed-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Activity project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Show activity", description: "Track live work." });
  const agent = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  store.claimNextAssignment(agent.id);
  const busy = store.listAgents().find((a) => a.name === "Codex");
  assert.equal(busy.status, "busy");
  assert.equal(busy.current_assignment_role, "planner", "the live activity shows the claimed assignment's role");
  assert.ok(busy.current_assignment_title, "and its title");
  assert.ok(busy.current_task_version >= 1, "and the task version it is working on");
});

test("opening an existing database repairs stale nonterminal task status", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-status-repair-"));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const firstStore = new DevTeamStore(dataDir);
  const project = firstStore.ensureProject("Status project", process.cwd());
  const task = firstStore.createTask({ projectId: project.id, title: "Repair status", description: "Restore active state." });
  const planner = firstStore.connectAgent({ name: "Planner", provider: "test" });
  const plan = firstStore.claimNextAssignment(planner.id);
  firstStore.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement", description: "Pending implementation.", requiresWrite: true });
  firstStore.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan complete." });
  firstStore.db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(task.id);
  firstStore.close();

  const reopened = new DevTeamStore(dataDir);
  assert.equal(reopened.getTask(task.id).status, "active");
  reopened.close();
});
