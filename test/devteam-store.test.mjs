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
  const agent = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  store.noteSet({ agentId: agent.id, taskId: task.id, scope: "project", key: "architecture/runtime", value: "SQLite is the source of truth; Markdown is the exported view." });
  const proposal = store.createProposal({ agentId: agent.id, taskId: task.id, kind: "decision", summary: "Use one serialized knowledge exporter", details: {} });
  store.voteProposal({ proposalId: proposal.id, vote: "agree" });
  await store.completeAssignment({
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
  // Only the leading notes carry a body; the rest are a headline and a wikilink, so the brief can
  // surface many more of them for the same bytes. Every note must still say what it claims.
  assert.ok(brief.projectKnowledge.every((note) => note.headline && note.headline.length <= 220));
  assert.ok(brief.projectKnowledge.every((note) => note.body === undefined || note.body.length <= 1_300));
  assert.ok(brief.projectKnowledge.some((note) => note.body), "the most relevant notes still arrive in full");
  const search = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "serialized", category: "decisions" });
  assert.equal(search.automated, true);
  assert.equal(search.notes.length, 1);
  assert.match(search.notes[0].title, /serialized knowledge exporter/i);
});

test("file-linked knowledge becomes stale or superseded without affecting unrelated notes", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-lifecycle-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-lifecycle-project-"));
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await writeFile(path.join(projectRoot, "src", "shared.js"), "export const shared = 1;\n", "utf8");
  await writeFile(path.join(projectRoot, "src", "unrelated.js"), "export const unrelated = 1;\n", "utf8");
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); });
  const lifecycleColumns = new Set(store.db.prepare("PRAGMA table_info(knowledge_notes)").all().map((column) => column.name));
  for (const column of ["superseded_by", "stale_reason", "status_changed_at", "last_validated_at", "last_validated_version"]) {
    assert.equal(lifecycleColumns.has(column), true, `knowledge migration adds ${column}`);
  }
  const project = store.ensureProject("Lifecycle", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Refresh implementation facts", description: "Change the same file twice." });
  const agent = store.connectAgent({ name: "Writer", provider: "test", freshTaskId: task.id });
  const planner = store.claimNextAssignment(agent.id);
  const firstWork = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "First shared implementation", description: "Implement shared.", role: "implementer", requiresWrite: true, paths: ["src/shared.js"] });
  await store.completeAssignment({ agentId: agent.id, assignmentId: planner.id, claimToken: planner.claimToken, message: "Planned." });
  const firstClaim = store.claimNextAssignment(agent.id);
  assert.equal(firstClaim.id, firstWork.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: firstClaim.id, claimToken: firstClaim.claimToken, message: "First shared behavior.", changedFiles: ["src/shared.js"] });

  const secondWork = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Replace shared implementation", description: "Replace shared.", role: "implementer", requiresWrite: true, paths: ["src/shared.js"] });
  const secondClaim = store.claimNextAssignment(agent.id);
  assert.equal(secondClaim.id, secondWork.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: secondClaim.id, claimToken: secondClaim.claimToken, message: "Current shared behavior.", changedFiles: ["src/shared.js"] });

  const thirdWork = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Unrelated implementation", description: "Change an unrelated module.", role: "implementer", requiresWrite: true, paths: ["src/unrelated.js"] });
  const thirdClaim = store.claimNextAssignment(agent.id);
  assert.equal(thirdClaim.id, thirdWork.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: thirdClaim.id, claimToken: thirdClaim.claimToken, message: "Unrelated behavior.", changedFiles: ["src/unrelated.js"] });

  const escapedWork = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Escaped report", description: "A malformed changed path must not invalidate knowledge.", role: "implementer", requiresWrite: true, paths: ["src"] });
  const escapedClaim = store.claimNextAssignment(agent.id);
  assert.equal(escapedClaim.id, escapedWork.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: escapedClaim.id, claimToken: escapedClaim.claimToken, message: "Malformed report.", changedFiles: ["../outside.js"] });

  const componentNotes = store.db.prepare(`
    SELECT * FROM knowledge_notes WHERE project_id = ? AND category = 'components' ORDER BY source_event_id ASC
  `).all(project.id);
  assert.equal(componentNotes.length, 3);
  assert.equal(componentNotes[0].status, "stale");
  assert.equal(componentNotes[0].superseded_by, componentNotes[1].id);
  assert.match(componentNotes[0].stale_reason, /src\/shared\.js/);
  assert.equal(componentNotes[1].status, "verified", "an unrelated change does not stale current shared knowledge");
  assert.equal(componentNotes[2].status, "verified");
  const lifecycleEvent = store.taskDetail(task.id).events.find((event) => event.type === "knowledge.superseded");
  assert.equal(lifecycleEvent.metadata.supersededBy, componentNotes[1].id);

  const brief = store.taskBrief(agent.id, task.id);
  assert.equal(brief.projectKnowledge.some((note) => note.id === componentNotes[0].id), false);
  const staleSearch = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, status: "stale" });
  assert.equal(staleSearch.notes.some((note) => note.id === componentNotes[0].id), true);
  const staleExport = await readFile(path.join(projectRoot, "knowledge", "components", `${componentNotes[0].slug}.md`), "utf8");
  assert.match(staleExport, /status: stale/);
  assert.match(staleExport, new RegExp(`superseded_by: "${componentNotes[1].id}"`));

  const sessions = path.join(projectRoot, "knowledge", "sessions");
  const generatedSession = (await readdir(sessions)).find((name) => name.endsWith(`${task.id.slice(0, 8)}.md`));
  await writeFile(path.join(sessions, "human-note.md"), "# Keep this human note\n", "utf8");
  store.deleteTask(task.id, task.id);
  assert.equal((await readdir(sessions)).includes(generatedSession), false, "deleted task session view is reconciled");
  assert.equal(await readFile(path.join(sessions, "human-note.md"), "utf8"), "# Keep this human note\n");
});

test("DevTeam coordinates plan, write lease, review, versioning, and consensus", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-store-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });

  const project = store.ensureProject("Test project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Ship a safe change", description: "Implement and review it.", requiredApprovals: 2 });
  const planner = store.connectAgent({ name: "Planner", provider: "Codex", capabilities: ["planning"], freshTaskId: task.id });
  const writer = store.connectAgent({ name: "Writer", provider: "Claude", capabilities: ["coding"], freshTaskId: task.id });
  const reviewerA = store.connectAgent({ name: "Reviewer A", provider: "Codex", capabilities: ["review"], freshTaskId: task.id });
  const reviewerB = store.connectAgent({ name: "Reviewer B", provider: "Claude", capabilities: ["review"], freshTaskId: task.id });

  const plan = store.claimNextAssignment(planner.id);
  assert.equal(plan.role, "planner");
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement", description: "Make the change.", role: "implementer", requiresWrite: true, targetAgentName: "Writer" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review A", description: "Review current version.", role: "reviewer", targetAgentName: "Reviewer A" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review B", description: "Review current version.", role: "reviewer", targetAgentName: "Reviewer B" });
  assert.equal(store.getTask(task.id).status, "planning", "review assignments do not prematurely move a planning task to review");
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan dispatched." });
  assert.equal(store.getTask(task.id).status, "active");

  assert.equal(store.claimNextAssignment(reviewerA.id), null, "review waits while an unrelated write remains queued");
  const implementation = store.claimNextAssignment(writer.id);
  assert.equal(implementation.requires_write, 1);
  assert.equal(store.claimNextAssignment(reviewerA.id), null, "review waits while an unrelated write is claimed");
  assert.equal(store.claimNextAssignment(planner.id), null, "an untargeted agent cannot take targeted work");
  const completed = await store.completeAssignment({ agentId: writer.id, assignmentId: implementation.id, message: "Implemented.", changedFiles: ["src/example.js"], checks: ["npm test"] });
  assert.equal(completed.version, 2);
  assert.equal(store.getTask(task.id).status, "review");

  const reviewOne = store.claimNextAssignment(reviewerA.id);
  await store.completeAssignment({ agentId: reviewerA.id, assignmentId: reviewOne.id, message: "Looks correct.", checks: ["npm test"] });
  const firstApproval = store.approveTask({ agentId: reviewerA.id, taskId: task.id, summary: "Reviewed version 2." });
  assert.equal(firstApproval.accepted, false);

  const reviewTwo = store.claimNextAssignment(reviewerB.id);
  await store.completeAssignment({ agentId: reviewerB.id, assignmentId: reviewTwo.id, message: "Independent review passed." });
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
  const planner = store.connectAgent({ name: "Planner", provider: "Codex", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "Claude", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review version one.", role: "reviewer", targetAgentName: "Reviewer" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan ready." });
  const review = store.claimNextAssignment(reviewer.id);
  await store.completeAssignment({ agentId: reviewer.id, assignmentId: review.id, message: "Version one reviewed." });
  store.approveTask({ agentId: reviewer.id, taskId: task.id, summary: "Version one is fine." });
  const change = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Change", description: "Modify a file.", role: "implementer", requiresWrite: true, targetAgentName: "Planner" });
  const claimedChange = store.claimNextAssignment(planner.id);
  assert.equal(claimedChange.id, change.id);
  await store.completeAssignment({ agentId: planner.id, assignmentId: claimedChange.id, message: "Updated plan file.", changedFiles: ["plan.md"] });
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
  const task = store.createTask({ projectId: project.id, title: "Recover work", description: "Release claimed work." });
  const first = store.connectAgent({ name: "First", provider: "Codex", freshTaskId: task.id });
  const second = store.connectAgent({ name: "Second", provider: "Claude", freshTaskId: task.id });
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
  const first = store.connectAgent({ name: "Codex", provider: "OpenAI Codex Desktop", freshTaskId: task.id });
  const claimed = store.claimNextAssignment(first.id);

  // A message arrives, then the first chat drops and a second "Codex" chat opens.
  store.humanMessage(task.id, "Keep going on the plan.", "Codex");
  const second = store.connectAgent({ name: "Codex", provider: "OpenAI Codex Desktop", freshTaskId: task.id });

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
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  const write = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Write", description: "Change files.", requiresWrite: true });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan complete." });
  assert.equal(store.claimNextAssignment(planner.id).id, write.id);

  // The writer goes silent for a long time while it is actually still reasoning/editing.
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", planner.id);

  const replacement = store.connectAgent({ name: "Replacement", provider: "test", freshTaskId: task.id });
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
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  const write = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Write", description: "Change files.", requiresWrite: true, targetAgentName: "Planner" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
  const claim = store.claimNextAssignment(planner.id);
  assert.equal(claim.id, write.id);
  assert.ok(claim.claimToken, "the claim returns a fencing token");
  assert.ok(claim.claimGeneration >= 1, "and a generation");

  // A human force-releases the stuck lease; the original session then tries to report with its now
  // stale token.
  store.forceReleaseAssignment({ assignmentId: write.id, confirmTitle: "Write" });
  const conflict = await store.completeAssignment({ agentId: planner.id, assignmentId: write.id, message: "Too late.", claimToken: claim.claimToken });
  assert.equal(conflict.completed, false, "a report against a lease that moved on is refused");
  assert.ok(conflict.claimConflict, "and the refusal is structured");
  assert.match(conflict.claimConflict.nextAction, /devteam_next|devteam_join/);

  // A fresh claim gets a new token and generation and can complete normally.
  const reclaim = store.claimNextAssignment(planner.id);
  assert.ok(reclaim.claimGeneration > claim.claimGeneration, "reclaiming bumps the generation");
  const done = await store.completeAssignment({ agentId: planner.id, assignmentId: write.id, message: "Done.", claimToken: reclaim.claimToken, changedFiles: ["package.json"] });
  assert.equal(done.completed, true, "the current lease holder completes with the matching token");
});

