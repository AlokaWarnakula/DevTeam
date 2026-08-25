import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";

// Property tests for the scheduling core. Instead of asserting one hand-built arrangement, these
// generate random-but-valid assignment graphs — mixed roles, dependency edges, path scopes,
// targeting, agents coming and going mid-run — drive the real claim/report loop over them, and
// assert the invariants that must hold no matter what shape the board takes.
//
// The seeds are fixed so a failure reproduces exactly; every assertion carries its seed, and a
// failing run prints the seed and the generated graph before rethrowing.
const SEEDS = [1, 7, 42, 99, 1337, 20260825];

// Kept under the scan's LIMIT 20 candidate window, so a full board is always visible to one scan.
const MAX_ASSIGNMENTS = 14;
const MAX_AGENTS = 4;
const CHURN_STEPS = 60;
const DRAIN_STEPS = 400;

// A name no agent in these runs ever uses, so work targeted at it is genuinely aimed at somebody who
// is not here. This is the F9 case: it must fall back to the general queue, not sit unclaimable.
const DEPARTED = "AgentWhoLeft";

const WRITER_ROLES = ["implementer", "architect", "planner"];
const VERIFIER_ROLES = ["reviewer", "security-reviewer", "tester"];
const SCOPES = [null, ["src"], ["src/devteam"], ["src/devteam/store.mjs"], ["test"], ["public", "docs"], ["src", "test"]];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];
const chance = (random, probability) => random() < probability;

// The store's own overlap rule, restated here independently. A property test that imported the
// implementation's answer would only be checking that the code equals itself.
const scopesOverlap = (a, b) => a === "" || b === "" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function declaredScopes(store, assignmentId) {
  const row = store.db.prepare("SELECT paths FROM assignment_write_scopes WHERE assignment_id = ?").get(assignmentId);
  const declared = row ? JSON.parse(row.paths) : [];
  return declared.length ? declared : [""];
}

// Write leases actually in force: a claimed write assignment whose owner is still connected. A
// disconnected owner's lease is not in force, which is what lets its paths be re-let.
function liveWriteLeases(store) {
  return store.db.prepare(`
    SELECT a.id, a.title, a.agent_id AS agentId, ag.name AS holder, t.project_id AS projectId
    FROM assignments a
    JOIN tasks t ON t.id = a.task_id
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status = 'claimed' AND a.requires_write = 1 AND ag.status != 'disconnected'
      AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
  `).all().map((row) => ({ ...row, scopes: declaredScopes(store, row.id) }));
}

const queuedAssignments = (store, taskId) =>
  store.db.prepare("SELECT id, title, role FROM assignments WHERE task_id = ? AND status = 'queued' ORDER BY created_at ASC").all(taskId);

const openAssignments = (store, taskId) =>
  store.db.prepare("SELECT id, title, role, status FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed') ORDER BY created_at ASC").all(taskId);

// Generate a random but *valid* graph: dependencies only ever point backwards (so the graph is
// acyclic and every edge is satisfiable), and at most one verifier declares write access.
//
// That last restriction is not a convenience — two write-declaring verifiers legitimately gate each
// other under the current review rule, and neither would ever be claimable. That is a scheduling
// design question, not a defect these invariants are about, so the generator stays clear of it and
// the invariants can then demand that the board fully drains.
function generateGraph(random, agentNames) {
  const count = 4 + Math.floor(random() * (MAX_ASSIGNMENTS - 4));
  const specs = [];
  let writingVerifierUsed = false;
  for (let index = 0; index < count; index += 1) {
    const isVerifier = chance(random, 0.4);
    const role = pick(random, isVerifier ? VERIFIER_ROLES : WRITER_ROLES);
    let requiresWrite = chance(random, isVerifier ? 0.3 : 0.7);
    if (isVerifier && requiresWrite) {
      if (writingVerifierUsed) requiresWrite = false;
      else writingVerifierUsed = true;
    }
    const paths = requiresWrite ? pick(random, SCOPES) : null;
    const targetAgentName = chance(random, 0.25)
      ? (chance(random, 0.5) ? DEPARTED : pick(random, agentNames))
      : null;
    const dependsOn = [];
    for (const earlier of specs) {
      if (dependsOn.length < 2 && chance(random, 0.12)) dependsOn.push(earlier.index);
    }
    specs.push({ index, role, requiresWrite, paths, targetAgentName, dependsOn });
  }
  return specs;
}

function createGraph(store, task, specs) {
  const created = [];
  for (const spec of specs) {
    created.push(store.createAssignment({
      taskId: task.id,
      title: `#${spec.index} ${spec.role}${spec.requiresWrite ? " (write)" : ""}`,
      description: "Generated work.",
      role: spec.role,
      requiresWrite: spec.requiresWrite,
      ...(spec.paths ? { paths: spec.paths } : {}),
      ...(spec.targetAgentName ? { targetAgentName: spec.targetAgentName } : {}),
      ...(spec.dependsOn.length ? { dependsOn: spec.dependsOn.map((index) => created[index].id) } : {}),
    }));
  }
  return created;
}

