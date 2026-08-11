import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeVault } from "./knowledge.mjs";

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const fromJson = (value, fallback = null) => {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
};

export class DevTeamStore extends EventEmitter {
  constructor(dataDir, { liveness = {}, knowledge = {} } = {}) {
    super();
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = path.join(this.dataDir, "devteam.sqlite");
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.knowledge = new KnowledgeVault(this.db, knowledge);
    this.knowledgeErrors = new Map();
    this.token = this.#getOrCreateToken();
    // Presence and ownership are different questions. A *busy* agent that goes quiet is
    // presumed to still be working — reasoning and editing make no MCP calls — so it keeps
    // its claim; only its presence lapses (it becomes 'unresponsive'). Silence alone never
    // transfers a write lease; only explicit disconnect, a confirmed transport close, a
    // same-identity reconnect, or a human force-release does. Long-silent *read-only* claims
    // are safe to requeue because no filesystem write is at risk.
    this.liveness = {
      presenceMs: 120_000,        // quiet longer than this: a waiting agent is gone, a busy one is 'unresponsive'
      staleWorkMs: 900_000,       // quiet longer than this: a read-only claim may be safely recovered
      proposalTimeoutMs: 600_000, // open longer than this: escalate the proposal for a human decision
      continuationWindowMs: 180_000, // after acceptance, keep the room "active" this long so members stay assembled for a same-conversation follow-up
      ...liveness,
    };
    this.#recoverOrphanedClaims("Recovered an orphaned assignment during server startup.");
    this.#syncAllTaskStatuses();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        status TEXT NOT NULL,
        current_task_id TEXT,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        disconnected_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        required_approvals INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        role TEXT NOT NULL,
        requires_write INTEGER NOT NULL DEFAULT 0,
        target_agent_name TEXT,
        agent_id TEXT REFERENCES agents(id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        claimed_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id),
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, agent_id, version)
      );

      CREATE TABLE IF NOT EXISTS message_receipts (
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        delivered_at TEXT,
        seen_at TEXT,
        PRIMARY KEY (event_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        proposer_id TEXT REFERENCES agents(id),
        proposer_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS proposal_votes (
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        voter_id TEXT NOT NULL,
        voter_name TEXT NOT NULL,
        vote TEXT NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (proposal_id, voter_id)
      );

      CREATE TABLE IF NOT EXISTS proposal_voters (
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        voter_id TEXT NOT NULL,
        PRIMARY KEY (proposal_id, voter_id)
      );

      CREATE TABLE IF NOT EXISTS assignment_checklists (
        assignment_id TEXT PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
        items TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_members (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'contributor',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (task_id, agent_id)
      );

      CREATE TABLE IF NOT EXISTS assignment_write_scopes (
        assignment_id TEXT PRIMARY KEY REFERENCES assignments(id) ON DELETE CASCADE,
        paths TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assignment_dependencies (
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        depends_on_assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        PRIMARY KEY (assignment_id, depends_on_assignment_id)
      );

      CREATE TABLE IF NOT EXISTS blackboard (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        updated_by_name TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, key)
      );

      CREATE TABLE IF NOT EXISTS project_blackboard (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT,
        updated_by_name TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_assignments_queue ON assignments(status, target_agent_name, created_at);
      CREATE INDEX IF NOT EXISTS idx_assignments_task_status ON assignments(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_status_seen ON agents(status, last_seen);
      CREATE INDEX IF NOT EXISTS idx_receipts_agent ON message_receipts(agent_id, delivered_at, seen_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_task_status ON proposals(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_members_agent ON task_members(agent_id);
      PRAGMA optimize;
    `);
    // One agent may hold at most one claimed assignment at a time. Self-heal any legacy
    // double-claims (keep the earliest) before enforcing it at the schema level, so the
    // unique index can be created even on a database that predates this rule.
    this.db.exec(`
      UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL
      WHERE status = 'claimed' AND agent_id IS NOT NULL AND rowid NOT IN (
        SELECT MIN(rowid) FROM assignments WHERE status = 'claimed' AND agent_id IS NOT NULL GROUP BY agent_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_claim_per_agent
        ON assignments(agent_id) WHERE status = 'claimed' AND agent_id IS NOT NULL;
    `);
    // Additive columns for databases created before consensus snapshots/quorum/timeout existed.
    for (const [table, column, ddl] of [
      ["proposals", "required_ratio", "REAL NOT NULL DEFAULT 1"],
      ["proposals", "escalated_at", "TEXT"],
      ["agents", "resume_token_hash", "TEXT"],  // hashed at rest; the raw token is returned once at connect
      ["agents", "message_floor", "TEXT"],       // on resume, replay messages back to the original session's start
      ["assignments", "claim_generation", "INTEGER NOT NULL DEFAULT 0"], // bumped every (re)claim, for lease fencing
      ["assignments", "claim_token_hash", "TEXT"],                        // hashed fencing token for the live claim
    ]) {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); } catch { /* already present */ }
    }
  }

  #getOrCreateToken() {
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'auth_token'").get();
    if (existing?.value) return existing.value;
    const token = randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO metadata (key, value) VALUES ('auth_token', ?)").run(token);
    return token;
  }

  #transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #event(taskId, agentId, type, message, metadata = {}) {
    const stamp = now();
    const info = this.db.prepare(`
      INSERT INTO events (task_id, agent_id, type, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, agentId || null, type, message, json(metadata), stamp);
    return Number(info.lastInsertRowid);
  }

  #changed(type, taskId = null) {
    const knowledgeChanges = new Set([
      "task.created", "task.continued", "task.accepted", "task.blocked", "task.unblocked",
      "assignment.created", "assignment.completed", "assignment.blocked",
      "proposal.adopted", "blackboard.updated", "agent.decision", "agent.finding", "human.message",
    ]);
    if (taskId && knowledgeChanges.has(type)) {
      try {
        this.knowledge.syncTask(taskId);
        this.knowledgeErrors.delete(taskId);
      } catch (error) {
        this.knowledgeErrors.set(taskId, { message: error.message, at: now() });
        this.emit("knowledge-error", { taskId, type, error });
      }
    }
    this.emit("change", { type, taskId, at: now() });
  }

  #syncTaskStatus(taskId, stamp = now()) {
    const task = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
    if (!task || ["accepted", "blocked", "cancelled"].includes(task.status)) return task?.status || null;
    const openAssignments = this.db.prepare(`
      SELECT role FROM assignments
      WHERE task_id = ? AND status IN ('queued', 'claimed')
    `).all(taskId);
    const reviewRoles = new Set(["reviewer", "security-reviewer", "tester"]);
    let status = "review";
    if (openAssignments.some((assignment) => String(assignment.role).toLowerCase() === "planner")) {
      status = "planning";
    } else if (openAssignments.some((assignment) => !reviewRoles.has(String(assignment.role).toLowerCase()))) {
      status = "active";
    }
    if (task.status !== status) {
      this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, stamp, taskId);
    }
    return status;
  }

  #syncAllTaskStatuses() {
    const taskIds = this.db.prepare(`
      SELECT id FROM tasks WHERE status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all();
    const stamp = now();
    for (const task of taskIds) this.#syncTaskStatus(task.id, stamp);
  }

  #releaseAgentClaims(agent, stamp, reason) {
    const taskIds = this.db.prepare(`
      SELECT DISTINCT task_id FROM assignments WHERE agent_id = ? AND status = 'claimed'
    `).all(agent.id).map((row) => row.task_id);
    const released = this.db.prepare(`
      UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL
      WHERE agent_id = ? AND status = 'claimed'
    `).run(agent.id).changes;
    this.db.prepare(`
      UPDATE agents
      SET status = 'disconnected', current_task_id = NULL, last_seen = ?, disconnected_at = ?
      WHERE id = ?
    `).run(stamp, stamp, agent.id);
    for (const taskId of taskIds) {
      this.#event(taskId, agent.id, "agent.disconnected", `${agent.name} disconnected and released unfinished work.`, {
        reason,
        releasedAssignments: released,
      });
      this.#syncTaskStatus(taskId, stamp);
    }
    return taskIds;
  }

  // Refresh presence and recover only what is safe to recover. This deliberately does NOT
  // release a busy agent's work on silence: a quiet agent that holds a claim is presumed to
  // still be reasoning/editing (which produce no MCP calls). It is flagged 'unresponsive' but
  // keeps its claim. Write leases are never transferred here; read-only claims held by an
  // agent that has been silent past staleWorkMs are requeued because nothing on disk is at risk.
  #reapStaleAgents() {
    const presenceBefore = new Date(Date.now() - this.liveness.presenceMs).toISOString();
    const staleWorkBefore = new Date(Date.now() - this.liveness.staleWorkMs).toISOString();
    const stamp = now();
    const affectedTasks = new Set();
    let presenceChanged = false;
    this.#transaction(() => {
      // Idle (waiting) agents that went silent are simply gone; they own nothing to protect.
      const goneIdle = this.db.prepare(`
        SELECT * FROM agents WHERE status = 'waiting' AND last_seen < ?
      `).all(presenceBefore);
      for (const agent of goneIdle) {
        for (const taskId of this.#releaseAgentClaims(agent, stamp, "Agent presence timed out while idle.")) affectedTasks.add(taskId);
        presenceChanged = true;
      }
      // Busy agents that went silent are presumed still working: keep the claim, flag presence.
      const flagged = this.db.prepare(`
        UPDATE agents SET status = 'unresponsive' WHERE status = 'busy' AND last_seen < ?
      `).run(presenceBefore).changes;
      if (flagged) presenceChanged = true;
      // Read-only work whose owner has been silent a long time is safe to recover.
      const recoverable = this.db.prepare(`
        SELECT a.id, a.task_id, COALESCE(ag.name, 'An agent') AS agent_name
        FROM assignments a JOIN agents ag ON ag.id = a.agent_id
        WHERE a.status = 'claimed' AND a.requires_write = 0
          AND ag.status IN ('unresponsive', 'disconnected') AND ag.last_seen < ?
      `).all(staleWorkBefore);
      for (const row of recoverable) {
        this.db.prepare("UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL WHERE id = ?").run(row.id);
        this.#event(row.task_id, null, "assignment.released", `${row.agent_name}'s read-only assignment was recovered after a long silence.`, { assignmentId: row.id, reason: "stale-readonly-recovery" });
        this.#syncTaskStatus(row.task_id, stamp);
        affectedTasks.add(row.task_id);
      }
    });
    for (const taskId of affectedTasks) this.#changed("assignment.released", taskId);
    if (presenceChanged) this.#changed("agent.disconnected");
    return [];
  }

  #recoverOrphanedClaims(reason = "Recovered an assignment whose agent is disconnected.") {
    const orphans = this.db.prepare(`
      SELECT DISTINCT a.task_id, a.agent_id, COALESCE(ag.name, 'Unknown agent') AS agent_name
      FROM assignments a
      LEFT JOIN agents ag ON ag.id = a.agent_id
      WHERE a.status = 'claimed' AND (ag.id IS NULL OR ag.status = 'disconnected')
    `).all();
    if (!orphans.length) return [];
    const stamp = now();
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL
        WHERE status = 'claimed' AND (
          agent_id IS NULL OR agent_id IN (SELECT id FROM agents WHERE status = 'disconnected')
        )
      `).run();
      for (const orphan of orphans) {
        this.#event(orphan.task_id, orphan.agent_id, "assignment.released", `${orphan.agent_name}'s orphaned assignment was returned to the queue.`, { reason });
        this.#syncTaskStatus(orphan.task_id, stamp);
      }
    });
    for (const taskId of new Set(orphans.map((orphan) => orphan.task_id))) this.#changed("assignment.released", taskId);
    return orphans;
  }

  // Public sweep used by the server's periodic reaper so the dashboard reflects
  // crashed or silently-closed desktop agents even when no request is in flight.
  reapAndRecover() {
    const reaped = this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    this.escalateStaleProposals();
    return reaped;
  }

  // A proposal that stays open past the decision window (a single holdout, or everyone who could
  // vote going quiet) can freeze team governance forever. Flag each such proposal once for a human
  // decision instead of leaving it silently stuck. Non-destructive: the proposal stays open and can
  // still be voted through or objected to.
  escalateStaleProposals() {
    const before = new Date(Date.now() - this.liveness.proposalTimeoutMs).toISOString();
    const stale = this.db.prepare(`
      SELECT id, task_id, summary FROM proposals
      WHERE status = 'open' AND escalated_at IS NULL AND created_at < ?
    `).all(before);
    if (!stale.length) return [];
    const stamp = now();
    this.#transaction(() => {
      for (const proposal of stale) {
        this.db.prepare("UPDATE proposals SET escalated_at = ? WHERE id = ?").run(stamp, proposal.id);
        this.#event(proposal.task_id, null, "proposal.needs_human", `A proposal has been open past the decision window and needs a human decision: ${proposal.summary}`, { proposalId: proposal.id });
      }
    });
    for (const taskId of new Set(stale.map((proposal) => proposal.task_id))) this.#changed("proposal.needs_human", taskId);
    return stale;
  }

  // Snapshot of whether the team is still doing something. Drives the keepWaiting
  // hint so a waiting agent stays assembled while work is in flight and only
  // leaves once the room is genuinely quiet.
  teamActivity(roomIds = null) {
    const scoped = Array.isArray(roomIds);
    if (scoped && !roomIds.length) return { active: false, openWork: 0, busyAgents: 0, waitingAgents: 0 };
    const roomFilter = scoped ? `AND a.task_id IN (${roomIds.map(() => "?").join(", ")})` : "";
    const busyFilter = scoped ? `AND current_task_id IN (${roomIds.map(() => "?").join(", ")})` : "";
    const openWork = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status IN ('queued', 'claimed') AND t.status NOT IN ('accepted', 'blocked', 'cancelled') ${roomFilter}
    `).get(...(scoped ? roomIds : [])).count);
    const busyAgents = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM agents WHERE status = 'busy' ${busyFilter}`).get(...(scoped ? roomIds : [])).count);
    const waitingAgents = Number(this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE status = 'waiting'").get().count);
    // A task accepted moments ago keeps the room "active" for a short window, so its members stay
    // assembled long enough to catch a same-conversation follow-up instead of being told to leave the
    // instant consensus lands (which is what made "continue in the same chat" impossible before).
    const continuationSince = new Date(Date.now() - this.liveness.continuationWindowMs).toISOString();
    const acceptedFilter = scoped ? `AND id IN (${roomIds.map(() => "?").join(", ")})` : "";
    const continuing = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE status = 'accepted' AND updated_at >= ? ${acceptedFilter}
    `).get(continuationSince, ...(scoped ? roomIds : [])).count);
    return { active: openWork > 0 || busyAgents > 0 || continuing > 0, openWork, busyAgents, waitingAgents, continuing };
  }

  // Activity as seen from one agent's rooms, so a member of a quiet task isn't kept assembled by
  // a different task's work on a multi-task server.
  teamActivityForAgent(agentId) {
    return this.teamActivity(this.#memberTaskIds(agentId));
  }

  // Return undirected/directed human messages this agent has not yet received,
  // and record delivery. "Directed" = target is this agent's name; broadcasts use
  // target "all". Only messages posted during this session are delivered live;
  // older history is still visible through devteam_state.
  // Is this timeline event a live message for the given agent? Human messages reach the agent
  // if broadcast ("all") or addressed to its name. Agent messages are only *pushed* when they
  // are directed to this agent by name (never the sender's own, never undirected broadcasts —
  // those stay timeline notes read via devteam_state).
  #messageIsForAgent(event, agent) {
    const nameLower = String(agent.name).toLowerCase();
    if (event.type === "human.message") {
      const target = String(event.metadata.target || "all").toLowerCase();
      return target === "all" || target === nameLower;
    }
    if (String(event.agent_id || "") === agent.id) return false;
    const target = String(event.metadata.target || "").toLowerCase();
    if (!target) return false;
    return target === nameLower || target === String(agent.id).toLowerCase();
  }

  deliverDirectedMessages(agentId) {
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") return [];
    const rooms = this.#memberTaskIds(agentId);
    if (!rooms.length) return [];
    const roomPlaceholders = rooms.map(() => "?").join(", ");
    const floor = agent.message_floor || agent.connected_at;
    const candidates = this.db.prepare(`
      SELECT e.id, e.task_id, e.agent_id, e.type, e.message, e.metadata, e.created_at
      FROM events e
      WHERE (e.type = 'human.message' OR e.type LIKE 'agent.%')
        AND e.task_id IN (${roomPlaceholders})
        AND e.created_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM message_receipts r
          WHERE r.event_id = e.id AND r.agent_id = ? AND r.delivered_at IS NOT NULL
        )
      ORDER BY e.id ASC
      LIMIT 50
    `).all(...rooms, floor, agentId).map((row) => ({ ...row, metadata: fromJson(row.metadata, {}) }));
    const mine = candidates.filter((event) => this.#messageIsForAgent(event, agent));
    if (!mine.length) return [];
    const stamp = now();
    const taskIds = new Set();
    this.#transaction(() => {
      for (const event of mine) {
        this.db.prepare(`
          INSERT INTO message_receipts (event_id, agent_id, delivered_at)
          VALUES (?, ?, ?)
          ON CONFLICT(event_id, agent_id) DO UPDATE SET delivered_at = COALESCE(message_receipts.delivered_at, excluded.delivered_at)
        `).run(event.id, agentId, stamp);
        taskIds.add(event.task_id);
      }
      this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(stamp, agentId);
    });
    for (const taskId of taskIds) this.#changed("message.delivered", taskId);
    return mine.map((event) => ({
      id: event.id,
      taskId: event.task_id,
      message: event.message,
      from: event.type === "human.message" ? "human" : (event.metadata.senderName || "a teammate"),
      target: event.metadata.targetLabel || (event.type === "human.message" ? "all agents" : agent.name),
      broadcast: event.type === "human.message" && String(event.metadata.target || "all").toLowerCase() === "all",
      at: event.created_at,
    }));
  }

  // Mark every delivered-but-unacknowledged message for this agent as seen. Called
  // when the agent takes any follow-up action, so the human sees a real acknowledgement.
  markMessagesSeen(agentId) {
    const changed = this.db.prepare(`
      UPDATE message_receipts SET seen_at = ?
      WHERE agent_id = ? AND delivered_at IS NOT NULL AND seen_at IS NULL
    `).run(now(), agentId).changes;
    if (changed) this.#changed("message.seen");
    return changed;
  }

  // Role checklists a planner can attach to review work so the team systematically
  // covers the usual blind spots instead of eyeballing a diff. Attached automatically
  // to review/security/test assignments unless the caller overrides them.
  static CHECKLIST_TEMPLATES = {
    "security-reviewer": [
      "Authentication: no broken/missing auth on protected paths",
      "Session handling: fixation, regeneration, secure/httponly cookies",
      "Authorization: object-level and function-level access checks",
      "Input validation and injection (SQL/command/template/XSS)",
      "Secrets: none logged, committed, or returned in responses",
      "Rate limiting / abuse protection on sensitive endpoints",
      "Error handling does not leak stack traces or internals",
      "Dependencies: no known-vulnerable or unpinned additions",
    ],
    reviewer: [
      "Correctness: does it do what the task asked?",
      "Edge cases and boundary conditions handled",
      "Error and failure paths are handled, not swallowed",
      "No dead code, debug logs, or leftover TODOs",
      "Readable and consistent with the surrounding code",
      "Tests cover the change and actually run",
    ],
    tester: [
      "Happy path verified end to end",
      "Edge cases and invalid input covered",
      "Failure modes and error states exercised",
      "Regression: existing behaviour still passes",
      "Checks are reproducible and named in the report",
    ],
  };

  checklistTemplates() {
    return DevTeamStore.CHECKLIST_TEMPLATES;
  }

  #resolveChecklist(role, provided) {
    if (Array.isArray(provided)) return provided.map((item) => String(item).trim()).filter(Boolean).slice(0, 40);
    return DevTeamStore.CHECKLIST_TEMPLATES[String(role || "").toLowerCase()] || null;
  }

  #storeChecklist(assignmentId, items) {
    if (!items || !items.length) return;
    this.db.prepare("INSERT OR REPLACE INTO assignment_checklists (assignment_id, items) VALUES (?, ?)").run(assignmentId, json(items));
  }

  #checklistFor(assignmentId) {
    return fromJson(this.db.prepare("SELECT items FROM assignment_checklists WHERE assignment_id = ?").get(assignmentId)?.items, []);
  }

  // --- Role negotiation: agents (and the human) propose role/handoff/plan changes,
  // teammates vote, and on agreement the change is adopted and real work is reassigned. ---

  static PROPOSAL_KINDS = ["role", "handoff", "plan", "decision"];

  createProposal({ agentId = null, taskId, kind = "role", summary, details = {} }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["accepted", "blocked", "cancelled"].includes(task.status)) throw new Error(`Task is already ${task.status}.`);
    if (!DevTeamStore.PROPOSAL_KINDS.includes(kind)) throw new Error(`Unknown proposal kind: ${kind}.`);
    const proposer = agentId ? this.getAgent(agentId) : null;
    const proposerName = proposer ? proposer.name : "You";
    if (kind === "handoff" && !details?.assignmentId) throw new Error("A handoff proposal needs details.assignmentId.");
    if (kind === "role" && !String(details?.role || "").trim()) throw new Error("A role proposal needs details.role.");
    const id = randomUUID();
    const stamp = now();
    // Quorum: 1 (default) = unanimity of the voter set snapshotted now; a fraction in (0,1) adopts
    // once that share of the snapshot agrees (supermajority/majority).
    const ratio = Math.min(1, Math.max(0, Number(details?.quorum) || 1)) || 1;
    // Snapshot the required voter set at creation: exactly the members connected right now, minus
    // the proposer. A teammate connecting mid-vote afterwards can neither block an almost-adopted
    // proposal nor be silently conscripted into it.
    const snapshotVoters = this.#connectedMemberIds(taskId).filter((memberId) => memberId !== agentId);
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO proposals (id, task_id, proposer_id, proposer_name, kind, summary, details, status, created_at, required_ratio)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      `).run(id, taskId, agentId, proposerName, kind, summary.trim(), json(details), stamp, ratio);
      for (const voterId of snapshotVoters) {
        this.db.prepare("INSERT OR IGNORE INTO proposal_voters (proposal_id, voter_id) VALUES (?, ?)").run(id, voterId);
      }
      // An AGENT proposer implicitly agrees to its own proposal. A human proposer gets no implicit
      // vote: the human decides with an explicit dashboard Agree/Object, and pre-seeding a "human
      // agree" here would make that later click an idempotent no-op that never resolves the proposal.
      if (agentId) {
        this.db.prepare(`
          INSERT INTO proposal_votes (proposal_id, voter_id, voter_name, vote, comment, created_at)
          VALUES (?, ?, ?, 'agree', NULL, ?)
        `).run(id, agentId, proposerName, stamp);
      }
      this.#event(taskId, agentId, "proposal.created", summary.trim(), { proposalId: id, kind, details, requiredVoters: snapshotVoters.length, quorum: ratio });
    });
    this.#changed("proposal.created", taskId);
    return this.getProposal(id);
  }

  getProposal(proposalId) {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId);
    if (!row) return null;
    const votes = this.db.prepare("SELECT voter_id, voter_name, vote, comment, created_at FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at ASC").all(proposalId);
    return { ...row, details: fromJson(row.details, {}), votes };
  }

  voteProposal({ agentId = null, proposalId, vote = "agree", comment = null }) {
    if (!["agree", "object"].includes(vote)) throw new Error("Vote must be 'agree' or 'object'.");
    const voter = agentId ? this.getAgent(agentId) : null;
    const voterName = voter ? voter.name : "You";
    if (agentId) {
      const owning = this.db.prepare("SELECT task_id FROM proposals WHERE id = ?").get(proposalId);
      if (owning) this.assertMembership(agentId, owning.task_id);
    }
    let outcome;
    this.#transaction(() => {
      const proposal = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId);
      if (!proposal) throw new Error("Proposal not found.");
      if (proposal.status !== "open") { outcome = { proposalId, taskId: proposal.task_id, status: proposal.status, alreadyResolved: true }; return; }
      const voterId = agentId || "human";
      const stamp = now();
      // Re-casting the identical vote records nothing new and emits no vote event, but we still
      // re-evaluate: a decisive vote already on record — e.g. a legacy proposal pre-seeded with the
      // human's implicit agree — must resolve exactly once instead of being frozen by a no-op. A vote
      // that leaves it open is marked unchanged so it doesn't spam duplicate "vote" change signals.
      const existing = this.db.prepare("SELECT vote FROM proposal_votes WHERE proposal_id = ? AND voter_id = ?").get(proposalId, voterId);
      if (existing && existing.vote === vote) {
        outcome = this.#evaluateProposal(proposal, stamp);
        if (outcome.status === "open") outcome.unchanged = true;
        return;
      }
      this.db.prepare(`
        INSERT INTO proposal_votes (proposal_id, voter_id, voter_name, vote, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposal_id, voter_id) DO UPDATE SET vote = excluded.vote, comment = excluded.comment, created_at = excluded.created_at
      `).run(proposalId, voterId, voterName, vote, comment?.trim() || null, stamp);
      this.#event(proposal.task_id, agentId, "proposal.vote", `${voterName} ${vote === "agree" ? "agreed to" : "objected to"}: ${proposal.summary}`, { proposalId, vote, comment: comment?.trim() || null });
      outcome = this.#evaluateProposal(proposal, stamp);
    });
    this.markMessagesSeen(agentId || "");
    // A resolution always signals (even when reached by re-evaluating an identical decisive vote); a
    // vote that merely stays open signals once, and a true no-op stays silent.
    if (outcome?.status === "adopted") this.#changed("proposal.adopted", outcome.taskId);
    else if (outcome?.status === "declined") this.#changed("proposal.declined", outcome.taskId);
    else if (!outcome?.unchanged && !outcome?.alreadyResolved) this.#changed("proposal.vote", outcome?.taskId);
    return outcome;
  }

  // Decide whether an open proposal is now adopted (all required teammates agreed) or
  // declined (someone objected). Runs inside the caller's transaction.
  #evaluateProposal(proposal, stamp) {
    const votes = this.db.prepare("SELECT voter_id, vote FROM proposal_votes WHERE proposal_id = ?").all(proposal.id);
    // Decide against the voter set snapshotted at creation, not whoever is connected right now.
    const snapshot = this.db.prepare("SELECT voter_id FROM proposal_voters WHERE proposal_id = ?").all(proposal.id).map((r) => r.voter_id);
    // The human is the room's owner: an explicit human vote is decisive and overrides agent consensus,
    // so a dashboard Agree/Object actually resolves the proposal (agree adopts, object declines) rather
    // than waiting on agent votes that may never come.
    const humanVote = votes.find((v) => v.voter_id === "human");
    if (humanVote && humanVote.vote === "agree") {
      this.#adoptProposal(proposal, stamp);
      this.db.prepare("UPDATE proposals SET status = 'adopted', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "adopted" };
    }
    if (humanVote && humanVote.vote === "object") {
      this.db.prepare("UPDATE proposals SET status = 'declined', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      this.#event(proposal.task_id, null, "proposal.declined", `Proposal declined: ${proposal.summary}`, { proposalId: proposal.id });
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "declined" };
    }
    const authoritative = new Set([...snapshot, "human"]); // late joiners can neither block nor carry a vote
    const objection = votes.find((v) => v.vote === "object" && authoritative.has(v.voter_id));
    if (objection) {
      this.db.prepare("UPDATE proposals SET status = 'declined', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      this.#event(proposal.task_id, null, "proposal.declined", `Proposal declined: ${proposal.summary}`, { proposalId: proposal.id });
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "declined" };
    }
    const agreed = new Set(votes.filter((v) => v.vote === "agree").map((v) => v.voter_id));
    const agreements = snapshot.filter((id) => agreed.has(id)).length;
    const ratio = Number(proposal.required_ratio) || 1;
    let adopt;
    if (!snapshot.length) {
      // No teammate was around at creation — only the human can decide a solo proposer's request.
      adopt = agreed.has("human");
    } else if (ratio >= 1) {
      // Unanimity of those still able to vote: a snapshot voter who has since disconnected or gone
      // unresponsive can't hold the whole team hostage, but if none remain it stays open for the
      // human/timeout rather than silently adopting.
      const eligible = snapshot.filter((id) => this.#canVoteNow(id));
      adopt = eligible.length > 0 && eligible.every((id) => agreed.has(id));
    } else {
      // Quorum/supermajority against the fixed snapshot denominator.
      const needed = Math.max(1, Math.ceil(ratio * snapshot.length));
      adopt = agreements >= needed;
    }
    if (adopt) {
      this.#adoptProposal(proposal, stamp);
      this.db.prepare("UPDATE proposals SET status = 'adopted', resolved_at = ? WHERE id = ?").run(stamp, proposal.id);
      return { proposalId: proposal.id, taskId: proposal.task_id, status: "adopted" };
    }
    // Report what adoption actually needs *now*: for unanimity that is the snapshot voters still able
    // to vote (a disconnected/unresponsive snapshot voter no longer counts), matching the adopt rule
    // above — so the dashboard never shows "need 2" when only one reachable voter remains.
    const needed = ratio >= 1
      ? snapshot.filter((id) => this.#canVoteNow(id)).length
      : Math.max(1, Math.ceil(ratio * snapshot.length));
    return { proposalId: proposal.id, taskId: proposal.task_id, status: "open", agreements, needed };
  }

  // An agent can cast a vote right now only if it is connected and actually responsive — an
  // 'unresponsive' (silently busy) agent is present but can't be waited on to break a tie.
  #canVoteNow(agentId) {
    const row = this.db.prepare("SELECT status FROM agents WHERE id = ?").get(agentId);
    return Boolean(row) && row.status !== "disconnected" && row.status !== "unresponsive";
  }

  // Apply an adopted proposal's real effect. Runs inside the caller's transaction.
  #adoptProposal(proposal, stamp) {
    const details = fromJson(proposal.details, {});
    if (proposal.kind === "role") {
      const assignmentId = randomUUID();
      const title = (details.title || `${details.role} work`).toString().trim();
      const description = (details.description || proposal.summary).toString().trim();
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(assignmentId, proposal.task_id, title, description, String(details.role).trim(), details.requiresWrite ? 1 : 0, details.targetAgentName?.trim() || null, stamp);
      const adoptedChecklist = this.#resolveChecklist(details.role, details.checklist);
      this.#storeChecklist(assignmentId, adoptedChecklist);
      if (details.requiresWrite && Array.isArray(details.paths) && details.paths.length) {
        const writePaths = [...new Set(details.paths.map((p) => String(p).trim()).filter(Boolean))].slice(0, 50);
        if (writePaths.length) this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)").run(assignmentId, json(writePaths));
      }
      this.#event(proposal.task_id, proposal.proposer_id, "assignment.created", title, { assignmentId, role: details.role, requiresWrite: Boolean(details.requiresWrite), targetAgentName: details.targetAgentName?.trim() || null, viaProposal: proposal.id, checklist: adoptedChecklist || [] });
      this.#syncTaskStatus(proposal.task_id, stamp);
    } else if (proposal.kind === "handoff") {
      const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(details.assignmentId);
      if (assignment) {
        const target = details.targetAgentName?.trim() || null;
        if (assignment.status === "claimed") {
          this.db.prepare("UPDATE assignments SET target_agent_name = ?, status = 'queued', agent_id = NULL, claimed_at = NULL WHERE id = ?").run(target, assignment.id);
        } else {
          this.db.prepare("UPDATE assignments SET target_agent_name = ? WHERE id = ?").run(target, assignment.id);
        }
        this.#event(proposal.task_id, proposal.proposer_id, "assignment.reassigned", `Reassigned "${assignment.title}"${target ? ` to ${target}` : ""}.`, { assignmentId: assignment.id, targetAgentName: target, viaProposal: proposal.id });
        this.#syncTaskStatus(proposal.task_id, stamp);
      }
    }
    this.#event(proposal.task_id, null, "proposal.adopted", `Team adopted: ${proposal.summary}`, { proposalId: proposal.id, kind: proposal.kind });
  }

  // Open proposals a waiting agent should weigh in on (in its rooms, not its own, not yet voted).
  openProposalsForAgent(agent) {
    const rooms = this.#memberTaskIds(agent.id);
    if (!rooms.length) return [];
    const roomPlaceholders = rooms.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT p.* FROM proposals p
      JOIN tasks t ON t.id = p.task_id
      WHERE p.status = 'open'
        AND p.task_id IN (${roomPlaceholders})
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
        AND (p.proposer_id IS NULL OR p.proposer_id != ?)
        AND NOT EXISTS (SELECT 1 FROM proposal_votes v WHERE v.proposal_id = p.id AND v.voter_id = ?)
      ORDER BY p.created_at ASC
      LIMIT 20
    `).all(...rooms, agent.id, agent.id);
    return rows.map((row) => ({ id: row.id, taskId: row.task_id, kind: row.kind, summary: row.summary, proposer: row.proposer_name, details: fromJson(row.details, {}) }));
  }

  proposalsForTask(taskId) {
    const rows = this.db.prepare("SELECT * FROM proposals WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
    return rows.map((row) => ({
      ...row,
      details: fromJson(row.details, {}),
      votes: this.db.prepare("SELECT voter_id, voter_name, vote, comment, created_at FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at ASC").all(row.id),
    }));
  }

  close() {
    this.db.close();
  }

  ensureProject(name, root) {
    const normalizedRoot = path.resolve(root);
    const existing = this.db.prepare("SELECT * FROM projects WHERE root = ?").get(normalizedRoot);
    if (existing) {
      try { this.knowledge.initializeProject(existing.id); }
      catch (error) { this.knowledgeErrors.set(`project:${existing.id}`, { message: error.message, at: now() }); }
      return existing;
    }
    const project = { id: randomUUID(), name: name.trim(), root: normalizedRoot, created_at: now() };
    this.db.prepare("INSERT INTO projects (id, name, root, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.root, project.created_at);
    try { this.knowledge.initializeProject(project.id); }
    catch (error) { this.knowledgeErrors.set(`project:${project.id}`, { message: error.message, at: now() }); }
    this.#changed("project.created");
    return project;
  }

  listProjects() {
    return this.db.prepare(`
      SELECT p.*,
        COUNT(DISTINCT t.id) AS task_count,
        SUM(CASE WHEN t.status NOT IN ('accepted', 'blocked', 'cancelled') THEN 1 ELSE 0 END) AS active_task_count
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at ASC
    `).all();
  }

  createTask({ projectId, title, description, requiredApprovals = 2 }) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    const taskId = randomUUID();
    const stamp = now();
    const approvals = Math.max(1, Math.min(8, Number(requiredApprovals) || 2));
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, status, version, required_approvals, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'planning', 1, ?, ?, ?)
      `).run(taskId, projectId, title.trim(), description.trim(), approvals, stamp, stamp);
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at)
        VALUES (?, ?, ?, ?, 'planner', 0, 'queued', ?)
      `).run(randomUUID(), taskId, "Create the implementation plan", "Inspect the project, propose a concrete plan, then assign implementation and review work to the team.", stamp);
      this.#event(taskId, null, "task.created", `Task created: ${title.trim()}`, { projectId, requiredApprovals: approvals });
    });
    this.#changed("task.created", taskId);
    return this.getTask(taskId);
  }

  getTask(taskId) {
    return this.db.prepare(`
      SELECT t.*, p.name AS project_name, p.root AS project_root
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = ?
    `).get(taskId);
  }

  listTasks(projectId = null) {
    const rows = projectId
      ? this.db.prepare(`
          SELECT t.*, p.name AS project_name,
            (SELECT COUNT(*) FROM assignments a WHERE a.task_id = t.id AND a.status IN ('queued', 'claimed')) AS open_assignments,
            (SELECT COUNT(*) FROM approvals ap WHERE ap.task_id = t.id AND ap.version = t.version) AS approval_count
          FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ? ORDER BY t.updated_at DESC
        `).all(projectId)
      : this.db.prepare(`
          SELECT t.*, p.name AS project_name,
            (SELECT COUNT(*) FROM assignments a WHERE a.task_id = t.id AND a.status IN ('queued', 'claimed')) AS open_assignments,
            (SELECT COUNT(*) FROM approvals ap WHERE ap.task_id = t.id AND ap.version = t.version) AS approval_count
          FROM tasks t JOIN projects p ON p.id = t.project_id
          ORDER BY t.updated_at DESC
        `).all();
    return rows;
  }

  deleteProject(projectId, confirmName) {
    this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    if (confirmName !== project.name) throw new Error("Project name confirmation does not match.");
    const connectedAgents = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM agents
      WHERE status != 'disconnected' AND current_task_id IN (SELECT id FROM tasks WHERE project_id = ?)
    `).get(projectId).count);
    if (connectedAgents) throw new Error("Disconnect agents working on this project before deleting it.");
    const taskCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ?").get(projectId).count);
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE agents SET current_task_id = NULL
        WHERE current_task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      `).run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    this.#changed("project.deleted");
    return { deleted: true, projectId, projectName: project.name, taskCount, filesDeleted: false };
  }

  deleteTask(taskId, confirmTaskId) {
    this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (confirmTaskId !== taskId) throw new Error("Task confirmation does not match.");
    const connectedAgents = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM agents WHERE status != 'disconnected' AND current_task_id = ?
    `).get(taskId).count);
    if (connectedAgents) throw new Error("Disconnect agents working on this task before deleting its history.");
    this.#transaction(() => {
      this.db.prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    });
    this.#changed("task.deleted", taskId);
    return { deleted: true, taskId, title: task.title, filesDeleted: false };
  }

  #hashToken(token) {
    return createHash("sha256").update(String(token)).digest("hex");
  }

  connectAgent({ name, provider, capabilities = [] }) {
    const cleanName = name.trim();
    const cleanProvider = provider.trim();
    if (!cleanName || !cleanProvider) throw new Error("Agent name and provider are required.");
    const id = randomUUID();
    const stamp = now();
    // A new connection is always a distinct identity. We no longer evict a prior session that
    // shares this name+provider — a second "Claude" chat must not silently kill the first one's
    // work. A returning agent reclaims its old claim explicitly via resumeAgent (with the resume
    // token issued below); a truly gone session is cleaned up by transport-close or the reaper.
    const resumeToken = randomBytes(24).toString("base64url");
    // A returning identity that reconnects within this window inherits its prior session's read floor
    // (below) so it still sees what it missed while away; older sessions are left as history.
    const RECONNECT_REPLAY_MS = 6 * 60 * 60 * 1000;
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO agents (id, name, provider, capabilities, status, connected_at, last_seen, resume_token_hash)
        VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?)
      `).run(id, cleanName, cleanProvider, json(capabilities), stamp, stamp, this.#hashToken(resumeToken));
      // A returning identity (same name+provider) that recently disconnected should still see what it
      // missed while away, even on a plain reconnect that carries no resume token. Inherit that prior
      // session's read floor — never its claim or write lease — so the backlog of directed/broadcast
      // messages replays on this session's next inbox check instead of being silently lost.
      const prior = this.db.prepare(`
        SELECT connected_at, message_floor, disconnected_at FROM agents
        WHERE name = ? AND provider = ? AND id != ? AND status = 'disconnected' AND disconnected_at IS NOT NULL
        ORDER BY disconnected_at DESC LIMIT 1
      `).get(cleanName, cleanProvider, id);
      if (prior && Date.parse(prior.disconnected_at) >= Date.now() - RECONNECT_REPLAY_MS) {
        this.db.prepare("UPDATE agents SET message_floor = ? WHERE id = ?").run(prior.message_floor || prior.connected_at, id);
      }
      // Pin implicit single-task membership now, while it is unambiguous, so a later second
      // task can't silently orphan this agent out of its room.
      const activeTasks = this.db.prepare(`
        SELECT id FROM tasks WHERE status NOT IN ('accepted', 'blocked', 'cancelled')
      `).all();
      if (activeTasks.length === 1) {
        this.db.prepare(`
          INSERT OR IGNORE INTO task_members (task_id, agent_id, role, joined_at) VALUES (?, ?, 'contributor', ?)
        `).run(activeTasks[0].id, id, stamp);
      }
    });
    this.#changed("agent.connected");
    // The resume token is returned exactly once, to this caller, and only its hash is stored.
    return { ...this.getAgent(id), resumeToken };
  }

  getAgent(agentId) {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
    if (!row) throw new Error("Agent session not found. Connect to DevTeam again.");
    const { resume_token_hash, ...safe } = row; // never expose the token hash to callers/dashboard
    return { ...safe, capabilities: fromJson(safe.capabilities, []) };
  }

  // A returning agent (e.g. the human reopened the same desktop chat) reclaims its prior session's
  // work instead of starting cold. Given a resume token issued at an earlier connect, transfer that
  // session's live claim, task, and room membership onto this new session, and lower this session's
  // message floor so anything said while it was away replays on the next inbox check. Single-use:
  // the prior session is retired and its token invalidated.
  resumeAgent({ agentId, resumeToken }) {
    const current = this.getAgent(agentId);
    if (current.status === "disconnected") throw new Error("This session is disconnected. Connect again before resuming.");
    if (!resumeToken || !String(resumeToken).trim()) throw new Error("A resume token is required.");
    const hash = this.#hashToken(String(resumeToken).trim());
    const prior = this.db.prepare(`
      SELECT * FROM agents WHERE resume_token_hash = ? AND id != ? ORDER BY connected_at DESC LIMIT 1
    `).get(hash, agentId);
    if (!prior) throw new Error("No matching session to resume. The resume token is unknown or already used.");
    const stamp = now();
    let reclaimed = 0;
    let claimToken = null;
    this.#transaction(() => {
      // Move any live claim from the prior session to this one, re-issuing a fresh fencing token
      // and bumping the generation so the retired session's old token can no longer complete it.
      const priorClaim = this.db.prepare("SELECT id FROM assignments WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(prior.id);
      if (priorClaim) {
        claimToken = randomBytes(18).toString("base64url");
        reclaimed = this.db.prepare(`
          UPDATE assignments
          SET agent_id = ?, claim_generation = claim_generation + 1, claim_token_hash = ?
          WHERE id = ?
        `).run(agentId, this.#hashToken(claimToken), priorClaim.id).changes;
      }
      // Inherit the prior session's rooms.
      this.db.prepare(`
        INSERT OR IGNORE INTO task_members (task_id, agent_id, role, joined_at)
        SELECT task_id, ?, role, ? FROM task_members WHERE agent_id = ?
      `).run(agentId, stamp, prior.id);
      // Adopt the prior task and status, and replay messages from the original session's start.
      const floor = prior.message_floor || prior.connected_at;
      this.db.prepare(`
        UPDATE agents SET current_task_id = ?, status = ?, last_seen = ?, message_floor = ? WHERE id = ?
      `).run(prior.current_task_id, reclaimed ? "busy" : current.status, stamp, floor, agentId);
      // Retire the prior session cleanly and invalidate its token.
      this.db.prepare(`
        UPDATE agents SET status = 'disconnected', current_task_id = NULL, disconnected_at = ?, resume_token_hash = NULL WHERE id = ?
      `).run(stamp, prior.id);
      if (prior.current_task_id) {
        this.#event(prior.current_task_id, agentId, "agent.resumed", `${current.name} resumed a previous session and reclaimed its work.`, { reclaimedAssignments: reclaimed });
      }
    });
    this.#changed("agent.resumed", prior.current_task_id);
    return { resumed: true, agentId, reclaimedAssignments: reclaimed, taskId: prior.current_task_id || null, claimToken };
  }

  // --- Task rooms: work, messages, and governance are scoped to the tasks an agent belongs
  // to, so an agent invoked for one task/project can't claim another's work or see its chatter. ---

  // The tasks an agent is a member of. Explicit joins win; if the agent has joined nothing and
  // there is exactly one active task in the whole store, it is implicitly in that sole room
  // (keeps the common single-task workflow zero-config while isolating multi-task servers).
  #memberTaskIds(agentId) {
    const explicit = this.db.prepare("SELECT task_id FROM task_members WHERE agent_id = ?").all(agentId).map((row) => row.task_id);
    if (explicit.length) return explicit;
    const active = this.db.prepare(`
      SELECT id FROM tasks WHERE status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all().map((row) => row.id);
    return active.length === 1 ? active : [];
  }

  // Connected agents that belong to a given task (used to scope proposal consensus).
  #connectedMemberIds(taskId) {
    const connected = this.db.prepare("SELECT id FROM agents WHERE status != 'disconnected'").all().map((row) => row.id);
    return connected.filter((id) => this.#memberTaskIds(id).includes(taskId));
  }

  // The task rooms an agent may *claim work in*. Observers are members (they see chatter and
  // proposals) but never claim, so they are excluded here. If the agent has any explicit
  // membership, only its non-observer rooms are claimable; otherwise the sole-active-task
  // implicit room applies (contributor by default), keeping single-task use zero-config.
  #claimableTaskIds(agentId) {
    const rows = this.db.prepare("SELECT task_id, role FROM task_members WHERE agent_id = ?").all(agentId);
    if (rows.length) return rows.filter((row) => row.role !== "observer").map((row) => row.task_id);
    const active = this.db.prepare(`
      SELECT id FROM tasks WHERE status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all().map((row) => row.id);
    return active.length === 1 ? active : [];
  }

  // Authorization for a task-scoped action by an agent. Membership is not just routing: an agent
  // may only read, message, propose, vote, assign, approve, or block inside a room it belongs to,
  // so an agent invoked for one task can't reach into another's by supplying its id. The human
  // control plane (no agentId) is trusted and bypasses this.
  assertMembership(agentId, taskId) {
    if (!agentId) return;
    if (!this.#memberTaskIds(agentId).includes(taskId)) {
      throw new Error("You are not a member of this task room. Call devteam_join first.");
    }
  }

  joinTask(agentId, taskId, role = "contributor") {
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("Agent is disconnected. Connect again.");
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const cleanRole = ["contributor", "observer"].includes(role) ? role : "contributor";
    const stamp = now();
    const isNew = !this.db.prepare("SELECT 1 FROM task_members WHERE task_id = ? AND agent_id = ?").get(taskId, agentId);
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO task_members (task_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id, agent_id) DO UPDATE SET role = excluded.role
      `).run(taskId, agentId, cleanRole, stamp);
      this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(stamp, agentId);
      if (isNew) {
        this.#event(taskId, agentId, "agent.joined", `${agent.name} joined the task room${cleanRole === "observer" ? " as observer" : ""}.`, { role: cleanRole });
      }
    });
    if (isNew) this.#changed("agent.joined", taskId);
    return { joined: true, taskId, agentId, role: cleanRole };
  }

  listAgents() {
    this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    return this.db.prepare(`
      SELECT a.*, t.title AS current_task_title, t.version AS current_task_version,
        ca.title AS current_assignment_title, ca.role AS current_assignment_role
      FROM agents a
      LEFT JOIN tasks t ON t.id = a.current_task_id
      LEFT JOIN assignments ca ON ca.agent_id = a.id AND ca.status = 'claimed'
      ORDER BY CASE a.status WHEN 'busy' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, a.last_seen DESC
      LIMIT 50
    `).all().map((row) => {
      // The resume token is hashed at rest, but the hash is still an authentication artifact and
      // has no place in dashboard or MCP snapshots. Keep it inside the store just like getAgent().
      const { resume_token_hash, ...safe } = row;
      return {
        ...safe,
        capabilities: fromJson(row.capabilities, []),
        pending_messages: row.status === "disconnected" ? 0 : this.#pendingMessageCount(row),
      };
    });
  }

  roomStatusForAgent(agentId) {
    this.getAgent(agentId);
    const joinedTaskIds = this.#memberTaskIds(agentId);
    const activeTasks = this.listTasks()
      .filter((task) => !["accepted", "blocked", "cancelled"].includes(task.status))
      .map((task) => ({
        id: task.id,
        title: task.title,
        projectId: task.project_id,
        projectName: task.project_name,
        status: task.status,
        version: task.version,
        openAssignments: task.open_assignments,
      }));
    return { joinedTaskIds, activeTasks };
  }

  // How many directed/broadcast messages (from the human or a teammate) this agent has not yet
  // received. Powers the per-agent unread badge in the dashboard.
  #pendingMessageCount(agent) {
    const rooms = this.#memberTaskIds(agent.id);
    if (!rooms.length) return 0;
    const roomPlaceholders = rooms.map(() => "?").join(", ");
    const candidates = this.db.prepare(`
      SELECT e.agent_id, e.type, e.metadata FROM events e
      WHERE (e.type = 'human.message' OR e.type LIKE 'agent.%')
        AND e.task_id IN (${roomPlaceholders})
        AND e.created_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM message_receipts r
          WHERE r.event_id = e.id AND r.agent_id = ? AND r.delivered_at IS NOT NULL
        )
    `).all(...rooms, agent.message_floor || agent.connected_at, agent.id);
    return candidates.filter((row) => this.#messageIsForAgent({ ...row, metadata: fromJson(row.metadata, {}) }, agent)).length;
  }

  heartbeat(agentId, status = null) {
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("Agent is disconnected. Connect again to receive work.");
    const nextStatus = status || agent.status;
    this.db.prepare("UPDATE agents SET last_seen = ?, status = ? WHERE id = ?").run(now(), nextStatus, agentId);
    return this.getAgent(agentId);
  }

  disconnectAgent(agentId, summary = "") {
    const agent = this.getAgent(agentId);
    const stamp = now();
    const affectedTaskIds = this.#transaction(() => this.#releaseAgentClaims(agent, stamp, summary || "Agent disconnected normally."));
    this.#changed("agent.disconnected", agent.current_task_id);
    for (const taskId of affectedTaskIds) this.#changed("assignment.released", taskId);
    return { disconnected: true, agentId, summary };
  }

  // A confirmed MCP transport close is strong evidence the client is truly gone (unlike mere
  // silence), so it is safe to release the agent's claims right away instead of waiting for a
  // timeout. Best-effort: ignore an agent that is unknown or already disconnected.
  handleTransportClose(agentId) {
    let agent;
    try { agent = this.getAgent(agentId); } catch { return { disconnected: false }; }
    if (agent.status === "disconnected") return { disconnected: false };
    return this.disconnectAgent(agentId, "MCP transport closed.");
  }

  // Human-driven recovery for a stuck claim — e.g. a crashed writer whose write lease will
  // never be released by silence alone. Requires the exact assignment title as confirmation so
  // a write lease is never handed off by accident while the original agent might still be running.
  forceReleaseAssignment({ assignmentId, confirmTitle = null, reason = "Human force-released the assignment." }) {
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    if (assignment.status !== "claimed") throw new Error("Only a claimed assignment can be force-released.");
    if (confirmTitle !== null && confirmTitle.trim().toLowerCase() !== assignment.title.trim().toLowerCase()) {
      throw new Error("Force release requires the exact assignment title as confirmation.");
    }
    const stamp = now();
    this.#transaction(() => {
      this.db.prepare("UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL WHERE id = ?").run(assignmentId);
      this.#event(assignment.task_id, assignment.agent_id, "assignment.released", reason, { assignmentId, reason: "force-release", requiresWrite: Boolean(assignment.requires_write) });
      this.#syncTaskStatus(assignment.task_id, stamp);
    });
    this.#changed("assignment.released", assignment.task_id);
    return { released: true, assignmentId, taskId: assignment.task_id, requiresWrite: Boolean(assignment.requires_write) };
  }

  createAssignment({ agentId = null, taskId, title, description, role = "implementer", requiresWrite = false, targetAgentName = null, checklist = undefined, paths = undefined, dependsOn = undefined }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (["accepted", "blocked", "cancelled"].includes(task.status)) throw new Error(`Task is already ${task.status}.`);
    if (agentId) { this.getAgent(agentId); this.assertMembership(agentId, taskId); }
    const assignment = {
      id: randomUUID(), taskId, title: title.trim(), description: description.trim(), role: role.trim(),
      requiresWrite: requiresWrite ? 1 : 0, targetAgentName: targetAgentName?.trim() || null, createdAt: now(),
    };
    const resolvedChecklist = this.#resolveChecklist(assignment.role, checklist);
    // A write assignment may declare the paths it will touch, enabling non-overlapping writers
    // to run in parallel; omitting them keeps the conservative whole-project lease.
    const writePaths = assignment.requiresWrite && Array.isArray(paths)
      ? [...new Set(paths.map((p) => String(p).trim()).filter(Boolean))].slice(0, 50)
      : [];
    const dependencyIds = Array.isArray(dependsOn)
      ? [...new Set(dependsOn.map((id) => String(id).trim()).filter(Boolean))].slice(0, 50)
      : [];
    if (dependencyIds.length) {
      const placeholders = dependencyIds.map(() => "?").join(", ");
      const dependencies = this.db.prepare(`SELECT id, task_id FROM assignments WHERE id IN (${placeholders})`).all(...dependencyIds);
      if (dependencies.length !== dependencyIds.length) throw new Error("Every dependency must reference an existing assignment.");
      if (dependencies.some((dependency) => dependency.task_id !== taskId)) throw new Error("Assignment dependencies must belong to the same task.");
    }
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(assignment.id, taskId, assignment.title, assignment.description, assignment.role, assignment.requiresWrite, assignment.targetAgentName, assignment.createdAt);
      this.#storeChecklist(assignment.id, resolvedChecklist);
      if (writePaths.length) this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)").run(assignment.id, json(writePaths));
      for (const dependencyId of dependencyIds) {
        this.db.prepare("INSERT INTO assignment_dependencies (assignment_id, depends_on_assignment_id) VALUES (?, ?)")
          .run(assignment.id, dependencyId);
      }
      this.#syncTaskStatus(taskId);
      this.#event(taskId, agentId, "assignment.created", assignment.title, {
        assignmentId: assignment.id,
        role: assignment.role,
        requiresWrite: Boolean(assignment.requiresWrite),
        targetAgentName: assignment.targetAgentName,
        checklist: resolvedChecklist || [],
        writePaths,
        dependsOn: dependencyIds,
      });
    });
    this.#changed("assignment.created", taskId);
    return { ...this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignment.id), checklist: resolvedChecklist || [], writePaths, dependsOn: dependencyIds };
  }

  claimNextAssignment(agentId) {
    this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("Agent is disconnected. Connect again.");
    // One claim at a time: an agent already holding a claimed assignment must finish (or release)
    // it before taking another. Prevents a single busy agent from hoarding multiple write leases.
    const existingClaim = this.db.prepare("SELECT id FROM assignments WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(agentId);
    if (existingClaim) return null;
    // An agent only claims work inside task rooms it belongs to *as a contributor* (observers
    // never claim). This prevents an agent invoked for one project/task from silently claiming
    // another's work, and stops an observer from taking on execution it only joined to watch.
    // Rooms this agent may claim in: its own contributor rooms, plus any active task where a queued
    // assignment explicitly names it. A targeted assignment is an *invitation* — it lets the planner
    // (or human) pull a specific agent into a new task's room without the agent having to devteam_join
    // first, which is what makes a second task get picked up promptly instead of stalling until every
    // other task is deleted. Untargeted work stays strictly room-scoped, so an agent invoked for one
    // task is never silently conscripted into another it was not invited to.
    const memberRooms = this.#claimableTaskIds(agentId);
    const invitedRooms = this.db.prepare(`
      SELECT DISTINCT a.task_id FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'queued' AND a.target_agent_name IS NOT NULL
        AND lower(a.target_agent_name) = lower(?)
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all(agent.name).map((row) => row.task_id);
    const claimRooms = [...new Set([...memberRooms, ...invitedRooms])];
    if (!claimRooms.length) {
      this.db.prepare("UPDATE agents SET status = CASE WHEN status = 'busy' THEN status ELSE 'waiting' END, last_seen = ? WHERE id = ?").run(now(), agentId);
      return null;
    }
    const claimPlaceholders = claimRooms.map(() => "?").join(", ");
    // In a room the agent already belongs to it may take targeted-or-untargeted work; in a room it
    // only reached by invitation, it may take *only* the assignment(s) addressed to it by name.
    const memberScopeClause = memberRooms.length
      ? `(a.task_id IN (${memberRooms.map(() => "?").join(", ")}) OR lower(a.target_agent_name) = lower(?))`
      : "lower(a.target_agent_name) = lower(?)";
    const memberScopeParams = memberRooms.length ? [...memberRooms, agent.name] : [agent.name];
    const assignment = this.#transaction(() => {
      // Fetch the eligible queue (membership + targeting + review gating). The write lease is
      // no longer project-wide: we resolve it per path below so non-overlapping writers run
      // in parallel.
      const candidates = this.db.prepare(`
        SELECT a.*, t.project_id, t.title AS task_title, t.description AS task_description,
          t.version AS task_version, t.required_approvals, p.root AS project_root, p.name AS project_name
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN projects p ON p.id = t.project_id
        WHERE a.status = 'queued'
          AND a.task_id IN (${claimPlaceholders})
          AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
          AND (a.target_agent_name IS NULL OR lower(a.target_agent_name) = lower(?))
          AND ${memberScopeClause}
          AND NOT EXISTS (
            SELECT 1 FROM assignment_dependencies dependency_link
            JOIN assignments dependency ON dependency.id = dependency_link.depends_on_assignment_id
            WHERE dependency_link.assignment_id = a.id AND dependency.status != 'done'
          )
          AND (
            lower(a.role) NOT IN ('reviewer', 'security-reviewer', 'tester') OR NOT EXISTS (
              SELECT 1 FROM assignments pending_write
              WHERE pending_write.task_id = a.task_id
                AND pending_write.requires_write = 1
                AND pending_write.status IN ('queued', 'claimed')
            )
          )
        ORDER BY CASE WHEN a.target_agent_name IS NOT NULL THEN 0 ELSE 1 END, a.created_at ASC
        LIMIT 20
      `).all(...claimRooms, agent.name, ...memberScopeParams);
      if (!candidates.length) {
        this.db.prepare("UPDATE agents SET status = 'waiting', last_seen = ? WHERE id = ?").run(now(), agentId);
        return null;
      }
      const heldLeases = this.#heldWriteLeases();
      const stamp = now();
      for (const candidate of candidates) {
        // A write assignment is claimable only if its declared paths don't overlap a write
        // lease already held by another agent in the same project. Undeclared paths mean the
        // whole project, which conflicts with everything (backward-compatible single lease).
        if (candidate.requires_write) {
          const scopes = this.#resolveScopesOnDisk(candidate.project_root, this.#writeScopeFor(candidate.id));
          const conflict = heldLeases.some((lease) => lease.projectId === candidate.project_id
            && lease.scopes.some((held) => scopes.some((want) => this.#scopesOverlap(held, want))));
          if (conflict) continue;
        }
        const claimToken = randomBytes(18).toString("base64url");
        const result = this.db.prepare(`
          UPDATE assignments
          SET status = 'claimed', agent_id = ?, claimed_at = ?, claim_generation = claim_generation + 1, claim_token_hash = ?
          WHERE id = ? AND status = 'queued'
        `).run(agentId, stamp, this.#hashToken(claimToken), candidate.id);
        if (!result.changes) continue;
        const claimGeneration = this.db.prepare("SELECT claim_generation FROM assignments WHERE id = ?").get(candidate.id).claim_generation;
        this.db.prepare("UPDATE agents SET status = 'busy', current_task_id = ?, last_seen = ? WHERE id = ?")
          .run(candidate.task_id, stamp, agentId);
        // Persist the room the moment the agent commits to its work, so an implicit membership
        // survives a second task being created later.
        this.db.prepare(`
          INSERT OR IGNORE INTO task_members (task_id, agent_id, role, joined_at) VALUES (?, ?, 'contributor', ?)
        `).run(candidate.task_id, agentId, stamp);
        this.#syncTaskStatus(candidate.task_id, stamp);
        const writeScope = candidate.requires_write ? this.#writeScopeFor(candidate.id) : [];
        this.#event(candidate.task_id, agentId, "assignment.claimed", `${agent.name} claimed: ${candidate.title}`, {
          assignmentId: candidate.id,
          role: candidate.role,
          requiresWrite: Boolean(candidate.requires_write),
          writeScope,
          claimGeneration,
        });
        const dependencies = this.#dependenciesFor(candidate.id);
        return { ...candidate, agent_id: agentId, status: "claimed", claimed_at: stamp, checklist: this.#checklistFor(candidate.id), writeScope, dependsOn: dependencies.map((item) => item.id), blockedBy: [], claimToken, claimGeneration };
      }
      this.db.prepare("UPDATE agents SET status = 'waiting', last_seen = ? WHERE id = ?").run(now(), agentId);
      return null;
    });
    if (assignment) this.#changed("assignment.claimed", assignment.task_id);
    return assignment;
  }

  // Currently-held write leases (claimed write assignments owned by a live agent on a live task),
  // with their normalized path scopes, for per-path conflict resolution.
  #heldWriteLeases() {
    return this.db.prepare(`
      SELECT a.id, t.project_id AS projectId, p.root AS root
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      JOIN agents ag ON ag.id = a.agent_id
      WHERE a.status = 'claimed' AND a.requires_write = 1
        AND ag.status != 'disconnected'
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all().map((row) => ({ projectId: row.projectId, scopes: this.#resolveScopesOnDisk(row.root, this.#writeScopeFor(row.id)) }));
  }

  // Normalize a declared write path to a canonical, comparable prefix so path aliases can't
  // smuggle two overlapping leases past the conflict check (e.g. "src/hud" and
  // "src/ocean/../hud" resolve to the same directory). Trailing globs/slashes are stripped,
  // "." / ".." segments are resolved lexically, and case is folded on Windows. A path that
  // escapes the project root (leading "..") is clamped to "" — the whole project — which
  // conflicts with everything, so an ambiguous scope can never be treated as narrower than it is.
  #normalizeScope(value) {
    let scope = String(value ?? "").trim().replace(/\\/g, "/");
    scope = scope.replace(/^\.\//, "").replace(/^\/+/, "");
    scope = scope.replace(/\/?\*+$/, "").replace(/\/+$/, "");
    const segments = [];
    for (const part of scope.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (!segments.length) return ""; // escapes the root: treat as whole-project
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    let normalized = segments.join("/");
    if (process.platform === "win32") normalized = normalized.toLowerCase();
    return normalized;
  }

  // Realpath the longest existing prefix of an absolute path and re-append the not-yet-created
  // tail. Lets us canonicalize a scope that points at a file/dir that doesn't exist yet while still
  // collapsing any symlink/junction in its existing ancestors.
  #realpathBestEffort(absolute) {
    let current = absolute;
    const tail = [];
    for (;;) {
      try { return tail.length ? path.join(realpathSync(current), ...tail) : realpathSync(current); }
      catch {
        const parent = path.dirname(current);
        if (parent === current) return absolute; // reached the volume root, nothing resolved
        tail.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  // Canonicalize declared scopes against the project's real location on disk, so a symlink or
  // junction can't present the same directory under two different prefixes and win two leases.
  // Best-effort: if the project root can't be resolved, fall back to the lexical scopes.
  #resolveScopesOnDisk(projectRoot, scopes) {
    if (!projectRoot) return scopes;
    let realRoot;
    try { realRoot = realpathSync(path.resolve(projectRoot)); }
    catch { return scopes; }
    return scopes.map((scope) => {
      if (scope === "") return "";
      const real = this.#realpathBestEffort(path.resolve(realRoot, scope));
      const rel = path.relative(realRoot, real).replace(/\\/g, "/");
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return ""; // root or escaped => whole project
      return this.#normalizeScope(rel);
    });
  }

  // Two path scopes overlap if they are equal or one contains the other (segment-aware).
  #scopesOverlap(a, b) {
    if (a === "" || b === "") return true;
    if (a === b) return true;
    return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }

  // The normalized write scope for an assignment. No declared paths => whole-project lease.
  #writeScopeFor(assignmentId) {
    const row = this.db.prepare("SELECT paths FROM assignment_write_scopes WHERE assignment_id = ?").get(assignmentId);
    const declared = fromJson(row?.paths, []);
    const normalized = Array.isArray(declared) ? [...new Set(declared.map((p) => this.#normalizeScope(p)))] : [];
    return normalized.length ? normalized : [""];
  }

  #dependenciesFor(assignmentId) {
    return this.db.prepare(`
      SELECT dependency.id, dependency.title, dependency.status, dependency.role
      FROM assignment_dependencies link
      JOIN assignments dependency ON dependency.id = link.depends_on_assignment_id
      WHERE link.assignment_id = ?
      ORDER BY dependency.created_at ASC
    `).all(assignmentId);
  }

  postMessage({ agentId, taskId, message, type = "agent.message", metadata = {} }) {
    const agent = this.getAgent(agentId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    // A message can be aimed at a specific teammate. A directed agent message is pushed to that
    // teammate (returned by their next devteam_wait / tool call); an undirected one is a
    // timeline note anyone can read via devteam_state.
    const enriched = { ...metadata };
    let directedTo = null;
    if (metadata.target && String(metadata.target).trim()) {
      enriched.targetLabel = metadata.targetLabel || String(metadata.target).trim();
      enriched.target = String(metadata.target).trim().toLowerCase();
      enriched.senderName = agent.name;
      directedTo = enriched.targetLabel;
    }
    this.#transaction(() => {
      this.#event(taskId, agentId, type, message.trim(), enriched);
      this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(now(), agentId);
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), taskId);
    });
    this.markMessagesSeen(agentId);
    this.#changed(type, taskId);
    return { posted: true, agent: agent.name, taskId, directedTo };
  }

  // Best-effort evidence check: which of the reported changed files can't be found on disk under
  // the project root. This does not block a report (not every project is git-tracked and paths can
  // be legitimately unusual) — it surfaces self-reported changes that don't match the filesystem so
  // a reviewer, the dashboard, or a future git diff can weigh them honestly.
  #unverifiedChangedFiles(projectRoot, files) {
    if (!projectRoot || !files.length) return [];
    const root = path.resolve(projectRoot);
    const missing = [];
    for (const file of files) {
      const resolved = path.resolve(root, file);
      const withinRoot = resolved === root || resolved.startsWith(root + path.sep);
      if (!withinRoot || !statSync(resolved, { throwIfNoEntry: false })) missing.push(file);
    }
    return missing;
  }

  // A structured description of why a claim can no longer be completed — the lease moved on. Far
  // more useful to an agent than a bare error string: it says who holds it now and what to do next.
  #claimConflict(assignment, agentId) {
    const holder = assignment.agent_id ? (this.db.prepare("SELECT name FROM agents WHERE id = ?").get(assignment.agent_id)?.name || null) : null;
    return {
      completed: false,
      claimConflict: {
        assignmentId: assignment.id,
        taskId: assignment.task_id,
        status: assignment.status,
        currentOwner: assignment.agent_id === agentId ? "you" : (holder || "nobody"),
        generation: assignment.claim_generation,
        reason: assignment.status !== "claimed"
          ? `This assignment is ${assignment.status}, not an active claim.`
          : "This assignment's lease has moved to a different session.",
        nextAction: "Do not write further under this claim. Call devteam_wait to pick up current work, or devteam_resume if you are returning to an earlier session.",
      },
    };
  }

  completeAssignment({ agentId, assignmentId, message, status = "done", changedFiles = [], checks = [], nextStatus = "waiting", claimToken = null }) {
    const agent = this.getAgent(agentId);
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    // Lease fencing: the owning session (session-bound identity already blocks other agents) and,
    // when supplied, the fencing token must match the live claim. A stale report — from a session
    // whose lease was force-released or moved on resume — gets a structured conflict, not a write.
    const ownedByCaller = assignment.agent_id === agentId && assignment.status === "claimed";
    const tokenMatches = claimToken == null || (assignment.claim_token_hash && this.#hashToken(claimToken) === assignment.claim_token_hash);
    if (!ownedByCaller || !tokenMatches) return this.#claimConflict(assignment, agentId);
    const cleanChanged = [...new Set(changedFiles.map((item) => String(item).trim()).filter(Boolean))].slice(0, 200);
    const cleanChecks = checks.map((item) => String(item).trim()).filter(Boolean).slice(0, 100);
    const task = this.getTask(assignment.task_id);
    const unverifiedFiles = this.#unverifiedChangedFiles(task?.project_root, cleanChanged);
    this.markMessagesSeen(agentId);
    let version;
    let followUpAssignmentId = null;
    this.#transaction(() => {
      const stamp = now();
      this.db.prepare("UPDATE assignments SET status = ?, completed_at = ?, claim_token_hash = NULL WHERE id = ?")
        .run(status === "blocked" ? "blocked" : "done", stamp, assignmentId);
      if (cleanChanged.length) {
        this.db.prepare("UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?").run(stamp, assignment.task_id);
        this.db.prepare("DELETE FROM approvals WHERE task_id = ?").run(assignment.task_id);
      } else {
        this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(stamp, assignment.task_id);
      }
      version = this.db.prepare("SELECT version FROM tasks WHERE id = ?").get(assignment.task_id).version;
      this.#event(assignment.task_id, agentId, status === "blocked" ? "assignment.blocked" : "assignment.completed", message.trim(), {
        assignmentId,
        role: assignment.role,
        changedFiles: cleanChanged,
        checks: cleanChecks,
        version,
        ...(unverifiedFiles.length ? { unverifiedFiles } : {}),
      });
      if (status === "blocked") {
        // An assignment-level blocker is a triage signal, not permission to stop every teammate.
        // Queue a fresh planner item so the team can re-scope or ask the human while sibling work
        // and write leases continue. Only the explicit blockTask/devteam_block path is task-wide.
        followUpAssignmentId = randomUUID();
        this.db.prepare(`
          INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at)
          VALUES (?, ?, ?, ?, 'planner', 0, 'queued', ?)
        `).run(
          followUpAssignmentId,
          assignment.task_id,
          `Resolve blocker: ${assignment.title}`,
          `Review the blocker reported for "${assignment.title}": ${message.trim()}. Re-scope the work, create a replacement assignment, or use devteam_block only if the entire task genuinely requires human input.`,
          stamp,
        );
        this.#event(assignment.task_id, agentId, "assignment.created", `Resolve blocker: ${assignment.title}`, {
          assignmentId: followUpAssignmentId,
          role: "planner",
          requiresWrite: false,
          blockedAssignmentId: assignment.id,
        });
        this.db.prepare("UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ? WHERE id = ?")
          .run(stamp, agentId);
        this.#syncTaskStatus(assignment.task_id, stamp);
      } else {
        const disconnect = nextStatus === "disconnected";
        this.db.prepare("UPDATE agents SET status = ?, current_task_id = NULL, last_seen = ?, disconnected_at = ? WHERE id = ?")
          .run(disconnect ? "disconnected" : "waiting", stamp, disconnect ? stamp : null, agentId);
        this.#syncTaskStatus(assignment.task_id, stamp);
      }
    });
    this.#changed(status === "blocked" ? "assignment.blocked" : "assignment.completed", assignment.task_id);
    return {
      completed: true,
      taskId: assignment.task_id,
      assignmentId,
      status,
      version,
      changedFiles: cleanChanged,
      checks: cleanChecks,
      agent: agent.name,
      ...(status === "blocked" ? { taskBlocked: false, followUpAssignmentId } : {}),
    };
  }

  // No dead-ends: a task can never require more independent approvals than the number
  // of distinct agents that actually took part (completed work or approved). A solo run
  // can finish; a two-agent run still needs two independent reviews.
  #participantCount(taskId) {
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT agent_id FROM approvals WHERE task_id = ? AND agent_id IS NOT NULL
        UNION
        SELECT agent_id FROM events WHERE task_id = ? AND type = 'assignment.completed' AND agent_id IS NOT NULL
      )
    `).get(taskId, taskId).count);
  }

  #effectiveRequiredApprovals(taskId, configured) {
    const participants = this.#participantCount(taskId);
    return Math.max(1, Math.min(configured, participants || 1));
  }

  // Did this agent author the change under review (a completed assignment that reported changed
  // files on the current version)? Used to keep review independent: the author of a version may
  // not sign off on their own version when other teammates exist to do it.
  #authoredCurrentVersion(taskId, agentId, version) {
    return this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version && Array.isArray(metadata.changedFiles) && metadata.changedFiles.length > 0;
    });
  }

  approveTask({ agentId, taskId, summary }) {
    const agent = this.getAgent(agentId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(`Cannot approve a ${task.status} task.`);
    if (task.status === "accepted") {
      return { accepted: true, approvalCount: task.required_approvals, requiredApprovals: task.required_approvals, openAssignments: 0, version: task.version };
    }
    const reviewEvidence = this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
      ORDER BY id DESC
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === task.version
        && ["reviewer", "tester", "security-reviewer"].includes(String(metadata.role || "").toLowerCase())
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
    if (!reviewEvidence) throw new Error("Approval requires a completed, read-only reviewer or tester assignment on the current task version.");
    // Reviewer ≠ author: when the team is more than one agent, the author of the current version
    // cannot approve it — an independent teammate must. A genuine solo run is still allowed to
    // finish (no dead-ends), but its acceptance is labeled selfReviewed so it is never mistaken
    // for independent consensus.
    const authoredThisVersion = this.#authoredCurrentVersion(taskId, agentId, task.version);
    const participants = this.#participantCount(taskId);
    if (authoredThisVersion && participants > 1) {
      throw new Error("The author of the current version cannot approve it; an independent reviewer or tester must.");
    }
    let outcome;
    this.#transaction(() => {
      const stamp = now();
      this.db.prepare(`
        INSERT INTO approvals (task_id, agent_id, version, summary, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_id, agent_id, version) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at
      `).run(taskId, agentId, task.version, summary.trim(), stamp);
      this.#event(taskId, agentId, "task.approved", `${agent.name} approved version ${task.version}.`, { summary: summary.trim(), version: task.version });
      const approvalCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE task_id = ? AND version = ?").get(taskId, task.version).count);
      const openAssignments = Number(this.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')").get(taskId).count);
      const effectiveRequired = this.#effectiveRequiredApprovals(taskId, task.required_approvals);
      const accepted = approvalCount >= effectiveRequired && openAssignments === 0;
      // Honest labeling: a single-participant task was never independently reviewed, however many
      // approvals it nominally required.
      const selfReviewed = participants <= 1;
      if (accepted) {
        this.db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, taskId);
        this.#event(taskId, null, "task.accepted", `${selfReviewed ? "Self-reviewed acceptance" : "Consensus reached"} for version ${task.version}.`, { approvalCount, requiredApprovals: effectiveRequired, selfReviewed });
        // Keep the room's agents assembled (status 'waiting', membership intact) rather than force-
        // disconnecting them on acceptance, so the human can send a same-conversation follow-up that
        // continueTask reopens and the still-waiting agents pick up without restarting their sessions.
        // The continuation window in teamActivity keeps them from idling out before that follow-up.
        this.db.prepare(`
          UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ?
          WHERE (current_task_id = ? OR id IN (SELECT agent_id FROM approvals WHERE task_id = ?)) AND status != 'disconnected'
        `).run(stamp, taskId, taskId);
      } else {
        this.db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(stamp, taskId);
      }
      outcome = { accepted, approvalCount, requiredApprovals: effectiveRequired, configuredApprovals: task.required_approvals, openAssignments, version: task.version, selfReviewed };
    });
    this.#changed(outcome.accepted ? "task.accepted" : "task.approved", taskId);
    return outcome;
  }

  // When a task stops (blocked, or an agent reports a blocker), release its co-workers cleanly:
  // close their claims and free them to do other work, but do NOT force-disconnect their session.
  // With path-scoped parallelism a teammate may be mid-write on an unrelated file; hard-killing the
  // connection loses that session. They stand down to 'waiting' and learn why via the timeline.
  #standDownTaskAgents(taskId, stamp, note) {
    const affected = this.db.prepare("SELECT name FROM agents WHERE current_task_id = ? AND status != 'disconnected'").all(taskId);
    if (!affected.length) return;
    this.db.prepare(`
      UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ?
      WHERE current_task_id = ? AND status != 'disconnected'
    `).run(stamp, taskId);
    this.#event(taskId, null, "agent.standdown", note, { agents: affected.map((a) => a.name) });
  }

  blockTask({ agentId = null, taskId, reason }) {
    if (agentId) this.getAgent(agentId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const stamp = now();
    this.#transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?").run(stamp, taskId);
      this.db.prepare(`
        UPDATE assignments SET status = 'blocked', completed_at = COALESCE(completed_at, ?)
        WHERE task_id = ? AND status IN ('queued', 'claimed')
      `).run(stamp, taskId);
      this.#event(taskId, agentId, "task.blocked", reason.trim(), {});
      this.#standDownTaskAgents(taskId, stamp, "Task was blocked; co-workers were released to other work.");
    });
    this.#changed("task.blocked", taskId);
    return { blocked: true, taskId, reason: reason.trim() };
  }

  unblockTask({ taskId, reason }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (task.status !== "blocked") throw new Error("Only a blocked task can be resumed.");
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) throw new Error("A resume reason is required.");
    const stamp = now();
    const assignmentId = randomUUID();
    let version;
    this.#transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'planning', version = version + 1, updated_at = ? WHERE id = ?")
        .run(stamp, taskId);
      this.db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at)
        VALUES (?, ?, 'Plan resumed task', ?, 'planner', 0, 'queued', ?)
      `).run(assignmentId, taskId, `The human resumed this blocked task: ${cleanReason}. Inspect the current project state and create fresh implementation and review assignments; do not revive stale claims.`, stamp);
      version = this.db.prepare("SELECT version FROM tasks WHERE id = ?").get(taskId).version;
      this.#event(taskId, null, "task.unblocked", `Human resumed the task: ${cleanReason}`, { reason: cleanReason, version });
      this.#event(taskId, null, "assignment.created", "Plan resumed task", {
        assignmentId,
        role: "planner",
        requiresWrite: false,
        resumed: true,
      });
    });
    this.#changed("task.unblocked", taskId);
    return { resumed: true, taskId, assignmentId, version, status: "planning" };
  }

  acceptTaskByHuman({ taskId, summary }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(`Cannot accept a ${task.status} task.`);
    if (task.status === "accepted") return { accepted: true, taskId, version: task.version, humanOverride: true };
    if (task.status !== "review") throw new Error("Human acceptance is available only when the task is ready for review.");
    const cleanSummary = String(summary || "").trim();
    if (!cleanSummary) throw new Error("An acceptance summary is required.");
    const openAssignments = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')
    `).get(taskId).count);
    if (openAssignments) throw new Error("Finish or release all open assignments before accepting the task.");
    const approvalCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM approvals WHERE task_id = ? AND version = ?
    `).get(taskId, task.version).count);
    const stamp = now();
    this.#transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, taskId);
      this.#event(taskId, null, "task.accepted", `Human accepted version ${task.version}: ${cleanSummary}`, {
        summary: cleanSummary,
        version: task.version,
        approvalCount,
        requiredApprovals: task.required_approvals,
        humanOverride: true,
      });
      this.db.prepare(`
        UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ?
        WHERE current_task_id = ? AND status != 'disconnected'
      `).run(stamp, taskId);
    });
    this.#changed("task.accepted", taskId);
    return {
      accepted: true,
      taskId,
      version: task.version,
      approvalCount,
      requiredApprovals: task.required_approvals,
      humanOverride: true,
    };
  }

  humanMessage(taskId, message, target = "all", replyTo = null) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const normalized = String(target || "all").trim() || "all";
    const targetKey = normalized.toLowerCase();
    let eventId;
    this.#transaction(() => {
      eventId = this.#event(taskId, null, "human.message", message.trim(), {
        target: targetKey,
        targetLabel: targetKey === "all" ? "all agents" : normalized,
        ...(replyTo ? { replyTo: Number(replyTo) } : {}),
      });
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), taskId);
    });
    this.#changed("human.message", taskId);
    return { posted: true, eventId, target: targetKey };
  }

  // Same-conversation continuation: the human sends a follow-up into an existing task's chat and the
  // work queue picks it up without anyone starting a new session. Posts the message, reopens an
  // already-accepted task (new version, prior approvals cleared so a stale sign-off can't auto-accept
  // the new work), and queues a planner assignment tied to the follow-up so the team re-splits. A
  // blocked/cancelled task is not auto-reopened — that needs an explicit human unblock.
  continueTask({ taskId, message, target = "all", replyTo = null, byAgentId = null }) {
    if (byAgentId) this.assertMembership(byAgentId, taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(`Task is ${task.status}; unblock it before continuing.`);
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) throw new Error("A continuation message is required.");
    const normalized = String(target || "all").trim() || "all";
    const targetKey = normalized.toLowerCase();
    const firstLine = cleanMessage.split("\n")[0].slice(0, 120) || "new request";
    const stamp = now();
    let result;
    this.#transaction(() => {
      const eventId = this.#event(taskId, null, "human.message", cleanMessage, {
        target: targetKey,
        targetLabel: targetKey === "all" ? "all agents" : normalized,
        continuation: true,
        ...(replyTo ? { replyTo: Number(replyTo) } : {}),
      });
      // A follow-up added once the work is settled (accepted, or under review awaiting sign-off) is
      // new work: advance the version and drop that version's approvals so a stale approval can't
      // carry over — even if the follow-up produces no changed-file report. Work still in flight
      // ('active'/'planning') stays on the current version and just gains the new planning item.
      const reopened = ["accepted", "review"].includes(task.status);
      if (reopened) {
        this.db.prepare("UPDATE tasks SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?").run(stamp, taskId);
        this.db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
      } else {
        this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(stamp, taskId);
      }
      const assignmentId = randomUUID();
      const title = `Plan follow-up: ${firstLine}`;
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at)
        VALUES (?, ?, ?, ?, 'planner', 0, NULL, 'queued', ?)
      `).run(assignmentId, taskId, title, `Plan the follow-up requested in chat: "${firstLine}". Split it into implementation and review work as needed.`, stamp);
      this.#event(taskId, byAgentId, "assignment.created", title, { assignmentId, role: "planner", requiresWrite: false, targetAgentName: null, continuesEvent: eventId });
      this.#syncTaskStatus(taskId, stamp);
      const version = this.db.prepare("SELECT version FROM tasks WHERE id = ?").get(taskId).version;
      result = { taskId, eventId, reopened, version, assignmentId };
    });
    this.#changed("task.continued", taskId);
    return result;
  }

  // --- Shared blackboard: a task-scoped, versioned key/document store that is the team's working
  // memory — goals, decisions, facts, open questions, per-file ownership — so agents read shared
  // state instead of re-deriving it from scrollback or trusting each other's summaries. Writes use
  // optimistic concurrency (pass the version you read; a mismatch is reported, not silently
  // clobbered) and carry provenance. A structured "world" document is just the value under one key. ---

  #noteScope(taskId, scope = "task") {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const cleanScope = scope === "project" ? "project" : "task";
    return cleanScope === "project"
      ? { scope: cleanScope, table: "project_blackboard", idColumn: "project_id", id: task.project_id }
      : { scope: cleanScope, table: "blackboard", idColumn: "task_id", id: taskId };
  }

  noteSet({ agentId = null, taskId, key, value, expectedVersion = null, scope = "task" }) {
    const target = this.#noteScope(taskId, scope);
    this.assertMembership(agentId, taskId);
    const cleanKey = String(key || "").trim();
    if (!cleanKey) throw new Error("A blackboard key is required.");
    const cleanValue = typeof value === "string" ? value : json(value);
    if (cleanValue.length > 100_000) throw new Error("Blackboard value is too large (100k max).");
    const author = agentId ? this.getAgent(agentId) : null;
    const stamp = now();
    let result;
    this.#transaction(() => {
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
      this.#event(taskId, agentId, "blackboard.updated", `${target.scope === "project" ? "Project" : "Task"} memory "${cleanKey}" updated (v${nextVersion}).`, { scope: target.scope, key: cleanKey, version: nextVersion });
      result = { ok: true, scope: target.scope, key: cleanKey, version: nextVersion, updatedBy: author?.name || "human", updatedAt: stamp };
    });
    if (result.ok) this.#changed("blackboard.updated", taskId);
    return result;
  }

  noteGet(taskId, key, scope = "task", agentId = null) {
    const target = this.#noteScope(taskId, scope);
    if (agentId) this.assertMembership(agentId, taskId);
    const row = this.db.prepare(`SELECT * FROM ${target.table} WHERE ${target.idColumn} = ? AND key = ?`).get(target.id, String(key || "").trim());
    if (!row) return null;
    return { scope: target.scope, key: row.key, value: row.value, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at };
  }

  noteList(taskId, scope = "task", agentId = null) {
    const target = this.#noteScope(taskId, scope);
    if (agentId) this.assertMembership(agentId, taskId);
    return this.db.prepare(`SELECT key, version, updated_by_name, updated_at FROM ${target.table} WHERE ${target.idColumn} = ? ORDER BY key ASC`).all(target.id)
      .map((row) => ({ scope: target.scope, key: row.key, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at }));
  }

  knowledgeSearch({ agentId = null, taskId, query = "", category = null, status = null, limit = 20 }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    return {
      automated: this.knowledge.enabled,
      vaultPath: path.join(task.project_root, "knowledge"),
      notes: this.knowledge.search(task.project_id, taskId, { query, category, status, limit }),
    };
  }

  taskDetail(taskId) {
    const task = this.getTask(taskId);
    if (!task) return null;
    const assignments = this.db.prepare(`
      SELECT a.*, ag.name AS agent_name, ag.provider AS agent_provider
      FROM assignments a LEFT JOIN agents ag ON ag.id = a.agent_id
      WHERE a.task_id = ? ORDER BY a.created_at ASC
    `).all(taskId).map((assignment) => {
      const dependencies = this.#dependenciesFor(assignment.id);
      return {
        ...assignment,
        checklist: this.#checklistFor(assignment.id),
        writeScope: assignment.requires_write ? this.#writeScopeFor(assignment.id) : [],
        dependsOn: dependencies.map((item) => item.id),
        blockedBy: dependencies.filter((item) => item.status !== "done"),
      };
    });
    const members = this.db.prepare(`
      SELECT m.role, ag.name AS agent_name, ag.provider AS agent_provider, ag.status
      FROM task_members m JOIN agents ag ON ag.id = m.agent_id
      WHERE m.task_id = ? ORDER BY m.joined_at ASC
    `).all(taskId);
    const approvals = this.db.prepare(`
      SELECT ap.*, ag.name AS agent_name, ag.provider AS agent_provider
      FROM approvals ap JOIN agents ag ON ag.id = ap.agent_id
      WHERE ap.task_id = ? AND ap.version = ? ORDER BY ap.created_at ASC
    `).all(taskId, task.version);
    const events = this.db.prepare(`
      SELECT recent.*, ag.name AS agent_name, ag.provider AS agent_provider
      FROM (
        SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 500
      ) recent
      LEFT JOIN agents ag ON ag.id = recent.agent_id
      ORDER BY recent.id ASC
    `).all(taskId).map((event) => ({ ...event, metadata: fromJson(event.metadata, {}) }));
    const receipts = this.db.prepare(`
      SELECT r.event_id, r.delivered_at, r.seen_at, ag.name AS agent_name, ag.provider AS agent_provider
      FROM message_receipts r
      JOIN agents ag ON ag.id = r.agent_id
      WHERE r.event_id IN (SELECT id FROM events WHERE task_id = ? AND type = 'human.message')
      ORDER BY r.delivered_at ASC
    `).all(taskId);
    const receiptsByEvent = new Map();
    for (const receipt of receipts) {
      if (!receiptsByEvent.has(receipt.event_id)) receiptsByEvent.set(receipt.event_id, []);
      receiptsByEvent.get(receipt.event_id).push(receipt);
    }
    for (const event of events) {
      if (event.type === "human.message") event.receipts = receiptsByEvent.get(event.id) || [];
    }
    const proposals = this.proposalsForTask(taskId);
    const blackboard = this.db.prepare("SELECT key, value, version, updated_by_name, updated_at FROM blackboard WHERE task_id = ? ORDER BY key ASC")
      .all(taskId).map((row) => ({ scope: "task", key: row.key, value: row.value, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at }));
    const projectBlackboard = this.db.prepare("SELECT key, value, version, updated_by_name, updated_at FROM project_blackboard WHERE project_id = ? ORDER BY key ASC")
      .all(task.project_id).map((row) => ({ scope: "project", key: row.key, value: row.value, version: row.version, updatedBy: row.updated_by_name, updatedAt: row.updated_at }));
    const knowledge = this.knowledge.list(task.project_id, { limit: 30 });
    return {
      ...task, assignments, approvals, events, proposals, blackboard, projectBlackboard, knowledge, members,
      knowledgeVault: {
        automated: this.knowledge.enabled,
        path: path.join(task.project_root, "knowledge"),
        noteCount: knowledge.length,
        error: this.knowledgeErrors.get(taskId) || this.knowledgeErrors.get(`project:${task.project_id}`) || null,
      },
    };
  }

  taskBrief(agentId, taskId) {
    this.getAgent(agentId);
    this.assertMembership(agentId, taskId);
    const detail = this.taskDetail(taskId);
    if (!detail) throw new Error("Task not found.");
    const clip = (value, max) => {
      const text = String(value || "");
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };
    const summarizeNote = (note) => ({
      scope: note.scope,
      key: note.key,
      value: clip(note.value, 2_000),
      version: note.version,
      updatedBy: note.updatedBy,
      updatedAt: note.updatedAt,
    });
    const relevantTypes = new Set(["human.message", "agent.decision", "agent.finding", "task.blocked", "task.unblocked", "task.accepted"]);
    const recent = detail.events.filter((event) => relevantTypes.has(event.type)).slice(-12).map((event) => ({
      id: event.id,
      type: event.type,
      from: event.agent_name || "human",
      message: clip(event.message, 800),
      at: event.created_at,
    }));
    const repliedTo = new Set(detail.events.map((event) => Number(event.metadata?.replyTo || 0)).filter(Boolean));
    const unresolvedQuestions = detail.events
      .filter((event) => event.type === "agent.question" && !repliedTo.has(event.id))
      .slice(-10)
      .map((event) => ({ id: event.id, from: event.agent_name || "agent", message: clip(event.message, 800), at: event.created_at }));
    const openAssignments = detail.assignments
      .filter((assignment) => ["queued", "claimed"].includes(assignment.status))
      .map((assignment) => ({
        id: assignment.id,
        title: assignment.title,
        description: clip(assignment.description, 600),
        role: assignment.role,
        status: assignment.status,
        agent: assignment.agent_name || null,
        dependsOn: assignment.dependsOn,
        blockedBy: assignment.blockedBy,
      }));
    const currentAssignment = openAssignments.find((assignment) => detail.assignments.find((item) => item.id === assignment.id)?.agent_id === agentId) || null;
    return {
      task: {
        id: detail.id,
        title: detail.title,
        description: clip(detail.description, 2_000),
        status: detail.status,
        version: detail.version,
        project: { id: detail.project_id, name: detail.project_name, root: detail.project_root },
      },
      currentAssignment,
      openAssignments,
      taskMemory: detail.blackboard.map(summarizeNote),
      projectMemory: detail.projectBlackboard.map(summarizeNote),
      projectKnowledge: this.knowledge.relevant(detail.project_id, taskId, 12),
      openProposals: detail.proposals.filter((proposal) => proposal.status === "open").map((proposal) => ({ id: proposal.id, kind: proposal.kind, summary: clip(proposal.summary, 800), votes: proposal.votes })),
      recent,
      unresolvedQuestions,
    };
  }

  snapshot(taskId = undefined) {
    const tasks = this.listTasks();
    const selectedId = taskId === undefined ? tasks[0]?.id || null : taskId;
    return {
      serverTime: now(),
      projects: this.listProjects(),
      agents: this.listAgents(),
      tasks,
      selectedTask: selectedId ? this.taskDetail(selectedId) : null,
    };
  }

  // The dashboard snapshot as one agent may see it: the pre-selected task detail is limited to a
  // room the agent belongs to, so a no-taskId devteam_state never hands a non-member another
  // room's full timeline. The project/agent/task lists stay visible (they carry no room secrets).
  snapshotForAgent(agentId) {
    const tasks = this.listTasks();
    const rooms = this.#memberTaskIds(agentId);
    const selectedId = tasks.find((task) => rooms.includes(task.id))?.id || null;
    return {
      serverTime: now(),
      projects: this.listProjects(),
      agents: this.listAgents(),
      tasks,
      selectedTask: selectedId ? this.taskDetail(selectedId) : null,
    };
  }
}