test("write assignments with non-overlapping paths run in parallel; overlapping ones wait", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-parallel-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Parallel project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Build in parallel", description: "Two writers, different files." });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const carol = store.connectAgent({ name: "Carol", provider: "test", freshTaskId: task.id });

  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Ocean", description: "Build ocean.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/ocean/**"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD", description: "Build HUD.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/hud"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Waves", description: "Ocean waves.", requiresWrite: true, targetAgentName: "Carol", paths: ["src/ocean/waves.js"] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const aWork = store.claimNextAssignment(alice.id);
  assert.equal(aWork.title, "Ocean");
  assert.deepEqual(aWork.writeScope, ["src/ocean"], "the claim reports its normalized write scope");
  const bWork = store.claimNextAssignment(bob.id);
  assert.equal(bWork && bWork.title, "HUD", "a non-overlapping writer claims in parallel");
  assert.equal(store.claimNextAssignment(carol.id), null, "an overlapping write waits for the lease to free");

  await store.completeAssignment({ agentId: alice.id, assignmentId: aWork.id, message: "Ocean done.", changedFiles: ["src/ocean/index.js"] });
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
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Real dir", description: "Edit the real directory.", requiresWrite: true, targetAgentName: "Alice", paths: ["real-hud"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Via junction", description: "Edit through the junction.", requiresWrite: true, targetAgentName: "Bob", paths: ["hud"] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const aWork = store.claimNextAssignment(alice.id);
  assert.equal(aWork.title, "Real dir");
  assert.equal(store.claimNextAssignment(bob.id), null, "the junction resolves to the same real directory and waits");
});

test("a long-silent read-only claim is recovered automatically", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-readonly-recover-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Recover project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Recover a read-only claim", description: "Planner work is safe to requeue." });
  const worker = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(worker.id); // planner role: read-only
  assert.equal(plan.requires_write, 0);
  // Long enough silent to safely recover the read-only claim (> staleWorkMs), but not so long the
  // agent is auto-purged as a ghost (< forgetMs) — so it survives as 'unresponsive' to be checked.
  const longSilence = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(longSilence, worker.id);

  const replacement = store.connectAgent({ name: "Replacement", provider: "test", freshTaskId: task.id });
  assert.equal(store.claimNextAssignment(replacement.id).id, plan.id, "a long-silent read-only claim is safely recovered");
  assert.equal(store.getAgent(worker.id).status, "unresponsive");
});

test("claiming work repairs an assignment already orphaned by a disconnected agent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-orphan-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Orphan project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Recover orphan", description: "Repair old database state." });
  const original = store.connectAgent({ name: "Original", provider: "test", freshTaskId: task.id });
  const claimed = store.claimNextAssignment(original.id);
  store.db.prepare("UPDATE agents SET status = 'disconnected', disconnected_at = ? WHERE id = ?").run(new Date().toISOString(), original.id);

  const replacement = store.connectAgent({ name: "Replacement", provider: "test", freshTaskId: task.id });
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
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: taskA.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: taskB.id });
  const carol = store.connectAgent({ name: "Carol", provider: "test" });

  // An agent that named no room on connect is in no room, whatever the board looks like, and is
  // told so rather than being shown an empty queue it has no way to interpret.
  assert.equal(store.claimNextAssignment(carol.id), null, "an unjoined agent cannot claim anything");
  const carolBoard = store.whyNoClaimableWork(carol.id);
  assert.equal(carolBoard.membershipRequired, true);
  assert.deepEqual(carolBoard.availableTasks.map((entry) => entry.id).sort(), [taskA.id, taskB.id].sort());

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
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: taskA.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: taskB.id });

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
  assert.ok(taskB, "a second task is on the board, and observing one room does not reach it");
});

test("membership named at connect survives a second task appearing", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-membership-persist-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  const taskA = store.createTask({ projectId: projectA.id, title: "First task", description: "The sole task at connect time." });
  const worker = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: taskA.id }); // explicit join, recorded now

  // A second active task later must not orphan the worker out of Task A.
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-implicit-persist-b"));
  store.createTask({ projectId: projectB.id, title: "Second task", description: "Now the server is multi-task." });

  store.humanMessage(taskA.id, "Still in your room?", "all");
  assert.equal(store.deliverDirectedMessages(worker.id).length, 1, "the worker still belongs to Task A after a second task appears");
  assert.equal(store.claimNextAssignment(worker.id).task_id, taskA.id, "and can still claim Task A's work");
});

test("an agent holds one write claim, and may still review while it holds it", async (t) => {
  // T0.3: the invariant that matters is about write leases. Two agents must never hold overlapping
  // write scopes, and one agent holding two write leases is how it hoards them. Read-only work takes
  // no lease at all, so capping it bought nothing and throttled exactly the review-heavy workflows
  // this server exists for.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-one-claim-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("One claim project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Bound the claims", description: "No hoarding." });
  const worker = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(worker.id);
  await store.completeAssignment({ agentId: worker.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  const firstWriter = store.createAssignment({ taskId: task.id, title: "Edit one", description: "Do it.", role: "implementer", requiresWrite: true, paths: ["src/one.mjs"], targetAgentName: "Worker" });
  // Untargeted, so the last assertion tests the *lease*, not who it was addressed to.
  const secondWriter = store.createAssignment({ taskId: task.id, title: "Edit two", description: "Do it.", role: "implementer", requiresWrite: true, paths: ["src/two.mjs"] });
  const write = store.claimNextAssignment(worker.id);
  assert.equal(write.id, firstWriter.id);

  // A second writer is refused even though its paths do not overlap: one write lease per agent.
  assert.equal(store.claimNextAssignment(worker.id), null, "an agent takes one piece of write work at a time");
  const blocked = store.whyNotClaimable(secondWriter.id, worker.id);
  assert.equal(blocked.claimable, false);
  assert.ok(blocked.reasons.some((reason) => reason.code === "agent_holds_write_claim"));

  // Read-only work is a different matter: reviewing while holding a write lease is not hoarding.
  // It has to be in another room, because the review gate holds a verifier behind pending writers in
  // its *own* task — which is exactly right, and is why the throughput this unlocks is cross-room.
  const otherTask = store.createTask({ projectId: project.id, title: "Another room", description: "Review work lives here." });
  store.joinTask(worker.id, otherTask.id);
  const otherPlan = store.db.prepare("SELECT id FROM assignments WHERE task_id = ? AND status = 'queued'").get(otherTask.id);
  store.db.prepare("UPDATE assignments SET status = 'done', completed_at = ? WHERE id = ?").run(new Date().toISOString(), otherPlan.id);
  for (const label of ["Read one", "Read two", "Read three", "Read four"]) {
    store.createAssignment({ taskId: otherTask.id, title: label, description: "Review.", role: "reviewer", targetAgentName: "Worker" });
  }

  const firstRead = store.claimNextAssignment(worker.id);
  assert.ok(firstRead, "a writer may still pick up review work");
  assert.equal(firstRead.requires_write, 0);
  const secondRead = store.claimNextAssignment(worker.id);
  assert.ok(secondRead, "and more than one of it");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE agent_id = ? AND status = 'claimed'").get(worker.id).count, 3);

  // But not without bound: the cap stops one agent draining the whole review queue.
  const thirdRead = store.claimNextAssignment(worker.id);
  assert.ok(thirdRead, "up to the cap");
  assert.equal(store.claimNextAssignment(worker.id), null, "and no further");

  // The write lease is still exclusive against *other* agents, which is the point of all of this.
  const rival = store.connectAgent({ name: "Rival", provider: "test", freshTaskId: task.id });
  const rivalBlocked = store.whyNotClaimable(secondWriter.id, rival.id);
  assert.equal(rivalBlocked.claimable, true, "a non-overlapping writer is still free for someone else");
  assert.equal(store.claimNextAssignment(rival.id).id, secondWriter.id);
});

test("two agents still cannot hold overlapping write scopes", async (t) => {
  // The guarantee T0.3 must not weaken, asserted separately from the throughput change.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-write-exclusive-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Exclusive project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "One writer per path", description: "Leases still hold." });
  const first = store.connectAgent({ name: "First", provider: "test", freshTaskId: task.id });
  const second = store.connectAgent({ name: "Second", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(first.id);
  await store.completeAssignment({ agentId: first.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  store.createAssignment({ taskId: task.id, title: "Edit shared", description: "Do it.", role: "implementer", requiresWrite: true, paths: ["src/shared.mjs"] });
  const overlapping = store.createAssignment({ taskId: task.id, title: "Edit shared again", description: "Do it.", role: "implementer", requiresWrite: true, paths: ["src/shared.mjs"] });
  const held = store.claimNextAssignment(first.id);
  assert.ok(held);
  const conflict = store.whyNotClaimable(overlapping.id, second.id);
  assert.equal(conflict.claimable, false);
  assert.ok(conflict.reasons.some((reason) => reason.code === "write_lease_conflict"),
    "the one guarantee that must survive the multi-claim change");
});

test("path scopes are canonicalized so a '..' alias cannot smuggle an overlapping lease", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-scope-alias-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Scope project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Guard the paths", description: "Aliases must not overlap." });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD direct", description: "Edit hud.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/hud"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD alias", description: "Same dir via alias.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/ocean/../hud"] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

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
  const writer = store.connectAgent({ name: "Writer", provider: "test", freshTaskId: blockedTask.id });
  const plan = store.claimNextAssignment(writer.id);
  const write = store.createAssignment({ agentId: writer.id, taskId: blockedTask.id, title: "Write", description: "Change files.", requiresWrite: true });
  await store.completeAssignment({ agentId: writer.id, assignmentId: plan.id, message: "Plan complete." });
  store.claimNextAssignment(writer.id);
  store.blockTask({ taskId: blockedTask.id, reason: "Human stopped the task." });
  assert.equal(store.taskDetail(blockedTask.id).assignments.find((assignment) => assignment.id === write.id).status, "blocked");

  const nextTask = store.createTask({ projectId: project.id, title: "Next", description: "This task should proceed." });
  const nextAgent = store.connectAgent({ name: "Next", provider: "test", freshTaskId: nextTask.id });
  const nextPlan = store.claimNextAssignment(nextAgent.id);
  const nextWrite = store.createAssignment({ agentId: nextAgent.id, taskId: nextTask.id, title: "Next write", description: "Proceed.", requiresWrite: true });
  await store.completeAssignment({ agentId: nextAgent.id, assignmentId: nextPlan.id, message: "Plan complete." });
  assert.equal(store.claimNextAssignment(nextAgent.id).id, nextWrite.id);
});

test("blocking a task stands co-workers down to waiting instead of force-disconnecting them", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-coworker-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Co-worker project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Two writers", description: "One blocks, the other survives." });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Ocean", description: "Edit ocean.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/ocean"] });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "HUD", description: "Edit hud.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/hud"] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
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
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const worker = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  const parent = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Schema", description: "Create schema.", targetAgentName: "Worker" });
  const child = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "API", description: "Use schema.", targetAgentName: "Worker", dependsOn: [parent.id] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const detailBefore = store.taskDetail(task.id).assignments.find((item) => item.id === child.id);
  assert.deepEqual(detailBefore.dependsOn, [parent.id]);
  assert.deepEqual(detailBefore.blockedBy.map((item) => item.title), ["Schema"]);
  assert.equal(store.claimNextAssignment(worker.id).id, parent.id, "the prerequisite is claimed first");
  assert.equal(store.claimNextAssignment(planner.id), null, "another agent cannot skip ahead to the dependent work");
  await store.completeAssignment({ agentId: worker.id, assignmentId: parent.id, message: "Schema done." });
  assert.equal(store.claimNextAssignment(worker.id).id, child.id, "the child unlocks after its dependency is done");
  assert.deepEqual(store.taskDetail(task.id).assignments.find((item) => item.id === child.id).blockedBy, []);
  await store.completeAssignment({ agentId: worker.id, assignmentId: child.id, message: "API done." });

  const blockedParent = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "External choice", description: "May block.", targetAgentName: "Worker" });
  const blockedChild = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "After choice", description: "Must remain queued.", targetAgentName: "Worker", dependsOn: [blockedParent.id] });
  assert.equal(store.claimNextAssignment(worker.id).id, blockedParent.id);
  await store.completeAssignment({ agentId: worker.id, assignmentId: blockedParent.id, message: "Choice unavailable.", status: "blocked" });
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
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const implementer = store.connectAgent({ name: "Implementer", provider: "test", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "test", freshTaskId: task.id });
  const securityReviewer = store.connectAgent({ name: "Security Reviewer", provider: "test", freshTaskId: task.id });
  const fixer = store.connectAgent({ name: "Fixer", provider: "test", freshTaskId: task.id });
  const tester = store.connectAgent({ name: "Tester", provider: "test", freshTaskId: task.id });

  const plan = store.claimNextAssignment(planner.id);
  const implementation = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement", description: "Build the change.", role: "implementer", requiresWrite: true, targetAgentName: "Implementer" });
  const review = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review the implementation.", role: "reviewer", targetAgentName: "Reviewer", dependsOn: [implementation.id] });
  const securityReview = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Security review", description: "Review security.", role: "security-reviewer", targetAgentName: "Security Reviewer", dependsOn: [review.id] });
  const fix = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Fix findings", description: "Apply review findings.", role: "implementer", requiresWrite: true, targetAgentName: "Fixer", dependsOn: [securityReview.id] });
  const testAssignment = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Test", description: "Verify the final change.", role: "tester", targetAgentName: "Tester", dependsOn: [fix.id] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Staged workflow planned." });

  assert.equal(store.claimNextAssignment(implementer.id).id, implementation.id);
  assert.equal(store.claimNextAssignment(reviewer.id), null, "review still waits for its upstream writer");
  await store.completeAssignment({ agentId: implementer.id, assignmentId: implementation.id, message: "Implemented.", changedFiles: ["src/feature.mjs"] });

  assert.equal(store.claimNextAssignment(reviewer.id)?.id, review.id, "review ignores the transitive downstream fixer");
  assert.equal(store.claimNextAssignment(securityReviewer.id), null, "security review waits for review");
  await store.completeAssignment({ agentId: reviewer.id, assignmentId: review.id, message: "Reviewed." });

  assert.equal(store.claimNextAssignment(securityReviewer.id)?.id, securityReview.id, "security review ignores its direct downstream fixer");
  await store.completeAssignment({ agentId: securityReviewer.id, assignmentId: securityReview.id, message: "Security reviewed." });

  assert.equal(store.claimNextAssignment(fixer.id)?.id, fix.id);
  assert.equal(store.claimNextAssignment(tester.id), null, "tester waits for the upstream fixer");
  await store.completeAssignment({ agentId: fixer.id, assignmentId: fix.id, message: "Findings fixed.", changedFiles: ["src/feature.mjs"] });

  assert.equal(store.claimNextAssignment(tester.id)?.id, testAssignment.id);
});

test("an assignment blocker queues triage without stopping sibling work or the task", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-assignment-block-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Assignment blocker", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Parallel work", description: "One item may need triage." });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  const risky = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Risky", description: "May block.", requiresWrite: true, targetAgentName: "Alice", paths: ["src/risky"] });
  const sibling = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Sibling", description: "Must continue.", requiresWrite: true, targetAgentName: "Bob", paths: ["src/sibling"] });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan complete." });
  assert.equal(store.claimNextAssignment(alice.id).id, risky.id);
  assert.equal(store.claimNextAssignment(bob.id).id, sibling.id);

  const outcome = await store.completeAssignment({ agentId: alice.id, assignmentId: risky.id, message: "Needs a human choice.", status: "blocked" });
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

test("a blocked task states its own recovery path everywhere an agent or human can hit it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-blocked-recovery-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Recovery", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Review the limiter", description: "Needs an independent review." });
  const author = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  store.joinTask(reviewer.id, task.id, "contributor");
  store.blockTask({ agentId: author.id, taskId: task.id, reason: "Review was misrouted to its own author." });

  const recovery = store.blockedRecovery(task.id);
  assert.equal(recovery.taskId, task.id);
  assert.equal(recovery.reason, "Review was misrouted to its own author.");
  assert.equal(recovery.blockedBy, "Codex");
  assert.ok(recovery.strandedAssignments >= 1, "the planner assignment the block closed is counted");
  assert.deepEqual(new Set(recovery.resumableBy), new Set(["Codex", "Claude"]));
  assert.match(recovery.humanAction, /Resume/);
  assert.match(recovery.agentAction, /Only the human can resume/);
  assert.match(recovery.agentAction, /do not delete and recreate/i);

  // The dashboard and devteam_state read the same descriptor.
  assert.deepEqual(store.taskDetail(task.id).blockedRecovery, recovery);

  // An idle agent asking why the board is empty is told about the block, not handed an empty list.
  const explained = store.whyNoClaimableWork(reviewer.id);
  assert.equal(explained.queuedCount, 0);
  assert.equal(explained.blockedRooms.length, 1);
  assert.equal(explained.blockedRooms[0].taskId, task.id);
  assert.match(explained.next, /Only the human can resume/);
  assert.equal(store.blockedRoomsForAgent(reviewer.id).length, 1);

  // Every route an agent might take to work around the block names the one move that works.
  assert.throws(
    () => store.createAssignment({ agentId: reviewer.id, taskId: task.id, title: "Replacement review", description: "Route around the block." }),
    /Only the human can resume it.*do not open a duplicate task/s,
  );
  assert.throws(
    () => store.createProposal({ agentId: reviewer.id, taskId: task.id, kind: "plan", summary: "Recreate the task" }),
    /Only the human can resume it/,
  );
  assert.throws(
    () => store.continueTask({ taskId: task.id, message: "carry on" }),
    /Only the human can resume it/,
  );

  // A healthy task carries no recovery block, and closed-for-other-reasons keeps its old wording.
  const other = store.createTask({ projectId: project.id, title: "Healthy", description: "Nothing wrong here." });
  assert.equal(store.blockedRecovery(other.id), null);
  assert.equal(store.taskDetail(other.id).blockedRecovery, null);
  assert.equal(store.closedTaskError({ status: "cancelled", title: "x" }, "continue it"), "Task is already cancelled.");
});

test("resuming a blocked task can address the fresh plan to one named agent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-targeted-resume-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Routing", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Route me back", description: "Review must return to Claude." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  store.joinTask(claude.id, task.id, "contributor");
  store.blockTask({ taskId: task.id, reason: "Claim stuck with the author." });

  assert.throws(
    () => store.unblockTask({ taskId: task.id, reason: "Reopen", targetAgentName: "Claud" }),
    /No agent named "Claud" is known/,
  );
  assert.equal(store.getTask(task.id).status, "blocked", "a bad target must not half-resume the task");

  // Case-insensitive, and the stored target is the agent's canonical name.
  const resumed = store.unblockTask({ taskId: task.id, reason: "Review is done; record closure.", targetAgentName: "claude" });
  assert.equal(resumed.targetAgentName, "Claude");
  const plan = store.taskDetail(task.id).assignments.find((item) => item.id === resumed.assignmentId);
  assert.equal(plan.target_agent_name, "Claude");
  assert.match(plan.description, /addressed to Claude/);

  // The scheduler honours the target: the untargeted agent may not take it, the named one may.
  assert.equal(store.claimNextAssignment(codex.id), null);
  assert.equal(store.claimNextAssignment(claude.id)?.id, resumed.assignmentId);
});

test("human acceptance requires finished review work and is labeled as an override", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-human-accept-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Human acceptance", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Accept me", description: "Human decides.", requiredApprovals: 2 });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  assert.throws(() => store.acceptTaskByHuman({ taskId: task.id, summary: "Too early." }), /ready for review/);
  const plan = store.claimNextAssignment(planner.id);
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planning is complete." });

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
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  const other = store.connectAgent({ name: "Other", provider: "test", freshTaskId: task.id });

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });

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
  const late = store.connectAgent({ name: "Latecomer", provider: "test", freshTaskId: task.id });
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
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  assert.equal(store.teamActivity().busyAgents, 1, "a claimed assignment marks the agent busy");
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Plan done." });
  assert.equal(store.teamActivity().active, false, "with no open work and no busy agent the room is quiet again");
});

test("a role proposal is adopted by team agreement and creates the assignment", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-propose-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Propose project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Negotiate roles", description: "Let the team organise." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  const plan = store.claimNextAssignment(codex.id);
  await store.completeAssignment({ agentId: codex.id, assignmentId: plan.id, message: "Planned." });
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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });

  const proposal = store.createProposal({ agentId: codex.id, taskId: task.id, kind: "decision", summary: "Ship plan A." });
  const erin = store.connectAgent({ name: "Erin", provider: "test", freshTaskId: task.id }); // joins after the proposal was snapshotted

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  const dave = store.connectAgent({ name: "Dave", provider: "test", freshTaskId: task.id });

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
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
  const solo = store.connectAgent({ name: "Solo", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Self review", description: "Review current version.", role: "reviewer", targetAgentName: "Solo" });
  await store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned." });
  const review = store.claimNextAssignment(solo.id);
  await store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed, no changes." });
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
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true, targetAgentName: "Alice" });
  const review = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review the current version.", role: "reviewer" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const build = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: build.id, message: "Implemented.", changedFiles: ["package.json"] });

  // The author is never handed the review of its own version. Refusing this at approval time alone
  // meant Alice claimed the review, read the whole diff, and only then found the one exit was to
  // block the assignment — which is what real sessions did, repeatedly.
  assert.equal(store.claimNextAssignment(alice.id), null, "the author is not handed a review of its own version");
  const aliceChain = store.whyNotClaimable(review.id, alice.id);
  assert.ok(aliceChain.reasons.some((reason) => reason.code === "verifier_is_author" && reason.blocking),
    "and it is told plainly why, instead of finding out after the work is done");
  const bobReview = store.claimNextAssignment(bob.id);
  assert.equal(bobReview.id, review.id, "the independent teammate is handed exactly that review");
  await store.completeAssignment({ agentId: bob.id, assignmentId: bobReview.id, message: "Independent review passed." });

  // Refusing the claim moves the author's stop one gate earlier: it can no longer complete a
  // read-only review of its own version at all, so it now fails for want of review evidence rather
  // than at the self-approval check. That check stays in approveTask as defence in depth for any
  // path that does not come through the queue — it is simply no longer what fires here.
  assert.throws(() => store.approveTask({ agentId: alice.id, taskId: task.id, summary: "I approve my own change." }),
    /Approval requires a completed, read-only reviewer or tester assignment/);
  const outcome = store.approveTask({ agentId: bob.id, taskId: task.id, summary: "Independently reviewed." });
  assert.equal(outcome.accepted, true, "an independent teammate can approve");
  assert.equal(outcome.selfReviewed, false, "and it is not labeled self-reviewed");
});

test("refusing the author a review of its own work never leaves that review unclaimable", async (t) => {
  // The rule is "somebody else could actually take this", not "an independent teammate exists". A
  // teammate who is connected but cannot claim — or who has left — must not hold a review hostage on
  // the board forever. The randomized scheduler suite found exactly this deadlock on seed 18 the
  // first time the rule was written the naive way; this pins the case down where it can be read.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-no-deadend-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Solo again project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Author is left alone", description: "The reviewer goes home.", requiredApprovals: 1 });
  const planner = store.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const alice = store.connectAgent({ name: "Alice", provider: "test", freshTaskId: task.id });
  const bob = store.connectAgent({ name: "Bob", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true, targetAgentName: "Alice" });
  const review = store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review the current version.", role: "reviewer" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });

  const build = store.claimNextAssignment(alice.id);
  await store.completeAssignment({ agentId: alice.id, assignmentId: build.id, message: "Implemented.", changedFiles: ["package.json"] });
  assert.equal(store.claimNextAssignment(alice.id), null, "while Bob is here, Alice may not review her own work");

  store.disconnectAgent(bob.id, "Going home.");
  store.disconnectAgent(planner.id, "Going home.");

  const aliceReview = store.claimNextAssignment(alice.id);
  assert.equal(aliceReview?.id, review.id, "with nobody else able to take it, the review is handed back rather than stranded");
  await store.completeAssignment({ agentId: alice.id, assignmentId: aliceReview.id, message: "Self review, honestly labeled." });
  const outcome = store.approveTask({ agentId: alice.id, taskId: task.id, summary: "Solo run." });
  assert.equal(outcome.accepted, true, "a genuine solo run still finishes");
  assert.equal(outcome.selfReviewed, true, "and it is labeled selfReviewed rather than passed off as consensus");
});

test("a disconnected historical teammate cannot dead-end the remaining solo author", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-now-solo-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Now-solo project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Finish after teammate leaves", description: "Current availability controls approvals.", requiredApprovals: 2 });
  const former = store.connectAgent({ name: "Former teammate", provider: "test", freshTaskId: task.id });
  const solo = store.connectAgent({ name: "Remaining author", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(former.id);
  store.createAssignment({ agentId: former.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true, targetAgentName: solo.name });
  store.createAssignment({ agentId: former.id, taskId: task.id, title: "Review", description: "Review the current version.", role: "reviewer", targetAgentName: solo.name });
  await store.completeAssignment({ agentId: former.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.disconnectAgent(former.id, "Left the task.");

  const build = store.claimNextAssignment(solo.id);
  await store.completeAssignment({ agentId: solo.id, assignmentId: build.id, claimToken: build.claimToken, message: "Built.", changedFiles: ["package.json"] });
  const review = store.claimNextAssignment(solo.id);
  await store.completeAssignment({ agentId: solo.id, assignmentId: review.id, claimToken: review.claimToken, message: "Self-reviewed." });
  const outcome = store.approveTask({ agentId: solo.id, taskId: task.id, summary: "No independent teammate remains connected." });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.requiredApprovals, 1);
  assert.equal(outcome.selfReviewed, true);
});

test("checkpoint successors share one approval lineage and cannot manufacture consensus", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-lineage-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Lineage project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Rotate one session", description: "A fresh session is not a fresh reviewer.", requiredApprovals: 2 });
  const oldSession = store.connectAgent({ name: "Rotating agent", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(oldSession.id);
  store.createAssignment({ agentId: oldSession.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true, targetAgentName: oldSession.name });
  store.createAssignment({ agentId: oldSession.id, taskId: task.id, title: "First review", description: "Review before rotation.", role: "reviewer", targetAgentName: oldSession.name });
  store.createAssignment({ agentId: oldSession.id, taskId: task.id, title: "Fresh-session review", description: "Review after rotation.", role: "reviewer", targetAgentName: "Fresh rotating agent" });
  await store.completeAssignment({ agentId: oldSession.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const build = store.claimNextAssignment(oldSession.id);
  await store.completeAssignment({ agentId: oldSession.id, assignmentId: build.id, claimToken: build.claimToken, message: "Built.", changedFiles: ["package.json"] });
  const firstReview = store.claimNextAssignment(oldSession.id);
  await store.completeAssignment({ agentId: oldSession.id, assignmentId: firstReview.id, claimToken: firstReview.claimToken, message: "Reviewed before rotation." });
  const beforeRotation = store.approveTask({ agentId: oldSession.id, taskId: task.id, summary: "Self-review before rotating." });
  assert.equal(beforeRotation.accepted, false, "the queued successor review keeps the task open");

  const checkpoint = await store.createSessionCheckpoint({ agentId: oldSession.id, taskId: task.id, nextAction: "Complete the queued review." });
  const freshSession = store.connectAgent({ name: "Fresh rotating agent", provider: "test", freshTaskId: task.id });
  await store.takeoverSessionCheckpoint({
    agentId: freshSession.id,
    taskId: task.id,
    checkpointId: checkpoint.checkpoint.id,
    handoffToken: checkpoint.handoffToken,
  });
  const freshReview = store.claimNextAssignment(freshSession.id);
  await store.completeAssignment({ agentId: freshSession.id, assignmentId: freshReview.id, claimToken: freshReview.claimToken, message: "Reviewed after rotation." });
  const outcome = store.approveTask({ agentId: freshSession.id, taskId: task.id, summary: "Same participant, fresh session." });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.approvalCount, 1, "predecessor and successor approvals collapse to one lineage");
  assert.equal(outcome.requiredApprovals, 1);
  assert.equal(outcome.selfReviewed, true, "the acceptance is not mislabeled as independent consensus");
});

test("a solo acceptance is labeled selfReviewed; changed files that aren't on disk are flagged", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-selfreview-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Self review project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Solo but honest", description: "Label the lack of independent review.", requiredApprovals: 2 });
  const solo = store.connectAgent({ name: "Solo", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Self review", description: "Review current version.", role: "reviewer", targetAgentName: "Solo" });
  const done = await store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned.", changedFiles: ["package.json", "does/not/exist.js"] });
  assert.equal(done.completed, true);
  const completedEvent = store.taskDetail(task.id).events.find((e) => e.type === "assignment.completed");
  assert.deepEqual(completedEvent.metadata.unverifiedFiles, ["does/not/exist.js"], "a real file passes; a missing one is flagged, without blocking the report");

  const review = store.claimNextAssignment(solo.id);
  await store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed." });
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
  const agent = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });

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
  const agent = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: firstTask.id });
  const first = store.noteSet({ agentId: codex.id, taskId: firstTask.id, scope: "project", key: "conventions", value: "Use SQLite." });
  assert.equal(first.scope, "project");
  assert.equal(first.version, 1);

  const secondTask = store.createTask({ projectId: project.id, title: "Second task", description: "Read project memory." });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: secondTask.id });
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
  const agent = store.connectAgent({ name: "Codex", provider: "test", freshTaskId: task.id });
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
  const planner = firstStore.connectAgent({ name: "Planner", provider: "test", freshTaskId: task.id });
  const plan = firstStore.claimNextAssignment(planner.id);
  firstStore.createAssignment({ agentId: planner.id, taskId: task.id, title: "Implement", description: "Pending implementation.", requiresWrite: true });
  await firstStore.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Plan complete." });
  firstStore.db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(task.id);
  firstStore.close();

  const reopened = new DevTeamStore(dataDir);
  assert.equal(reopened.getTask(task.id).status, "active");
  reopened.close();
});

test("a targeted assignment invites an agent into a task room it never joined", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-invite-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const projectA = store.ensureProject("Project A", process.cwd());
  const projectB = store.ensureProject("Project B", path.join(os.tmpdir(), "devteam-invite-b"));
  store.createTask({ projectId: projectA.id, title: "Task A", description: "Work A." });
  const taskB = store.createTask({ projectId: projectB.id, title: "Task B", description: "Work B." });
  const claude = store.connectAgent({ name: "Claude", provider: "test" });
  const bob = store.connectAgent({ name: "Bob", provider: "test" });

  // Neither agent joined anything, so neither has a room: nothing is claimable.
  assert.equal(store.claimNextAssignment(claude.id), null, "no invitation, no room, no claim");

  // The human (control plane) targets a Task B assignment at Claude — an explicit invitation.
  const invited = store.createAssignment({ taskId: taskB.id, title: "Do B", description: "Implement B.", targetAgentName: "Claude" });
  const claimed = store.claimNextAssignment(claude.id);
  assert.equal(claimed && claimed.id, invited.id, "the invited agent claims the targeted work across rooms");
  assert.equal(claimed.task_id, taskB.id);
  assert.equal(store.taskDetail(taskB.id).members.some((m) => m.agent_name === "Claude"), true, "the invitation auto-joined the room");

  // Untargeted work (Task B's own planner assignment) is not reachable by an uninvited agent.
  assert.equal(store.claimNextAssignment(bob.id), null, "an uninvited agent that joined no room still cannot claim");
});

test("a plain reconnect replays messages missed while the agent was disconnected", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-reconnect-replay-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Reconnect project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Stay in sync", description: "Do not lose messages." });
  const first = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  store.deliverDirectedMessages(first.id); // drain anything already waiting
  store.disconnectAgent(first.id, "Desktop closed.");

  // The human keeps talking to the (now absent) agent.
  store.humanMessage(task.id, "Please pick this up when you return.", "all");

  // A fresh session for the same identity reconnects — no resume token, a plain devteam_join.
  const second = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  const inbox = store.deliverDirectedMessages(second.id);
  assert.ok(inbox.some((m) => /pick this up/.test(m.message)), "the message sent while away replays on a plain reconnect");
});

test("an open unanimity vote reports only the voters still able to decide it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-needed-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Needed project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Count the voters", description: "Honest requirements." });
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  const dave = store.connectAgent({ name: "Dave", provider: "test", freshTaskId: task.id });
  const erin = store.connectAgent({ name: "Erin", provider: "test", freshTaskId: task.id });

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
  const solo = store.connectAgent({ name: "Solo", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Review", description: "Review v1.", role: "reviewer", targetAgentName: "Solo" });
  await store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned." });
  const review = store.claimNextAssignment(solo.id);
  await store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed." });
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
  const solo = store.connectAgent({ name: "Solo", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(solo.id);
  store.createAssignment({ agentId: solo.id, taskId: task.id, title: "Review", description: "Review.", role: "reviewer", targetAgentName: "Solo" });
  await store.completeAssignment({ agentId: solo.id, assignmentId: plan.id, message: "Planned." });
  const review = store.claimNextAssignment(solo.id);
  await store.completeAssignment({ agentId: solo.id, assignmentId: review.id, message: "Reviewed." });
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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });

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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
  const claude = store.connectAgent({ name: "Claude", provider: "Anthropic", freshTaskId: task.id });
  const dave = store.connectAgent({ name: "Dave", provider: "test", freshTaskId: task.id });
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
  store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id }); // a teammate is present in the room
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
  const codex = store.connectAgent({ name: "Codex", provider: "OpenAI", freshTaskId: task.id });
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
  const planner = store.connectAgent({ name: "Planner", provider: "Codex", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "Claude", freshTaskId: task.id });
  store.connectAgent({ name: "Second reviewer", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(planner.id);
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Write", description: "Change a file.", role: "implementer", requiresWrite: true, targetAgentName: "Planner" });
  store.createAssignment({ agentId: planner.id, taskId: task.id, title: "Review", description: "Review.", role: "reviewer", targetAgentName: "Reviewer" });
  await store.completeAssignment({ agentId: planner.id, assignmentId: plan.id, message: "Planned." });
  const write = store.claimNextAssignment(planner.id);
  await store.completeAssignment({ agentId: planner.id, assignmentId: write.id, message: "Wrote it.", changedFiles: ["src/x.js"] });
  const review = store.claimNextAssignment(reviewer.id);
  await store.completeAssignment({ agentId: reviewer.id, assignmentId: review.id, message: "Reviewed." });
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

  const live = store.connectAgent({ name: "Live", provider: "Claude", freshTaskId: task.id });
  assert.throws(() => store.forgetAgent(live.id), /still connected/, "a connected agent is protected from removal");

  const writer = store.connectAgent({ name: "Writer", provider: "Codex", freshTaskId: task.id });
  const plan = store.claimNextAssignment(writer.id);
  store.createAssignment({ agentId: writer.id, taskId: task.id, title: "Edit core", description: "Change files.", role: "implementer", requiresWrite: true, targetAgentName: "Writer" });
  await store.completeAssignment({ agentId: writer.id, assignmentId: plan.id, message: "Planned." });
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

  const writer = store.connectAgent({ name: "Writer", provider: "Codex", freshTaskId: task.id });
  const idler = store.connectAgent({ name: "Idler", provider: "Claude", freshTaskId: task.id });
  const plan = store.claimNextAssignment(writer.id);
  store.createAssignment({ agentId: writer.id, taskId: task.id, title: "Edit core", description: "Change files.", role: "implementer", requiresWrite: true, targetAgentName: "Writer" });
  await store.completeAssignment({ agentId: writer.id, assignmentId: plan.id, message: "Planned." });
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

test("workspaceSearch spans tasks, timeline messages, assignments, and knowledge safely", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-workspace-search-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true } });
  // A real directory of its own, never process.cwd(): a knowledge-enabled store exports a vault into
  // its project root, and pointing one at the repository is what deleted this project's own notes.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-search-project-"));
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Search project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Searchable nebula task", description: "Investigate a quartz boundary." });
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-search-other-"));
  t.after(async () => { await rm(otherRoot, { recursive: true, force: true }); });
  const otherProject = store.ensureProject("Other search project", otherRoot);
  store.humanMessage(task.id, "Timeline contains the cobalt phrase.", "all");
  store.createAssignment({ taskId: task.id, title: "Inspect vermilion module", description: "Search assignment coverage." });
  const stamp = new Date().toISOString();
  store.db.prepare(`INSERT INTO knowledge_notes
    (id, project_id, category, slug, title, body, status, confidence, source_task_id, related_files, provenance, created_at, updated_at)
    VALUES (?, ?, 'decisions', 'indigo-search', 'Indigo architecture decision', 'Knowledge contains an indigo phrase.', 'verified', 'high', ?, '[]', '{}', ?, ?)`)
    .run("indigo-search-note", project.id, task.id, stamp, stamp);

  assert.ok(store.workspaceSearch("nebula").some((result) => result.kind === "task" && result.task_id === task.id));
  assert.ok(store.workspaceSearch("cobalt").some((result) => result.kind === "event" && result.task_id === task.id));
  assert.ok(store.workspaceSearch("vermilion").some((result) => result.kind === "assignment" && result.task_id === task.id));
  assert.ok(store.workspaceSearch("indigo").some((result) => result.kind === "knowledge" && result.task_id === task.id));
  assert.equal(store.workspaceSearch("nebula", { projectId: otherProject.id }).length, 0, "project-scoped search cannot cross into another project");
  assert.deepEqual(store.workspaceSearch("x"), [], "one-character scans are rejected");
  assert.doesNotThrow(() => store.workspaceSearch("%' OR 1=1 --"), "search text stays parameterized and escaped");
});

// Shared scaffolding for the scheduler regressions below: a store, a project, a task whose planner
// assignment is already closed, and one connected agent.
async function schedulerFixture(t, { knowledge = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-sched-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-sched-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: knowledge }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Scheduler project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Scheduler", description: "Exercise claim scheduling." });
  const agent = store.connectAgent({ name: "Worker", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return { store, project, task, agent };
}

test("a verifier that declares write access is not treated as the writer it waits for", async (t) => {
  const { store, task, agent } = await schedulerFixture(t);
  const writingTester = store.createAssignment({
    taskId: task.id,
    title: "Write regression tests",
    description: "Add coverage.",
    role: "tester",
    requiresWrite: true,
    paths: ["test/**"],
  });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim?.id, writingTester.id, "a write-requiring tester must not block itself out of every scan");
  await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Tests written." });
  // The real rule still holds: a verifier waits for a genuinely separate pending writer.
  store.createAssignment({
    taskId: task.id, title: "Ship the feature", description: "Edit source.",
    role: "implementer", requiresWrite: true, paths: ["src/**"],
  });
  const secondTester = store.createAssignment({
    taskId: task.id, title: "Verify the feature", description: "Check it.",
    role: "tester", requiresWrite: true, paths: ["test/**"],
  });
  const next = store.claimNextAssignment(agent.id);
  assert.notEqual(next?.id, secondTester.id, "a verifier still waits for an unrelated queued writer");
});

test("an agent that goes quiet while holding a claim still counts as working", async (t) => {
  const { store, task, agent } = await schedulerFixture(t);
  store.createAssignment({
    taskId: task.id, title: "Long implementation", description: "Edit source for a while.",
    role: "implementer", requiresWrite: true, paths: ["src/**"],
  });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(store.teamActivity([task.id]).busyAgents, 1);
  assert.equal(store.teamActivity([task.id]).workingAgents, 1);
  // Editing files produces no MCP calls, so the liveness sweep marks the session unresponsive
  // while it still owns the claim and the write lease.
  store.db.prepare("UPDATE agents SET status = 'unresponsive' WHERE id = ?").run(agent.id);
  const activity = store.teamActivity([task.id]);
  assert.equal(activity.busyAgents, 0, "responsiveness is reported honestly");
  assert.equal(activity.workingAgents, 1, "but a claim holder is still reported as working");
  assert.equal(activity.active, true);
  await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done." });
  assert.equal(store.teamActivity([task.id]).workingAgents, 0, "the count clears once the claim is released");
});

test("purging an agent removes it from the roster without rewriting who spoke", async (t) => {
  const { store, task, agent } = await schedulerFixture(t);
  store.postMessage({ agentId: agent.id, taskId: task.id, message: "Agent said this." });
  store.humanMessage(task.id, "Human said this.");
  const authored = () => store.taskDetail(task.id).events.filter((event) => event.message === "Agent said this.")[0];
  assert.equal(authored().author_kind, "agent", "authorship is recorded when the event is written");
  assert.equal(authored().author_name, "Worker");

  // The liveness sweep purges a long-gone agent; its foreign key is cleared, but the transcript
  // must still attribute the message to the agent that wrote it.
  store.disconnectAgent(agent.id, "done");
  store.forgetAgent(agent.id, { force: true });
  const afterPurge = authored();
  assert.equal(afterPurge.agent_id, null, "the roster row is gone");
  assert.equal(afterPurge.author_kind, "agent", "a purged agent's message is still an agent's message");
  assert.equal(afterPurge.author_name, "Worker", "the original author name survives the purge");
  const humanEvent = store.taskDetail(task.id).events.find((event) => event.message === "Human said this.");
  assert.equal(humanEvent.author_kind, "human", "human messages stay human");
});

test("targeting routes work to a teammate without outliving them", async (t) => {
  const { store, task, agent } = await schedulerFixture(t);
  const other = store.connectAgent({ name: "Other", provider: "fixture", freshTaskId: task.id });
  store.joinTask(other.id, task.id, "contributor");
  const targeted = store.createAssignment({
    taskId: task.id, title: "Work for Worker", description: "Targeted work.",
    role: "implementer", targetAgentName: "Worker",
  });
  // While the target is connected, targeting is exclusive — nobody else may take it.
  assert.equal(store.claimNextAssignment(other.id), null, "a live target keeps its exclusive hold");
  // Once the target is gone, the item must return to the general queue rather than stranding.
  store.disconnectAgent(agent.id, "left");
  const claim = store.claimNextAssignment(other.id);
  assert.equal(claim?.id, targeted.id, "work addressed to an absent agent is claimable by the room");
});

test("a queued assignment explains why the scheduler is holding it back", async (t) => {
  const { store, task } = await schedulerFixture(t);
  store.createAssignment({
    taskId: task.id, title: "Ship the feature", description: "Edit source.",
    role: "implementer", requiresWrite: true, paths: ["src/**"],
  });
  const reviewer = store.createAssignment({
    taskId: task.id, title: "Review it", description: "Read the diff.", role: "reviewer",
  });
  const ghosted = store.createAssignment({
    taskId: task.id, title: "Work for a ghost", description: "Targeted work.",
    role: "implementer", targetAgentName: "NobodyHere",
  });
  const detail = store.taskDetail(task.id);
  const held = detail.assignments.find((item) => item.id === reviewer.id);
  assert.equal(held.blockedBy.length, 0, "it has no dependency blockers");
  assert.equal(held.schedulingHold?.reason, "awaiting_writer", "yet the stall is explained rather than invisible");
  assert.match(held.schedulingHold.detail, /Ship the feature/);
  const absent = detail.assignments.find((item) => item.id === ghosted.id);
  assert.equal(absent.schedulingHold?.reason, "target_absent");
});

// --- T2.2: rework loops instead of blunt blocking -----------------------------------------------

// One writer, one reviewer, one completed piece of work on the current version, and a reviewer that
// has earned standing on it. This is the state every rework test starts from.
async function reviewFixture(t, { requiredApprovals = 1 } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-rework-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
  });
  const project = store.ensureProject("Rework project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Ship it well", description: "Write it, then review it.", requiredApprovals });
  const author = store.connectAgent({ name: "Author", provider: "test", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "test", freshTaskId: task.id });

  const plan = store.claimNextAssignment(author.id);
  const work = store.createAssignment({
    agentId: author.id, taskId: task.id, title: "Implement the feature", description: "Write it.",
    role: "implementer", requiresWrite: true, paths: ["src/feature.mjs"],
  });
  const review = store.createAssignment({
    agentId: author.id, taskId: task.id, title: "Review the feature", description: "Read the diff.", role: "reviewer",
  });
  await store.completeAssignment({ agentId: author.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  const workClaim = store.claimNextAssignment(author.id);
  assert.equal(workClaim.id, work.id);
  await store.completeAssignment({
    agentId: author.id, assignmentId: work.id, claimToken: workClaim.claimToken,
    message: "Implemented the feature.", changedFiles: ["src/feature.mjs"],
  });
  const reviewClaim = store.claimNextAssignment(reviewer.id);
  assert.equal(reviewClaim.id, review.id, "the reviewer picks up the review once the writer is done");
  return { store, project, task, author, reviewer, work, review, reviewClaim };
}

test("a reviewer sends work back to its author instead of approving it or blocking the task", async (t) => {
  const { store, task, author, reviewer, work, review, reviewClaim } = await reviewFixture(t);

  const sentBack = store.requestChanges({
    agentId: reviewer.id, taskId: task.id, assignmentId: work.id,
    summary: "The error path is untested and swallows the cause.",
    findings: [
      { detail: "rethrow with the original cause attached", path: "src/feature.mjs" },
      "add a test for the failure branch",
    ],
  });
  assert.equal(sentBack.changesRequested, true);
  assert.equal(sentBack.routedTo, "Author", "it goes back to whoever wrote it");
  assert.equal(sentBack.reworkCount, 1);
  assert.equal(sentBack.findings.length, 2);

  // The task keeps running: nobody was disconnected and the reviewer still holds its own claim.
  assert.notEqual(store.getTask(task.id).status, "blocked");
  assert.equal(store.db.prepare("SELECT status FROM assignments WHERE id = ?").get(review.id).status, "claimed");
  assert.equal(store.getAgent(reviewer.id).status, "busy");

  // The original row is reopened rather than replaced, so its history stays with the work.
  const row = store.db.prepare("SELECT * FROM assignments WHERE id = ?").get(work.id);
  assert.equal(row.status, "queued");
  assert.equal(row.agent_id, null);
  assert.equal(row.completed_at, null);
  assert.equal(row.target_agent_name, "Author");
  assert.equal(row.rework_count, 1);
  assert.ok(row.rework_requested_at);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ?").get(task.id).count,
    3, "no near-duplicate follow-up assignment is created");
  const detail = store.taskDetail(task.id);
  assert.ok(detail.events.some((event) => event.type === "assignment.completed" && event.metadata?.assignmentId === work.id),
    "the original completion stays on the timeline");
  assert.ok(detail.events.some((event) => event.type === "assignment.changes_requested"));

  // The author re-claims it and is handed exactly what to fix.
  const reclaim = store.claimNextAssignment(author.id);
  assert.equal(reclaim.id, work.id);
  assert.equal(reclaim.rework.count, 1);
  assert.deepEqual(reclaim.rework.findings.map((finding) => finding.detail).sort(),
    ["add a test for the failure branch", "rethrow with the original cause attached"]);
  assert.equal(reclaim.rework.findings.find((finding) => finding.path)?.path, "src/feature.mjs");
  assert.deepEqual(reclaim.writeScope, workClaimScope(store, work.id), "the reopened work keeps its write scope");

  // Reporting again resolves the findings, and the next claim is clean.
  await store.completeAssignment({
    agentId: author.id, assignmentId: work.id, claimToken: reclaim.claimToken,
    message: "Rethrew with the cause and covered the failure branch.", changedFiles: ["src/feature.mjs"],
  });
  assert.equal(store.taskDetail(task.id).assignments.find((item) => item.id === work.id).findings.length, 0,
    "the findings stop being outstanding once the rework is reported");
  assert.equal(store.taskDetail(task.id).assignments.find((item) => item.id === work.id).resolvedFindings.length, 2,
    "but they stay on the record, so the next reviewer can see what this went back for");
});

function workClaimScope(store, assignmentId) {
  return store.taskDetail(store.db.prepare("SELECT task_id FROM assignments WHERE id = ?").get(assignmentId).task_id)
    .assignments.find((item) => item.id === assignmentId).writeScope;
}

test("sending work back clears approvals built on the version that was judged not good enough", async (t) => {
  const { store, task, reviewer, work } = await reviewFixture(t, { requiredApprovals: 1 });
  const version = store.getTask(task.id).version;
  // A second reviewer had already approved this version.
  const second = store.connectAgent({ name: "Second reviewer", provider: "test", freshTaskId: task.id });
  store.createAssignment({ taskId: task.id, title: "Second look", description: "Read it too.", role: "reviewer", targetAgentName: "Second reviewer" });
  const secondClaim = store.claimNextAssignment(second.id);
  await store.completeAssignment({ agentId: second.id, assignmentId: secondClaim.id, claimToken: secondClaim.claimToken, message: "Looks fine to me." });
  store.approveTask({ agentId: second.id, taskId: task.id, summary: "Approved." });
  assert.equal(store.taskDetail(task.id).approvals.length, 1);

  const sentBack = store.requestChanges({
    agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "Not yet.",
  });
  assert.equal(sentBack.clearedApprovals, 1);
  assert.equal(store.taskDetail(task.id).approvals.length, 0,
    "an approval cannot survive a reviewer saying the same version needs changes");
  assert.equal(store.getTask(task.id).version, version, "and sending back does not itself advance the version");
});

test("only a completed assignment can be sent back, and only by someone with review standing", async (t) => {
  const { store, task, author, reviewer, work, review } = await reviewFixture(t);
  const outsiderTask = store.createTask({ projectId: store.listProjects()[0].id, title: "Elsewhere", description: "Another room." });
  const outsider = store.connectAgent({ name: "Outsider", provider: "test", freshTaskId: outsiderTask.id });

  assert.throws(() => store.requestChanges({
    agentId: outsider.id, taskId: task.id, assignmentId: work.id, summary: "Not mine to judge.",
  }), /not a member/i, "a non-member cannot reach into the room to bounce its work");

  assert.throws(() => store.requestChanges({
    agentId: author.id, taskId: task.id, assignmentId: work.id, summary: "I have not reviewed anything.",
  }), /reviewer or tester/i, "review standing is earned the same way the right to approve is");

  assert.throws(() => store.requestChanges({
    agentId: reviewer.id, taskId: task.id, assignmentId: review.id, summary: "Sending back the open review.",
  }), /Only completed work/i, "work that is not finished has nothing to send back");

  assert.throws(() => store.requestChanges({
    agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "   ",
  }), /what needs to change/i, "a reason is not optional");
});

test("rework survives its author leaving, and counts how many times it has gone back", async (t) => {
  const { store, task, author, reviewer, work } = await reviewFixture(t);
  store.requestChanges({ agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "First pass back." });

  // Targeting is a preference, not a lock. Once nobody by that name is present, the existing
  // absent-target rule returns the item to the room rather than leaving it claimable by nobody.
  store.disconnectAgent(author.id, "Desktop closed.");
  const standIn = store.connectAgent({ name: "Stand-in", provider: "test", freshTaskId: task.id });
  const picked = store.claimNextAssignment(standIn.id);
  assert.equal(picked.id, work.id, "rework does not become unclaimable because its author went home");
  assert.equal(picked.rework.count, 1);
  await store.completeAssignment({
    agentId: standIn.id, assignmentId: work.id, claimToken: picked.claimToken,
    message: "Picked up the rework.", changedFiles: ["src/feature.mjs"],
  });

  // A second pass back records that this is the second time, so a loop is visible rather than silent.
  const again = store.requestChanges({ agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "Still not right." });
  assert.equal(again.reworkCount, 2);
  assert.equal(again.routedTo, "Stand-in", "it goes back to whoever wrote the version being reviewed");
});

test("a late report from the session that was sent back is fenced, not applied over the rework", async (t) => {
  const { store, task, author, reviewer, work } = await reviewFixture(t);
  const generationBefore = store.db.prepare("SELECT claim_generation FROM assignments WHERE id = ?").get(work.id).claim_generation;
  store.requestChanges({ agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "Send it back." });
  assert.equal(store.db.prepare("SELECT claim_token_hash FROM assignments WHERE id = ?").get(work.id).claim_token_hash, null,
    "reopening drops the fencing token exactly as a force-release does");
  const reclaim = store.claimNextAssignment(author.id);
  assert.equal(reclaim.claimGeneration, generationBefore + 1, "and the re-claim is what advances the generation");
  assert.equal(reclaim.rework.summary, "Send it back.", "the author is told why even with no itemised findings");
  const stale = await store.completeAssignment({
    agentId: author.id, assignmentId: work.id, claimToken: "the-previous-sessions-token",
    message: "Reported from the old session.",
  });
  assert.equal(stale.completed, false);
  assert.ok(stale.claimConflict);
});

test("the human can send work back from the dashboard without a review assignment of its own", async (t) => {
  const { store, task, work } = await reviewFixture(t);
  const sentBack = store.requestChanges({
    taskId: task.id, assignmentId: work.id, summary: "I want this done differently.",
    findings: ["use the existing helper instead of a new one"],
  });
  assert.equal(sentBack.changesRequested, true);
  assert.equal(sentBack.findings.length, 1);
  assert.equal(store.taskDetail(task.id).assignments.find((item) => item.id === work.id).findings[0].requested_by_name, "the human");
});

// --- T2.6: human steering mid-flight --------------------------------------------------------------

test("a human can re-prioritise the queue without letting priority skip a real gate", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-priority-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Priority project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Order the work", description: "Some of it matters more." });
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  const first = store.createAssignment({ taskId: task.id, title: "Ordinary work", description: "Do it.", role: "implementer" });
  const urgent = store.createAssignment({ taskId: task.id, title: "The urgent thing", description: "Do it first.", role: "implementer" });
  const gated = store.createAssignment({ taskId: task.id, title: "Blocked on the first", description: "Later.", role: "implementer", dependsOn: [first.id] });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });

  // Without priority, creation order decides.
  assert.equal(store.whyNotClaimable(urgent.id, agent.id).claimable, true);
  store.prioritizeAssignment({ taskId: task.id, assignmentId: urgent.id, priority: 10 });
  assert.equal(store.claimNextAssignment(agent.id).id, urgent.id, "the prioritised item is handed out first");

  // Priority cannot make gated work claimable: a dependency is not a preference.
  store.prioritizeAssignment({ taskId: task.id, assignmentId: gated.id, priority: 100 });
  const held = store.whyNotClaimable(gated.id, agent.id);
  assert.equal(held.claimable, false);
  assert.ok(held.reasons.some((reason) => reason.code === "dependency_pending"),
    "wanting something sooner is not a reason to skip its prerequisite");
  assert.throws(() => store.prioritizeAssignment({ taskId: task.id, assignmentId: "missing", priority: 1 }), /not found/i);
});

test("a cancel request reaches a working agent and asks rather than kills", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-cancel-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Cancel project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Stop it", description: "Changed my mind." });
  const agent = store.connectAgent({ name: "Worker", provider: "test", freshTaskId: task.id });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(store.steeringFor(agent.id), null, "nothing to say while all is well");

  const cancelled = store.requestCancel({ taskId: task.id, assignmentId: claim.id, reason: "We are shipping without this." });
  assert.equal(cancelled.cancelRequested, true);

  const steering = store.steeringFor(agent.id);
  assert.equal(steering.cancelRequested, true);
  assert.match(steering.reason, /shipping without this/);
  assert.match(steering.next, /report what you have/i);

  // The claim is untouched: a half-written tree is exactly what killing a writer produces.
  const row = store.db.prepare("SELECT status, agent_id FROM assignments WHERE id = ?").get(claim.id);
  assert.equal(row.status, "claimed");
  assert.equal(row.agent_id, agent.id);
  // The agent complies by reporting, which is the normal path and needs no special handling.
  const reported = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    status: "blocked", message: "Stopped as asked; the outline is half done.",
  });
  assert.equal(reported.completed, true);

  assert.throws(() => store.requestCancel({ taskId: task.id, assignmentId: claim.id }), /actually doing/i,
    "queued work is not cancelled, it is deleted or re-prioritised");
});

// --- T4.3: what happened --------------------------------------------------------------------------

test("a task replays as a narrative that reports what happened without re-grading it", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-replay-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Replay project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Ship the parser", description: "Write it and review it.", requiredApprovals: 1 });
  const author = store.connectAgent({ name: "Author", provider: "test", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: "Reviewer", provider: "test", freshTaskId: task.id });

  const plan = store.claimNextAssignment(author.id);
  const work = store.createAssignment({ agentId: author.id, taskId: task.id, title: "Write the parser", description: "Write it.", role: "implementer", requiresWrite: true, paths: ["src/parser.mjs"] });
  store.createAssignment({ agentId: author.id, taskId: task.id, title: "Review the parser", description: "Read it.", role: "reviewer" });
  await store.completeAssignment({ agentId: author.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const workClaim = store.claimNextAssignment(author.id);
  await store.completeAssignment({
    agentId: author.id, assignmentId: work.id, claimToken: workClaim.claimToken,
    message: "Wrote it.\nHandles the nested case.", changedFiles: ["src/parser.mjs"],
    checks: ["I ran it by hand"],
  });
  const reviewClaim = store.claimNextAssignment(reviewer.id);
  await store.completeAssignment({ agentId: reviewer.id, assignmentId: reviewClaim.id, claimToken: reviewClaim.claimToken, message: "Read it closely." });
  store.requestChanges({ agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "Nested case is wrong.", findings: ["handle depth > 2"] });

  const replay = store.taskReplay(task.id);
  assert.match(replay.markdown, /^# Ship the parser/m);
  assert.match(replay.markdown, /\*\*Status:\*\*/);
  assert.match(replay.markdown, /### Version 2/, "a version bump is the spine of the story");
  assert.match(replay.markdown, /Author.*assignment\.completed.*Wrote it/);
  assert.match(replay.markdown, /> Handles the nested case\./, "a report's own prose is kept");
  assert.match(replay.markdown, /changed `src\/parser\.mjs`/);
  assert.match(replay.markdown, /I ran it by hand.*asserted, not run/,
    "an asserted check still reads as asserted — the replay reports, it does not re-grade");
  assert.match(replay.markdown, /changes_requested.*Nested case is wrong/);
  assert.match(replay.markdown, /## Where it stands/);
  assert.ok(replay.events > 5);
  assert.throws(() => store.taskReplay("00000000-0000-4000-8000-000000000000"), /Task not found/);
});

