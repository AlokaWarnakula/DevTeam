import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

test("automatic knowledge vault exports safe Obsidian notes and feeds task briefings", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-knowledge-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-knowledge-project-"));
  await mkdir(path.join(projectRoot, "memory"), { recursive: true });
  await writeFile(path.join(projectRoot, "memory", "INDEX.md"), "# Old memory\n\nAPI_KEY=super-secret-value", "utf8");
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true } });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  const project = store.ensureProject("Knowledge project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Add durable memory", description: "Exercise automatic knowledge." });
  const agent = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const plan = store.claimNextAssignment(agent.id);
  store.noteSet({ agentId: agent.id, taskId: task.id, scope: "project", key: "architecture/runtime", value: "SQLite is the source of truth; Markdown is the exported view." });
  const proposal = store.createProposal({ agentId: agent.id, taskId: task.id, kind: "decision", summary: "Use one serialized knowledge exporter", details: {} });
  store.voteProposal({ proposalId: proposal.id, vote: "agree" });
  store.completeAssignment({
    agentId: agent.id,
    assignmentId: plan.id,
    message: "Implemented exporter. password=hunter2",
    changedFiles: ["src/knowledge.mjs", ".env", "secrets/token.txt"],
    checks: ["node --test"],
  });

  const vault = path.join(projectRoot, "knowledge");
  const index = await readFile(path.join(vault, "INDEX.md"), "utf8");
  const current = await readFile(path.join(vault, "CURRENT.md"), "utf8");
  const componentFiles = await readdir(path.join(vault, "components"));
  const decisionFiles = await readdir(path.join(vault, "decisions"));
  const archiveFiles = await readdir(path.join(vault, "archive"));
  const exported = await Promise.all([...componentFiles.map((file) => path.join(vault, "components", file)), ...archiveFiles.map((file) => path.join(vault, "archive", file))].map((file) => readFile(file, "utf8")));

  assert.match(index, /\[\[CURRENT\]\]/);
  assert.match(index, /\[\[decisions\//);
  assert.match(current, /Add durable memory/);
  assert.ok(componentFiles.length >= 1, "completed implementation becomes component knowledge");
  assert.ok(decisionFiles.length >= 1, "adopted proposal becomes a durable decision");
  assert.ok(archiveFiles.length >= 1, "legacy Shorekeeper memory is imported without deleting it");
  assert.equal(await readFile(path.join(projectRoot, "memory", "INDEX.md"), "utf8"), "# Old memory\n\nAPI_KEY=super-secret-value");
  assert.doesNotMatch(exported.join("\n"), /hunter2|super-secret-value|secrets\/token|\.env/);
  assert.match(exported.join("\n"), /\[REDACTED\]/);

  const detail = store.taskDetail(task.id);
  assert.ok(detail.knowledge.length >= 3);
  const brief = store.taskBrief(agent.id, task.id);
  assert.ok(brief.projectKnowledge.length >= 3);
  assert.ok(brief.projectKnowledge.every((note) => note.body.length <= 1_300));
  const search = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "serialized", category: "decisions" });
  assert.equal(search.automated, true);
  assert.equal(search.notes.length, 1);
  assert.match(search.notes[0].title, /serialized knowledge exporter/i);
});

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

  assert.equal(store.claimNextAssignment(reviewerA.id), null, "review waits while an unrelated write remains queued");
  const implementation = store.claimNextAssignment(writer.id);
  assert.equal(implementation.requires_write, 1);
  assert.equal(store.claimNextAssignment(reviewerA.id), null, "review waits while an unrelated write is claimed");
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
  assert.equal(store.getAgent(reviewerA.id).status, "waiting", "accepted agents stay assembled for a same-conversation follow-up, not force-disconnected");
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

test("a same-name reconnect does not evict the prior session; resume reclaims its work and missed messages", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-resume-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Resume project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Resume safely", description: "Do not kill the first session." });
  const first = store.connectAgent({ name: "Codex", provider: "OpenAI Codex Desktop" });
  const claimed = store.claimNextAssignment(first.id);

  // A message arrives, then the first chat drops and a second "Codex" chat opens.
  store.humanMessage(task.id, "Keep going on the plan.", "Codex");
  const second = store.connectAgent({ name: "Codex", provider: "OpenAI Codex Desktop" });

  // The prior session is NOT evicted and its claim is NOT stealable by the new session.
  assert.notEqual(store.getAgent(first.id).status, "disconnected", "the first session survives a same-name reconnect");
  assert.equal(store.taskDetail(task.id).assignments.find((a) => a.id === claimed.id).status, "claimed", "its claim is intact");
  assert.equal(store.claimNextAssignment(second.id), null, "the new session cannot steal the prior claim");

  // The returning agent resumes with the first session's token: it reclaims the work and the
  // message sent while it was away.
  const resumed = store.resumeAgent({ agentId: second.id, resumeToken: first.resumeToken });
  assert.equal(resumed.reclaimedAssignments, 1);
  assert.equal(store.getAgent(first.id).status, "disconnected", "the prior session is retired on resume");
  assert.equal(store.getAgent(second.id).current_task_id, task.id, "the new session adopts the task");
  const inbox = store.deliverDirectedMessages(second.id);
  assert.ok(inbox.some((m) => /Keep going/.test(m.message)), "messages from the away window replay to the resumed session");
  assert.throws(() => store.resumeAgent({ agentId: second.id, resumeToken: first.resumeToken }), /No matching session|already used/, "the resume token is single-use");
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

test("a claim carries a fencing token; a stale report is refused with a structured conflict", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-fence-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Fence project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Fence the lease", description: "Stale reports must not land." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  const write = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Write", description: "Change files.", requiresWrite: true, targetAgentName: "Planner" });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
  const claim = store.claimNextAssignment(planner.id);
  assert.equal(claim.id, write.id);
  assert.ok(claim.claimToken, "the claim returns a fencing token");
  assert.ok(claim.claimGeneration >= 1, "and a generation");

  // A human force-releases the stuck lease; the original session then tries to report with its now
  // stale token.
  store.forceReleaseAssignment({ assignmentId: write.id, confirmTitle: "Write" });
  const conflict = store.completeAssignment({ agentId: planner.id, assignmentId: write.id, message: "Too late.", claimToken: claim.claimToken });
  assert.equal(conflict.completed, false, "a report against a lease that moved on is refused");
  assert.ok(conflict.claimConflict, "and the refusal is structured");
  assert.match(conflict.claimConflict.nextAction, /devteam_wait|devteam_resume/);

  // A fresh claim gets a new token and generation and can complete normally.
  const reclaim = store.claimNextAssignment(planner.id);
  assert.ok(reclaim.claimGeneration > claim.claimGeneration, "reclaiming bumps the generation");
  const done = store.completeAssignment({ agentId: planner.id, assignmentId: write.id, message: "Done.", claimToken: reclaim.claimToken, changedFiles: ["package.json"] });
  assert.equal(done.completed, true, "the current lease holder completes with the matching token");
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

