// Team memory and the knowledge vault: the blackboard notes a task or project carries, the vault
// notes agents write and confirm and dispute, and the code-graph queries that answer "what does this
// project already look like".
//
// A mixin on DevTeamStore.prototype, for the reasons in store-checks.mjs. The vault and the graph
// are real collaborators — this.knowledge and this.codegraph — and these methods are the thin,
// membership-checked layer between an agent and those two objects.
import path from "node:path";
import { fromJson, json, now } from "./util.mjs";

export const knowledgeMethods = {
  _noteScope(taskId, scope = "task") {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const cleanScope = scope === "project" ? "project" : "task";
    return cleanScope === "project"
      ? { scope: cleanScope, table: "project_blackboard", idColumn: "project_id", id: task.project_id }
      : { scope: cleanScope, table: "blackboard", idColumn: "task_id", id: taskId };
  },

  noteSet({ agentId = null, taskId, key, value, expectedVersion = null, scope = "task" }) {
    const target = this._noteScope(taskId, scope);
    this.assertMembership(agentId, taskId);
    const cleanKey = String(key || "").trim();
    if (!cleanKey) throw new Error("A blackboard key is required.");
    const cleanValue = typeof value === "string" ? value : json(value);
    if (cleanValue.length > 100_000) throw new Error("Blackboard value is too large (100k max).");
    const author = agentId ? this.getAgent(agentId) : null;
    const stamp = now();
    let result;
    this._transaction(() => {
      const current = this.db.prepare(`SELECT version FROM ${target.table} WHERE ${target.idColumn} = ? AND key = ?`).get(target.id, cleanKey);
      const currentVersion = current?.version || 0;
      if (expectedVersion !== null && Number(expectedVersion) !== currentVersion) {
        result = { ok: false, conflict: true, scope: target.scope, key: cleanKey, expectedVersion: Number(expectedVersion), currentVersion, nextAction: "Re-read this key with devteam_note_get using the same scope, merge your change onto the current value, and set it again with the version you just read." };
        return;
      }
      const nextVersion = currentVersion + 1;
      this.db.prepare(`
        INSERT INTO ${target.table} (${target.idColumn}, key, value, version, updated_by, updated_by_name, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(${target.idColumn}, key) DO UPDATE SET value = excluded.value, version = excluded.version, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at
      `).run(target.id, cleanKey, cleanValue, nextVersion, agentId, author?.name || "human", stamp);
      this._event(taskId, agentId, "blackboard.updated", `${target.scope === "project" ? "Project" : "Task"} memory "${cleanKey}" updated (v${nextVersion}).`, { scope: target.scope, key: cleanKey, version: nextVersion });
      result = { ok: true, scope: target.scope, key: cleanKey, version: nextVersion, updatedBy: author?.name || "human", updatedAt: stamp };
    });
    if (result.ok) this._changed("blackboard.updated", taskId);
    return result;
  },

  noteGet(taskId, key, scope = "task", agentId = null) {
    const target = this._noteScope(taskId, scope);
    if (agentId) this.assertMembership(agentId, taskId);
    const row = this.db.prepare(`SELECT * FROM ${target.table} WHERE ${target.idColumn} = ? AND key = ?`).get(target.id, String(key || "").trim());
    if (!row) return null;
    return { scope: target.scope, key: row.key, value: row.value, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at };
  },

  noteList(taskId, scope = "task", agentId = null) {
    const target = this._noteScope(taskId, scope);
    if (agentId) this.assertMembership(agentId, taskId);
    return this.db.prepare(`SELECT key, version, updated_by_name, updated_at FROM ${target.table} WHERE ${target.idColumn} = ? ORDER BY key ASC`).all(target.id)
      .map((row) => ({ scope: target.scope, key: row.key, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at }));
  },

  knowledgeSearch({ agentId = null, taskId, query = "", category = null, status = null, limit = 20 }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    return {
      automated: this.knowledge.enabled,
      vaultPath: path.join(task.project_root, "knowledge"),
      // Every result carries what points at it, so a decision is read together with what depended
      // on it rather than looking equally isolated however load-bearing it turns out to be.
      notes: this.knowledge.search(task.project_id, taskId, { query, category, status, limit })
        .map((note) => ({ ...note, backlinks: this.knowledge.backlinks(note.id, { limit: 5 }) })),
    };
  },

  // An agent recording something it learned, as a first-class vault note rather than prose in a
  // report. Membership-scoped like every other task-shaped action, and written under the agent's own
  // name so the timeline and the note agree about who claimed it.
  knowledgeWrite({ agentId = null, taskId, category, title, body, confidence = "medium", relatedFiles = [] }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const author = agent?.name || "the human";
    const eventId = this._event(taskId, agentId, "agent.finding", `${author} recorded: ${String(title || "").trim()}`, {
      category: String(category || "").trim().toLowerCase(),
      confidence,
      knowledgeNote: true,
    });
    const result = this.knowledge.write({
      projectId: task.project_id, category, title, body, confidence,
      relatedFiles, author, taskId, eventId,
    });
    if (result.written) {
      try { this.knowledge.exportProject(task.project_id); } catch { /* the vault export is best-effort, as elsewhere */ }
    }
    this._changed("knowledge.written", taskId);
    return { ...result, vaultPath: path.join(task.project_root, "knowledge") };
  },

  // What has not been confirmed in a long time, plus anything currently disputed. A maintainer agent
  // works this queue; the human sees it on the board.
  knowledgeMaintenance({ agentId = null, taskId, olderThanDays = 90, limit = 20 }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const disputed = this.knowledge.search(task.project_id, taskId, { status: "disputed", limit });
    return {
      stale: this.knowledge.staleKnowledge(task.project_id, { olderThanDays, limit }),
      disputed,
      next: "Correct a stale note by writing over it with devteam_memory action=write, or resolve a disputed pair with devteam_propose.",
    };
  },

  // Say a note still holds. This is the only thing that resets its age, which is what keeps the
  // decay honest: re-reading a note is not confirmation, checking it against the project is.
  knowledgeConfirm({ agentId = null, taskId, noteId }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const result = this.knowledge.confirmNote(task.project_id, noteId, { author: agent?.name || "the human" });
    if (!result.confirmed) throw new Error("Note not found in this project.");
    this._event(taskId, agentId, "agent.finding", `${agent?.name || "The human"} confirmed a knowledge note still holds.`, { noteId, confirmed: true });
    this._changed("knowledge.confirmed", taskId);
    return result;
  },

  // Mark notes as disagreeing. Both drop to `disputed`, which briefs and searches already exclude, so
  // a contested fact stops being served as truth immediately rather than once someone resolves it.
  knowledgeDispute({ agentId = null, taskId, noteIds, reason }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const result = this.knowledge.disputeNotes(task.project_id, noteIds, reason);
    if (!result.disputed) throw new Error("Give at least two note IDs from this project that disagree.");
    this._event(taskId, agentId, "agent.finding",
      `${agent?.name || "The human"} flagged ${result.disputed} knowledge notes as contradicting each other.`,
      { noteIds: result.noteIds, reason: String(reason || "").slice(0, 500) });
    this._changed("knowledge.disputed", taskId);
    return { ...result, next: "Disputed notes are excluded from briefings until resolved. Decide which is right and write over the other, or raise it with devteam_propose." };
  },

  // Offer a note to other projects, or withdraw it.
  knowledgeShare({ agentId = null, taskId, noteId, shared = true }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const result = this.knowledge.shareNote(task.project_id, noteId, { shared });
    this._event(taskId, agentId, "agent.finding",
      `${agent?.name || "The human"} ${shared ? "shared a lesson with other projects" : "withdrew a lesson from other projects"}.`,
      { noteId, shared: Boolean(shared) });
    this._changed("knowledge.shared", taskId);
    return result;
  },

  // Lessons other projects have chosen to share. Kept out of the ordinary knowledge path on purpose:
  // an agent asks for them, and every one says where it came from and that it needs confirming here.
  knowledgeShared({ agentId = null, taskId, query = "", limit = 10 }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    return { notes: this.knowledge.sharedFromOtherProjects(task.project_id, { query, limit }) };
  },

  // What references a note, and what it references. Membership-scoped through the task room.
  knowledgeLinks({ agentId = null, taskId, noteId }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const note = this.db.prepare("SELECT id, project_id, category, slug, title, status, confidence FROM knowledge_notes WHERE id = ?").get(noteId);
    // A note in another project is not this room's to read, and "no such note" and "not yours" answer
    // identically so this cannot be used to enumerate another project's vault.
    if (!note || note.project_id !== task.project_id) throw new Error("Note not found in this project.");
    return {
      note: { id: note.id, category: note.category, slug: note.slug, title: note.title, status: note.status, confidence: note.confidence },
      backlinks: this.knowledge.backlinks(noteId),
      links: this.knowledge.outboundLinks(noteId),
    };
  },

  codeGraphSearch({ agentId = null, taskId, path: modulePath }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    return {
      automated: this.codegraph.enabled,
      graphPath: path.join(task.project_root, "knowledge", "graph"),
      ...this.codegraph.neighborhood(taskId, modulePath),
    };
  },

  codeContextForAssignment(agentId, taskId, assignmentId) {
    this.getAgent(agentId);
    this.assertMembership(agentId, taskId);
    const task = this.getTask(taskId);
    const errorKey = task ? `project:${task.project_id}` : null;
    try {
      this.codegraph.reconcileTask(taskId);
      if (errorKey) this.codegraphErrors.delete(errorKey);
      return this.codegraph.codeContext(taskId, { assignmentId });
    } catch (error) {
      if (errorKey) this.codegraphErrors.set(errorKey, { message: error.message, at: now() });
      this.emit("codegraph-error", { taskId, type: "codegraph.context", error });
      return this.codegraph.enabled ? [] : null;
    }
  },
};
