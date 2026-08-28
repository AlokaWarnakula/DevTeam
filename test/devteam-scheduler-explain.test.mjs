import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

// Every branch on which claimNextAssignment skips a candidate, paired with the reason code
// whyNotClaimable must return for it. The scan may never grow a silent skip: if a branch here has
// no matching code, an agent that sees no work has no way to find out why, which is exactly how the
// self-blocking verifier and the departed-target deadlock both stayed invisible for a whole session.
const SKIP_BRANCHES = [
  "agent_disconnected",
  "agent_holds_claim",
  "agent_holds_write_claim",
  "assignment_not_queued",
  "task_closed",
  "room_not_claimable",
  "room_membership_required",
  "room_invitation_only",
  "targeted_elsewhere",
  "dependency_pending",
  "awaiting_writer",
  "write_lease_conflict",
];

async function explainFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-explain-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-explain-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Explain project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Explain", description: "Exercise the scheduler explanation." });
  return { store, project, task };
}

// Drain the planner assignment createTask seeds, so later tests start from an empty queue.
async function drainPlanner(store, agent) {
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  return plan;
}

const codesOf = (explanation) => explanation.reasons.map((reason) => reason.code);
const reasonFor = (explanation, code) => explanation.reasons.find((reason) => reason.code === code);

test("whyNotClaimable names a reason for every branch on which the scan skips a candidate", async (t) => {
  const seen = new Set();
  const record = (explanation, code) => {
    const reason = reasonFor(explanation, code);
    assert.ok(reason, `expected reason ${code}, got ${JSON.stringify(codesOf(explanation))}`);
    assert.ok(reason.detail && reason.detail.length > 10, `${code} must explain itself, not just name itself`);
    assert.equal(explanation.claimable, false, `${code} is a blocker, so the item is not claimable`);
    seen.add(code);
    return reason;
  };

  // --- assignment_not_queued / agent_holds_claim -----------------------------------------------
  {
    const { store, task } = await explainFixture(t);
    const agent = store.connectAgent({ name: "Holder", provider: "fixture", freshTaskId: task.id });
    const plan = store.claimNextAssignment(agent.id);
    const held = record(store.whyNotClaimable(plan.id, agent.id), "assignment_not_queued");
    assert.equal(held.status, "claimed");
    assert.equal(held.holder, "Holder", "the claim explanation names who holds it");
    // Its own live claim is reported as such when asked about that assignment.
    record(store.whyNotClaimable(plan.id, agent.id), "agent_holds_claim");

    // T0.3: holding a *write* claim blocks a second writer — that is the lease invariant — but the
    // same agent may still take read-only work, so a review is not reported as blocked here.
    await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
    store.createAssignment({ taskId: task.id, title: "First writer", description: "Edit.", role: "implementer", requiresWrite: true, paths: ["src/first.mjs"] });
    const writeClaim = store.claimNextAssignment(agent.id);
    const secondWriter = store.createAssignment({ taskId: task.id, title: "Second writer", description: "Edit elsewhere.", role: "implementer", requiresWrite: true, paths: ["src/second.mjs"] });
    const blocked = record(store.whyNotClaimable(secondWriter.id, agent.id), "agent_holds_write_claim");
    assert.equal(blocked.heldAssignmentId, writeClaim.id);
    assert.match(blocked.detail, /Holder/);
  }

  // --- agent_disconnected -----------------------------------------------------------------------
  {
    const { store, task } = await explainFixture(t);
    const agent = store.connectAgent({ name: "Departed", provider: "fixture", freshTaskId: task.id });
    await drainPlanner(store, agent);
    const work = store.createAssignment({ taskId: task.id, title: "Left behind", description: "Work.", role: "implementer" });
    store.disconnectAgent(agent.id, "Session ended.");
    record(store.whyNotClaimable(work.id, agent.id), "agent_disconnected");
    assert.throws(() => store.claimNextAssignment(agent.id), /disconnected/i, "the scan's own branch still throws");
  }

  // --- task_closed ------------------------------------------------------------------------------
  {
    const { store, task } = await explainFixture(t);
    const agent = store.connectAgent({ name: "Worker", provider: "fixture", freshTaskId: task.id });
    await drainPlanner(store, agent);
    const work = store.createAssignment({ taskId: task.id, title: "Shelved", description: "Work.", role: "implementer" });
    store.blockTask({ taskId: task.id, reason: "Needs a human decision." });
    const reason = record(store.whyNotClaimable(work.id, agent.id), "task_closed");
    assert.equal(reason.taskStatus, "blocked");
    assert.equal(store.claimNextAssignment(agent.id), null, "the scan hands out nothing from a closed task");
  }

  // --- room_not_claimable / room_membership_required / room_invitation_only / targeted_elsewhere -
  {
    const { store, project, task } = await explainFixture(t);
    const insider = store.connectAgent({ name: "Insider", provider: "fixture", freshTaskId: task.id });
    await drainPlanner(store, insider);
    const elsewhere = store.createTask({ projectId: project.id, title: "Other room", description: "Not yours." });
    const outsider = store.connectAgent({ name: "Outsider", provider: "fixture", freshTaskId: elsewhere.id });

    const untargeted = store.createAssignment({ taskId: task.id, title: "Room work", description: "Work.", role: "implementer" });
    const reason = record(store.whyNotClaimable(untargeted.id, outsider.id), "room_not_claimable");
    assert.equal(reason.taskId, task.id);

    // Being in the wrong room and being in no room at all are different situations, and only the
    // second one is fixed by joining anything. A fresh session lands in the second one, so it gets
    // its own code and is handed the list of rooms it could join.
    const roomless = store.connectAgent({ name: "Roomless", provider: "fixture" });
    const needsRoom = record(store.whyNotClaimable(untargeted.id, roomless.id), "room_membership_required");
    assert.deepEqual(needsRoom.availableTasks.map((entry) => entry.id).sort(), [task.id, elsewhere.id].sort());
    const board = store.whyNoClaimableWork(roomless.id);
    assert.equal(board.membershipRequired, true);
    assert.match(board.next, /devteam_join/);
    assert.equal(store.claimNextAssignment(roomless.id), null, "and the scan hands it nothing");

    // An invitation addressed by name reaches into the room for that item only.
    const invitation = store.createAssignment({
      taskId: task.id, title: "Just for Outsider", description: "Targeted work.",
      role: "implementer", targetAgentName: "Outsider",
    });
    record(store.whyNotClaimable(untargeted.id, outsider.id), "room_invitation_only");
    assert.equal(store.whyNotClaimable(invitation.id, outsider.id).claimable, true, "the invitation itself is claimable");

    // A present target holds its own work exclusively against everyone else.
    const targeted = record(store.whyNotClaimable(invitation.id, insider.id), "targeted_elsewhere");
    assert.equal(targeted.targetAgentName, "Outsider");
    assert.equal(store.claimNextAssignment(outsider.id).id, invitation.id, "and the scan agrees on who gets it");
  }

  // --- dependency_pending -----------------------------------------------------------------------
  {
    const { store, task } = await explainFixture(t);
    const agent = store.connectAgent({ name: "Worker", provider: "fixture", freshTaskId: task.id });
    await drainPlanner(store, agent);
    const first = store.createAssignment({ taskId: task.id, title: "Lay the foundation", description: "Work.", role: "implementer" });
    const second = store.createAssignment({
      taskId: task.id, title: "Build on it", description: "Work.", role: "implementer", dependsOn: [first.id],
    });
    const reason = record(store.whyNotClaimable(second.id, agent.id), "dependency_pending");
    assert.equal(reason.dependsOn.length, 1);
    assert.equal(reason.dependsOn[0].id, first.id, "each unmet dependency is named");
    assert.match(reason.detail, /Lay the foundation/);
    assert.notEqual(store.claimNextAssignment(agent.id).id, second.id, "and the scan skips it too");
  }

  // --- awaiting_writer (the self-blocking verifier deadlock, F8) ---------------------------------
  {
    const { store, task } = await explainFixture(t);
    const agent = store.connectAgent({ name: "Worker", provider: "fixture", freshTaskId: task.id });
    await drainPlanner(store, agent);
    store.createAssignment({
      taskId: task.id, title: "Ship the feature", description: "Edit source.",
      role: "implementer", requiresWrite: true, paths: ["src"],
    });
    const reviewer = store.createAssignment({ taskId: task.id, title: "Review it", description: "Read the diff.", role: "reviewer" });
    const reason = record(store.whyNotClaimable(reviewer.id, agent.id), "awaiting_writer");
    assert.match(reason.detail, /Ship the feature/, "the blocking writer is named, not merely counted");
    assert.equal(reason.writers.length, 1);

    // A verifier that itself declares write access is never the writer it waits for.
    const writingTester = store.createAssignment({
      taskId: task.id, title: "Write regression tests", description: "Add coverage.",
      role: "tester", requiresWrite: true, paths: ["test"],
    });
    const selfBlock = store.whyNotClaimable(writingTester.id, agent.id);
    assert.ok(!reasonFor(selfBlock, "awaiting_writer")?.writers?.some((writer) => writer.id === writingTester.id),
      "a verifier must not be reported as blocking itself");
  }

  // --- write_lease_conflict ---------------------------------------------------------------------
  {
    const { store, task } = await explainFixture(t);
    const first = store.connectAgent({ name: "First writer", provider: "fixture", freshTaskId: task.id });
    await drainPlanner(store, first);
    store.createAssignment({
      taskId: task.id, title: "Rework the core", description: "Edit source.",
      role: "implementer", requiresWrite: true, paths: ["src/devteam"],
    });
    const overlapping = store.createAssignment({
      taskId: task.id, title: "Touch the same tree", description: "Edit source.",
      role: "implementer", requiresWrite: true, paths: ["src/devteam/store.mjs"],
    });
    const claim = store.claimNextAssignment(first.id);
    assert.equal(claim.title, "Rework the core");
    const second = store.connectAgent({ name: "Second writer", provider: "fixture", freshTaskId: task.id });
    store.joinTask(second.id, task.id, "contributor");
    const reason = record(store.whyNotClaimable(overlapping.id, second.id), "write_lease_conflict");
    assert.equal(reason.holder, "First writer", "the conflicting holder is named");
    assert.equal(reason.conflictingAssignmentId, claim.id);
    assert.ok(reason.paths.length >= 1, "and the overlapping paths are listed");
    assert.match(reason.detail, /src\/devteam/);
    assert.notEqual(store.claimNextAssignment(second.id)?.id, overlapping.id, "and the scan skips it too");
  }

  assert.deepEqual([...seen].sort(), [...SKIP_BRANCHES].sort(),
    "every skip branch in claimNextAssignment must have a matching reason code");
});

