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
// The seeds are the first N integers, deliberately. An earlier version of this file used six
// hand-picked seeds; they passed, and four of the next eight integers did not, because a real
// deadlock was hiding in the seeds nobody ran. A seed list that is chosen rather than enumerated is
// a seed list fitted to passing runs. Every assertion carries its seed, and a failure prints it.
const SEEDS = Array.from({ length: 24 }, (unused, index) => index + 1);

// Deliberately larger than the scan's candidate page, so boards that must be paged through are
// generated rather than avoided. An earlier version capped this under the page size and hid a defect
// where a claimable item ranked below a screenful of lease-blocked ones was never handed out.
const MAX_ASSIGNMENTS = 26;
const MAX_AGENTS = 4;
const CHURN_STEPS = 60;
const DRAIN_STEPS = 600;

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

// Generate a random but *valid* graph: dependencies only ever point backwards, so the dependency
// graph is acyclic and every edge is satisfiable. Nothing else is restricted — in particular
// verifiers may declare write access freely, which an earlier version of this file avoided on the
// mistaken grounds that mutual gating between two of them was a design question rather than a bug.
function generateGraph(random, agentNames) {
  const count = 4 + Math.floor(random() * (MAX_ASSIGNMENTS - 4));
  const specs = [];
  for (let index = 0; index < count; index += 1) {
    const isVerifier = chance(random, 0.4);
    const role = pick(random, isVerifier ? VERIFIER_ROLES : WRITER_ROLES);
    const requiresWrite = chance(random, isVerifier ? 0.3 : 0.7);
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

// The scan and the explanation agree. Checked immediately after a claim call returned nothing, which
// is the only moment it can actually fire: an earlier version checked it only at the end of the run,
// where the board is empty by construction, so it never executed once across the whole suite.
function assertScanAndExplanationAgree(store, taskId, agent, context) {
  for (const queued of queuedAssignments(store, taskId)) {
    const chain = store.whyNotClaimable(queued.id, agent.id);
    assert.equal(chain.claimable, false,
      `${context}: whyNotClaimable says “${agent.name}” can claim “${queued.title}”, but the scan just handed it nothing — the explanation and the scan disagree`);
    assert.ok(chain.reasons.some((reason) => reason.blocking),
      `${context}: “${queued.title}” is not claimable by “${agent.name}” yet carries no blocking reason`);
  }
}

// Nothing sits unclaimed and unexplained.
function assertEverythingExplained(store, taskId, liveAgents, context) {
  for (const queued of queuedAssignments(store, taskId)) {
    const agnostic = store.whyNotClaimable(queued.id);
    assert.ok(agnostic.reasons.length > 0,
      `${context}: “${queued.title}” is queued, nobody claimed it, and nothing explains why`);
    for (const agent of liveAgents) assertScanAndExplanationAgree(store, taskId, agent, context);
  }
}

// A claim must respect the rules the scan claims to enforce. Checked on every successful claim.
function assertClaimWasLegal(store, claim, agent, context) {
  // Dependencies: never claimed while a prerequisite is unfinished.
  const unmet = store.db.prepare(`
    SELECT dependency.title FROM assignment_dependencies link
    JOIN assignments dependency ON dependency.id = link.depends_on_assignment_id
    WHERE link.assignment_id = ? AND dependency.status != 'done'
  `).all(claim.id);
  assert.equal(unmet.length, 0,
    `${context}: “${claim.title}” was claimed with ${unmet.length} unfinished dependency/ies (${unmet.map((item) => item.title).join(", ")})`);

  // Targeting: while a named target is connected, nobody else may take its work.
  if (claim.target_agent_name) {
    const present = store.db.prepare("SELECT name FROM agents WHERE lower(name) = lower(?) AND status != 'disconnected' LIMIT 1")
      .get(claim.target_agent_name);
    if (present) {
      assert.equal(agent.name.toLowerCase(), claim.target_agent_name.toLowerCase(),
        `${context}: “${claim.title}” is targeted at “${claim.target_agent_name}”, who is connected, but “${agent.name}” claimed it`);
    }
  }

  // Review gating: a verifier may not start while a plain writer in its task is pending and ready.
  if (VERIFIER_ROLES.includes(String(claim.role || "").toLowerCase())) {
    const readyWriter = store.db.prepare(`
      SELECT pending.title FROM assignments pending
      WHERE pending.task_id = ? AND pending.id != ?
        AND pending.requires_write = 1 AND pending.status IN ('queued', 'claimed')
        AND lower(pending.role) NOT IN ('reviewer', 'security-reviewer', 'tester')
        AND NOT EXISTS (
          SELECT 1 FROM assignment_dependencies link
          JOIN assignments dependency ON dependency.id = link.depends_on_assignment_id
          WHERE link.assignment_id = pending.id AND dependency.status != 'done'
        )
      LIMIT 1
    `).get(claim.task_id, claim.id);
    assert.ok(!readyWriter,
      `${context}: verifier “${claim.title}” was claimed while the ready writer “${readyWriter?.title}” was still pending`);
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
    const agent = store.connectAgent({ name, provider: "property-fixture", freshTaskId: task.id });
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
  await store.completeAssignment({ agentId: liveAgents()[0].id, assignmentId: seeded.id, claimToken: seeded.claimToken, message: "Planned." });

  const specs = generateGraph(random, agentNames);
  createGraph(store, task, specs);
  const graphSummary = specs.map((spec) => `#${spec.index} ${spec.role}${spec.requiresWrite ? `(write ${JSON.stringify(spec.paths)})` : ""}${spec.targetAgentName ? ` →${spec.targetAgentName}` : ""}${spec.dependsOn.length ? ` after ${spec.dependsOn}` : ""}`).join("\n  ");
  const context = `seed=${seed}`;
  const exercised = { agreementChecks: 0, legalClaims: 0, fencedReports: 0, disconnectsHoldingClaim: 0, hardDeaths: 0 };

  const report = async (agentId, claim) => {
    // Task version must advance exactly when files actually changed, and never otherwise.
    const before = store.getTask(task.id).version;
    const changedFiles = chance(random, 0.5) ? [`src/generated-${Math.floor(random() * 1000)}.mjs`] : [];
    const result = await store.completeAssignment({
      agentId, assignmentId: claim.id, claimToken: claim.claimToken,
      message: "Generated report.", changedFiles,
    });
    assert.equal(result.completed, true, `${context}: a well-formed report was refused`);
    const after = store.getTask(task.id).version;
    assert.equal(after, changedFiles.length ? before + 1 : before,
      `${context}: version went ${before} → ${after} for a report that changed ${changedFiles.length} files`);
  };

  const claimFor = (agent, phase) => {
    // Ask the explanation FIRST, then the scan, and require them to agree in both directions.
    // Asking afterwards hides a whole class of skew: claimNextAssignment reaps dead sessions and
    // recovers their orphaned claims before it looks at the queue, so an explanation that skipped
    // the reaper would already have been repaired by the very call it is meant to be predicting.
    // Settle liveness first, so both sides see one board. A hard session death leaves an orphaned
    // claim that the reaper returns to the queue; snapshotting before that repair would compare a
    // stale prediction against a repaired scan and fail for reasons of our own making. (That the
    // explanation itself must not skip the reaper is a separate, sharper property, covered by a
    // targeted test in devteam-scheduler-explain.test.mjs.)
    store.reapAndRecover();
    const predicted = queuedAssignments(store, task.id)
      .filter((queued) => store.whyNotClaimable(queued.id, agent.id).claimable);
    exercised.agreementChecks += 1;
    const claim = store.claimNextAssignment(agent.id);
    if (claim?.claimToken) {
      assert.ok(predicted.some((queued) => queued.id === claim.id),
        `${context} ${phase}: the scan handed “${agent.name}” “${claim.title}”, which the explanation said it could not claim — the explanation and the scan disagree`);
      exercised.legalClaims += 1;
      assertClaimWasLegal(store, claim, agent, `${context} ${phase}`);
      assertNoDoubleLease(store, `${context} after claim in ${phase}`);
      return claim;
    }
    assert.deepEqual(predicted.map((queued) => queued.title), [],
      `${context} ${phase}: whyNotClaimable says “${agent.name}” can claim work the scan just refused to hand it — the explanation and the scan disagree`);
    return null;
  };

  // --- phase 1: churn. Agents connect, disconnect, claim and report in random order. -------------
  for (let step = 0; step < CHURN_STEPS; step += 1) {
    const live = liveAgents();
    const roll = random();
    if (roll < 0.12 && live.length > 1) {
      const leaving = pick(random, live);
      if (store.db.prepare("SELECT 1 FROM assignments WHERE agent_id = ? AND status = 'claimed'").get(leaving.id)) {
        exercised.disconnectsHoldingClaim += 1;
      }
      store.disconnectAgent(leaving.id, "Randomized disconnect.");
    } else if (roll < 0.18 && live.length > 1) {
      // A hard session death: the transport dies with no clean disconnect, so any claim it held is
      // left orphaned for the reaper to recover. This is the state the explanation must not answer
      // against — it is where "held by someone else" and "here, take it" come apart.
      const lost = pick(random, live);
      store.db.prepare("UPDATE agents SET status = 'disconnected', disconnected_at = ? WHERE id = ?")
        .run(new Date().toISOString(), lost.id);
      sessions.set(lost.name, null);
      exercised.hardDeaths += 1;
    } else if (roll < 0.24) {
      const absent = agentNames.filter((name) => !live.some((agent) => agent.name === name));
      if (absent.length) connect(pick(random, absent));
    } else if (live.length) {
      const agent = pick(random, live);
      const claim = claimFor(agent, `step ${step}`);
      if (claim) {
        // Occasionally prove the fence is real before reporting honestly.
        if (chance(random, 0.15)) {
          const fenced = await store.completeAssignment({
            agentId: agent.id, assignmentId: claim.id, claimToken: "not-the-right-token", message: "Stale report.",
          });
          assert.equal(fenced.completed, false, `${context}: a report with a wrong claim token was accepted`);
          assert.ok(fenced.claimConflict, `${context}: a fenced report must explain itself`);
          exercised.fencedReports += 1;
        }
        if (chance(random, 0.75)) await report(agent.id, claim);
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
        await report(agent.id, { id: carried.id, claimToken: null });
        continue;
      }
      const claim = claimFor(agent, `drain step ${step}`);
      if (!claim) continue;
      progressed = true;
      await report(agent.id, claim);
    }
    if (!progressed) break;
  }
  assert.ok(step < DRAIN_STEPS, `${context}: the drain never reached a fixed point`);

  // No deadlock: at the fixed point nothing is claimable by anyone, and everything queued explains
  // itself. No starvation: with every agent present and every dependency satisfiable, the whole
  // board drains — a waits-for cycle shows up here as work nobody can ever take.
  assertEverythingExplained(store, task.id, liveAgents(), context);
  const stuck = openAssignments(store, task.id);
  assert.deepEqual(stuck, [],
    `${context}: the board never drained. Still open:\n  ${stuck.map((item) => `${item.title} [${item.status}] — ${JSON.stringify(store.whyNotClaimable(item.id).reasons.map((reason) => reason.code))}`).join("\n  ")}\nGraph:\n  ${graphSummary}`);

  return { graphSummary, assignments: specs.length, agents: agentNames.length, exercised };
}

const coverage = { agreementChecks: 0, legalClaims: 0, fencedReports: 0, disconnectsHoldingClaim: 0, hardDeaths: 0, boards: 0, largestBoard: 0 };

for (const seed of SEEDS) {
  test(`scheduler invariants hold for randomized graphs (seed ${seed})`, async (t) => {
    try {
      const summary = await runSimulation(t, seed);
      coverage.boards += 1;
      coverage.largestBoard = Math.max(coverage.largestBoard, summary.assignments);
      for (const key of Object.keys(summary.exercised)) coverage[key] += summary.exercised[key];
      assert.ok(summary.assignments >= 4 && summary.agents >= 2);
    } catch (error) {
      // Print the seed prominently: it is the only thing needed to reproduce this exact run.
      error.message = `[scheduler property failure — reproduce with seed ${seed}]\n${error.message}`;
      throw error;
    }
  });
}

test("the invariants actually execute, rather than passing vacuously", () => {
  // A property suite can be green because nothing it asserts was ever reached. An earlier version of
  // this file checked scan/explanation agreement only at the end of a run, where the board is empty
  // by construction — the assertion never ran once. These counters keep that from recurring quietly.
  assert.equal(coverage.boards, SEEDS.length, "every seed produced a board");
  assert.ok(coverage.agreementChecks > 50, `scan/explanation agreement ran ${coverage.agreementChecks} times`);
  assert.ok(coverage.legalClaims > 100, `claim legality ran ${coverage.legalClaims} times`);
  assert.ok(coverage.fencedReports > 5, `claim-token fencing ran ${coverage.fencedReports} times`);
  assert.ok(coverage.hardDeaths > 3, `hard session death ran ${coverage.hardDeaths} times`);
  assert.ok(coverage.disconnectsHoldingClaim > 3, `disconnect-while-holding ran ${coverage.disconnectsHoldingClaim} times`);
  assert.ok(coverage.largestBoard > 20, `largest generated board was ${coverage.largestBoard}, which never exercises paging`);
});

test("the invariants are load-bearing: a scheduler that withholds claimable work is caught", async (t) => {
  // A guard on the guards, aimed at the assertion that matters most. The item below is targeted at
  // somebody who is not connected, so it carries a reason (target_absent) but is genuinely claimable
  // — which means only the per-agent agreement check can catch a scheduler that refuses it. An
  // earlier version of this guard was satisfied by an unrelated assertion and stayed green when the
  // per-agent checks were deleted outright.
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
  const agent = store.connectAgent({ name: "Worker0", provider: "property-fixture", freshTaskId: task.id });
  store.joinTask(agent.id, task.id, "contributor");
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.createAssignment({
    taskId: task.id, title: "Claimable but explained", description: "Aimed at somebody who left.",
    role: "implementer", targetAgentName: "AgentWhoLeft",
  });

  // Sanity: the agnostic check is satisfied, so only the per-agent one can fail.
  assert.ok(store.whyNotClaimable(queuedAssignments(store, task.id)[0].id).reasons.length > 0);
  store.claimNextAssignment = () => null; // the scheduler now hands out nothing at all

  assert.throws(
    () => assertScanAndExplanationAgree(store, task.id, { id: agent.id, name: "Worker0" }, "guard"),
    /the explanation and the scan disagree/,
    "a scheduler that refuses claimable work must fail the agreement invariant",
  );
});