// ---- the invariants ---------------------------------------------------------------------------

// Two agents never hold overlapping write paths at once.
function assertNoDoubleLease(store, context) {
  const leases = liveWriteLeases(store);
  for (let i = 0; i < leases.length; i += 1) {
    for (let j = i + 1; j < leases.length; j += 1) {
      if (leases[i].projectId !== leases[j].projectId) continue;
      if (leases[i].agentId === leases[j].agentId) continue;
      for (const held of leases[i].scopes) {
        for (const other of leases[j].scopes) {
          assert.ok(!scopesOverlap(held, other),
            `${context}: “${leases[i].holder}” holds ${JSON.stringify(held)} for “${leases[i].title}” while “${leases[j].holder}” holds ${JSON.stringify(other)} for “${leases[j].title}”`);
        }
      }
    }
  }
}

// Nothing sits unclaimed and unexplained: at a point where no connected agent could claim anything,
// every queued item must have a blocking reason, and no idle agent may be told it *could* claim
// something the scan just refused to hand it.
function assertEverythingExplained(store, task, liveAgents, context) {
  for (const queued of queuedAssignments(store, task.id)) {
    const agnostic = store.whyNotClaimable(queued.id);
    assert.ok(agnostic.reasons.length > 0,
      `${context}: “${queued.title}” is queued, nobody claimed it, and nothing explains why`);
    for (const agent of liveAgents) {
      const chain = store.whyNotClaimable(queued.id, agent.id);
      assert.equal(chain.claimable, false,
        `${context}: whyNotClaimable says “${agent.name}” can claim “${queued.title}”, but the scan handed it nothing — the explanation and the scan disagree`);
      assert.ok(chain.reasons.some((reason) => reason.blocking),
        `${context}: “${queued.title}” is not claimable by “${agent.name}” yet carries no blocking reason`);
    }
  }
}

// ---- the run ------------------------------------------------------------------------------------