test("a symlink/junction cannot present the same directory under two non-overlapping leases", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-symlink-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-symproj-"));
  await mkdir(path.join(projectRoot, "real-hud"), { recursive: true });
  try {
    await symlink(path.join(projectRoot, "real-hud"), path.join(projectRoot, "hud"), "junction");
  } catch {
    t.skip("symlinks/junctions are not permitted in this environment");
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
    return;
  }
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });

  const project = store.ensureProject("Symlink project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Resolve real paths", description: "Junction must not alias a lease." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Real dir", description: "Edit the real directory.", requiresWrite: true, targetAgentName: "Alice", paths: ["real-hud"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Via junction", description: "Edit through the junction.", requiresWrite: true, targetAgentName: "Bob", paths: ["hud"] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const aWork = store.claimNextAssignment(alice.id);
  assert.equal(aWork.title, "Real dir");
  assert.equal(store.claimNextAssignment(bob.id), null, "the junction resolves to the same real directory and waits");
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
  // Long enough silent to safely recover the read-only claim (> staleWorkMs), but not so long the
  // agent is auto-purged as a ghost (< forgetMs) — so it survives as 'unresponsive' to be checked.
  const longSilence = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(longSilence, worker.id);

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

test("membership is authorization: a non-member cannot read, message, propose, or govern another room", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-authz-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-authz-b"));
  const taskA = store.createTask({ projectId: projectA.id, title: "Task A", description: "Work A." });
  const taskB = store.createTask({ projectId: projectB.id, title: "Task B", description: "Work B." });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  store.joinTask(alice.id, taskA.id);
  store.joinTask(bob.id, taskB.id);

  // Bob (Task B) may not reach into Task A by supplying its id.
  assert.throws(() => store.postMessage({ agentId: bob.id, taskId: taskA.id, message: "sneaking in" }), /not a member/);
  assert.throws(() => store.createProposal({ agentId: bob.id, taskId: taskA.id, kind: "decision", summary: "decide A" }), /not a member/);
  assert.throws(() => store.approveTask({ agentId: bob.id, taskId: taskA.id, summary: "approve A" }), /not a member/);
  assert.throws(() => store.blockTask({ agentId: bob.id, taskId: taskA.id, reason: "block A" }), /not a member/);
  assert.throws(() => store.assertMembership(bob.id, taskA.id), /not a member/);

  // Alice, a real member, is allowed; the human control plane (no agentId) is always allowed.
  assert.doesNotThrow(() => store.postMessage({ agentId: alice.id, taskId: taskA.id, message: "hello room A" }));
  assert.doesNotThrow(() => store.assertMembership(null, taskA.id));
});

test("an observer joins a room but never claims its work", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-observer-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-observer-b"));
  const taskA = store.createTask({ projectId: projectA.id, title: "Watch me", description: "Observer only." });
  const taskB = store.createTask({ projectId: store.listProjects()[1].id, title: "Elsewhere", description: "Keep it multi-task." });
  const watcher = store.connectAgent({ name: "Watcher", provider: "test" });
  store.joinTask(watcher.id, taskA.id, "observer");
  assert.equal(store.claimNextAssignment(watcher.id), null, "an observer cannot claim the planner assignment it joined to watch");
  assert.ok(taskB, "a second task keeps membership explicit rather than implicit");
});

test("implicit single-task membership persists when a second task appears", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-implicit-persist-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  const taskA = store.createTask({ projectId: projectA.id, title: "First task", description: "The sole task at connect time." });
  const worker = store.connectAgent({ name: "Worker", provider: "test" }); // auto-joined to the sole task

  // A second active task later must not orphan the worker out of Task A.
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-implicit-persist-b"));
  store.createTask({ projectId: projectB.id, title: "Second task", description: "Now the server is multi-task." });

  store.humanMessage(taskA.id, "Still in your room?", "all");
  assert.equal(store.deliverDirectedMessages(worker.id).length, 1, "the worker still belongs to Task A after a second task appears");
  assert.equal(store.claimNextAssignment(worker.id).task_id, taskA.id, "and can still claim Task A's work");
});

test("an agent holds at most one claimed assignment at a time", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-one-claim-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("One claim project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Bound the claims", description: "No hoarding." });
  const worker = store.connectAgent({ name: "Worker", provider: "test" });
  const plan = store.claimNextAssignment(worker.id);
  store.createAssignment({ agentId: worker.id, taskId: task.id, title: "Job one", description: "Do it.", targetAgentName: "Worker" });
  store.createAssignment({ agentId: worker.id, taskId: task.id, title: "Job two", description: "Do it.", targetAgentName: "Worker" });
  assert.equal(store.claimNextAssignment(worker.id), null, "a busy agent already holding a claim cannot grab a second");
  store.completeAssignment({ agentId: worker.id, assignmentId: plan.id, message: "Planned." });
  const first = store.claimNextAssignment(worker.id);
  assert.ok(first, "after completing, the agent claims the next job");
  assert.equal(store.claimNextAssignment(worker.id), null, "but still only one at a time");
});

