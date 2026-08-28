import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findingSignature, KnowledgeVault, rankKnowledgeNotes } from "../src/devteam/knowledge.mjs";
import { DevTeamStore } from "../src/devteam/store.mjs";

const base = {
  category: "components",
  body: "General implementation detail.",
  status: "verified",
  confidence: "high",
  source_task_id: "older-task",
  source_event_id: 1,
  relatedFiles: [],
  updated_at: "2026-08-01T00:00:00.000Z",
  verified_at: "2026-08-01T00:00:00.000Z",
  last_validated_at: "2026-08-01T00:00:00.000Z",
  last_validated_version: 1,
  source_metadata: "{}",
};

test("knowledge relevance prefers task paths and goals over unrelated recency", () => {
  const notes = [
    { ...base, id: "recent-unrelated", title: "Recent unrelated dashboard color", relatedFiles: ["public/theme.css"], updated_at: "2026-08-24T00:00:00.000Z" },
    { ...base, id: "older-relevant", title: "Authentication token validation", body: "Validate the session token before accepting a request.", relatedFiles: ["src/auth/session.mjs"], updated_at: "2026-06-01T00:00:00.000Z" },
    { ...base, id: "inferred", title: "Authentication guess", status: "inferred", relatedFiles: ["src/auth/session.mjs"] },
  ];
  const context = {
    taskId: "new-task",
    taskTitle: "Fix authentication session validation",
    taskDescription: "Correct token checks.",
    taskVersion: 1,
    taskUpdatedAt: "2026-08-24T00:00:00.000Z",
    assignmentTitle: "Repair auth session",
    role: "implementer",
    declaredPaths: ["src/auth/session.mjs"],
  };
  const first = rankKnowledgeNotes(notes, context, 3);
  const second = rankKnowledgeNotes(notes, context, 3);
  assert.deepEqual(first, second);
  assert.equal(first[0].id, "older-relevant");
  assert.match(first[0].whyIncluded, /declared path/);
  assert.ok(first.findIndex((note) => note.id === "inferred") > first.findIndex((note) => note.id === "older-relevant"));
});

test("knowledge selection limits one category and preserves useful diversity", () => {
  const components = Array.from({ length: 8 }, (_, index) => ({
    ...base,
    id: `component-${index}`,
    title: `Parser component ${index}`,
    body: "Parser implementation and validation.",
    relatedFiles: [`src/parser/${index}.mjs`],
  }));
  const diverse = [
    { ...base, id: "architecture", category: "architecture", title: "Parser boundaries" },
    { ...base, id: "conventions", category: "conventions", title: "Parser error conventions" },
    { ...base, id: "pitfall", category: "pitfalls", title: "Parser recursion pitfall" },
  ];
  const selected = rankKnowledgeNotes([...components, ...diverse], {
    taskId: "new-task",
    taskTitle: "Improve parser validation",
    role: "reviewer",
    taskUpdatedAt: "2026-08-24T00:00:00.000Z",
  }, 6);
  assert.ok(selected.filter((note) => note.category === "components").length <= 2);
  assert.ok(new Set(selected.map((note) => note.category)).size >= 3);
});

test("a new task briefing ranks older path-relevant project knowledge before newer noise", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-relevance-integration-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Relevance integration", process.cwd());
  const task = store.createTask({ projectId: project.id, title: "Fix authentication sessions", description: "Correct token validation." });
  const agent = store.connectAgent({ name: "Writer", provider: "test", freshTaskId: task.id });
  const planner = store.claimNextAssignment(agent.id);
  store.createAssignment({ agentId: agent.id, taskId: task.id, title: "Repair session validation", description: "Edit the authentication session module.", role: "implementer", requiresWrite: true, paths: ["src/auth/session.mjs"] });
  await store.completeAssignment({ agentId: agent.id, assignmentId: planner.id, claimToken: planner.claimToken, message: "Planned." });
  const claim = store.claimNextAssignment(agent.id);
  const insert = store.db.prepare(`
    INSERT INTO knowledge_notes (
      id, project_id, category, slug, title, body, status, confidence, source_task_id,
      source_event_id, source_author, related_files, provenance, created_at, updated_at,
      verified_at, revision, status_changed_at, last_validated_at, last_validated_version
    ) VALUES (?, ?, 'components', ?, ?, ?, 'verified', 'high', NULL, NULL, 'fixture', ?, '[]', ?, ?, ?, 1, ?, ?, 1)
  `);
  insert.run("auth-note", project.id, "auth-note", "Authentication session contract", "Validate session tokens before accepting requests.", JSON.stringify(["src/auth/session.mjs"]), "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
  insert.run("theme-note", project.id, "theme-note", "Dashboard color refresh", "Recent visual styling change.", JSON.stringify(["public/theme.css"]), "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z");
  const brief = store.taskBrief(agent.id, task.id, { currentAssignment: claim });
  assert.equal(brief.projectKnowledge[0].id, "auth-note");
  assert.match(brief.projectKnowledge[0].whyIncluded, /declared path/);
});