// --- T2.1: work decomposition ---------------------------------------------------------------------

async function splitFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-split-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Split project", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Big job", description: "Bigger than it looked." });
  const agent = store.connectAgent({ name: "Splitter", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  const big = store.createAssignment({
    taskId: task.id, title: "Rewrite the importer", description: "All of it.",
    role: "implementer", requiresWrite: true, paths: ["src/import"],
  });
  const claim = store.claimNextAssignment(agent.id);
  assert.equal(claim.id, big.id);
  return { store, project, task, agent, big, claim };
}

test("a finished task cannot be closed by blocking it", async (t) => {
  // Six task.blocked events on the live board read "Done", "done", "because all work is done".
  // Blocking stands every teammate down and only the human can undo it, so a task closed that way
  // has to be reopened purely to be accepted. The kind is what separates the meanings.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-block-kind-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Block kinds", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Everything is finished", description: "Nothing is open." });
  const agent = store.connectAgent({ name: "Claude", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned and finished." });

  assert.throws(() => store.blockTask({ agentId: agent.id, taskId: task.id, reason: "Done", kind: "over-my-head" }),
    /Finishing is not blocking/);
  assert.throws(() => store.blockTask({ agentId: agent.id, taskId: task.id, reason: "done", kind: "external" }),
    /no work in flight/);
  assert.throws(() => store.blockTask({ agentId: agent.id, taskId: task.id, reason: "done", kind: "finished" }),
    /is not a kind of blocker/);
  assert.equal(store.getTask(task.id).status, "review", "and none of those refusals closed the task");

  // Genuine escalation is still allowed on an empty board: needing the human is not a claim that
  // work is in flight.
  const blocked = store.blockTask({ agentId: agent.id, taskId: task.id, reason: "Only you can approve the spend.", kind: "needs-human" });
  assert.equal(blocked.kind, "needs-human");
  assert.equal(store.blockedRecovery(task.id).kind, "needs-human", "the kind reaches the recovery banner the human reads");
});

test("a blocker on work in flight records which kind it was", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-block-inflight-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Block in flight", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Work is open", description: "Something is queued." });
  const agent = store.connectAgent({ name: "Claude", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned." });

  const blocked = store.blockTask({ agentId: agent.id, taskId: task.id, reason: "This needs a frontier model to do safely.", kind: "over-my-head" });
  assert.equal(blocked.kind, "over-my-head");
  const recovery = store.blockedRecovery(task.id);
  assert.equal(recovery.kind, "over-my-head");
  assert.equal(recovery.strandedAssignments, 1, "the open work is stranded and counted, as before");
});

test("a task blocked to mean “finished” can be closed without replanning it", async (t) => {
  // Six task.blocked events on the live board read "Done", "done", "because all work is done".
  // Accepting was refused for anything blocked, so closing already-finished work meant Resume —
  // version bumped, approvals cleared, a fresh planning assignment queued — to replan work that was
  // already done. Twenty tasks sat blocked with three resumes ever recorded.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-accept-blocked-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Accept blocked", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Everything shipped", description: "Nothing left open." });
  const agent = store.connectAgent({ name: "Claude", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned and delivered." });
  store.blockTask({ agentId: agent.id, taskId: task.id, reason: "Needs your sign-off before I close it.", kind: "needs-human" });
  assert.equal(store.getTask(task.id).status, "blocked");

  const accepted = store.acceptTaskByHuman({ taskId: task.id, summary: "Checked it; this was finished." });
  assert.equal(accepted.accepted, true);
  assert.equal(store.getTask(task.id).status, "accepted", "closed in place — same task, same timeline, no replan");
  const event = store.db.prepare("SELECT metadata FROM events WHERE task_id = ? AND type = 'task.accepted' ORDER BY id DESC LIMIT 1").get(task.id);
  const metadata = JSON.parse(event.metadata);
  assert.equal(metadata.acceptedFromBlocked, true, "the ledger records that it was closed out of blocked");
  assert.equal(metadata.strandedAssignments, 0);
});

test("closing a blocked task that still had work in flight takes a second, explicit yes", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-accept-stranded-"));
  const store = new DevTeamStore(dataDir);
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Accept stranded", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Stopped midway", description: "Real work was open." });
  const agent = store.connectAgent({ name: "Claude", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned." });
  store.blockTask({ agentId: agent.id, taskId: task.id, reason: "Needs a key only you have.", kind: "needs-human" });

  assert.throws(() => store.acceptTaskByHuman({ taskId: task.id, summary: "Close it." }),
    /1 assignment still in flight/, "unfinished work is never quietly buried by an acceptance");
  assert.equal(store.getTask(task.id).status, "blocked", "and the refusal changed nothing");

  const accepted = store.acceptTaskByHuman({ taskId: task.id, summary: "Closing it; that work is no longer wanted.", acceptStranded: true });
  assert.equal(accepted.accepted, true, "but the human can still say so deliberately");
  const metadata = JSON.parse(store.db.prepare("SELECT metadata FROM events WHERE task_id = ? AND type = 'task.accepted' ORDER BY id DESC LIMIT 1").get(task.id).metadata);
  assert.equal(metadata.strandedAssignments, 1, "and how much was left unfinished is on the record");
});