test("path scopes are canonicalized so a '..' alias cannot smuggle an overlapping lease", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-scope-alias-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Scope project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Guard the paths", description: "Aliases must not overlap." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD direct", description: "Edit hud.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/hud"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD alias", description: "Same dir via alias.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/ocean/../hud"] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const aWork = store.claimNextAssignment(alice.id);
  assert.equal(aWork.title, "HUD direct");
  assert.deepEqual(aWork.writeScope, ["src/hud"], "the alias resolves to the same normalized scope");
  assert.equal(store.claimNextAssignment(bob.id), null, "the aliased path is recognized as overlapping and waits");
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

test("blocking a task stands co-workers down to waiting instead of force-disconnecting them", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-coworker-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Co-worker project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Two writers", description: "One blocks, the other survives." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Ocean", description: "Edit ocean.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/ocean"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD", description: "Edit hud.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/hud"] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
  store.claimNextAssignment(alice.id);
  store.claimNextAssignment(bob.id);

  store.blockTask({ agentId: alice.id, taskId: task.id, reason: "Alice hit a blocker." });
  assert.equal(store.getAgent(alice.id).status, "waiting", "the blocker's session is not killed");
  assert.equal(store.getAgent(bob.id).status, "waiting", "the parallel co-worker is stood down, not disconnected");
  assert.equal(store.getAgent(bob.id).current_task_id, null, "and released from the blocked task");
  assert.ok(store.taskDetail(task.id).events.some((e) => e.type === "agent.standdown"), "co-workers are notified via the timeline");
});

test("assignment dependencies hold queued work until every same-task prerequisite is done", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-dependencies-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Dependencies", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Build in order", description: "Parent before child." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const worker = store.connectAgent({ name: "Worker", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  const parent = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Schema", description: "Create schema.", targetAgentName: "Worker" });
  const child = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "API", description: "Use schema.", targetAgentName: "Worker", dependsOn: [parent.id] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const detailBefore = store.taskDetail(task.id).assignments.find((item) => item.id === child.id);
  assert.deepEqual(detailBefore.dependsOn, [parent.id]);
  assert.deepEqual(detailBefore.blockedBy.map((item) => item.title), ["Schema"]);
  assert.equal(store.claimNextAssignment(worker.id).id, parent.id, "the prerequisite is claimed first");
  assert.equal(store.claimNextAssignment(planner.id), null, "another agent cannot skip ahead to the dependent work");
  store.completeAssignment({ agentId: worker.id, assignmentId: parent.id, message: "Schema done." });
  assert.equal(store.claimNextAssignment(worker.id).id, child.id, "the child unlocks after its dependency is done");
  assert.deepEqual(store.taskDetail(task.id).assignments.find((item) => item.id === child.id).blockedBy, []);
  store.completeAssignment({ agentId: worker.id, assignmentId: child.id, message: "API done." });

  const blockedParent = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "External choice", description: "May block.", targetAgentName: "Worker" });
  const blockedChild = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "After choice", description: "Must remain queued.", targetAgentName: "Worker", dependsOn: [blockedParent.id] });
  assert.equal(store.claimNextAssignment(worker.id).id, blockedParent.id);
  store.completeAssignment({ agentId: worker.id, assignmentId: blockedParent.id, message: "Choice unavailable.", status: "blocked" });
  const blockedDetail = store.taskDetail(task.id).assignments.find((item) => item.id === blockedChild.id);
  assert.equal(blockedDetail.status, "queued");
  assert.equal(blockedDetail.blockedBy[0].status, "blocked", "a blocked prerequisite never silently unlocks its dependent");

  const otherTask = store.createTask({ projectId: project.id, title: "Other", description: "Different task." });
  store.joinTask(planner.id, otherTask.id);
  assert.throws(() => store.createAssignment({ agentId: planner.id, taskId: otherTask.id, title: "Cross-task", description: "Invalid.", dependsOn: [parent.id] }), /same task/);
  assert.throws(() => store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Missing", description: "Invalid.", dependsOn: ["00000000-0000-4000-8000-000000000000"] }), /existing assignment/);
});

test("review stages do not deadlock behind a transitive downstream writer", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-review-dependencies-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Staged review", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Ship staged changes", description: "Implement, review, fix, and test." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const implementer = store.connectAgent({ name: "Implementer", provider: "test" });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "test" });
  const securityReviewer = store.connectAgent({ name: "Security Reviewer", provider: "test" });
  const fixer = store.connectAgent({ name: "Fixer", provider: "test" });
  const tester = store.connectAgent({ name: "Tester", provider: "test" });

  const plan = store.claimNextAssignment(planner.id);
  const implementation = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement", description: "Build the change.", role: "implementer", requiresWrite: true, targetAgentName: "Implementer" });
  const review = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review the implementation.", role: "reviewer", targetAgentName: "Reviewer", dependsOn: [implementation.id] });
  const securityReview = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Security review", description: "Review security.", role: "security-reviewer", targetAgentName: "Security Reviewer", dependsOn: [review.id] });
  const fix = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Fix findings", description: "Apply review findings.", role: "implementer", requiresWrite: true, targetAgentName: "Fixer", dependsOn: [securityReview.id] });
  const testAssignment = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Test", description: "Verify the final change.", role: "tester", targetAgentName: "Tester", dependsOn: [fix.id] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Staged workflow planned." });

  assert.equal(store.claimNextAssignment(implementer.id).id, implementation.id);
  assert.equal(store.claimNextAssignment(reviewer.id), null, "review still waits for its upstream writer");
  store.completeAssignment({ agentId: implementer.id, assignmentId: implementation.id, message: "Implemented.", changedFiles: ["src/feature.mjs"] });

  assert.equal(store.claimNextAssignment(reviewer.id)?.id, review.id, "review ignores the transitive downstream fixer");
  assert.equal(store.claimNextAssignment(securityReviewer.id), null, "security review waits for review");
  store.completeAssignment({ agentId: reviewer.id, assignmentId: review.id, message: "Reviewed." });

  assert.equal(store.claimNextAssignment(securityReviewer.id)?.id, securityReview.id, "security review ignores its direct downstream fixer");
  store.completeAssignment({ agentId: securityReviewer.id, assignmentId: securityReview.id, message: "Security reviewed." });

  assert.equal(store.claimNextAssignment(fixer.id)?.id, fix.id);
  assert.equal(store.claimNextAssignment(tester.id), null, "tester waits for the upstream fixer");
  store.completeAssignment({ agentId: fixer.id, assignmentId: fix.id, message: "Findings fixed.", changedFiles: ["src/feature.mjs"] });

  assert.equal(store.claimNextAssignment(tester.id)?.id, testAssignment.id);
});