// --- T3.1 / T3.4: agent-writable notes and a backlink index -------------------------------------

async function vaultFixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-vault-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-vault-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  t.after(async () => {
    try { store.close(); } catch { /* some tests close early */ }
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const project = store.ensureProject("Vault project", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Learn things", description: "Record what we find." });
  const agent = store.connectAgent({ name: "Scout", provider: "test", freshTaskId: task.id });
  return { store, project, task, agent, projectRoot };
}

test("an agent can record what it learned, and it comes back through ordinary retrieval", async (t) => {
  const { store, task, agent, projectRoot } = await vaultFixture(t);
  const written = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "pitfalls",
    title: "The billing API rate-limits at 30 requests per minute",
    body: "Bulk imports must batch. The limit is per API key, not per IP, so parallel workers share it. Related: [[conventions/retry-policy]].",
    confidence: "high",
    relatedFiles: ["src/billing.mjs"],
  });
  assert.equal(written.written, true);
  assert.equal(written.note.category, "pitfalls");
  assert.equal(written.note.status, "inferred", "an agent asserting something is never 'verified'");
  assert.equal(written.note.confidence, "high");
  assert.match(written.note.link, /^\[\[pitfalls\//);

  // It is a real vault note: searchable, and on disk in the Obsidian vault.
  const found = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "rate-limits" });
  assert.equal(found.notes.length, 1);
  assert.match(found.notes[0].title, /30 requests per minute/);
  const onDisk = await readdir(path.join(projectRoot, "knowledge", "pitfalls"));
  assert.ok(onDisk.length >= 1, "a written note is exported to the vault like any other");

  // The event trail says who claimed it, so the note and the timeline agree.
  const finding = store.taskDetail(task.id).events.find((event) => event.type === "agent.finding" && event.metadata?.knowledgeNote);
  assert.ok(finding);
  assert.equal(finding.author_name, "Scout");
});

test("a written note is redacted and validated exactly like a derived one", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  const written = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "conventions",
    title: "Auth uses a shared key",
    body: "The staging key is API_KEY=super-secret-value and must never be committed.",
  });
  assert.equal(written.written, true);
  const note = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "shared key" }).notes[0];
  assert.doesNotMatch(note.body, /super-secret-value/, "a secret an agent pastes in is redacted, not stored");
  assert.match(note.body, /REDACTED/);

  assert.throws(() => store.knowledgeWrite({ agentId: agent.id, taskId: task.id, category: "sessions", title: "x", body: "y" }),
    /Unknown knowledge category/, "DevTeam's own bookkeeping categories are not writable");
  assert.throws(() => store.knowledgeWrite({ agentId: agent.id, taskId: task.id, category: "pitfalls", title: "", body: "y" }), /title/);
  assert.throws(() => store.knowledgeWrite({ agentId: agent.id, taskId: task.id, category: "pitfalls", title: "x", body: "  " }), /body/);
});

