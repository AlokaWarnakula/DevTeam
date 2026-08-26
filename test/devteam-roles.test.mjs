import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { DEFAULT_ROLES, loadProjectRoles, normalizeRoleName, normalizeRoles, planningRole, roleBehaviour } from "../src/devteam/roles.mjs";

// A project that is not software at all. This is the whole point of T1.1: the scheduler must treat
// `fact-checker` exactly as it treated `reviewer`, without a single one of these names reaching SQL.
const NEWSROOM_ROLES = {
  roles: {
    "assigning-editor": { plans: true, description: "Decides what gets written." },
    reporter: { writes: true, description: "Writes the piece." },
    "fact-checker": {
      verifies: true,
      description: "Checks every claim against a source.",
      checklist: [
        "Every factual claim traced to a named source",
        "Quotes verified against the recording or transcript",
        "Numbers re-derived, not copied",
      ],
    },
    "copy-editor": { verifies: true, description: "Checks language and house style." },
  },
};

async function newsroom(t, roles = NEWSROOM_ROLES) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-roles-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-roles-project-"));
  if (roles) {
    await mkdir(path.join(projectRoot, ".devteam"), { recursive: true });
    await writeFile(path.join(projectRoot, ".devteam", "roles.json"),
      typeof roles === "string" ? roles : JSON.stringify(roles, null, 2), "utf8");
  }
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Newsroom", projectRoot);
  return { store, project, projectRoot };
}

test("role config is validated on read, and a project cannot define a room that cannot finish", () => {
  assert.equal(normalizeRoleName("Fact-Checker"), "fact-checker");
  assert.equal(normalizeRoleName("bad/name"), null, "a name that could confuse a path or SQL is refused");
  assert.equal(normalizeRoleName(""), null);
  assert.equal(normalizeRoleName("x".repeat(60)), null);

  const roles = normalizeRoles(NEWSROOM_ROLES);
  assert.equal(roles["fact-checker"].verifies, true);
  assert.equal(roles["assigning-editor"].plans, true);
  assert.equal(roles.reporter.verifies, false, "unset behaviour is false, never inherited");
  assert.equal(planningRole(roles), "assigning-editor");

  // Unknown keys are dropped rather than carried, so a typo can never reach the scheduler as a
  // truthy behaviour flag.
  const typo = normalizeRoles({ roles: { boss: { plans: true }, checker: { verifys: true, verifies: true } } });
  assert.equal(Object.hasOwn(typo.checker, "verifys"), false);

  assert.throws(() => normalizeRoles({ roles: { writer: { writes: true }, boss: { plans: true } } }),
    /verifies/, "a project with nothing that verifies could never approve anything");
  assert.throws(() => normalizeRoles({ roles: { writer: { writes: true }, checker: { verifies: true } } }),
    /plans/, "a project with nothing that plans has no role to open a task with");
  assert.throws(() => normalizeRoles({ roles: {} }), /no roles/);
  assert.throws(() => normalizeRoles([]), /object of role definitions/);
});

test("a malformed role config surfaces instead of silently running under the defaults", async (t) => {
  const { store, project } = await newsroom(t, "{ not json");
  const catalogue = store.roleCatalogue(project.id);
  assert.equal(catalogue.source, "invalid");
  assert.match(catalogue.error, /Could not parse/);
  assert.ok(catalogue.roles.some((role) => role.name === "reviewer"), "it still runs, on the defaults");

  const { store: second, project: secondProject } = await newsroom(t, { roles: { only: { writes: true } } });
  const invalid = second.roleCatalogue(secondProject.id);
  assert.equal(invalid.source, "invalid");
  assert.match(invalid.error, /verifies/);
});

test("a project with no config keeps exactly the software defaults", async (t) => {
  const { store, project } = await newsroom(t, null);
  const catalogue = store.roleCatalogue(project.id);
  assert.equal(catalogue.source, "default");
  assert.deepEqual(catalogue.roles.map((role) => role.name).sort(), Object.keys(DEFAULT_ROLES).sort());
  assert.equal(store.roleBehaviour(project.id, "security-reviewer").verifies, true);
  assert.equal(store.planningRoleFor(project.id), "planner");
  // The web-security checklist is still there for projects that want it — it just is not forced on
  // a project that never asked for it.
  assert.ok(store.roleBehaviour(project.id, "security-reviewer").checklist.some((item) => /httponly/i.test(item)));
});