test("whyNotClaimable reports the whole chain and says so plainly when nothing blocks", async (t) => {
  const { store, task } = await explainFixture(t);
  const agent = store.connectAgent({ name: "Worker", provider: "fixture", freshTaskId: task.id });
  await drainPlanner(store, agent);

  const ready = store.createAssignment({ taskId: task.id, title: "Plain work", description: "Nothing in the way.", role: "implementer" });
  const clear = store.whyNotClaimable(ready.id, agent.id);
  assert.equal(clear.claimable, true);
  assert.deepEqual(clear.reasons, [], "an unobstructed item carries no reasons at all");
  assert.equal(clear.agentName, "Worker");

  // Three independent blockers at once: the chain must carry all of them, not stop at the first.
  const writer = store.createAssignment({
    taskId: task.id, title: "Rewrite the module", description: "Edit source.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const dependency = store.createAssignment({ taskId: task.id, title: "Groundwork", description: "First.", role: "implementer" });
  const piled = store.createAssignment({
    taskId: task.id, title: "Review everything", description: "Read it.", role: "reviewer",
    dependsOn: [dependency.id], targetAgentName: "Ghost",
  });
  store.claimNextAssignment(agent.id);

  const chain = store.whyNotClaimable(piled.id, agent.id);
  const codes = codesOf(chain);
  // T0.3: the agent holds a read-only planner claim, which no longer blocks read-only work, so
  // `agent_holds_claim` is correctly absent here. Everything else still piles up.
  assert.equal(codes.includes("agent_holds_claim"), false, "a read-only claim does not block review work");
  assert.ok(codes.includes("dependency_pending"), "the unmet dependency is reported");
  assert.ok(codes.includes("awaiting_writer"), "so is the pending writer");
  assert.ok(codes.includes("target_absent"), "so is the departed target");
  assert.ok(codes.length >= 3, `the chain is ordered and complete, got ${JSON.stringify(codes)}`);
  assert.equal(chain.reasons.find((reason) => reason.code === "target_absent").blocking, false,
    "an absent target widens who may claim, so it is reported without being counted as a blocker");
  assert.match(chain.reasons.find((reason) => reason.code === "awaiting_writer").detail, new RegExp(writer.title));

  // The agent-agnostic form drops the agent-specific links and keeps the rest.
  const agnostic = store.whyNotClaimable(piled.id);
  assert.equal(agnostic.agentId, null);
  assert.ok(!codesOf(agnostic).includes("agent_holds_claim"));
  assert.ok(codesOf(agnostic).includes("awaiting_writer"));
});

test("the scheduling hold shown on a card is the same explanation, not a second opinion", async (t) => {
  const { store, task } = await explainFixture(t);
  const agent = store.connectAgent({ name: "Worker", provider: "fixture", freshTaskId: task.id });
  await drainPlanner(store, agent);
  store.createAssignment({
    taskId: task.id, title: "Ship the feature", description: "Edit source.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const reviewer = store.createAssignment({ taskId: task.id, title: "Review it", description: "Read the diff.", role: "reviewer" });
  const ghosted = store.createAssignment({
    taskId: task.id, title: "Work for a ghost", description: "Targeted work.",
    role: "implementer", targetAgentName: "NobodyHere",
  });

  const detail = store.taskDetail(task.id);
  for (const item of [reviewer, ghosted]) {
    const card = detail.assignments.find((entry) => entry.id === item.id);
    const chain = store.whyNotClaimable(item.id);
    const matching = chain.reasons.find((reason) => reason.code === card.schedulingHold.reason);
    assert.ok(matching, "the one-line hold is drawn from the chain, so the two can never drift");
    assert.equal(card.schedulingHold.detail, matching.detail);
  }
});

test("an idle agent can ask why the whole board is unclaimable, without seeing other rooms", async (t) => {
  const { store, project, task } = await explainFixture(t);
  const agent = store.connectAgent({ name: "Idle", provider: "fixture", freshTaskId: task.id });
  await drainPlanner(store, agent);
  store.joinTask(agent.id, task.id, "contributor");
  const elsewhere = store.createTask({ projectId: project.id, title: "Another room", description: "Not yours." });
  store.createAssignment({ taskId: elsewhere.id, title: "Someone else's work", description: "Private.", role: "implementer" });
  store.createAssignment({
    taskId: task.id, title: "Ship the feature", description: "Edit source.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const reviewer = store.createAssignment({ taskId: task.id, title: "Review it", description: "Read the diff.", role: "reviewer" });

  const answer = store.whyNoClaimableWork(agent.id);
  assert.deepEqual(answer.rooms, [task.id], "membership still bounds what the explainer will show");
  assert.equal(answer.queuedCount, 2, "and it covers every queued item in the rooms it may see");
  assert.ok(!answer.assignments.some((entry) => entry.title === "Someone else's work"));
  assert.equal(answer.claimable.length, 1, "the writer is claimable right now");
  const held = answer.assignments.find((entry) => entry.assignmentId === reviewer.id);
  assert.equal(held.claimable, false);
  assert.match(held.reasons.find((reason) => reason.code === "awaiting_writer").detail, /Ship the feature/);
  assert.equal(answer.holdingClaim, null);

  // Asking about a room the agent never joined is refused rather than answered.
  assert.throws(() => store.whyNoClaimableWork(agent.id, elsewhere.id), /not a member/i);
  const outsider = store.connectAgent({ name: "Outsider", provider: "fixture", freshTaskId: elsewhere.id });
  store.joinTask(outsider.id, elsewhere.id, "contributor");
  assert.throws(() => store.assertExplainable(outsider.id, task.id), /not a member/i);
});

test("a write-lease conflict never carries a foreign task room's title or holder", async (t) => {
  // Write leases are project-wide, so the agent blocking you may be working in a room you are not
  // in. Before this was caught in review, the explanation named that room's assignment title, id and
  // holder, and #schedulingHold carried the same string into taskDetail for the room you *are* in.
  const { store, project, task } = await explainFixture(t);
  const insider = store.connectAgent({ name: "Insider", provider: "fixture", freshTaskId: task.id });
  const outsider = store.connectAgent({ name: "Outsider", provider: "fixture", freshTaskId: task.id });
  const confidential = store.createTask({ projectId: project.id, title: "Confidential", description: "Another room." });
  store.joinTask(insider.id, confidential.id, "contributor");
  store.joinTask(outsider.id, task.id, "contributor");
  // Both rooms seed a planner assignment; drain every one of them so the leases below are the only
  // work on the board.
  for (let round = 0; round < 6; round += 1) {
    for (const agentId of [insider.id, outsider.id]) {
      const plan = store.claimNextAssignment(agentId);
      if (plan?.claimToken) await store.completeAssignment({ agentId, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
    }
  }

  store.createAssignment({
    taskId: confidential.id, title: "Rewrite the MERGER pricing engine", description: "Confidential.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const mine = store.createAssignment({
    taskId: task.id, title: "Ordinary work", description: "Open.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const held = store.claimNextAssignment(insider.id);
  assert.equal(held.title, "Rewrite the MERGER pricing engine");

  const chain = store.whyNotClaimable(mine.id, outsider.id);
  const conflict = reasonFor(chain, "write_lease_conflict");
  assert.ok(conflict, "the stall is still explained");
  assert.equal(conflict.sameRoom, false);
  assert.equal(conflict.holder, null, "the holder in another room is not named");
  assert.equal(conflict.conflictingTitle, null);
  assert.equal(conflict.conflictingAssignmentId, null);
  assert.doesNotMatch(conflict.detail, /MERGER|Insider/, "and nothing leaks through the prose either");
  assert.ok(conflict.paths.length, "the overlapping paths stay, since they are what makes the stall legible");
  assert.match(conflict.detail, /src/);

  // The same string reaches the dashboard through taskDetail, so it must be redacted there too.
  const card = store.taskDetail(task.id).assignments.find((item) => item.id === mine.id);
  assert.doesNotMatch(card.schedulingHold.detail, /MERGER|Insider/);

  // Within one room the full detail is still useful and is still given.
  const sibling = store.createAssignment({
    taskId: confidential.id, title: "Sibling work", description: "Same room.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const sameRoom = reasonFor(store.whyNotClaimable(sibling.id, insider.id), "write_lease_conflict");
  assert.equal(sameRoom.sameRoom, true);
  assert.equal(sameRoom.holder, "Insider");
  assert.match(sameRoom.detail, /Rewrite the MERGER pricing engine/);
});

test("the explanation surfaces authorize before they compute, and are not an existence oracle", async (t) => {
  const { store, project, task } = await explainFixture(t);
  // The outsider needs a room of its own, so that "not a member of the room under test" is the
  // only thing being tested here rather than "in no room at all".
  const elsewhere = store.createTask({ projectId: project.id, title: "Elsewhere", description: "Not yours." });
  const outsider = store.connectAgent({ name: "Outsider", provider: "fixture", freshTaskId: elsewhere.id });
  store.joinTask(outsider.id, elsewhere.id, "contributor");
  const foreign = store.createAssignment({ taskId: task.id, title: "Private work", description: "Not yours.", role: "implementer" });

  // assignmentRoom answers the authorization question without computing the explanation.
  assert.equal(store.assignmentRoom(foreign.id), task.id);
  assert.equal(store.assignmentRoom("00000000-0000-4000-8000-000000000000"), null);
  assert.throws(() => store.assertExplainable(outsider.id, task.id), /not a member/i);
});

test("the explanation answers against the same liveness the scan will act on", async (t) => {
  // claimNextAssignment reaps dead sessions and recovers their orphaned claims before it looks at
  // the queue. whyNotClaimable did not, so it reported work as "held by someone else" that the very
  // next claim call handed straight over — an idle agent asking why it had nothing to do was told a
  // stale answer about the exact assignment it was about to be given.
  const { store, task } = await explainFixture(t);
  const first = store.connectAgent({ name: "First", provider: "fixture", freshTaskId: task.id });
  const second = store.connectAgent({ name: "Second", provider: "fixture", freshTaskId: task.id });
  store.joinTask(first.id, task.id, "contributor");
  store.joinTask(second.id, task.id, "contributor");
  for (let round = 0; round < 4; round += 1) {
    for (const agentId of [first.id, second.id]) {
      const plan = store.claimNextAssignment(agentId);
      if (plan?.claimToken) await store.completeAssignment({ agentId, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
    }
  }

  const work = store.createAssignment({
    taskId: task.id, title: "Orphaned work", description: "Write.",
    role: "implementer", requiresWrite: true, paths: ["src"],
  });
  const claim = store.claimNextAssignment(first.id);
  assert.equal(claim.id, work.id);

  // A hard transport death: the session row goes disconnected without releasing its claim.
  store.db.prepare("UPDATE agents SET status = 'disconnected', disconnected_at = ? WHERE id = ?")
    .run(new Date().toISOString(), first.id);

  const explanation = store.whyNotClaimable(work.id, second.id);
  assert.equal(explanation.claimable, true,
    "the explanation recovers the orphaned claim first, exactly as the scan is about to");
  assert.deepEqual(explanation.reasons.filter((reason) => reason.blocking), []);
  assert.equal(store.claimNextAssignment(second.id)?.id, work.id, "and the scan then hands it over, agreeing");
});