test("wikilinks are indexed both ways, including ones written before their target exists", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  // The pitfall references a convention note that does not exist yet — a forward reference.
  const pitfall = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "pitfalls",
    title: "Parallel imports trip the rate limit",
    body: "See [[conventions/retry-policy]] for how we back off.",
  });
  const forward = store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: pitfall.note.id });
  assert.equal(forward.links.length, 1);
  assert.equal(forward.links[0].target, "conventions/retry-policy");
  assert.equal(forward.links[0].resolved, false, "it points somewhere real, it just is not written yet");

  // Writing the target resolves the existing link without touching the note that wrote it.
  const convention = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "conventions",
    title: "Retry policy", body: "Exponential backoff capped at 30s.",
  });
  const resolved = store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: pitfall.note.id });
  assert.equal(resolved.links[0].resolved, true);
  assert.equal(resolved.links[0].noteId, convention.note.id);

  // And the convention now knows what depends on it — the whole point of the index.
  const back = store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: convention.note.id });
  assert.equal(back.backlinks.length, 1);
  assert.equal(back.backlinks[0].id, pitfall.note.id);
  assert.match(back.backlinks[0].title, /Parallel imports/);

  // Backlinks travel with search results, so a note is read together with what depends on it.
  const searched = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "Retry policy" });
  assert.equal(searched.notes.find((note) => note.id === convention.note.id).backlinks.length, 1);
});

test("rewriting a note replaces its links rather than accumulating them", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  store.knowledgeWrite({ agentId: agent.id, taskId: task.id, category: "conventions", title: "First target", body: "a" });
  store.knowledgeWrite({ agentId: agent.id, taskId: task.id, category: "conventions", title: "Second target", body: "b" });
  const source = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "architecture",
    title: "How it fits", body: "Depends on [[conventions/first-target]].",
  });
  assert.deepEqual(store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: source.note.id }).links.map((link) => link.target),
    ["conventions/first-target"]);

  // Same title → same slug → same note, rewritten to point elsewhere.
  store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "architecture",
    title: "How it fits", body: "Actually depends on [[conventions/second-target]].",
  });
  const after = store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: source.note.id });
  assert.deepEqual(after.links.map((link) => link.target), ["conventions/second-target"],
    "the stale edge is gone, not merely joined by a new one");

  const orphaned = store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: KnowledgeVault.noteId(store.listProjects()[0].id, "conventions", "first-target") });
  assert.equal(orphaned.backlinks.length, 0);
});

test("a self-link is not a backlink, and duplicate links collapse", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  const note = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "decisions",
    title: "Use one exporter",
    body: "See [[decisions/use-one-exporter]] — that is this note. Also [[architecture/runtime]] and [[architecture/runtime|the runtime]] and a bare [[architecture]].",
  });
  const links = store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: note.note.id });
  assert.equal(links.backlinks.length, 0, "a note referencing itself is noise, not a backlink");
  const targets = links.links.map((link) => link.target);
  assert.equal(targets.filter((target) => target === "architecture/runtime").length, 1, "the |label form is the same edge");
  assert.ok(targets.includes("architecture"), "a bare category link is recorded, just not as a note edge");
  assert.equal(links.links.find((link) => link.target === "architecture").noteId, null);
});

test("knowledge links are scoped to the room's project and are not an existence oracle", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  const other = store.ensureProject("Other project", await mkdtemp(path.join(os.tmpdir(), "devteam-vault-other-")));
  const otherTask = store.createTask({ projectId: other.id, title: "Elsewhere", description: "Not yours." });
  const otherAgent = store.connectAgent({ name: "Outsider", provider: "test", freshTaskId: otherTask.id });
  const secret = store.knowledgeWrite({
    agentId: otherAgent.id, taskId: otherTask.id, category: "decisions", title: "Their private decision", body: "Not for you.",
  });

  assert.throws(() => store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: secret.note.id }),
    /Note not found in this project/);
  // A note that does not exist at all answers identically, so this cannot enumerate another vault.
  assert.throws(() => store.knowledgeLinks({ agentId: agent.id, taskId: task.id, noteId: "0".repeat(24) }),
    /Note not found in this project/);
  assert.throws(() => store.knowledgeWrite({ agentId: agent.id, taskId: otherTask.id, category: "pitfalls", title: "x", body: "y" }),
    /not a member/i);
});