test("an assignment blocker queues triage without stopping sibling work or the task", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-assignment-block-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Assignment blocker", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Parallel work", description: "One item may need triage." });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  const risky = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Risky", description: "May block.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/risky"] });
  const sibling = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Sibling", description: "Must continue.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/sibling"] });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan complete." });
  assert.equal(store.claimNextAssignment(alice.id).id, risky.id);
  assert.equal(store.claimNextAssignment(bob.id).id, sibling.id);

  const outcome = store.completeAssignment({ agentId: alice.id, assignmentId: risky.id, message: "Needs a human choice.", status: "blocked" });
  const detail = store.taskDetail(task.id);
  assert.equal(outcome.taskBlocked, false);
  assert.equal(detail.status, "planning", "the triage planner keeps the task active");
  assert.equal(detail.assignments.find((item) => item.id === sibling.id).status, "claimed", "sibling work is untouched");
  assert.equal(store.getAgent(bob.id).status, "busy", "the sibling agent keeps its claim");
  assert.ok(detail.assignments.some((item) => item.id === outcome.followUpAssignmentId && item.role === "planner" && item.status === "queued"));
  assert.equal(detail.events.some((event) => event.type === "task.blocked"), false, "assignment triage is not mislabeled task-wide");
});

test("multi-task room choices are actionable and agent snapshots redact resume hashes", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-room-choice-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Rooms", process.cwd());
  const first = store.createTask({ projectId: project.id, title: "First", description: "First room." });
  const second = store.createTask({ projectId: project.id, title: "Second", description: "Second room." });
  const agent = store.connectAgent({ name: "Roomless", provider: "test" });

  const roomStatus = store.roomStatusForAgent(agent.id);
  assert.deepEqual(roomStatus.joinedTaskIds, []);
  assert.deepEqual(new Set(roomStatus.activeTasks.map((task) => task.id)), new Set([first.id, second.id]));
  assert.ok(roomStatus.activeTasks.every((task) => task.projectName === "Rooms" && Number.isInteger(task.openAssignments)));
  assert.equal(Object.hasOwn(store.listAgents().find((item) => item.id === agent.id), "resume_token_hash"), false);
  assert.equal(JSON.stringify(store.snapshotForAgent(agent.id)).includes("resume_token_hash"), false);
});

test("a human can safely resume a blocked task with a fresh version and planner", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-unblock-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Recovery", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Recover me", description: "Resume safely." });
  store.blockTask({ taskId: task.id, reason: "Paused for a decision." });

  const resumed = store.unblockTask({ taskId: task.id, reason: "Decision made; continue cleanly." });
  const detail = store.taskDetail(task.id);
  assert.equal(resumed.version, 2);
  assert.equal(detail.status, "planning");
  assert.equal(detail.approvals.length, 0);
  assert.ok(detail.assignments.some((item) => item.id === resumed.assignmentId && item.status === "queued" && item.role === "planner"));
  assert.ok(detail.events.some((event) => event.type === "task.unblocked" && event.metadata.version === 2));
  assert.throws(() => store.unblockTask({ taskId: task.id, reason: "Again" }), /Only a blocked task/);
});

test("human acceptance requires finished review work and is labeled as an override", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-human-accept-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Human acceptance", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Accept me", description: "Human decides.", requiredApprovals: 2 });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  assert.throws(() => store.acceptTaskByHuman({ taskId: task.id, summary: "Too early." }), /ready for review/);
  const plan = store.claimNextAssignment(planner.id);
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planning is complete." });

  const accepted = store.acceptTaskByHuman({ taskId: task.id, summary: "I reviewed the delivered result." });
  const detail = store.taskDetail(task.id);
  const event = detail.events.findLast((item) => item.type === "task.accepted");
  assert.equal(accepted.humanOverride, true);
  assert.equal(detail.status, "accepted");
  assert.equal(event.metadata.humanOverride, true);
  assert.equal(event.metadata.approvalCount, 0, "human acceptance does not forge agent approvals");
  assert.match(event.message, /Human accepted/);
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

test("a late joiner cannot block a proposal decided by the voters present when it was made", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-snapshot-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Snapshot project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Decide together", description: "Snapshot the voters." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });

  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Ship plan A." });
  const erin = store.connectAgent({ name: "Erin", provider: "test" }); // joins after the proposal was snapshotted

  store.voteProposal({ agentId: erin.id, proposalId: proposal.id, vote: "object", comment: "I just got here." });
  assert.equal(store.getProposal(proposal.id).status, "open", "a late joiner's objection does not decide the proposal");
  const outcome = store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" });
  assert.equal(outcome.status, "adopted", "the snapshotted voter's agreement adopts it");
});

test("a quorum proposal adopts on a majority instead of unanimity", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-quorum-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Quorum project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Majority rules", description: "Configurable quorum." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const dave = store.connectAgent({ name: "Dave", provider: "test" });

  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Adopt convention X.", details: { quorum: 0.5 } });
  const outcome = store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" });
  assert.equal(outcome.status, "adopted", "one of two snapshot voters meets a simple-majority quorum");
  assert.ok(dave, "the third agent never had to vote");
});