async function runSimulation(t, seed) {
  const random = mulberry32(seed);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `devteam-prop-${seed}-data-`));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `devteam-prop-${seed}-project-`));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* already closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  const project = store.ensureProject(`Property project ${seed}`, projectRoot);
  const task = store.createTask({ projectId: project.id, title: `Property task ${seed}`, description: "Randomized scheduling." });
  const agentNames = Array.from({ length: 2 + Math.floor(random() * (MAX_AGENTS - 1)) }, (unused, index) => `Worker${index}`);

  // Sessions come and go; a name is the stable identity, the id is per-connection.
  const sessions = new Map(agentNames.map((name) => [name, null]));
  const connect = (name) => {
    const agent = store.connectAgent({ name, provider: "property-fixture" });
    store.joinTask(agent.id, task.id, "contributor");
    sessions.set(name, agent.id);
    return agent.id;
  };
  const liveAgents = () => [...sessions.entries()]
    .filter(([, id]) => id && store.getAgent(id).status !== "disconnected")
    .map(([name, id]) => ({ name, id }));

  for (const name of agentNames) connect(name);

  // Drain the planner item createTask seeds, so the generated graph is the whole board.
  const seeded = store.claimNextAssignment(liveAgents()[0].id);
  store.completeAssignment({ agentId: liveAgents()[0].id, assignmentId: seeded.id, claimToken: seeded.claimToken, message: "Planned." });

  const specs = generateGraph(random, agentNames);
  createGraph(store, task, specs);
  const graphSummary = specs.map((spec) => `#${spec.index} ${spec.role}${spec.requiresWrite ? `(write ${JSON.stringify(spec.paths)})` : ""}${spec.targetAgentName ? ` →${spec.targetAgentName}` : ""}${spec.dependsOn.length ? ` after ${spec.dependsOn}` : ""}`).join("\n  ");
  const context = `seed=${seed}`;

  // Anything the explainer ever declared claimable must end the run claimed or done. This is the
  // starvation invariant: work that could be handed out is not allowed to be forgotten.
  const everClaimable = new Set();
  const noteClaimable = (agent) => {
    for (const queued of queuedAssignments(store, task.id)) {
      if (store.whyNotClaimable(queued.id, agent.id).claimable) everClaimable.add(queued.id);
    }
  };

  const report = (agentId, claim) => {
    // Task version must advance exactly when files actually changed, and never otherwise.
    const before = store.getTask(task.id).version;
    const changedFiles = chance(random, 0.5) ? [`src/generated-${Math.floor(random() * 1000)}.mjs`] : [];
    const result = store.completeAssignment({
      agentId, assignmentId: claim.id, claimToken: claim.claimToken,
      message: "Generated report.", changedFiles,
    });
    assert.equal(result.completed, true, `${context}: a well-formed report was refused`);
    const after = store.getTask(task.id).version;
    assert.equal(after, changedFiles.length ? before + 1 : before,
      `${context}: version went ${before} → ${after} for a report that changed ${changedFiles.length} files`);
  };

  // --- phase 1: churn. Agents connect, disconnect, claim and report in random order. -------------
  for (let step = 0; step < CHURN_STEPS; step += 1) {
    const live = liveAgents();
    const roll = random();
    if (roll < 0.12 && live.length > 1) {
      store.disconnectAgent(pick(random, live).id, "Randomized disconnect.");
    } else if (roll < 0.24) {
      const absent = agentNames.filter((name) => !live.some((agent) => agent.name === name));
      if (absent.length) connect(pick(random, absent));
    } else if (live.length) {
      const agent = pick(random, live);
      noteClaimable(agent);
      const claim = store.claimNextAssignment(agent.id);
      if (claim?.claimToken) {
        assertNoDoubleLease(store, `${context} after claim at step ${step}`);
        if (chance(random, 0.75)) report(agent.id, claim);
      }
    }
    assertNoDoubleLease(store, `${context} at step ${step}`);
  }

  // --- phase 2: drain. Everyone is present; the board must empty out. ----------------------------
  for (const name of agentNames) {
    if (!liveAgents().some((agent) => agent.name === name)) connect(name);
  }
  let step = 0;
  for (; step < DRAIN_STEPS; step += 1) {
    let progressed = false;
    for (const agent of liveAgents()) {
      // An agent that carried a claim out of the churn phase finishes it first: it can hold only one
      // at a time, so leaving it holding would stall the board for reasons of our own making.
      const carried = store.db.prepare("SELECT id FROM assignments WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(agent.id);
      if (carried) {
        progressed = true;
        report(agent.id, { id: carried.id, claimToken: null });
        continue;
      }
      noteClaimable(agent);
      const claim = store.claimNextAssignment(agent.id);
      if (!claim?.claimToken) continue;
      progressed = true;
      assertNoDoubleLease(store, `${context} during drain step ${step}`);
      report(agent.id, claim);
    }
    if (!progressed) break;
  }
  assert.ok(step < DRAIN_STEPS, `${context}: the drain never reached a fixed point`);

  // No deadlock: at the fixed point nothing is claimable by anyone, and everything still queued
  // explains itself.
  assertEverythingExplained(store, task, liveAgents(), context);

  // No starvation: everything the explainer ever called claimable was in fact taken, and with every
  // agent present and every dependency satisfiable, the whole board drains.
  for (const assignmentId of everClaimable) {
    const status = store.db.prepare("SELECT title, status FROM assignments WHERE id = ?").get(assignmentId);
    assert.notEqual(status.status, "queued",
      `${context}: “${status.title}” was reported claimable and was still never claimed`);
  }
  const stuck = openAssignments(store, task.id);
  assert.deepEqual(stuck, [],
    `${context}: the board never drained. Still open:\n  ${stuck.map((item) => `${item.title} [${item.status}] — ${JSON.stringify(store.whyNotClaimable(item.id).reasons.map((reason) => reason.code))}`).join("\n  ")}\nGraph:\n  ${graphSummary}`);

  return { graphSummary, assignments: specs.length, agents: agentNames.length };
}

for (const seed of SEEDS) {
  test(`scheduler invariants hold for randomized graphs (seed ${seed})`, async (t) => {
    try {
      const summary = await runSimulation(t, seed);
      assert.ok(summary.assignments >= 4 && summary.agents >= 2);
    } catch (error) {
      // Print the seed prominently: it is the only thing needed to reproduce this exact run.
      error.message = `[scheduler property failure — reproduce with seed ${seed}]\n${error.message}`;
      throw error;
    }
  });
}

test("the invariants are load-bearing: a broken scheduler is caught, not tolerated", async (t) => {
  // A guard on the guards. If the property run can pass against a store whose scheduler cannot hand
  // out claimable work, the invariants above are decorative. Here the scan is disabled outright,
  // which is the most extreme version of the two deadlocks these tests exist to catch.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-prop-guard-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-prop-guard-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* already closed */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Guard project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Guard", description: "Deliberately broken scheduler." });
  const agent = store.connectAgent({ name: "Worker0", provider: "property-fixture" });
  store.joinTask(agent.id, task.id, "contributor");
  const plan = store.claimNextAssignment(agent.id);
  store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.createAssignment({ taskId: task.id, title: "Plainly claimable", description: "Nothing blocks it.", role: "implementer" });

  store.claimNextAssignment = () => null; // the scheduler now hands out nothing at all

  assert.throws(
    () => assertEverythingExplained(store, task, [{ id: agent.id, name: "Worker0" }], "guard"),
    /nothing explains why|the explanation and the scan disagree/,
    "a scheduler that refuses claimable work must fail the deadlock invariant",
  );
});