test("retrieval ranks by relevance rather than recency, and still finds fragments", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  // A note squarely about the topic, written first.
  store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "pitfalls",
    title: "Rate limiting on the billing API",
    body: "The billing API rate limit is 30 requests per minute per key. Batch bulk work.",
  });
  // Then several newer notes that mention it only in passing. Under recency ordering these would
  // all outrank the note above, which is exactly the failure mode BM25 exists to fix.
  for (const index of [1, 2, 3, 4]) {
    store.knowledgeWrite({
      agentId: agent.id, taskId: task.id, category: "workflows",
      title: `Unrelated workflow ${index}`,
      body: `Deploy step ${index}. Occasionally we hit a rate limit here, but that is not the topic.`,
    });
  }

  const ranked = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "billing API rate limit" });
  assert.ok(ranked.notes.length >= 1);
  assert.match(ranked.notes[0].title, /Rate limiting on the billing API/,
    "the note the query is about outranks four newer ones that merely mention it");

  // Multi-term queries rank a note matching more of them higher.
  const specific = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "requests per minute" });
  assert.match(specific.notes[0].title, /Rate limiting/);

  // Prose queries cannot become FTS operators. Each of these is a syntax error if passed raw.
  for (const hostile of ['billing AND "', "NEAR(a b", "rate -limit", "*", '"""', "OR OR OR"]) {
    assert.doesNotThrow(() => store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: hostile }),
      `a query like ${JSON.stringify(hostile)} must never reach SQLite as syntax`);
  }

  // FTS matches whole tokens, so a fragment inside a word falls through to the substring fallback
  // rather than returning nothing.
  const fragment = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "illing" });
  assert.ok(fragment.notes.some((note) => /billing/i.test(note.title)), "a fragment still finds its note");
});

// --- T3.2 / T3.5 / T3.6: contradictions, decay, and lessons that travel ---------------------------

test("a note that disagrees with what the project already believes says so on write", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  const first = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "conventions",
    title: "Retry policy for the billing client",
    body: "We retry three times with exponential backoff.",
    relatedFiles: ["src/billing.mjs"],
  });
  // Same subject, different claim.
  const second = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "conventions",
    title: "Retry policy for the billing client, revised",
    body: "We do not retry at all; the caller decides.",
    relatedFiles: ["src/billing.mjs"],
  });
  assert.ok(second.possibleConflicts?.length, "the disagreement is surfaced while the author is still here");
  assert.equal(second.possibleConflicts[0].id, first.note.id);
  assert.match(second.conflictNext, /do not leave two contradictory facts/i);

  // An unrelated note in the same category is not a conflict.
  const unrelated = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "conventions",
    title: "Commit messages use the imperative mood", body: "Add the thing, not Added the thing.",
  });
  assert.equal(unrelated.possibleConflicts ?? undefined, undefined);

  // Acting on it: both drop out of ordinary retrieval until someone decides.
  const disputed = store.knowledgeDispute({
    agentId: agent.id, taskId: task.id,
    noteIds: [first.note.id, second.note.id], reason: "One says retry three times, the other says never.",
  });
  assert.equal(disputed.disputed, 2);
  const searched = store.knowledgeSearch({ agentId: agent.id, taskId: task.id, query: "retry policy billing" });
  assert.equal(searched.notes.some((note) => note.id === first.note.id), false,
    "better a gap than confidently serving one of two contradictory facts");
  assert.equal(store.knowledgeMaintenance({ agentId: agent.id, taskId: task.id }).disputed.length, 2);
  assert.throws(() => store.knowledgeDispute({ agentId: agent.id, taskId: task.id, noteIds: [first.note.id], reason: "x" }), /at least two/i);
});

test("unconfirmed knowledge decays in ranking, and confirming it makes it current again", async (t) => {
  const { store, task, agent } = await vaultFixture(t);
  const written = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "pitfalls",
    title: "The importer chokes on BOM-prefixed CSV", body: "Strip the BOM before parsing.",
  });
  assert.equal(KnowledgeVault.ageWeight(new Date().toISOString()), 1);
  assert.ok(KnowledgeVault.ageWeight(new Date(Date.now() - 120 * 86_400_000).toISOString()) <= 0.51,
    "a note unconfirmed for one half-life is worth about half as much");
  assert.equal(KnowledgeVault.ageWeight("not a date"), 0.5, "unknown age is neither fresh nor stale");

  // Age it well past the staleness threshold.
  store.db.prepare("UPDATE knowledge_notes SET verified_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 300 * 86_400_000).toISOString(), new Date(Date.now() - 300 * 86_400_000).toISOString(), written.note.id);

  const maintenance = store.knowledgeMaintenance({ agentId: agent.id, taskId: task.id, olderThanDays: 90 });
  assert.equal(maintenance.stale.length, 1);
  assert.equal(maintenance.stale[0].id, written.note.id);
  assert.ok(maintenance.stale[0].ageWeight < 0.3);
  assert.match(maintenance.stale[0].next, /Confirm it against the project/);

  const confirmed = store.knowledgeConfirm({ agentId: agent.id, taskId: task.id, noteId: written.note.id });
  assert.equal(confirmed.confirmed, true);
  assert.equal(store.knowledgeMaintenance({ agentId: agent.id, taskId: task.id, olderThanDays: 90 }).stale.length, 0,
    "confirming resets the age, because checking it is what makes it current");
  assert.throws(() => store.knowledgeConfirm({ agentId: agent.id, taskId: task.id, noteId: "0".repeat(24) }), /not found/i);
});