test("a proposal left open past the decision window is escalated for a human once", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-escalate-"));
  const store = new DevTeamStore(dataDir, { liveness: { proposalTimeoutMs: 60_000 } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Escalate project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Break the deadlock", description: "Escalate a stuck vote." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Nobody will vote on this." });
  store.db.prepare("UPDATE proposals SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(proposal.id);

  assert.equal(store.escalateStaleProposals().length, 1, "the stale open proposal is escalated");
  assert.ok(store.taskDetail(task.id).events.some((e) => e.type === "proposal.needs_human"), "a human-decision event is recorded");
  assert.equal(store.escalateStaleProposals().length, 0, "it is not escalated again");
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

test("the author of a version cannot approve it when a teammate could review instead", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-independent-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Independent project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Review must be independent", description: "No self-approval when others exist.", requiredApprovals: 1 });
  const planner = store.connectAgent({ name: "Planner", provider: "test" });
  const alice = store.connectAgent({ name: "Alice", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true, targetAgentName: "Alice" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Alice review", description: "Review current version.", role: "reviewer", targetAgentName: "Alice" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Bob review", description: "Independent review.", role: "reviewer", targetAgentName: "Bob" });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const build = store.claimNextAssignment(alice.id);
  store.completeAssignment({ agentId: alice.id, assignmentId: build.id, message: "Implemented.", changedFiles: ["package.json"] });
  const aliceReview = store.claimNextAssignment(alice.id);
  store.completeAssignment({ agentId: alice.id, assignmentId: aliceReview.id, message: "Self review." });
  assert.throws(() => store.approveTask({ agentId: alice.id, taskId: task.id, summary: "I approve my own change." }), /author of the current version cannot approve/);

  const bobReview = store.claimNextAssignment(bob.id);
  store.completeAssignment({ agentId: bob.id, assignmentId: bobReview.id, message: "Independent review passed." });
  const outcome = store.approveTask({ agentId: bob.id, taskId: task.id, summary: "Independently reviewed." });
  assert.equal(outcome.accepted, true, "an independent teammate can approve");
  assert.equal(outcome.selfReviewed, false, "and it is not labeled self-reviewed");
});

test("a solo acceptance is labeled selfReviewed; changed files that aren't on disk are flagged", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-selfreview-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Self review project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Solo but honest", description: "Label the lack of independent review.", requiredApprovals: 2 });
  const solo = store.connectAgent({ name: "Solo", provider: "test" });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Self review", description: "Review current version.", role: "reviewer", targetAgentName: "Solo" });
  const done = store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned.", changedFiles: ["package.json", "does/not/exist.js"] });
  assert.equal(done.completed, true);
  const completedEvent = store.taskDetail(task.id).events.find((e) => e.type === "assignment.completed");
  assert.deepEqual(completedEvent.metadata.unverifiedFiles, ["does/not/exist.js"], "a real file passes; a missing one is flagged, without blocking the report");

  const review = store.claimNextAssignment(solo.id);
  store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed." });
  const outcome = store.approveTask({ agentId: solo.id, taskId: task.id, summary: "Looks good." });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.selfReviewed, true, "a single-participant acceptance is labeled self-reviewed");
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

test("the shared blackboard stores versioned team memory with optimistic concurrency", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-blackboard-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Blackboard project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Share a mind", description: "One working memory." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });

  const first = store.noteSet({ agentId: codex.id, taskId: task.id, key: "decisions", value: "Use SQLite." });
  assert.equal(first.ok, true);
  assert.equal(first.version, 1);
  assert.equal(store.noteGet(task.id, "decisions").value, "Use SQLite.");
  assert.equal(store.noteGet(task.id, "decisions").updatedBy, "Codex", "provenance is recorded");

  // A stale write (wrong expected version) is refused, not silently clobbered.
  const stale = store.noteSet({ agentId: claude.id, taskId: task.id, key: "decisions", value: "Use Postgres.", expectedVersion: 0 });
  assert.equal(stale.conflict, true, "an out-of-date write is rejected");
  assert.equal(store.noteGet(task.id, "decisions").value, "Use SQLite.", "the current value is untouched");

  // A correctly-versioned write succeeds and bumps the version.
  const merged = store.noteSet({ agentId: claude.id, taskId: task.id, key: "decisions", value: "Use SQLite (WAL).", expectedVersion: 1 });
  assert.equal(merged.version, 2);

  // A non-member cannot write another room's memory.
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-blackboard-b"));
  const taskB = store.createTask({ projectId: projectB.id, title: "Other", description: "Different room." });
  store.joinTask(codex.id, task.id); // codex now explicitly only in task A
  assert.throws(() => store.noteSet({ agentId: codex.id, taskId: taskB.id, key: "x", value: "y" }), /not a member/);
  assert.equal(store.taskDetail(task.id).blackboard.length, 1, "taskDetail surfaces the blackboard for the dashboard");
});