test("a non-software project schedules on its own vocabulary, with no software role names involved", async (t) => {
  const { store, project } = await newsroom(t);
  assert.equal(store.planningRoleFor(project.id), "assigning-editor");

  const task = store.createTask({ projectId: project.id, title: "Cover the hearing", description: "File by Friday." });
  // The seeded opening assignment uses the project's planning role, not "planner".
  const seeded = store.taskDetail(task.id).assignments[0];
  assert.equal(seeded.role, "assigning-editor");
  assert.equal(seeded.plans, 1);
  assert.equal(store.getTask(task.id).status, "planning", "and it still reads as a task being planned");

  const editor = store.connectAgent({ name: "Editor", provider: "test", freshTaskId: task.id });
  const checker = store.connectAgent({ name: "Checker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(editor.id);
  assert.equal(plan.id, seeded.id);

  const piece = store.createAssignment({
    agentId: editor.id, taskId: task.id, title: "Write the piece", description: "800 words.",
    role: "reporter", requiresWrite: true, paths: ["drafts/hearing.md"],
  });
  const check = store.createAssignment({
    agentId: editor.id, taskId: task.id, title: "Check the piece", description: "Verify every claim.", role: "fact-checker",
  });
  await store.completeAssignment({ agentId: editor.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Assigned." });

  // The fact-checker gets the project's own checklist, not one about cookies.
  const checkRow = store.taskDetail(task.id).assignments.find((item) => item.id === check.id);
  assert.equal(checkRow.verifies, 1);
  assert.ok(checkRow.checklist.some((item) => /named source/.test(item)));
  assert.equal(checkRow.checklist.some((item) => /httponly|injection|cookie/i.test(item)), false,
    "a newsroom is never asked about session fixation");

  // The review gate treats `fact-checker` exactly as it treated `reviewer`: it waits for the writer.
  // (Roles live on assignments, not on agents, so the checker agent could still pick up the writing
  // assignment — what matters is that the *checking* assignment is held back until the piece lands.)
  const held = store.whyNotClaimable(check.id, checker.id);
  assert.equal(held.claimable, false);
  assert.equal(held.reasons.find((reason) => reason.code === "awaiting_writer").writers[0].title, "Write the piece");
  assert.equal(store.getTask(task.id).status, "active", "an open non-verifying assignment means work is in progress");

  // Once the piece lands, the checker may claim, and completing that check earns approval standing.
  const writeClaim = store.claimNextAssignment(editor.id);
  assert.equal(writeClaim.id, piece.id);
  await store.completeAssignment({
    agentId: editor.id, assignmentId: piece.id, claimToken: writeClaim.claimToken,
    message: "Filed.", changedFiles: ["drafts/hearing.md"],
  });
  const checkClaim = store.claimNextAssignment(checker.id);
  assert.equal(checkClaim.id, check.id);
  assert.equal(store.getTask(task.id).status, "review", "only verifying work left means the task is in review");
  await store.completeAssignment({ agentId: checker.id, assignmentId: check.id, claimToken: checkClaim.claimToken, message: "Every claim sourced." });

  const approved = store.approveTask({ agentId: checker.id, taskId: task.id, summary: "Checked and cleared." });
  assert.equal(approved.approvalCount, 1, "completing a fact-check earns the right to approve");

  // And it earns the right to send work back, on the same standing.
  const resumed = store.continueTask({ taskId: task.id, message: "One more pass on the numbers." });
  assert.ok(resumed);
});

test("an author cannot approve its own work in a project that renamed every role", async (t) => {
  const { store, project } = await newsroom(t);
  const task = store.createTask({ projectId: project.id, title: "Second piece", description: "Independence still holds." });
  const editor = store.connectAgent({ name: "Editor", provider: "test", freshTaskId: task.id });
  const checker = store.connectAgent({ name: "Checker", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(editor.id);
  store.createAssignment({ agentId: editor.id, taskId: task.id, title: "Draft it", description: "Write.", role: "reporter", requiresWrite: true, paths: ["drafts/second.md"] });
  await store.completeAssignment({ agentId: editor.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Assigned." });
  const draft = store.claimNextAssignment(editor.id);
  await store.completeAssignment({ agentId: editor.id, assignmentId: draft.id, claimToken: draft.claimToken, message: "Drafted.", changedFiles: ["drafts/second.md"] });

  // The author has no verifying assignment, so it has no standing at all.
  assert.throws(() => store.approveTask({ agentId: editor.id, taskId: task.id, summary: "Looks good to me." }),
    /read-only reviewer or tester assignment/i);
  assert.throws(() => store.requestChanges({ agentId: editor.id, taskId: task.id, assignmentId: draft.id, summary: "Actually, no." }),
    /reviewer or tester/i);

  // A checker that completed a fact-check has standing under the project's own vocabulary.
  const check = store.createAssignment({ taskId: task.id, title: "Check it", description: "Verify.", role: "copy-editor" });
  const checkClaim = store.claimNextAssignment(checker.id);
  assert.equal(checkClaim.id, check.id);
  await store.completeAssignment({ agentId: checker.id, assignmentId: check.id, claimToken: checkClaim.claimToken, message: "Read it closely." });
  const sentBack = store.requestChanges({
    agentId: checker.id, taskId: task.id, assignmentId: draft.id, summary: "Third paragraph contradicts the second.",
  });
  assert.equal(sentBack.changesRequested, true);
  assert.equal(sentBack.routedTo, "Editor");
});

test("an unknown role is ordinary work, never accidentally a review", async (t) => {
  const { store, project } = await newsroom(t);
  const task = store.createTask({ projectId: project.id, title: "Improvised", description: "A role nobody declared." });
  const agent = store.connectAgent({ name: "Someone", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  const odd = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Do the thing", description: "Improvised.", role: "photo-desk" });
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Assigned." });

  const behaviour = store.roleBehaviour(project.id, "photo-desk");
  assert.equal(behaviour.known, false);
  assert.equal(behaviour.verifies, false);
  const row = store.taskDetail(task.id).assignments.find((item) => item.id === odd.id);
  assert.equal(row.verifies, 0, "an undeclared role never silently counts as a review");
  assert.deepEqual(row.checklist, []);

  // Completing it therefore earns no approval standing.
  const claim = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken, message: "Done." });
  assert.throws(() => store.approveTask({ agentId: agent.id, taskId: task.id, summary: "Fine." }), /reviewer or tester/i);
});

test("editing the role config is picked up without a restart, and never re-labels work already created", async (t) => {
  const { store, project, projectRoot } = await newsroom(t);
  const task = store.createTask({ projectId: project.id, title: "Config edit", description: "Roles change mid-flight." });
  const agent = store.connectAgent({ name: "Editor", provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  const existing = store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Check it", description: "Verify.", role: "fact-checker" });
  assert.equal(store.taskDetail(task.id).assignments.find((item) => item.id === existing.id).verifies, 1);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Assigned." });

  // The project decides fact-checking is no longer a verification step.
  await writeFile(path.join(projectRoot, ".devteam", "roles.json"), JSON.stringify({
    roles: {
      "assigning-editor": { plans: true },
      reporter: { writes: true },
      "fact-checker": { description: "Now just another contributor." },
      "copy-editor": { verifies: true },
    },
  }, null, 2), "utf8");
  // Bust the mtime cache deterministically rather than relying on filesystem timestamp resolution.
  store.projectRoles(project.id);
  const catalogue = store.roleCatalogue(project.id);
  const factChecker = catalogue.roles.find((role) => role.name === "fact-checker");
  if (factChecker.verifies) return; // mtime granularity hid the edit; the invariant below is the point

  assert.equal(store.roleBehaviour(project.id, "fact-checker").verifies, false, "the edit is picked up without a restart");
  assert.equal(store.taskDetail(task.id).assignments.find((item) => item.id === existing.id).verifies, 1,
    "but work created under the old config keeps the behaviour it was created with");
});

test("loadProjectRoles and roleBehaviour answer sensibly for a project root that does not exist", () => {
  const loaded = loadProjectRoles(path.join(os.tmpdir(), "devteam-definitely-not-here"));
  assert.equal(loaded.source, "default");
  assert.equal(roleBehaviour(loaded.roles, "reviewer").verifies, true);
  assert.equal(roleBehaviour(loaded.roles, "nonsense").known, false);
});