test("a lesson can be carried to another project, but only the kinds that travel", async (t) => {
  const { store, task, agent, projectRoot } = await vaultFixture(t);
  const pitfall = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "pitfalls",
    title: "This vendor API silently truncates at 1000 rows", body: "Page it, or you lose data with no error.",
  });
  const architecture = store.knowledgeWrite({
    agentId: agent.id, taskId: task.id, category: "architecture",
    title: "The importer runs in-process", body: "No queue; it is called directly from the handler.",
  });

  assert.throws(() => store.knowledgeShare({ agentId: agent.id, taskId: task.id, noteId: architecture.note.id }),
    /cannot be true elsewhere/i, "an architecture note is about this system in particular");
  const shared = store.knowledgeShare({ agentId: agent.id, taskId: task.id, noteId: pitfall.note.id });
  assert.equal(shared.shared, true);

  // A second project sees it, labeled as borrowed.
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-vault-borrower-"));
  t.after(async () => { await rm(otherRoot, { recursive: true, force: true }); });
  const otherProject = store.ensureProject("Borrowing project", otherRoot);
  const otherTask = store.createTask({ projectId: otherProject.id, title: "Elsewhere", description: "Different project." });
  const otherAgent = store.connectAgent({ name: "Borrower", provider: "test", freshTaskId: otherTask.id });

  const borrowed = store.knowledgeShared({ agentId: otherAgent.id, taskId: otherTask.id });
  assert.equal(borrowed.notes.length, 1);
  assert.match(borrowed.notes[0].title, /truncates at 1000/);
  assert.equal(borrowed.notes[0].fromProject, "Vault project");
  assert.match(borrowed.notes[0].note, /Confirm it applies here/);

  // The borrowing project's own knowledge is unaffected: sharing is a separate, asked-for surface.
  assert.equal(store.knowledgeSearch({ agentId: otherAgent.id, taskId: otherTask.id, query: "truncates" }).notes.length, 0);
  // And the sharing project does not see its own note as borrowed.
  assert.equal(store.knowledgeShared({ agentId: agent.id, taskId: task.id }).notes.length, 0);
  assert.ok(projectRoot);

  // Withdrawing works.
  store.knowledgeShare({ agentId: agent.id, taskId: task.id, noteId: pitfall.note.id, shared: false });
  assert.equal(store.knowledgeShared({ agentId: otherAgent.id, taskId: otherTask.id }).notes.length, 0);
});