test("project memory persists across same-project tasks while membership isolates other projects", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-project-memory-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Persistent memory", process.cwd());
  const firstTask = store.createTask({ projectId: project.id, title: "First task", description: "Write project memory." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const first = store.noteSet({ agentId: codex.id, taskId: firstTask.id, scope: "project", key: "conventions", value: "Use SQLite." });
  assert.equal(first.scope, "project");
  assert.equal(first.version, 1);

  const secondTask = store.createTask({ projectId: project.id, title: "Second task", description: "Read project memory." });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  store.joinTask(claude.id, secondTask.id);
  const carried = store.noteGet(secondTask.id, "conventions", "project", claude.id);
  assert.equal(carried.value, "Use SQLite.", "a later task in the project sees durable memory");
  assert.equal(carried.updatedBy, "Codex");
  assert.equal(store.noteGet(secondTask.id, "conventions", "task", claude.id), null, "task and project scopes remain distinct");

  const stale = store.noteSet({ agentId: claude.id, taskId: secondTask.id, scope: "project", key: "conventions", value: "Use Postgres.", expectedVersion: 0 });
  assert.equal(stale.conflict, true);
  assert.equal(stale.scope, "project");
  const merged = store.noteSet({ agentId: claude.id, taskId: secondTask.id, scope: "project", key: "conventions", value: "Use SQLite with WAL.", expectedVersion: 1 });
  assert.equal(merged.version, 2);

  const otherProject = store.ensureProject("Other project", path.join(os.tmpdir(), "devteam-project-memory-other"));
  const otherTask = store.createTask({ projectId: otherProject.id, title: "Other task", description: "Isolated." });
  assert.throws(() => store.noteGet(otherTask.id, "conventions", "project", codex.id), /not a member/);
  assert.throws(() => store.noteSet({ agentId: codex.id, taskId: otherTask.id, scope: "project", key: "x", value: "y" }), /not a member/);
  assert.equal(store.taskDetail(firstTask.id).projectBlackboard[0].value, "Use SQLite with WAL.");
  assert.equal(store.taskDetail(firstTask.id).blackboard.length, 0);
});

test("taskBrief returns bounded actionable context without global agent secrets", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-brief-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Brief", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Brief me", description: "Keep context compact." });
  const agent = store.connectAgent({ name: "Codex", provider: "test" });
  store.noteSet({ agentId: agent.id, taskId: task.id, key: "goal", value: "x".repeat(3_000) });
  store.noteSet({ agentId: agent.id, taskId: task.id, scope: "project", key: "convention", value: "local-first" });
  store.postMessage({ agentId: agent.id, taskId: task.id, type: "agent.question", message: "Which API shape?" });
  store.postMessage({ agentId: agent.id, taskId: task.id, type: "agent.decision", message: "Use a compact response." });

  const brief = store.taskBrief(agent.id, task.id);
  assert.equal(brief.task.title, "Brief me");
  assert.equal(brief.taskMemory[0].value.length, 2_001, "large memory values are truncated with an ellipsis");
  assert.equal(brief.projectMemory[0].value, "local-first");
  assert.match(brief.recent[0].message, /compact response/);
  assert.match(brief.unresolvedQuestions[0].message, /API shape/);
  assert.equal(JSON.stringify(brief).includes("resume_token_hash"), false);
  assert.equal(JSON.stringify(brief).includes("agents"), false, "the brief is task context, not a global agent dump");

  const otherTask = store.createTask({ projectId: project.id, title: "Other", description: "Not joined." });
  assert.throws(() => store.taskBrief(agent.id, otherTask.id), /not a member/);
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

test("a targeted assignment invites an agent into a new task's room across a multi-task server", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-invite-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-invite-b"));
  store.createTask({ projectId: projectA.id, title: "Task A", description: "Work A." });
  const taskB = store.createTask({ projectId: projectB.id, title: "Task B", description: "Work B." });
  const claude = store.connectAgent({ name: "Claude", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });

  // With two active tasks and no join, neither agent has an implicit room: nothing is claimable.
  assert.equal(store.claimNextAssignment(claude.id), null, "no invitation, no room, no claim");

  // The human (control plane) targets a Task B assignment at Claude — an explicit invitation.
  const invited = store.createAssignment({ taskId: taskB.id, title: "Do B", description: "Implement B.", targetAgentName: "Claude" });
  const claimed = store.claimNextAssignment(claude.id);
  assert.equal(claimed && claimed.id, invited.id, "the invited agent claims the targeted work across rooms");
  assert.equal(claimed.task_id, taskB.id);
  assert.equal(store.taskDetail(taskB.id).members.some((m) => m.agent_name === "Claude"), true, "the invitation auto-joined the room");

  // Untargeted work (Task B's own planner assignment) is not reachable by an uninvited agent.
  assert.equal(store.claimNextAssignment(bob.id), null, "an uninvited agent still cannot claim on a multi-task server");
});

test("a plain reconnect replays messages missed while the agent was disconnected", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-reconnect-replay-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Reconnect project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Stay in sync", description: "Do not lose messages." });
  const first = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  store.deliverDirectedMessages(first.id); // drain anything already waiting
  store.disconnectAgent(first.id, "Desktop closed.");

  // The human keeps talking to the (now absent) agent.
  store.humanMessage(task.id, "Please pick this up when you return.", "all");

  // A fresh session for the same identity reconnects — no resume token, plain devteam_connect.
  const second = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const inbox = store.deliverDirectedMessages(second.id);
  assert.ok(inbox.some((m) => /pick this up/.test(m.message)), "the message sent while away replays on a plain reconnect");
});

test("an open unanimity vote reports only the voters still able to decide it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-needed-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Needed project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Count the voters", description: "Honest requirements." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const dave = store.connectAgent({ name: "Dave", provider: "test" });
  const erin = store.connectAgent({ name: "Erin", provider: "test" });

  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Decide together." });
  // Erin was a snapshot voter but leaves before voting: it must no longer count toward the requirement.
  store.disconnectAgent(erin.id, "left");
  const outcome = store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" });
  assert.equal(outcome.status, "open", "still open until the remaining reachable voter agrees");
  assert.equal(outcome.needed, 2, "needed counts only the snapshot voters still able to vote (Claude+Dave), not the departed Erin");
  assert.equal(outcome.agreements, 1);
  // Once the last reachable voter agrees it adopts — the departed voter cannot deadlock it.
  assert.equal(store.voteProposal({ agentId: dave.id, proposalId: proposal.id, vote: "agree" }).status, "adopted");
});

