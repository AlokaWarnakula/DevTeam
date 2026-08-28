import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { currentRung, normalizeLadder, requiredRung, rungLabel } from "../src/devteam/models.mjs";

test("a session below the rung a piece of work needs finishes everything else first, then says what is waiting", async (t) => {
  // The whole point: not "stop at the hard thing", but "do everything you can, then say what is
  // left and what it needs". Stopping at the first hard item strands work the current model could
  // have finished.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-ladder-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-ladder-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    for (const dir of [dataDir, projectRoot]) await rm(dir, { recursive: true, force: true });
  });
  const project = store.ensureProject("Ladder", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Mixed difficulty", description: "Some easy, one hard." });

  const agent = store.connectAgent({
    name: "Claude", provider: "Anthropic Claude Code", freshTaskId: task.id,
    model: "Sonnet 5", effort: "medium",
  });
  const reported = store.runtimeLadder({
    agentId: agent.id, taskId: task.id,
    ladder: [
      { model: "Sonnet 5", effort: "medium" },
      { model: "Sonnet 5", effort: "high" },
      { model: "Opus 5", effort: "high" },
      { model: "Opus 5", effort: "maximum" },
    ],
  });
  assert.equal(reported.running, "Sonnet 5 · medium");
  assert.equal(reported.askForLadder, false, "a ladder just reported is not immediately stale");
  assert.equal(reported.ladder.length, 4);

  const plan = store.claimNextAssignment(agent.id);
  store.createAssignment({
    agentId: agent.id, taskId: task.id, title: "Rename the footer label",
    description: "Change one string.", role: "implementer", requiresWrite: true, paths: ["src/footer.js"],
  });
  const hard = store.createAssignment({
    agentId: agent.id, taskId: task.id, title: "Migrate the auth schema",
    description: "Rewrite authentication and session handling, migrate the schema, and reconcile concurrency and write leases across the whole codebase. Secrets and authorization boundaries are involved throughout.",
    role: "implementer", requiresWrite: true,
  });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned." });

  const easy = store.claimNextAssignment(agent.id);
  assert.equal(easy.title, "Rename the footer label", "the ordinary work is claimed as normal");
  await store.completeAssignment({ agentId: agent.id, assignmentId: easy.id, message: "Renamed.", changedFiles: ["src/footer.js"] });

  assert.equal(store.claimNextAssignment(agent.id), null, "the work above its rung is withheld, not handed over");
  assert.equal(store.getTask(task.id).status !== "blocked", true, "and withholding never blocks the task");

  const held = store.workAboveCurrentRung(agent.id);
  assert.equal(held.count, 1);
  assert.equal(held.running, "Sonnet 5 · medium");
  assert.deepEqual(held.needs, ["Opus 5 · high"]);
  assert.match(held.message, /needs Opus 5 · high/);
  assert.equal(held.assignments[0].title, "Migrate the auth schema");

  // A fresh session on the stronger model joins the same task and picks up exactly that work. No
  // replanning, no new task, same history.
  const strong = store.connectAgent({
    name: "Claude", provider: "Anthropic Claude Code", freshTaskId: task.id,
    model: "Opus 5", effort: "maximum",
  });
  store.joinTask(strong.id, task.id, "contributor");
  const claimed = store.claimNextAssignment(strong.id);
  assert.equal(claimed.id, hard.id, "the stronger session takes the work the weaker one left");
  assert.equal(store.workAboveCurrentRung(strong.id), null, "and nothing is above its rung");
});

test("with no ladder reported, or a model that is not on it, nothing is ever withheld", async (t) => {
  // Silence has to mean the team keeps working. One unreported field must not stall a board.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-ladder-silent-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-ladder-silent-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    for (const dir of [dataDir, projectRoot]) await rm(dir, { recursive: true, force: true });
  });
  const project = store.ensureProject("Silent", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "No ladder", description: "Nobody reported one." });
  const agent = store.connectAgent({ name: "Quiet", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  store.createAssignment({
    agentId: agent.id, taskId: task.id, title: "Migrate the auth schema",
    description: "Rewrite authentication and session handling, migrate the schema, and reconcile concurrency and write leases across the whole codebase. Secrets and authorization boundaries are involved throughout.",
    role: "implementer", requiresWrite: true,
  });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, message: "Planned." });

  const claimed = store.claimNextAssignment(agent.id);
  assert.equal(claimed?.title, "Migrate the auth schema", "no ladder means no judgement, and no judgement never withholds");
  assert.equal(store.workAboveCurrentRung(agent.id), null);

  // A ladder that does not mention the model this session is running is the same situation.
  const stranger = store.connectAgent({ name: "Stranger", provider: "test", freshTaskId: task.id, model: "Mystery 9", effort: "high" });
  store.runtimeLadder({
    agentId: stranger.id, taskId: task.id,
    ladder: [{ model: "Sonnet 5", effort: "medium" }, { model: "Opus 5", effort: "high" }],
  });
  const status = store.runtimeLadder({ agentId: stranger.id, taskId: task.id });
  assert.equal(status.running, null, "an unrecognised model is reported as unknown");
  assert.equal(store.workAboveCurrentRung(stranger.id), null, "and still nothing is withheld");
});

test("a ladder the human has taken ownership of is never overwritten by an agent", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-ladder-human-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-ladder-human-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    for (const dir of [dataDir, projectRoot]) await rm(dir, { recursive: true, force: true });
  });
  const project = store.ensureProject("Human ladder", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Owned", description: "The human wrote the file." });
  const agent = store.connectAgent({ name: "Claude", provider: "test", freshTaskId: task.id, model: "Sonnet 5", effort: "medium" });

  await mkdir(path.join(projectRoot, ".devteam"), { recursive: true });
  await writeFile(path.join(projectRoot, ".devteam", "models.json"), JSON.stringify({
    source: "human",
    providers: { test: { ladder: [{ model: "Sonnet 5", effort: "medium" }, { model: "Opus 5", effort: "high" }] } },
  }), "utf8");

  const result = store.runtimeLadder({
    agentId: agent.id, taskId: task.id,
    ladder: [{ model: "Something Else", effort: "low" }],
  });
  assert.equal(result.ladderSaved, false);
  assert.equal(result.notSaved, "human-owned");
  assert.deepEqual(result.ladder, ["Sonnet 5 · medium", "Opus 5 · high"], "the human's file stands");
  assert.equal(result.askForLadder, false, "and a human-owned ladder never goes stale");
});