test("a second database pointed at the same project root cannot delete the first one's vault", async (t) => {
  // This is not hypothetical: `ensureProject(name, process.cwd())` in a knowledge-enabled test is a
  // second database pointed at this repository, and running the suite deleted all 64 notes this
  // project had accumulated. The notes live in SQLite and were re-exported, but the Markdown is what
  // a human and an editor actually read, and it was gone.
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-shared-root-"));
  const ownerData = await mkdtemp(path.join(os.tmpdir(), "devteam-owner-data-"));
  const strangerData = await mkdtemp(path.join(os.tmpdir(), "devteam-stranger-data-"));
  const owner = new DevTeamStore(ownerData, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  const stranger = new DevTeamStore(strangerData, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  t.after(async () => {
    owner.close();
    stranger.close();
    for (const dir of [projectRoot, ownerData, strangerData]) await rm(dir, { recursive: true, force: true });
  });

  const ownerProject = owner.ensureProject("The real project", projectRoot);
  owner.knowledge.write({
    projectId: ownerProject.id, category: "pitfalls", title: "Never run the migration twice",
    body: "The second run duplicates every historical grade.", author: "agent",
  });
  const firstExport = owner.knowledge.exportProject(ownerProject.id);
  assert.equal(firstExport.reconciled, true, "the first exporter claims the vault and cleans up after itself");
  const afterOwner = await readdir(path.join(projectRoot, "knowledge", "pitfalls"));
  assert.equal(afterOwner.length, 1, "the note is on disk");

  // A different database, same root, knowing nothing about that note.
  const strangerProject = stranger.ensureProject("A test that used the wrong root", projectRoot);
  const strangerExport = stranger.knowledge.exportProject(strangerProject.id);
  assert.equal(strangerExport.reconciled, false, "the stranger is refused the right to delete");
  assert.equal(strangerExport.foreignVault.project, "The real project", "and is told whose vault it is");

  const afterStranger = await readdir(path.join(projectRoot, "knowledge", "pitfalls"));
  assert.deepEqual(afterStranger, afterOwner, "the note survives an export from a database that never knew it");

  // The owner still cleans up its own obsolete files: the guard removes deletion for strangers, not
  // for the project the vault belongs to.
  owner.knowledge.write({
    projectId: ownerProject.id, category: "pitfalls", title: "Never run the migration twice",
    body: "Superseded body.", author: "agent",
  });
  const second = owner.knowledge.exportProject(ownerProject.id);
  assert.equal(second.reconciled, true, "the owner keeps its cleanup");
});

// One review cycle that ends in a request for changes, so findings are produced through the real
// path rather than inserted behind the store's back.
async function reviewCycle(store, project, label, findings) {
  const task = store.createTask({ projectId: project.id, title: label, description: `${label} description.` });
  const author = store.connectAgent({ name: `Author ${label}`, provider: "test", freshTaskId: task.id });
  const reviewer = store.connectAgent({ name: `Reviewer ${label}`, provider: "test", freshTaskId: task.id });
  const plan = store.claimNextAssignment(author.id);
  store.createAssignment({ agentId: author.id, taskId: task.id, title: "Build", description: "Implement it.", role: "implementer", requiresWrite: true });
  store.createAssignment({ agentId: author.id, taskId: task.id, title: "Review", description: "Read the diff.", role: "reviewer" });
  await store.completeAssignment({ agentId: author.id, assignmentId: plan.id, message: "Planned." });
  const work = store.claimNextAssignment(author.id);
  await store.completeAssignment({ agentId: author.id, assignmentId: work.id, message: "Implemented.", changedFiles: ["src/feature.mjs"] });
  const review = store.claimNextAssignment(reviewer.id);
  assert.equal(review.role, "reviewer", "the independent reviewer picks up the review");
  store.requestChanges({ agentId: reviewer.id, taskId: task.id, assignmentId: work.id, summary: "Sending this back.", findings });
  store.knowledge.syncTask(task.id);
  return { task, author, reviewer };
}

const conventionNotes = (store, projectId) => store.db
  .prepare("SELECT * FROM knowledge_notes WHERE project_id = ? AND category = 'conventions' ORDER BY slug")
  .all(projectId);

test("the same objection raised on separate tasks becomes a conventions note, quoting its evidence", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-conventions-data-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-conventions-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    for (const dir of [dataDir, projectRoot]) await rm(dir, { recursive: true, force: true });
  });
  const project = store.ensureProject("Conventions", projectRoot);

  // One thorough review raising the same point twice is one reviewer being thorough, not a rule.
  const first = await reviewCycle(store, project, "First", [
    { detail: "clamp the page size before the query runs", path: "src/list.mjs" },
    { detail: "page size must be clamped before querying", path: "src/list.mjs" },
    { detail: "rename helper", path: "src/list.mjs" },
  ]);
  assert.deepEqual(conventionNotes(store, project.id), [], "three findings inside one task write nothing");

  // The same objection on separate work is the signal.
  const second = await reviewCycle(store, project, "Second", [
    { detail: "the page size is not clamped before the query", path: "src/report.mjs" },
  ]);
  const notes = conventionNotes(store, project.id);
  assert.equal(notes.length, 1, "now it is a convention");
  assert.match(notes[0].title, /^Recurring review finding: /);
  assert.equal(notes[0].status, "proposed", "offered for confirmation, not asserted as settled");
  assert.match(notes[0].body, /3 times across 2 separate tasks/);
  assert.match(notes[0].body, /clamp the page size before the query runs/, "the body quotes the findings verbatim");
  assert.match(notes[0].body, /Reviewer First/, "and says who raised each one");
  const related = JSON.parse(notes[0].related_files);
  assert.ok(related.includes("src/list.mjs") && related.includes("src/report.mjs"), "both files are linked");

  // "rename helper" carries two significant words and no subject; it must never become a rule.
  assert.equal(notes.filter((note) => /rename/.test(note.title)).length, 0, "a finding too short to be about anything is ignored");

  const onDisk = await readdir(path.join(projectRoot, "knowledge", "conventions"));
  assert.equal(onDisk.length, 1, "and it reaches the vault on disk");

  // Evidence can go away — deleting a task takes its findings with it. A rule nobody can still
  // point at is archived rather than left standing as something the project agreed to.
  store.disconnectAgent(second.author.id, "Done.");
  store.disconnectAgent(second.reviewer.id, "Done.");
  store.deleteTask(second.task.id, second.task.id);
  store.knowledge.syncTask(first.task.id);
  assert.equal(conventionNotes(store, project.id)[0].status, "archived",
    "the note is retired once its evidence no longer clears the bar");
});