test("continueTask reopens an accepted task, bumps the version, clears approvals, and re-queues planning", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-continue-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Continue project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Ship then continue", description: "Same-conversation follow-up.", requiredApprovals: 1 });
  const solo = store.connectAgent({ name: "Solo", provider: "test" });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Review", description: "Review v1.", role: "reviewer", targetAgentName: "Solo" });
  store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned." });
  const review = store.claimNextAssignment(solo.id);
  store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed." });
  assert.equal(store.approveTask({ agentId: solo.id, taskId: task.id, summary: "Good." }).accepted, true);
  assert.equal(store.getTask(task.id).status, "accepted");
  assert.equal(store.getAgent(solo.id).status, "waiting", "the agent stays assembled after acceptance");
  const acceptedVersion = store.getTask(task.id).version;

  // The human continues in the same task's chat.
  const cont = store.continueTask({ taskId: task.id, message: "Now also add dark mode." });
  assert.equal(cont.reopened, true);
  assert.equal(cont.version, acceptedVersion + 1, "reopening advances the version");
  assert.equal(store.taskDetail(task.id).approvals.length, 0, "the accepted version's approvals are cleared");
  assert.equal(store.getTask(task.id).status, "planning", "a fresh planner assignment reopens planning");
  // The still-waiting agent claims the follow-up planner work without reconnecting.
  const followup = store.claimNextAssignment(solo.id);
  assert.equal(followup && followup.id, cont.assignmentId, "the assembled agent picks up the continuation");
  assert.equal(followup.role, "planner");

  // A blocked task is not auto-reopened by a continuation.
  const blocked = store.createTask({ projectId: project.id, title: "Blocked", description: "Needs a human." });
  store.blockTask({ taskId: blocked.id, reason: "waiting on a human decision" });
  assert.throws(() => store.continueTask({ taskId: blocked.id, message: "keep going" }), /blocked/);
});

test("an accepted task keeps the room active within the continuation window, then goes quiet", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-contwindow-"));
  const store = new DevTeamStore(dataDir, { liveness: { continuationWindowMs: 60_000 } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Window project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Stay a moment", description: "Continuation window.", requiredApprovals: 1 });
  const solo = store.connectAgent({ name: "Solo", provider: "test" });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Review", description: "Review.", role: "reviewer", targetAgentName: "Solo" });
  store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned." });
  const review = store.claimNextAssignment(solo.id);
  store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed." });
  store.approveTask({ agentId: solo.id, taskId: task.id, summary: "Good." });
  assert.equal(store.getTask(task.id).status, "accepted");
  assert.equal(store.teamActivity().active, true, "a just-accepted room stays assembled for the follow-up window");

  // Push the acceptance outside the window: the room goes quiet.
  store.db.prepare("UPDATE tasks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(task.id);
  assert.equal(store.teamActivity().active, false, "past the window, an accepted task no longer keeps the room active");
});

test("a human Agree adopts a proposal outright; a human Object declines it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-humanvote-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Human vote project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Owner decides", description: "Human is authoritative." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });

  // Without the human, adoption would wait on Claude; the human's own click decides it.
  const p1 = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Adopt plan A." });
  assert.equal(store.voteProposal({ agentId: null, proposalId: p1.id, vote: "agree" }).status, "adopted", "the human's Agree is decisive");
  const p2 = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Adopt plan B." });
  assert.equal(store.voteProposal({ agentId: null, proposalId: p2.id, vote: "object" }).status, "declined", "the human's Object is decisive");
  assert.ok(claude, "the other agent never had to vote");
});

test("re-casting the same vote is idempotent and emits no duplicate events", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-idempotent-vote-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Idempotent project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "No spam", description: "Repeated clicks are safe." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic" });
  const dave = store.connectAgent({ name: "Dave", provider: "test" });
  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Adopt X." });
  store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" }); // stays open: Dave hasn't voted
  const voteEvents = () => store.taskDetail(task.id).events.filter((e) => e.type === "proposal.vote" && e.agent_id === claude.id).length;
  const before = voteEvents();
  const repeat = store.voteProposal({ agentId: claude.id, proposalId: proposal.id, vote: "agree" });
  assert.equal(repeat.unchanged, true, "a repeat identical vote is a no-op");
  assert.equal(voteEvents(), before, "no duplicate vote event is recorded");
  assert.ok(dave, "a third snapshot voter keeps the proposal open for the repeat");
});

test("a dashboard-created proposal has no implicit vote and is adopted once by an explicit human Agree", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-humanpropose-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Human propose project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Human proposes", description: "Owner-authored proposal." });
  store.connectAgent({ name: "Codex", provider: "OpenAI" }); // a teammate is present in the room
  const proposal = store.createProposal({ agentId: null, taskId: task.id, kind: "decision", summary: "Human decision." });
  assert.equal(store.getProposal(proposal.id).votes.length, 0, "a human-created proposal starts with no implicit vote");
  assert.equal(store.voteProposal({ agentId: null, proposalId: proposal.id, vote: "agree" }).status, "adopted", "one explicit human Agree adopts it");
  assert.equal(store.voteProposal({ agentId: null, proposalId: proposal.id, vote: "agree" }).alreadyResolved, true, "a repeat click after resolution is idempotent");
});

test("a legacy proposal already carrying the human's agree adopts on the next identical human Agree", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-legacy-humanvote-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Legacy vote project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Legacy adopt", description: "Pre-seeded human vote." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI" });
  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Legacy decision." });
  // Simulate a legacy pre-seeded human agree recorded without triggering evaluation; still open.
  store.db.prepare("INSERT OR REPLACE INTO proposal_votes (proposal_id, voter_id, voter_name, vote, comment, created_at) VALUES (?, 'human', 'You', 'agree', NULL, ?)").run(proposal.id, new Date().toISOString());
  assert.equal(store.getProposal(proposal.id).status, "open", "the pre-seeded vote never resolved it");
  assert.equal(store.voteProposal({ agentId: null, proposalId: proposal.id, vote: "agree" }).status, "adopted", "an identical human Agree re-evaluates and adopts the stuck proposal once");
});

test("continueTask during review advances the version and clears the in-progress approvals", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-continue-review-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Continue-review project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Review then continue", description: "Follow-up mid-review.", requiredApprovals: 2 });
  const planner = store.connectAgent({ name: "Planner", provider: "Codex" });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "Claude" });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Write", description: "Change a file.", role: "implementer", requiresWrite: true, targetAgentName: "Planner" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review.", role: "reviewer", targetAgentName: "Reviewer" });
  store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
  const write = store.claimNextAssignment(planner.id);
  store.completeAssignment({ agentId: planner.id, assignmentId: write.id, message: "Wrote it.", changedFiles: ["src/x.js"] });
  const review = store.claimNextAssignment(reviewer.id);
  store.completeAssignment({ agentId: reviewer.id, assignmentId: review.id, message: "Reviewed." });
  assert.equal(store.approveTask({ agentId: reviewer.id, taskId: task.id, summary: "One of two." }).accepted, false);
  assert.equal(store.getTask(task.id).status, "review");
  assert.equal(store.taskDetail(task.id).approvals.length, 1, "a partial approval exists during review");
  const versionBefore = store.getTask(task.id).version;

  const cont = store.continueTask({ taskId: task.id, message: "Tweak the copy too." });
  assert.equal(cont.reopened, true, "a follow-up during review reopens as new work");
  assert.equal(cont.version, versionBefore + 1, "the version advances so the partial approval can't carry over");
  assert.equal(store.taskDetail(task.id).approvals.length, 0, "the in-progress approval is cleared");
});

test("forgetAgent removes an unresponsive ghost, returns its work, and refuses a live agent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-forget-"));
  const store = new DevTeamStore(dataDir, { liveness: { presenceMs: 100 } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Ghost project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Hold a lease", description: "Exercise ghost removal." });

  const live = store.connectAgent({ name: "Live", provider: "Claude" });
  assert.throws(() => store.forgetAgent(live.id), /still connected/, "a connected agent is protected from removal");

  const writer = store.connectAgent({ name: "Writer", provider: "Codex" });
  const plan = store.claimNextAssignment(writer.id);
  store.createAssignment({ agentId: writer.id, taskId: task.id, title: "Edit core", description: "Change files.", role: "implementer", requiresWrite: true, targetAgentName: "Writer" });
  store.completeAssignment({ agentId: writer.id, assignmentId: plan.id, message: "Planned." });
  const write = store.claimNextAssignment(writer.id);
  assert.equal(write.requires_write, 1, "the writer holds a write lease");

  await new Promise((resolve) => setTimeout(resolve, 125));
  store.reapAndRecover();
  assert.equal(store.getAgent(writer.id).status, "unresponsive", "a silent busy writer becomes unresponsive but keeps its claim");

  const result = store.forgetAgent(writer.id);
  assert.equal(result.forgotten, true);
  assert.ok(!store.listAgents().some((agent) => agent.name === "Writer"), "the removed agent leaves the roster");
  const wrote = store.taskDetail(task.id).assignments.find((assignment) => assignment.title === "Edit core");
  assert.equal(wrote.status, "queued", "its unfinished write work returns to the queue");
  assert.equal(wrote.agent_id, null);
});

test("long-gone agents are auto-purged, but a ghost still holding a write lease is kept", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-purge-"));
  const store = new DevTeamStore(dataDir, { liveness: { presenceMs: 100, forgetMs: 1 } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Purge project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Reap the ghosts", description: "Exercise auto-purge." });

  const writer = store.connectAgent({ name: "Writer", provider: "Codex" });
  const idler = store.connectAgent({ name: "Idler", provider: "Claude" });
  const plan = store.claimNextAssignment(writer.id);
  store.createAssignment({ agentId: writer.id, taskId: task.id, title: "Edit core", description: "Change files.", role: "implementer", requiresWrite: true, targetAgentName: "Writer" });
  store.completeAssignment({ agentId: writer.id, assignmentId: plan.id, message: "Planned." });
  store.claimNextAssignment(writer.id); // Writer now holds a write lease.
  store.disconnectAgent(idler.id); // Idler leaves for good, holding nothing.

  await new Promise((resolve) => setTimeout(resolve, 125));
  store.reapAndRecover();
  const names = store.listAgents().map((agent) => agent.name);
  assert.ok(!names.includes("Idler"), "a long-disconnected agent is purged from the roster");
  const survivor = store.listAgents().find((agent) => agent.name === "Writer");
  assert.ok(survivor, "a ghost still holding a write lease is kept, not silently purged");
  assert.equal(survivor.status, "unresponsive");
});

test("updateTask edits task information without touching version, approvals, or work", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-edit-task-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Edit project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Typo in titel", description: "Old brief.", requiredApprovals: 2 });
  const versionBefore = task.version;

  const updated = store.updateTask(task.id, { title: "Fixed title", description: "Sharpened brief.", requiredApprovals: 3 });
  assert.equal(updated.title, "Fixed title");
  assert.equal(updated.description, "Sharpened brief.");
  assert.equal(updated.required_approvals, 3);
  assert.equal(updated.version, versionBefore, "editing the brief does not advance the version");
  assert.equal(store.taskDetail(task.id).events.some((event) => event.type === "task.updated"), true, "the edit is recorded on the timeline");
  assert.throws(() => store.updateTask(task.id, { title: "   " }), /title cannot be empty/);
  assert.throws(() => store.updateTask("missing-id", { title: "x" }), /Task not found/);
});

test("updateProject renames a project and repoints its root with validation", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-edit-project-"));
  const rootA = await mkdtemp(path.join(os.tmpdir(), "devteam-root-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "devteam-root-b-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });
  const first = store.ensureProject("First", rootA);
  const second = store.ensureProject("Second", rootB);

  const renamed = store.updateProject(first.id, { name: "First renamed" });
  assert.equal(renamed.name, "First renamed");
  assert.equal(renamed.root, path.resolve(rootA), "leaving root out keeps the existing folder");

  assert.throws(() => store.updateProject(first.id, { root: rootB }), /already uses that folder/, "a root already owned by another project is rejected");
  const moved = store.updateProject(first.id, { root: rootA });
  assert.equal(moved.root, path.resolve(rootA));
  assert.throws(() => store.updateProject(second.id, { name: "  " }), /name cannot be empty/);
});