test("a finding signature groups the same objection and separates different ones", () => {
  const clamp = findingSignature("clamp the page size before the query runs");
  assert.equal(findingSignature("page size must be clamped before querying"), clamp, "tense and word order do not matter");
  assert.equal(findingSignature("the page size is not clamped before the query"), clamp);
  assert.notEqual(findingSignature("the retry backoff grows without an upper bound"), clamp, "a different subject is a different rule");
  assert.equal(findingSignature("rename helper"), null, "too few significant words to be about anything");
  assert.equal(findingSignature(""), null);
});

test("a brief spends its knowledge budget on breadth, not on three long notes", async (t) => {
  // Measured against the real vault before this changed: the ranker chose the best 30 notes out of
  // 626, handed back 46 KB, and the 6 KB knowledge budget admitted THREE. Twenty-seven ranked notes
  // were dropped for want of bytes on every single brief.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-knowledge-budget-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "devteam-knowledge-budget-project-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: true }, codegraph: { enabled: false } });
  t.after(async () => {
    store.close();
    for (const dir of [dataDir, projectRoot]) await rm(dir, { recursive: true, force: true });
  });
  const project = store.ensureProject("Budget", projectRoot);
  const task = store.createTask({ projectId: project.id, title: "Session tokens", description: "Validate session handling." });
  for (let index = 0; index < 30; index += 1) {
    store.knowledge.write({
      projectId: project.id, category: "pitfalls",
      title: `Session finding ${index}`,
      // A real note: a distinct claim, then a lot of evidence for it. The claims have to genuinely
      // differ — thirty notes asserting the same thing are contradictions, and the vault is right to
      // dispute them rather than serve them to anyone.
      body: `Session rule ${index}: validate claim ${index} before use. ${"Evidence and detail. ".repeat(90)}`,
      relatedFiles: ["src/auth/session.mjs"], author: "agent",
    });
  }
  const notes = store.knowledge.relevant(project.id, task.id, 30, { taskTitle: task.title, taskDescription: task.description, role: "implementer" });
  // The ranker returns what it judges relevant, not everything asked for. How many it returns is its
  // business; what this test is about is how many survive the byte budget afterwards.
  assert.ok(notes.length >= 10, `the ranker offered only ${notes.length} notes to budget`);

  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  let used = 0;
  let admitted = 0;
  for (const note of notes) {
    if (used + bytes(note) > 6_144) break;
    used += bytes(note);
    admitted += 1;
  }
  assert.ok(admitted >= 8, `only ${admitted} notes fit the 6 KiB knowledge budget; breadth regressed`);

  // Every note says what it claims, whether or not it carries its evidence.
  assert.ok(notes.every((note) => /^Session rule \d+: validate claim \d+ before use\.$/u.test(note.headline)),
    "every note leads with its own claim, evidence or not");
  assert.ok(notes.every((note) => note.link.startsWith("[[pitfalls/")), "and links to where the rest is");
  const withBodies = notes.filter((note) => note.body !== undefined);
  assert.ok(withBodies.length >= 1 && withBodies.length <= 4, "the few most relevant still arrive in full");
  assert.ok(notes.slice(withBodies.length).every((note) => note.body === undefined), "the tail pays nothing for a body");
});
