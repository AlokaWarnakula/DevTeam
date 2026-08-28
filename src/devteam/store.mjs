import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "./schema.mjs";
import { fromJson, json, now } from "./util.mjs";
import { checksMethods } from "./store-checks.mjs";
import { knowledgeMethods } from "./store-knowledge.mjs";
import { consensusMethods, PROPOSAL_KINDS } from "./store-consensus.mjs";
import { viewMethods } from "./store-views.mjs";
import { CodeGraph } from "./codegraph.mjs";
import { KnowledgeVault } from "./knowledge.mjs";
import { buildBudgetedBrief, clipUtf8, DEFAULT_BRIEF_BUDGET } from "./brief.mjs";
import { DEFAULT_ROLES, loadProjectRoles, planningRole, roleBehaviour, ROLES_CONFIG_PATH } from "./roles.mjs";
import { currentRung, ladderIsStale, loadLadders, requiredRung, rungLabel, saveLadder } from "./models.mjs";
import { hashToken, mintToken, normalizeTokenLabel, tokensMatch } from "./access.mjs";
import { assessAssignment, COMPLEXITY_POLICY_VERSION } from "./runtime/index.mjs";
import {
  CHECK_ALLOWLIST_LIMIT,
  DEFAULT_CHECK_TIMEOUT_MS,
  matchCheckCommand,
  normalizeCheckCommand,
  packageScriptCommands,
  projectDeclaredCommands,
  resolveLocalBinary,
  CHECKS_CONFIG_PATH,
  runVerifiedCheck,
  VERIFIED_CHECKS_PER_REPORT,
} from "./checks.mjs";

// A task in one of these states hands out no work; named once so the candidate scan and the
// scheduler's explanation can never disagree about what "closed" means.
const CLOSED_TASK_STATUSES = ["accepted", "blocked", "cancelled"];
// Why a task was stopped, recorded rather than inferred from prose. Blocking is the one action no
// MCP tool can undo, and on the live board agents reached for that single verb to mean six different
// things — including "done": six task.blocked events read "Done", "done", "because all work is
// done". A finished task closed that way stands every teammate down and needs the human to reopen it
// purely so it can be accepted. None of these kinds is "finished", which is the point: naming the
// kind is what stops the verb from absorbing a meaning it should never have had.
const BLOCK_KINDS = ["needs-human", "over-my-head", "misrouted", "external"];
// The three above that describe work in flight. With an empty board there is nothing for them to
// stop, so they are refused and the caller is pointed at the move it actually wanted.
const BLOCK_KINDS_NEEDING_OPEN_WORK = BLOCK_KINDS.filter((kind) => kind !== "needs-human");
// How far the candidate scan will look past lease-blocked and runtime-gated work before giving up.
// Generous for a local single-user server, and bounded so a pathological board cannot stall a claim.
const CANDIDATE_PAGE_SIZE = 20;
const CANDIDATE_SCAN_CEILING = 500;
// How many read-only assignments one agent may hold at once, on top of its single write claim. A
// guard against one agent draining the review queue, not a correctness rule — reviews take no lease.
const MAX_CONCURRENT_READ_CLAIMS = 3;
// Which assignments depend, directly or transitively, on which. Written once so the candidate scan
// and the scheduler's explanation walk the same edges.
const DEPENDENCY_CLOSURE_CTE = `
        WITH RECURSIVE dependency_closure(assignment_id, prerequisite_id) AS (
          SELECT assignment_id, depends_on_assignment_id FROM assignment_dependencies
          UNION
          SELECT dependency_closure.assignment_id, dependency_link.depends_on_assignment_id
          FROM dependency_closure
          JOIN assignment_dependencies dependency_link
            ON dependency_link.assignment_id = dependency_closure.prerequisite_id
        )`;

// The pending writers a verifier is waiting on. Used both by the scan's review-gating predicate
// (which asks only whether any exist) and by the explanation (which names them).
const BLOCKING_WRITER_CONDITIONS = `pending_write.task_id = a.task_id
                -- An assignment can never be the writer it is waiting for. Without this, a
                -- reviewer/tester that itself declares write access matches its own row here and
                -- is excluded from every scan forever, with nothing reported as blocking it.
                -- (Kept explicit for the reader: the creation-order rule below now also excludes
                -- the self row, since nothing is strictly older than itself. Mutation testing
                -- confirms removing this line changes no behavior — it states the intent.)
                AND pending_write.id != a.id
                AND pending_write.requires_write = 1
                AND pending_write.status IN ('queued', 'claimed')
                AND NOT EXISTS (
                  SELECT 1 FROM dependency_closure
                  WHERE dependency_closure.assignment_id = pending_write.id
                    AND dependency_closure.prerequisite_id = a.id
                )
                -- A writer that cannot start yet is not about to change anything, so waiting for it
                -- buys nothing and costs liveness. Without this, the review gate and the dependency
                -- gate compose into a waits-for cycle that never resolves: V1 waits for W1, W1
                -- depends on V2, V2 waits for W2, W2 depends on V1 — four assignments, an acyclic
                -- dependency graph, every agent present, and a board that never moves again. The
                -- exclusion above only breaks that cycle when it is one hop long.
                AND NOT EXISTS (
                  SELECT 1 FROM assignment_dependencies blocking_link
                  JOIN assignments blocking ON blocking.id = blocking_link.depends_on_assignment_id
                  WHERE blocking_link.assignment_id = pending_write.id AND blocking.status != 'done'
                )
                -- Two verifiers that both declare write access are each other's pending writer, so
                -- without an order they gate each other forever. Creation order breaks the tie
                -- deterministically: a verifier waits only for verifiers older than itself.
                AND (
                  pending_write.verifies = 0
                  OR pending_write.created_at < a.created_at
                  OR (pending_write.created_at = a.created_at AND pending_write.id < a.id)
                )`;

// Why the two conditions above are enough to guarantee the board always drains: every waits-for edge
// now points at something strictly older, or at something with no outgoing edges at all. A verifier
// waits for a writer only when that writer has no unmet dependencies — so the writer has no outgoing
// dependency edge — and a writer has an outgoing review edge only when it is itself a verifier, in
// which case the creation-order rule makes that edge point backwards. Dependency edges always point
// backwards too, since a dependency must already exist to be referenced. A graph whose every edge
// points backwards or into a sink cannot contain a cycle.
//
// The cost is that a verifier may occasionally start just before a distant queued writer runs. That
// is already handled: a completing writer with changed files bumps the task version and clears the
// approvals built on the old one, so a review overtaken by later work is invalidated rather than
// trusted. Liveness is the better trade.

// A path scope of "" is the whole-project lease; spell that out wherever a scope reaches a human.
const scopeLabel = (scope) => (scope === "" ? "the whole project" : scope);

// Whether the process recorded in the instance lock still exists. Signal 0 asks without sending
// anything. EPERM means it exists and belongs to somebody else, which still counts as alive; only
// ESRCH means gone. An unknown pid is treated as alive so a malformed lock never opens the door.
function holdingProcessIsAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return true;
  if (id === process.pid) return true;
  try { process.kill(id, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export class DevTeamStore extends EventEmitter {
  // Per-project role config, cached by the file's mtime (see projectRoles).
  #roleCache = new Map();
  #splitOutcome = { inferred: [], keep: false };

  // `exclusive: false` opens the database to *look* at it — `devteam token`, a doctor command, a
  // script — while the real server is running. Such a process takes no lock, and, just as important,
  // performs none of the startup recovery: reaping orphaned claims and re-deriving task status are
  // the server's job, and doing them from a CLI peek would move work around behind a live
  // scheduler's back. That was already happening before the lock existed.
  constructor(dataDir, { liveness = {}, knowledge = {}, codegraph = {}, checks = {}, exclusive = true } = {}) {
    super();
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = path.join(this.dataDir, "devteam.sqlite");
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    // T0.4 — one process per data directory, enforced rather than assumed.
    //
    // WAL makes concurrent *SQLite* access safe, which is not the same thing as making two DevTeam
    // servers safe. Each one runs its own reaper and its own scheduler: they would recover each
    // other's live claims as orphans, hand the same write scopes to two agents, and reap agents that
    // are talking to the other process. The write-lease model is the invariant this whole server is
    // built on, so a second instance is refused loudly instead of silently corrupting it.
    this.exclusive = exclusive;
    this.instanceId = exclusive ? randomUUID() : null;
    if (exclusive) this.#claimDataDirectory();
    // How long DevTeam will block while verifying one reported check. The ceiling lives in
    // checks.mjs; this is the per-install default a host may lower.
    this.checkTimeoutMs = Number(checks.timeoutMs) || DEFAULT_CHECK_TIMEOUT_MS;
    this.knowledge = new KnowledgeVault(this.db, knowledge);
    this.knowledgeErrors = new Map();
    this.codegraph = new CodeGraph(this.db, codegraph);
    this.codegraphErrors = new Map();
    this.briefHealth = new Map();
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
      forgetMs: 86_400_000,       // gone this long (disconnected, or unresponsive holding no write lease): purge the row so ghosts stop lingering as "online"
      ...liveness,
    };
    // Everything below moves state: it belongs to the process that owns the directory, never to a
    // CLI looking in while that process is running.
    if (!exclusive) return;
    // A report whose checks were still running when the process died left a verifying flag behind.
    // The child processes are gone with it, so nothing is coming to settle those reports. Clearing
    // the flag returns the assignment to a plain live claim, which is exactly what it still is — the
    // claim, the lease and the fencing token were never released while verification ran — so the
    // agent simply reports again. The alternative, leaving it set, would refuse every retry forever.
    this.db.exec("UPDATE assignments SET verifying_at = NULL WHERE verifying_at IS NOT NULL");
    this.#recoverInterruptedJobs();
    this.#recoverOrphanedClaims("Recovered an orphaned assignment during server startup.");
    this.#syncAllTaskStatuses();
  }

  // How long a lock survives without a heartbeat before another process may take the directory.
  // Long enough that a busy server is never mistaken for a dead one, short enough that a hard kill
  // does not leave the tool refusing to start until somebody deletes something by hand — which is
  // how a safety measure becomes the thing people turn off.
  static INSTANCE_LOCK_STALE_MS = 120_000;
  static INSTANCE_HEARTBEAT_MS = 30_000;

  #claimDataDirectory() {
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get();
    const lock = existing ? fromJson(existing.value, null) : null;
    if (lock?.instanceId && lock.instanceId !== this.instanceId) {
      const age = Date.now() - Date.parse(lock.heartbeatAt || lock.startedAt || 0);
      // A dead process holds nothing. A clean shutdown releases the lock, but a SIGKILL cannot, and
      // waiting out the stale window then means the tool refuses to restart for two minutes after
      // any hard kill — which is exactly how a safety measure trains people to work around it. The
      // lock is always same-machine (it guards a local directory), so the pid can simply be asked.
      if (holdingProcessIsAlive(lock.pid) && Number.isFinite(age) && age < DevTeamStore.INSTANCE_LOCK_STALE_MS) {
        this.db.close();
        throw new Error([
          `Another DevTeam server is already using this data directory`,
          `(pid ${lock.pid ?? "unknown"}, last seen ${Math.max(0, Math.round(age / 1000))}s ago).`,
          "DevTeam runs one process per data directory: two would hand out the same write leases from",
          "two schedulers and reap each other's agents. Stop the other server, or start this one with a",
          "different --data directory.",
        ].join(" "));
      }
    }
    this.#writeInstanceLock();
    // Unref'd so a store never keeps a process alive on its own account — tests create dozens, and a
    // heartbeat that held the event loop open would hang every one of them.
    this.instanceHeartbeat = setInterval(() => {
      try { this.#writeInstanceLock(); } catch { /* the database is closing; the lock will go stale on its own */ }
    }, DevTeamStore.INSTANCE_HEARTBEAT_MS);
    this.instanceHeartbeat.unref?.();
  }

  #writeInstanceLock() {
    const stamp = now();
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get();
    const startedAt = existing ? (fromJson(existing.value, {})?.startedAt || stamp) : stamp;
    const value = json({ instanceId: this.instanceId, pid: process.pid, startedAt, heartbeatAt: stamp });
    if (existing) this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'server_instance'").run(value);
    else this.db.prepare("INSERT INTO metadata (key, value) VALUES ('server_instance', ?)").run(value);
  }

  #releaseDataDirectory() {
    if (this.instanceHeartbeat) clearInterval(this.instanceHeartbeat);
    this.instanceHeartbeat = null;
    try {
      const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'server_instance'").get();
      if (existing && fromJson(existing.value, {})?.instanceId === this.instanceId) {
        this.db.prepare("DELETE FROM metadata WHERE key = 'server_instance'").run();
      }
    } catch { /* closing anyway */ }
  }

  // A job still marked running belongs to a process that no longer exists — this one has only just
  // started, and nothing else may hold the directory. Close those rows out and say so on the
  // timeline. Nothing is retried: see the note on the `jobs` table for why that is the whole point.
  #recoverInterruptedJobs() {
    const orphaned = this.db.prepare("SELECT * FROM jobs WHERE state = 'running'").all();
    if (!orphaned.length) return;
    const stamp = now();
    for (const job of orphaned) {
      this.db.prepare("UPDATE jobs SET state = 'interrupted', finished_at = ?, outcome = ? WHERE id = ?")
        .run(stamp, "Interrupted by a server restart before it finished.", job.id);
      const detail = fromJson(job.detail, {});
      const commands = Array.isArray(detail.commands) ? detail.commands.join(", ") : "";
      this._event(job.task_id, null, "job.interrupted",
        `A server restart interrupted the checks DevTeam was running${commands ? ` (${commands})` : ""}. Nothing was recorded from that run; the claim is untouched, so the agent holding it can report again.`,
        { jobId: job.id, assignmentId: job.assignment_id || null, kind: job.kind });
    }
  }

  #startJob({ kind, taskId, assignmentId = null, agentId = null, detail = {} }) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO jobs (id, kind, task_id, assignment_id, agent_id, state, detail, instance_id, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(id, kind, taskId, assignmentId, agentId, json(detail), this.instanceId, now());
    return id;
  }

  #finishJob(jobId, { state = "finished", outcome = null } = {}) {
    if (!jobId) return;
    this.db.prepare("UPDATE jobs SET state = ?, finished_at = ?, outcome = ? WHERE id = ?")
      .run(state, now(), outcome, jobId);
  }

  // Everything currently executing, across every task. The honest answer to "is this server busy, or
  // is it stuck?" — and, after a restart, it is empty by construction.
  openJobs() {
    return this.db.prepare("SELECT * FROM jobs WHERE state = 'running' ORDER BY started_at ASC").all();
  }

  jobs(taskId, { limit = 20 } = {}) {
    return this.db.prepare("SELECT * FROM jobs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(taskId, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  #migrate() {
    applySchema(this.db);
  }

  #getOrCreateToken() {
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'auth_token'").get();
    if (existing?.value) return existing.value;
    const token = randomBytes(24).toString("base64url");
    this.db.prepare("INSERT INTO metadata (key, value) VALUES ('auth_token', ?)").run(token);
    return token;
  }

  // Adopt an operator-supplied shared token (DEVTEAM_TOKEN). Persisted, so agents configured with
  // it keep working across restarts and the value in the data directory never disagrees with the
  // value that actually authenticates.
  setSharedToken(token) {
    const clean = String(token || "").trim();
    if (clean.length < 16) throw new Error("A shared token must be at least 16 characters.");
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = 'auth_token'").get();
    if (existing) this.db.prepare("UPDATE metadata SET value = ? WHERE key = 'auth_token'").run(clean);
    else this.db.prepare("INSERT INTO metadata (key, value) VALUES ('auth_token', ?)").run(clean);
    this.token = clean;
    return clean;
  }

  // T4.1 — named, revocable credentials alongside the shared one.
  //
  // One shared bearer token is right for one person on one machine: every agent pastes the same
  // string and there is nothing to manage. It is wrong the moment more than one *party* is
  // involved, for two reasons that matter more than secrecy — a compromised or misbehaving agent
  // cannot be cut off without re-keying everybody, and the record cannot say which credential did
  // something, only that a valid one did.
  //
  // Only the hash is stored, so the database is not a list of live secrets. The plaintext is
  // returned exactly once, at mint time, and cannot be recovered afterwards.
  mintAccessToken({ label }) {
    const clean = normalizeTokenLabel(label);
    const token = mintToken();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO access_tokens (id, label, token_hash, created_at) VALUES (?, ?, ?, ?)
    `).run(id, clean, hashToken(token), now());
    return { id, label: clean, token, createdAt: now() };
  }

  revokeAccessToken(id) {
    const row = this.db.prepare("SELECT * FROM access_tokens WHERE id = ?").get(id);
    if (!row) throw new Error("No such token.");
    if (row.revoked_at) return { id, label: row.label, revokedAt: row.revoked_at, alreadyRevoked: true };
    const stamp = now();
    this.db.prepare("UPDATE access_tokens SET revoked_at = ? WHERE id = ?").run(stamp, id);
    return { id, label: row.label, revokedAt: stamp, alreadyRevoked: false };
  }

  // Never returns the secret — there is nothing here that could re-issue one.
  accessTokens() {
    return this.db.prepare("SELECT id, label, created_at, last_used_at, revoked_at FROM access_tokens ORDER BY created_at ASC").all();
  }

  // Resolve a presented bearer to the credential it is, or null. A revoked token is not a
  // credential; last use is stamped so the dashboard can show which agent is actually using which
  // token, which is the audit trail one shared string could never give.
  resolveAccessToken(presented) {
    if (!presented) return null;
    if (tokensMatch(presented, this.token)) return { kind: "shared", id: null, label: "Shared server token" };
    const row = this.db.prepare("SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashToken(presented));
    if (!row) return null;
    this.db.prepare("UPDATE access_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    return { kind: "agent", id: row.id, label: row.label };
  }

  // _transaction, _event and _changed are the three things almost every method in this class needs,
  // and they are the reason the rest of the split is possible at all. A JavaScript `#private` is
  // lexically bound to the class body it is declared in, so a method composed onto the prototype
  // from another file cannot see one — no mixin can call this.#event, ever.
  //
  // So these three are internals by convention rather than by the language: an underscore says "not
  // part of the public surface" to a reader, where `#` said it to the compiler. That is a real loss
  // and it is the price of the file being separable at all. Nothing outside DevTeamStore and its
  // mixins should call them.
  _transaction(callback) {
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

  // Authorship is denormalized onto the row at write time. agent_id is a nullable foreign key that
  // gets cleared when an agent is purged from the roster, so it cannot be the record of who spoke:
  // relying on it silently reattributed every purged agent's message to the human.
  _event(taskId, agentId, type, message, metadata = {}) {
    const stamp = now();
    const author = agentId
      ? this.db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId)
      : null;
    const info = this.db.prepare(`
      INSERT INTO events (task_id, agent_id, type, message, metadata, created_at, author_name, author_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, agentId || null, type, message, json(metadata), stamp,
      agentId ? (author?.name || null) : null, agentId ? "agent" : "human");
    return Number(info.lastInsertRowid);
  }

  _changed(type, taskId = null) {
    const knowledgeChanges = new Set([
      "task.created", "task.continued", "task.updated", "task.accepted", "task.blocked", "task.unblocked",
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
    const codeGraphChanges = new Set(["task.created", "assignment.completed", "assignment.blocked"]);
    if (taskId && codeGraphChanges.has(type)) {
      const task = this.db.prepare("SELECT project_id FROM tasks WHERE id = ?").get(taskId);
      const errorKey = task ? `project:${task.project_id}` : null;
      try {
        this.codegraph.syncTask(taskId);
        if (errorKey) this.codegraphErrors.delete(errorKey);
      } catch (error) {
        if (errorKey) this.codegraphErrors.set(errorKey, { message: error.message, at: now() });
        this.emit("codegraph-error", { taskId, type, error });
      }
    }
    this.emit("change", { type, taskId, at: now() });
  }

  _syncTaskStatus(taskId, stamp = now()) {
    const task = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
    if (!task || ["accepted", "blocked", "cancelled"].includes(task.status)) return task?.status || null;
    const openAssignments = this.db.prepare(`
      SELECT verifies, plans FROM assignments
      WHERE task_id = ? AND status IN ('queued', 'claimed')
    `).all(taskId);
    // Role behaviour, not role names: a project whose planning role is called `scoping` and whose
    // verifying role is called `fact-checker` moves through the same three states.
    let status = "review";
    if (openAssignments.some((assignment) => assignment.plans)) {
      status = "planning";
    } else if (openAssignments.some((assignment) => !assignment.verifies)) {
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
    for (const task of taskIds) this._syncTaskStatus(task.id, stamp);
  }

  #releaseAgentClaims(agent, stamp, reason) {
    const taskIds = this.db.prepare(`
      SELECT DISTINCT task_id FROM assignments WHERE agent_id = ? AND status = 'claimed'
    `).all(agent.id).map((row) => row.task_id);
    const released = this.db.prepare(`
      UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL
      WHERE agent_id = ? AND status = 'claimed'
    `).run(agent.id).changes;
    this.db.prepare(`
      UPDATE agents
      SET status = 'disconnected', current_task_id = NULL, last_seen = ?, disconnected_at = ?
      WHERE id = ?
    `).run(stamp, stamp, agent.id);
    for (const taskId of taskIds) {
      this._event(taskId, agent.id, "agent.disconnected", `${agent.name} disconnected and released unfinished work.`, {
        reason,
        releasedAssignments: released,
      });
      this._syncTaskStatus(taskId, stamp);
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
    const forgetBefore = new Date(Date.now() - this.liveness.forgetMs).toISOString();
    const stamp = now();
    const affectedTasks = new Set();
    let presenceChanged = false;
    let purged = false;
    this._transaction(() => {
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
        this.db.prepare("UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE id = ?").run(row.id);
        this._event(row.task_id, null, "assignment.released", `${row.agent_name}'s read-only assignment was recovered after a long silence.`, { assignmentId: row.id, reason: "stale-readonly-recovery" });
        this._syncTaskStatus(row.task_id, stamp);
        affectedTasks.add(row.task_id);
      }
      // Agents gone a very long time are purged so the roster reflects reality instead of showing
      // days-old ghosts as "online". A disconnected agent already holds no claim; an unresponsive
      // one is purged only when it holds no write lease — a still-held lease is left for a human to
      // force-release first, preserving the write-safety guarantee.
      const purgeable = this.db.prepare(`
        SELECT id FROM agents
        WHERE last_seen < ? AND (
          status = 'disconnected'
          OR (status = 'unresponsive' AND id NOT IN (
            SELECT agent_id FROM assignments WHERE status = 'claimed' AND requires_write = 1 AND agent_id IS NOT NULL
          ))
        )
      `).all(forgetBefore);
      for (const row of purgeable) {
        for (const taskId of this.#purgeAgent(row.id)) affectedTasks.add(taskId);
        purged = true;
      }
    });
    for (const taskId of affectedTasks) this._changed("assignment.released", taskId);
    if (presenceChanged || purged) this._changed("agent.disconnected");
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
    this._transaction(() => {
      this.db.prepare(`
        UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL
        WHERE status = 'claimed' AND (
          agent_id IS NULL OR agent_id IN (SELECT id FROM agents WHERE status = 'disconnected')
        )
      `).run();
      for (const orphan of orphans) {
        this._event(orphan.task_id, orphan.agent_id, "assignment.released", `${orphan.agent_name}'s orphaned assignment was returned to the queue.`, { reason });
        this._syncTaskStatus(orphan.task_id, stamp);
      }
    });
    for (const taskId of new Set(orphans.map((orphan) => orphan.task_id))) this._changed("assignment.released", taskId);
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
    this._transaction(() => {
      for (const proposal of stale) {
        this.db.prepare("UPDATE proposals SET escalated_at = ? WHERE id = ?").run(stamp, proposal.id);
        this._event(proposal.task_id, null, "proposal.needs_human", `A proposal has been open past the decision window and needs a human decision: ${proposal.summary}`, { proposalId: proposal.id });
      }
    });
    for (const taskId of new Set(stale.map((proposal) => proposal.task_id))) this._changed("proposal.needs_human", taskId);
    return stale;
  }

  // Snapshot of whether the team is still doing something. Drives the keepWaiting
  // hint so a waiting agent stays assembled while work is in flight and only
  // leaves once the room is genuinely quiet.
  teamActivity(roomIds = null) {
    const scoped = Array.isArray(roomIds);
    if (scoped && !roomIds.length) return { active: false, openWork: 0, busyAgents: 0, workingAgents: 0, waitingAgents: 0 };
    const roomFilter = scoped ? `AND a.task_id IN (${roomIds.map(() => "?").join(", ")})` : "";
    const busyFilter = scoped ? `AND current_task_id IN (${roomIds.map(() => "?").join(", ")})` : "";
    const openWork = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status IN ('queued', 'claimed') AND t.status NOT IN ('accepted', 'blocked', 'cancelled') ${roomFilter}
    `).get(...(scoped ? roomIds : [])).count);
    const busyAgents = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM agents WHERE status = 'busy' ${busyFilter}`).get(...(scoped ? roomIds : [])).count);
    // Presence and work are different things. The liveness sweep marks a session 'unresponsive'
    // after it goes quiet, which is exactly what a teammate deep in an edit looks like — it still
    // holds its claim. Counting only 'busy' therefore reports an actively working teammate as
    // nobody at all, so ownership of a claim is counted separately from responsiveness.
    const workingAgents = Number(this.db.prepare(`
      SELECT COUNT(DISTINCT a.agent_id) AS count FROM assignments a
      JOIN agents agent ON agent.id = a.agent_id
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'claimed' AND agent.status != 'disconnected'
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled') ${roomFilter}
    `).get(...(scoped ? roomIds : [])).count);
    const waitingAgents = Number(this.db.prepare("SELECT COUNT(*) AS count FROM agents WHERE status = 'waiting'").get().count);
    // A task accepted moments ago keeps the room "active" for a short window, so its members stay
    // assembled long enough to catch a same-conversation follow-up instead of being told to leave the
    // instant consensus lands (which is what made "continue in the same chat" impossible before).
    const continuationSince = new Date(Date.now() - this.liveness.continuationWindowMs).toISOString();
    const acceptedFilter = scoped ? `AND id IN (${roomIds.map(() => "?").join(", ")})` : "";
    const continuing = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM tasks WHERE status = 'accepted' AND updated_at >= ? ${acceptedFilter}
    `).get(continuationSince, ...(scoped ? roomIds : [])).count);
    return { active: openWork > 0 || busyAgents > 0 || workingAgents > 0 || continuing > 0, openWork, busyAgents, workingAgents, waitingAgents, continuing };
  }

  // Activity as seen from one agent's rooms, so a member of a quiet task isn't kept assembled by
  // a different task's work on a multi-task server.
  teamActivityForAgent(agentId) {
    return this.teamActivity(this._memberTaskIds(agentId));
  }

  // Return undirected/directed human messages this agent has not yet received,
  // and record delivery. "Directed" = target is this agent's name; broadcasts use
  // target "all". Only messages posted during this session are delivered live;
  // older history is still visible through devteam_next with want=state.
  // Is this timeline event a live message for the given agent? Human messages reach the agent
  // if broadcast ("all") or addressed to its name. Agent messages are only *pushed* when they
  // are directed to this agent by name (never the sender's own, never undirected broadcasts —
  // those stay timeline notes read via devteam_next with want=state).
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
    const rooms = this._memberTaskIds(agentId);
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
    this._transaction(() => {
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
    for (const taskId of taskIds) this._changed("message.delivered", taskId);
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
    if (changed) this._changed("message.seen");
    return changed;
  }

  // Role checklists a planner can attach to review work so the team systematically
  // covers the usual blind spots instead of eyeballing a diff. Attached automatically
  // to review/security/test assignments unless the caller overrides them.
  // A project's roles, cached until its `.devteam/roles.json` changes on disk. The mtime check keeps
  // an edit picked up without a restart while not re-reading the file on every assignment.
  projectRoles(projectId) {
    const project = this.db.prepare("SELECT root FROM projects WHERE id = ?").get(projectId);
    if (!project) return { roles: DEFAULT_ROLES, source: "default" };
    const cached = this.#roleCache.get(projectId);
    let stamp = 0;
    try { stamp = statSync(path.join(project.root, ROLES_CONFIG_PATH)).mtimeMs; } catch { stamp = 0; }
    if (cached && cached.mtimeMs === stamp) return cached;
    const loaded = loadProjectRoles(project.root);
    this.#roleCache.set(projectId, loaded);
    return loaded;
  }

  // What a role name means *in this project*: whether it verifies, plans, or writes by default, and
  // the checklist its assignments carry. An unknown name is ordinary work rather than an error.
  roleBehaviour(projectId, role) {
    return roleBehaviour(this.projectRoles(projectId).roles, role);
  }

  // The role a seeded planning assignment is created in for this project.
  planningRoleFor(projectId) {
    return planningRole(this.projectRoles(projectId).roles);
  }

  // The role catalogue for a project, for the dashboard's assignment form and for agents asking what
  // roles this room understands. Includes whether the config came from the project or the defaults,
  // and surfaces a malformed config rather than pretending the defaults were chosen.
  roleCatalogue(projectId) {
    const loaded = this.projectRoles(projectId);
    return {
      source: loaded.source,
      configPath: ROLES_CONFIG_PATH,
      ...(loaded.error ? { error: loaded.error } : {}),
      roles: Object.entries(loaded.roles).map(([name, definition]) => ({ name, ...definition })),
    };
  }

  _resolveChecklist(projectId, role, provided) {
    if (Array.isArray(provided)) return provided.map((item) => String(item).trim()).filter(Boolean).slice(0, 40);
    const checklist = this.roleBehaviour(projectId, role).checklist;
    return checklist.length ? checklist : null;
  }

  _storeChecklist(assignmentId, items) {
    if (!items || !items.length) return;
    this.db.prepare("INSERT OR REPLACE INTO assignment_checklists (assignment_id, items) VALUES (?, ?)").run(assignmentId, json(items));
  }

  _checklistFor(assignmentId) {
    return fromJson(this.db.prepare("SELECT items FROM assignment_checklists WHERE assignment_id = ?").get(assignmentId)?.items, []);
  }

  // --- Role negotiation: agents (and the human) propose role/handoff/plan changes,
  // teammates vote, and on agreement the change is adopted and real work is reassigned. ---

  static PROPOSAL_KINDS = PROPOSAL_KINDS;

  close() {
    this.#releaseDataDirectory();
    this.db.close();
  }

  ensureProject(name, root) {
    const normalizedRoot = path.resolve(root);
    const existing = this.db.prepare("SELECT * FROM projects WHERE root = ?").get(normalizedRoot);
    if (existing) {
      try { this.knowledge.initializeProject(existing.id); }
      catch (error) { this.knowledgeErrors.set(`project:${existing.id}`, { message: error.message, at: now() }); }
      try { this.codegraph.initializeProject(existing.id); this.codegraphErrors.delete(`project:${existing.id}`); }
      catch (error) { this.codegraphErrors.set(`project:${existing.id}`, { message: error.message, at: now() }); }
      return existing;
    }
    const project = { id: randomUUID(), name: name.trim(), root: normalizedRoot, created_at: now() };
    this.db.prepare("INSERT INTO projects (id, name, root, created_at) VALUES (?, ?, ?, ?)")
      .run(project.id, project.name, project.root, project.created_at);
    try { this.knowledge.initializeProject(project.id); }
    catch (error) { this.knowledgeErrors.set(`project:${project.id}`, { message: error.message, at: now() }); }
    try { this.codegraph.initializeProject(project.id); this.codegraphErrors.delete(`project:${project.id}`); }
    catch (error) { this.codegraphErrors.set(`project:${project.id}`, { message: error.message, at: now() }); }
    this._changed("project.created");
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

  // Edit a project's display name and/or its root folder after creation. Changing the root is
  // validated for existence by the caller (server) and for uniqueness here (one project per root),
  // and re-initializes the knowledge vault against the new location. At least one field must change.
  updateProject(projectId, { name = undefined, root = undefined } = {}) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    const nextName = name === undefined ? project.name : String(name).trim();
    if (!nextName) throw new Error("Project name cannot be empty.");
    const nextRoot = root === undefined ? project.root : path.resolve(root);
    if (nextRoot !== project.root) {
      const clash = this.db.prepare("SELECT id FROM projects WHERE root = ? AND id != ?").get(nextRoot, projectId);
      if (clash) throw new Error("Another project already uses that folder.");
    }
    if (nextName === project.name && nextRoot === project.root) return project;
    this.db.prepare("UPDATE projects SET name = ?, root = ? WHERE id = ?").run(nextName, nextRoot, projectId);
    // A check allowlist is approved against the tree it was reviewed in. Repointing the root would
    // otherwise silently start executing those commands somewhere the human never looked.
    if (nextRoot !== project.root) this.db.prepare("DELETE FROM project_check_commands WHERE project_id = ?").run(projectId);
    if (nextRoot !== project.root) {
      try { this.knowledge.initializeProject(projectId); }
      catch (error) { this.knowledgeErrors.set(`project:${projectId}`, { message: error.message, at: now() }); }
      try { this.codegraph.initializeProject(projectId); this.codegraphErrors.delete(`project:${projectId}`); }
      catch (error) { this.codegraphErrors.set(`project:${projectId}`, { message: error.message, at: now() }); }
    }
    this._changed("project.updated");
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }

  createTask({ projectId, title, description, requiredApprovals = 2, sessionPolicy = "per_task" }) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    const taskId = randomUUID();
    const plannerAssignmentId = randomUUID();
    const stamp = now();
    const approvals = Math.max(1, Math.min(8, Number(requiredApprovals) || 2));
    const planningRoleName = this.planningRoleFor(projectId);
    this._transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, status, version, required_approvals,
          session_policy, session_policy_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'planning', 1, ?, ?, 1, ?, ?)
      `).run(taskId, projectId, title.trim(), description.trim(), approvals,
        ["manual", "per_task", "adaptive", "per_assignment"].includes(sessionPolicy) ? sessionPolicy : "per_task",
        stamp, stamp);
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at, plans)
        VALUES (?, ?, ?, ?, ?, 0, 'queued', ?, 1)
      `).run(plannerAssignmentId, taskId, "Create the implementation plan", "Inspect the project, propose a concrete plan, then assign implementation and review work to the team.", planningRoleName, stamp);
      this._event(taskId, null, "task.created", `Task created: ${title.trim()}`, { projectId, requiredApprovals: approvals });
    });
    this.assignmentAssessment({ assignmentId: plannerAssignmentId });
    this._changed("task.created", taskId);
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

  workspaceSearch(query, { projectId = null, limit = 40 } = {}) {
    const clean = String(query || "").trim().slice(0, 120);
    if (clean.length < 2) return [];
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 40));
    const perGroup = Math.max(5, Math.ceil(boundedLimit / 2));
    const escaped = clean.replace(/[\\%_]/g, (character) => `\\${character}`);
    const pattern = `%${escaped}%`;
    const projectClause = projectId ? " AND t.project_id = ?" : "";
    const projectArgs = projectId ? [projectId] : [];
    const taskRows = this.db.prepare(`
      SELECT 'task' AS kind, t.id AS task_id, NULL AS event_id, t.project_id, p.name AS project_name,
        t.title, t.description AS snippet, t.status AS subtype, t.updated_at AS occurred_at
      FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE (t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')${projectClause}
      ORDER BY t.updated_at DESC LIMIT ?
    `).all(pattern, pattern, ...projectArgs, perGroup);
    const eventRows = this.db.prepare(`
      SELECT 'event' AS kind, t.id AS task_id, e.id AS event_id, t.project_id, p.name AS project_name,
        t.title, e.message AS snippet, e.type AS subtype, e.created_at AS occurred_at
      FROM events e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
      WHERE e.message LIKE ? ESCAPE '\\'${projectClause}
      ORDER BY e.id DESC LIMIT ?
    `).all(pattern, ...projectArgs, perGroup);
    const assignmentRows = this.db.prepare(`
      SELECT 'assignment' AS kind, t.id AS task_id, NULL AS event_id, t.project_id, p.name AS project_name,
        a.title, a.description AS snippet, a.status AS subtype, a.created_at AS occurred_at
      FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
      WHERE (a.title LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\')${projectClause}
      ORDER BY a.created_at DESC LIMIT ?
    `).all(pattern, pattern, ...projectArgs, perGroup);
    const knowledgeProjectClause = projectId ? " AND k.project_id = ?" : "";
    const knowledgeRows = this.db.prepare(`
      SELECT 'knowledge' AS kind, k.source_task_id AS task_id, k.source_event_id AS event_id,
        k.project_id, p.name AS project_name, k.title, k.body AS snippet, k.status AS subtype,
        k.updated_at AS occurred_at
      FROM knowledge_notes k JOIN projects p ON p.id = k.project_id
      WHERE (k.title LIKE ? ESCAPE '\\' OR k.body LIKE ? ESCAPE '\\')${knowledgeProjectClause}
      ORDER BY k.updated_at DESC LIMIT ?
    `).all(pattern, pattern, ...projectArgs, perGroup);
    return [...taskRows, ...eventRows, ...assignmentRows, ...knowledgeRows]
      .map((row) => ({ ...row, snippet: String(row.snippet || "").replace(/\s+/g, " ").trim().slice(0, 260) }))
      .sort((left, right) => String(right.occurred_at).localeCompare(String(left.occurred_at))
        || String(left.kind).localeCompare(String(right.kind)))
      .slice(0, boundedLimit);
  }

  // Edit a task's own information (title, description, or how many independent approvals it needs)
  // after creation, so a typo or a sharpened spec no longer means deleting and recreating the room.
  // This is metadata only: it does not touch the version, existing approvals, assignments, or the
  // timeline of work — it just records that the human revised the brief. At least one field changes.
  updateTask(taskId, { title = undefined, description = undefined, requiredApprovals = undefined, sessionPolicy = undefined } = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (task.status === "cancelled") throw new Error("A cancelled task cannot be edited.");
    const nextTitle = title === undefined ? task.title : String(title).trim();
    if (!nextTitle) throw new Error("Task title cannot be empty.");
    const nextDescription = description === undefined ? task.description : String(description).trim();
    if (!nextDescription) throw new Error("Task description cannot be empty.");
    const nextApprovals = requiredApprovals === undefined
      ? task.required_approvals
      : Math.max(1, Math.min(8, Number(requiredApprovals) || task.required_approvals));
    const nextPolicy = sessionPolicy === undefined ? task.session_policy : String(sessionPolicy);
    if (!["manual", "per_task", "adaptive", "per_assignment"].includes(nextPolicy)) throw new Error("Invalid session policy.");
    if (nextTitle === task.title && nextDescription === task.description && nextApprovals === task.required_approvals
      && nextPolicy === task.session_policy) {
      return this.getTask(taskId);
    }
    const changed = [
      nextTitle !== task.title ? "title" : null,
      nextDescription !== task.description ? "description" : null,
      nextApprovals !== task.required_approvals ? "approvals" : null,
      nextPolicy !== task.session_policy ? "session policy" : null,
    ].filter(Boolean);
    const stamp = now();
    this._transaction(() => {
      this.db.prepare(`UPDATE tasks SET title = ?, description = ?, required_approvals = ?, session_policy = ?,
        session_policy_version = session_policy_version + ?, updated_at = ? WHERE id = ?`)
        .run(nextTitle, nextDescription, nextApprovals, nextPolicy, nextPolicy === task.session_policy ? 0 : 1, stamp, taskId);
      this._event(taskId, null, "task.updated", `Task details edited (${changed.join(", ")}).`, { changed, requiredApprovals: nextApprovals, sessionPolicy: nextPolicy });
    });
    this._changed("task.updated", taskId);
    return this.getTask(taskId);
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
    const deletedTaskIds = this.db.prepare("SELECT id FROM tasks WHERE project_id = ?").all(projectId).map((row) => row.id);
    this._transaction(() => {
      this.db.prepare(`
        UPDATE agents SET current_task_id = NULL
        WHERE current_task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      `).run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    for (const deletedTaskId of deletedTaskIds) this.briefHealth.delete(deletedTaskId);
    this._changed("project.deleted");
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
    this._transaction(() => {
      this.db.prepare("UPDATE agents SET current_task_id = NULL WHERE current_task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    });
    this.briefHealth.delete(taskId);
    try {
      this.knowledge.exportProject(task.project_id);
      this.knowledgeErrors.delete(`project:${task.project_id}`);
    } catch (error) {
      this.knowledgeErrors.set(`project:${task.project_id}`, { message: error.message, at: now() });
    }
    this._changed("task.deleted", taskId);
    return { deleted: true, taskId, title: task.title, filesDeleted: false };
  }

  #hashToken(token) {
    return createHash("sha256").update(String(token)).digest("hex");
  }

  #dependencyDepth(assignmentId, seen = new Set()) {
    if (seen.has(assignmentId)) return 0;
    seen.add(assignmentId);
    const dependencies = this._dependenciesFor(assignmentId);
    if (!dependencies.length) return 0;
    return 1 + Math.max(...dependencies.map((item) => this.#dependencyDepth(item.id, new Set(seen))));
  }

  _assessmentRecord(row) {
    if (!row) return null;
    return {
      id: row.id,
      assignmentId: row.assignment_id,
      assignmentVersion: Number(row.assignment_version),
      taskVersion: Number(row.task_version),
      evidenceHash: row.evidence_hash,
      policyVersion: Number(row.policy_version),
      score: Number(row.score),
      level: row.level,
      reasons: fromJson(row.reasons, []),
      requirements: fromJson(row.requirements, {}),
      createdAt: row.created_at,
      invalidatedAt: row.invalidated_at || null,
    };
  }

  // What the working agent gets, as opposed to what the dashboard gets. The full record carries six
  // bookkeeping fields — evidence hashes, policy and assignment versions — that an agent cannot act
  // on, and no instruction at all. On this board 27 of 54 assignments scored difficult or worse and
  // not one of them produced a word of advice, because model gating needed a registered profile and
  // there never was one. The gate is gone; the brief says the quiet part instead: nobody is going to
  // stop you, the judgement is yours, and here is the one move that works.
  _assessmentForBrief(row) {
    const record = this._assessmentRecord(row);
    if (!record) return null;
    const demanding = ["difficult", "critical", "recovery", "exceptional"].includes(record.level);
    return {
      level: record.level,
      score: record.score,
      reasons: (record.reasons || []).slice(0, 3).map((reason) => reason.detail || String(reason)),
      guidance: demanding
        ? `This assignment scored ${record.level}. No model gate is active, so nothing will stop you if it is beyond the model or effort you are running — that judgement is yours alone. If it is beyond you, do not push on: call devteam_stuck with kind "over-my-head" and name the capability needed.`
        : null,
    };
  }

  assignmentAssessment({ agentId = null, assignmentId, refresh = false }) {
    const assignment = this.db.prepare(`
      SELECT a.*, t.title AS task_title, t.description AS task_description, t.version AS task_version
      FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?
    `).get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    if (agentId) { this.getAgent(agentId); this.assertMembership(agentId, assignment.task_id); }
    const failures = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE task_id = ? AND type = 'assignment.blocked'
        AND json_extract(metadata, '$.assignmentId') = ?
        AND CAST(json_extract(metadata, '$.version') AS INTEGER) = ?
    `).get(assignment.task_id, assignmentId, assignment.task_version).count);
    const assessed = assessAssignment({
      ...assignment,
      paths: assignment.requires_write ? this._writeScopeFor(assignment.id) : [],
      checklist: this._checklistFor(assignment.id),
      dependencyDepth: this.#dependencyDepth(assignment.id),
      priorFailures: failures,
      override: fromJson(assignment.complexity_override, null),
    });
    const current = this.db.prepare(`
      SELECT * FROM complexity_assessments
      WHERE assignment_id = ? AND invalidated_at IS NULL ORDER BY created_at DESC LIMIT 1
    `).get(assignmentId);
    if (!refresh && current && current.evidence_hash === assessed.evidenceHash
      && Number(current.policy_version) === COMPLEXITY_POLICY_VERSION
      && Number(current.assignment_version) === Number(assignment.assignment_version)) return this._assessmentRecord(current);
    const stamp = now();
    if (current) this.db.prepare("UPDATE complexity_assessments SET invalidated_at = ? WHERE id = ?").run(stamp, current.id);
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO complexity_assessments (
        id, assignment_id, assignment_version, task_version, evidence_hash, policy_version,
        score, level, reasons, requirements, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, assignmentId, assignment.assignment_version, assignment.task_version, assessed.evidenceHash,
      assessed.policyVersion, assessed.score, assessed.level, json(assessed.reasons), json(assessed.requirements), stamp);
    this._event(assignment.task_id, agentId, "assignment.complexity_assessed", `Assessed “${assignment.title}” as ${assessed.level} (${assessed.score}).`, {
      assignmentId, assessmentId: id, score: assessed.score, level: assessed.level,
      requirements: assessed.requirements, invalidatedAssessmentId: current?.id || null,
    });
    this.emit("change", { type: "assignment.complexity_assessed", taskId: assignment.task_id, at: stamp });
    return this._assessmentRecord(this.db.prepare("SELECT * FROM complexity_assessments WHERE id = ?").get(id));
  }

  setAssignmentComplexityOverride({ assignmentId, override = null }) {
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    if (override != null && (typeof override !== "object" || Array.isArray(override))) throw new Error("Complexity override must be an object or null.");
    const level = override?.level;
    if (level != null && !["base", "difficult", "critical", "recovery", "exceptional"].includes(level)) throw new Error("Invalid complexity override level.");
    this.db.prepare(`
      UPDATE assignments SET complexity_override = ?, assignment_version = assignment_version + 1 WHERE id = ?
    `).run(override == null ? null : json({ level: level || null, score: Number.isFinite(Number(override.score)) ? Math.max(0, Math.floor(Number(override.score))) : null }), assignmentId);
    const assessment = this.assignmentAssessment({ assignmentId, refresh: true });
    this._changed("assignment.complexity_override", assignment.task_id);
    return assessment;
  }

  connectAgent({ name, provider, capabilities = [], sessionGeneration = 1, freshTaskId = null, model = null, effort = null }) {
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
    this._transaction(() => {
      this.db.prepare(`
        INSERT INTO agents (id, name, provider, capabilities, status, connected_at, last_seen, resume_token_hash, session_generation, fresh_task_id, current_model, current_effort)
        VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)
      `).run(id, cleanName, cleanProvider, json(capabilities), stamp, stamp, this.#hashToken(resumeToken), Math.max(1, Number(sessionGeneration) || 1), freshTaskId || null,
        String(model || "").trim().slice(0, 80) || null, String(effort || "").trim().slice(0, 40) || null);
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
    });
    this._changed("agent.connected");
    // A connect that names its task room joins it here, as a real membership with a real joined
    // event — not a second implicit path. An earlier version instead pinned a connecting agent to
    // whichever task happened to be the only active one, which then hid every later task from it;
    // an agent that names no room is now told which rooms exist rather than guessed into one.
    let room = null;
    if (freshTaskId) {
      try { room = this.joinTask(id, freshTaskId); }
      catch (error) { room = { joined: false, taskId: freshTaskId, error: error.message }; }
    }
    // The resume token is returned exactly once, to this caller, and only its hash is stored.
    return { ...this.getAgent(id), room, resumeToken };
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
    this._transaction(() => {
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
        this._event(prior.current_task_id, agentId, "agent.resumed", `${current.name} resumed a previous session and reclaimed its work.`, { reclaimedAssignments: reclaimed });
      }
    });
    this._changed("agent.resumed", prior.current_task_id);
    return { resumed: true, agentId, reclaimedAssignments: reclaimed, taskId: prior.current_task_id || null, claimToken };
  }

  // --- Task rooms: work, messages, and governance are scoped to the tasks an agent belongs
  // to, so an agent invoked for one task/project can't claim another's work or see its chatter. ---

  // The tasks an agent is a member of — exactly the rooms it explicitly joined, and nothing else.
  // There is deliberately no implicit "sole active task" fallback: it made single-task use
  // zero-config at the price of an agent's room silently changing meaning the moment a second task
  // appeared, which read as "the board stopped handing out work" with nothing to explain it.
  // devteam_join are the ways in; roomStatusForAgent says so out loud.
  _memberTaskIds(agentId) {
    return this.db.prepare("SELECT task_id FROM task_members WHERE agent_id = ?").all(agentId).map((row) => row.task_id);
  }

  // The task rooms an agent may *claim work in*: the rooms it joined as a contributor. Observers
  // are members (they see chatter and proposals) but never claim, so they are excluded here.
  #claimableTaskIds(agentId) {
    return this.db.prepare("SELECT task_id, role FROM task_members WHERE agent_id = ?")
      .all(agentId).filter((row) => row.role !== "observer").map((row) => row.task_id);
  }

  // Authorization for a task-scoped action by an agent. Membership is not just routing: an agent
  // may only read, message, propose, vote, assign, approve, or block inside a room it belongs to,
  // so an agent invoked for one task can't reach into another's by supplying its id. The human
  // control plane (no agentId) is trusted and bypasses this.
  assertMembership(agentId, taskId) {
    if (!agentId) return;
    if (!this._memberTaskIds(agentId).includes(taskId)) {
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
    this._transaction(() => {
      this.db.prepare(`
        INSERT INTO task_members (task_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id, agent_id) DO UPDATE SET role = excluded.role
      `).run(taskId, agentId, cleanRole, stamp);
      this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(stamp, agentId);
      if (isNew) {
        this._event(taskId, agentId, "agent.joined", `${agent.name} joined the task room${cleanRole === "observer" ? " as observer" : ""}.`, { role: cleanRole });
      }
    });
    if (isNew) this._changed("agent.joined", taskId);
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
    const joinedTaskIds = this._memberTaskIds(agentId);
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
    const rooms = this._memberTaskIds(agent.id);
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
    const affectedTaskIds = this._transaction(() => this.#releaseAgentClaims(agent, stamp, summary || "Agent disconnected normally."));
    this._changed("agent.disconnected", agent.current_task_id);
    for (const taskId of affectedTaskIds) this._changed("assignment.released", taskId);
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

  // Human-driven removal of an agent that has left for good. A currently connected agent
  // (waiting/busy) is protected: it must go unresponsive or disconnect first, so a live teammate
  // is never deleted out from under its own work by accident. Pass force to override that guard.
  // Releasing any claim the agent still holds is part of removal — the human's explicit removal is
  // the confirmation, mirroring force-release — so a stuck write lease is freed as the ghost goes.
  forgetAgent(agentId, { force = false } = {}) {
    const agent = this.getAgent(agentId); // throws a clear "connect again" error if already gone
    if (!force && !["disconnected", "unresponsive"].includes(agent.status)) {
      throw new Error("Agent is still connected. Disconnect it, or wait for it to go unresponsive, before removing it.");
    }
    const affectedTaskIds = this._transaction(() => this.#purgeAgent(agentId));
    for (const taskId of affectedTaskIds) this._changed("assignment.released", taskId);
    this._changed("agent.forgotten");
    return { forgotten: true, agentId, name: agent.name };
  }

  // Remove an agent row entirely: release any live claim it still holds, detach the historical
  // references the schema would otherwise pin (events, completed assignments, and proposals it
  // raised are nullable with no cascade), then delete it — approvals, message receipts, and room
  // memberships cascade away. Runs inside the caller's transaction and returns the task ids whose
  // open work changed, so the caller can emit the right change signals.
  #purgeAgent(agentId) {
    const stamp = now();
    const name = this.db.prepare("SELECT name FROM agents WHERE id = ?").get(agentId)?.name || "An agent";
    const claimedTaskIds = this.db.prepare(
      "SELECT DISTINCT task_id FROM assignments WHERE agent_id = ? AND status = 'claimed'",
    ).all(agentId).map((row) => row.task_id);
    if (claimedTaskIds.length) {
      this.db.prepare(
        "UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE agent_id = ? AND status = 'claimed'",
      ).run(agentId);
      for (const taskId of claimedTaskIds) {
        this._event(taskId, null, "assignment.released", `${name}'s work returned to the queue when the agent was removed.`, { reason: "agent-forgotten" });
        this._syncTaskStatus(taskId, stamp);
      }
    }
    this.db.prepare("UPDATE assignments SET agent_id = NULL WHERE agent_id = ?").run(agentId);
    // Detach the purged roster row without rewriting history: author_name/author_kind were recorded
    // when each event was written, and any legacy row missing them is backfilled here so the
    // transcript still says who spoke after the agent is gone.
    this.db.prepare(`
      UPDATE events SET author_name = COALESCE(author_name, (SELECT name FROM agents WHERE id = ?)),
        author_kind = COALESCE(author_kind, 'agent')
      WHERE agent_id = ?
    `).run(agentId, agentId);
    this.db.prepare("UPDATE events SET agent_id = NULL WHERE agent_id = ?").run(agentId);
    this.db.prepare("UPDATE proposals SET proposer_id = NULL WHERE proposer_id = ?").run(agentId);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    return claimedTaskIds;
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
    this._transaction(() => {
      this.db.prepare("UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE id = ?").run(assignmentId);
      this._event(assignment.task_id, assignment.agent_id, "assignment.released", reason, { assignmentId, reason: "force-release", requiresWrite: Boolean(assignment.requires_write) });
      this._syncTaskStatus(assignment.task_id, stamp);
    });
    this._changed("assignment.released", assignment.task_id);
    return { released: true, assignmentId, taskId: assignment.task_id, requiresWrite: Boolean(assignment.requires_write) };
  }

  createAssignment({ agentId = null, taskId, title, description, role = "implementer", requiresWrite = false, targetAgentName = null, checklist = undefined, paths = undefined, dependsOn = undefined }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (["accepted", "blocked", "cancelled"].includes(task.status)) throw new Error(this.closedTaskError(task, "create an assignment on it"));
    if (agentId) { this.getAgent(agentId); this.assertMembership(agentId, taskId); }
    const assignment = {
      id: randomUUID(), taskId, title: title.trim(), description: description.trim(), role: role.trim(),
      requiresWrite: requiresWrite ? 1 : 0, targetAgentName: targetAgentName?.trim() || null, createdAt: now(),
    };
    // Resolve the role against *this project's* roles once, here, and store what the scheduler needs
    // on the row. Doing it at creation rather than at scan time means editing a project's role config
    // never silently re-classifies work that is already queued or in flight.
    const behaviour = this.roleBehaviour(task.project_id, assignment.role);
    const resolvedChecklist = this._resolveChecklist(task.project_id, assignment.role, checklist);
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
    this._transaction(() => {
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, verifies, plans)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(assignment.id, taskId, assignment.title, assignment.description, assignment.role, assignment.requiresWrite, assignment.targetAgentName, assignment.createdAt,
        behaviour.verifies ? 1 : 0, behaviour.plans ? 1 : 0);
      this._storeChecklist(assignment.id, resolvedChecklist);
      if (writePaths.length) this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)").run(assignment.id, json(writePaths));
      for (const dependencyId of dependencyIds) {
        this.db.prepare("INSERT INTO assignment_dependencies (assignment_id, depends_on_assignment_id) VALUES (?, ?)")
          .run(assignment.id, dependencyId);
      }
      this._syncTaskStatus(taskId);
      this._event(taskId, agentId, "assignment.created", assignment.title, {
        assignmentId: assignment.id,
        role: assignment.role,
        verifies: behaviour.verifies,
        requiresWrite: Boolean(assignment.requiresWrite),
        targetAgentName: assignment.targetAgentName,
        checklist: resolvedChecklist || [],
        writePaths,
        dependsOn: dependencyIds,
      });
    });
    this.assignmentAssessment({ assignmentId: assignment.id });
    this._changed("assignment.created", taskId);
    return { ...this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignment.id), checklist: resolvedChecklist || [], writePaths, dependsOn: dependencyIds };
  }

  // The candidate scan used to be one 55-line SELECT carrying membership, targeting, dependencies
  // and review-gating at once, and both of the deadlocks this work exists to fix hid inside it. It
  // is now this list: each entry is one named, individually evaluable predicate paired with the
  // reason code that explains its failure. claimNextAssignment ANDs them together; whyNotClaimable
  // runs them one at a time against a single assignment. Because both read this list, the query and
  // the explanation cannot drift apart — tightening a predicate moves its explanation with it.
  //
  // Order matters and is the order a reader should think in: is it even open, may this agent work in
  // that room, is the room open, is it addressed to someone else, is this agent's reach into the room
  // wide enough, is its own work ready, and is it waiting on a writer.
  #claimPredicates({ agentName, memberRooms, claimRooms, holdsWriteClaim = false }) {
    const list = (values) => (values.length ? values.map(() => "?").join(", ") : null);
    const claimRoomList = list(claimRooms);
    // In a room the agent already belongs to it may take targeted-or-untargeted work; in a room it
    // only reached by invitation, it may take *only* the assignment(s) addressed to it by name.
    const memberRoomList = list(memberRooms);
    return [
      {
        code: "assignment_not_queued",
        sql: "a.status = 'queued'",
        params: [],
      },
      {
        // An agent holding a write claim may still pick up read-only work, but not a second writer:
        // one agent with two write leases is exactly the hoarding the single-claim rule existed to
        // prevent, and it is the only part of that rule worth keeping.
        code: "agent_holds_write_claim",
        sql: holdsWriteClaim ? "a.requires_write = 0" : "1 = 1",
        params: [],
      },
      {
        // An agent only claims work inside task rooms it belongs to *as a contributor* (observers
        // never claim), plus any room a queued assignment invited it into by name.
        code: "room_not_claimable",
        sql: claimRoomList ? `a.task_id IN (${claimRoomList})` : "0",
        params: claimRooms,
      },
      {
        code: "task_closed",
        sql: `t.status NOT IN (${CLOSED_TASK_STATUSES.map(() => "?").join(", ")})`,
        params: CLOSED_TASK_STATUSES,
      },
      {
        // Targeting routes work to a teammate by name; it must not outlive that teammate. A target
        // that is still connected keeps its exclusive hold (and its ORDER BY priority), but once
        // nobody by that name is present the item returns to the general queue instead of sitting
        // claimable-by-nobody and blocking every verifier behind it.
        code: "targeted_elsewhere",
        sql: `(
            a.target_agent_name IS NULL
            OR lower(a.target_agent_name) = lower(?)
            OR NOT EXISTS (
              SELECT 1 FROM agents present
              WHERE lower(present.name) = lower(a.target_agent_name) AND present.status != 'disconnected'
            )
          )`,
        params: [agentName],
      },
      {
        code: "room_invitation_only",
        sql: memberRoomList
          ? `(a.task_id IN (${memberRoomList}) OR lower(a.target_agent_name) = lower(?))`
          : "lower(a.target_agent_name) = lower(?)",
        params: memberRoomList ? [...memberRooms, agentName] : [agentName],
      },
      {
        code: "dependency_pending",
        sql: `NOT EXISTS (
            SELECT 1 FROM assignment_dependencies dependency_link
            JOIN assignments dependency ON dependency.id = dependency_link.depends_on_assignment_id
            WHERE dependency_link.assignment_id = a.id AND dependency.status != 'done'
          )`,
        params: [],
      },
      {
        code: "awaiting_writer",
        sql: `(
            a.verifies = 0 OR NOT EXISTS (
              SELECT 1 FROM assignments pending_write WHERE ${BLOCKING_WRITER_CONDITIONS}
            )
          )`,
        params: [],
      },
    ];
  }

  // Who the review-gating predicate matched. Same condition, asked for names instead of existence.
  #blockingWriters(assignmentId) {
    return this.db.prepare(`
      ${DEPENDENCY_CLOSURE_CTE}
      SELECT pending_write.id, pending_write.title, pending_write.status
      FROM assignments a, assignments pending_write
      WHERE a.id = ? AND ${BLOCKING_WRITER_CONDITIONS}
      ORDER BY pending_write.created_at ASC
    `).all(assignmentId);
  }

  // The dependency predicate's own inner SELECT, asked for rows instead of existence.
  #pendingDependencies(assignmentId) {
    return this.db.prepare(`
      SELECT dependency.id, dependency.title, dependency.status
      FROM assignment_dependencies dependency_link
      JOIN assignments dependency ON dependency.id = dependency_link.depends_on_assignment_id
      WHERE dependency_link.assignment_id = ? AND dependency.status != 'done'
      ORDER BY dependency.created_at ASC
    `).all(assignmentId);
  }

  // Which of the scan's predicates this one assignment fails, evaluated with the very SQL the scan
  // composes. Agent-scoped predicates are skipped when there is no agent to scope them to.
  #failedClaimPredicates(assignment, agent) {
    const AGENT_SCOPED = ["room_not_claimable", "room_invitation_only", "targeted_elsewhere"];
    const predicates = this.#claimPredicates(agent
      ? {
        agentName: agent.name,
        memberRooms: this.#claimableTaskIds(agent.id),
        claimRooms: this.#claimRoomsFor(agent),
      }
      : { agentName: "", memberRooms: [], claimRooms: [] });
    const failed = [];
    for (const predicate of predicates) {
      if (!agent && AGENT_SCOPED.includes(predicate.code)) continue;
      const passes = this.db.prepare(`
        ${DEPENDENCY_CLOSURE_CTE}
        SELECT 1 FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        WHERE a.id = ? AND ${predicate.sql}
        LIMIT 1
      `).get(assignment.id, ...predicate.params);
      if (!passes) failed.push(predicate.code);
    }
    return failed;
  }

  // The rooms this agent may be handed work in: its own contributor rooms, plus any active task
  // where a queued assignment names it. A targeted assignment is an *invitation* — it lets the
  // planner (or human) pull a specific agent into a new task's room without the agent having to
  // devteam_join first, which is what makes a second task get picked up promptly instead of stalling
  // until every other task is deleted. Untargeted work stays strictly room-scoped, so an agent
  // invoked for one task is never silently conscripted into another it was not invited to.
  #claimRoomsFor(agent) {
    const invitedRooms = this.db.prepare(`
      SELECT DISTINCT a.task_id FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'queued' AND a.target_agent_name IS NOT NULL
        AND lower(a.target_agent_name) = lower(?)
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all(agent.name).map((row) => row.task_id);
    return [...new Set([...this.#claimableTaskIds(agent.id), ...invitedRooms])];
  }

  // Cache what an agent reported it can be run as, and say whether we should ask again.
  //
  // Asking the agent is the only honest source: it is the one party that knows what its host offers,
  // and the alternative — a catalogue typed in by hand — is exactly the dialog nobody ever filled in.
  // It is cached because interrogating every session is wasteful, and it expires because a list of
  // models written once in March is wrong by June.
  runtimeLadder({ agentId, taskId, model = null, effort = null, ladder = null }) {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error("Agent not found.");
    const stamp = now();
    if (model || effort) {
      this.db.prepare("UPDATE agents SET current_model = COALESCE(?, current_model), current_effort = COALESCE(?, current_effort) WHERE id = ?")
        .run(model ? String(model).trim().slice(0, 80) : null, effort ? String(effort).trim().slice(0, 40) : null, agentId);
    }
    const task = taskId ? this.getTask(taskId) : null;
    if (!task) return { known: false, askForLadder: false, reason: "no project in view yet" };
    const root = task.project_root;
    let saved = null;
    if (Array.isArray(ladder) && ladder.length) {
      saved = saveLadder(root, agent.provider, { ladder, reportedBy: agent.name });
      if (saved.written) {
        this._event(taskId, agentId, "agent.progress",
          `${agent.name} reported what ${agent.provider} can be run as: ${saved.rungs} rungs, weakest first.`,
          { ladderRungs: saved.rungs, provider: agent.provider });
      }
    }
    const ladders = loadLadders(root);
    const entry = ladders.providers[agent.provider];
    const stale = ladderIsStale(entry, Date.parse(stamp));
    const rung = this.agentRung({ ...agent, current_model: model || agent.current_model, current_effort: effort || agent.current_effort }, root);
    return {
      known: Boolean(entry?.ladder?.length),
      askForLadder: stale,
      ...(saved ? { ladderSaved: saved.written, ...(saved.written ? {} : { notSaved: saved.reason }) } : {}),
      ...(entry?.ladder?.length ? {
        ladder: entry.ladder.map((step) => rungLabel(step)),
        ladderSource: entry.source,
        ladderReportedAt: entry.reportedAt,
      } : {}),
      ...(rung && rung.at >= 0 ? { running: rungLabel(rung.ladder[rung.at]), rung: rung.at } : {}),
      ...(rung && rung.at < 0 && entry?.ladder?.length ? {
        running: null,
        note: "This session's model is not on the reported ladder, so DevTeam cannot tell whether work is above it. Nothing will be withheld from you.",
      } : {}),
      next: stale
        ? "Call devteam_join again with `ladder`: the model and effort combinations this host can run you at, ordered weakest first. It is cached for a week and is what lets DevTeam name the model a hard assignment needs."
        : null,
    };
  }

  // The rung a difficulty level needs, named from whatever ladder this project has cached. Any
  // provider will do: they are all describing the same piece of work, and the human recognises the
  // names either way. Null when no ladder has been reported yet, and the dashboard then says nothing
  // rather than falling back to a score nobody can act on.
  _rungLabelFor(projectId, level) {
    const project = this.db.prepare("SELECT root FROM projects WHERE id = ?").get(projectId);
    if (!project?.root) return null;
    let ladders;
    try { ladders = loadLadders(project.root); } catch { return null; }
    const entry = Object.values(ladders.providers)[0];
    if (!entry?.ladder?.length) return null;
    return rungLabel(entry.ladder[requiredRung(level, entry.ladder.length)]);
  }

  // The ladder this provider reported, and where this session sits on it. Everything about model
  // selection reads through here, so there is one place that decides what "too hard for you" means.
  //
  // A missing ladder, an unrecognised current model, or a session that never said what it is running
  // all resolve to "cannot judge", and cannot-judge never withholds work. Silence has to mean the
  // team keeps working, or one unreported field stalls the board.
  agentRung(agent, projectRoot) {
    if (!agent?.provider) return null;
    let ladders;
    try { ladders = loadLadders(projectRoot); } catch { return null; }
    const entry = ladders.providers[agent.provider];
    if (!entry?.ladder?.length) return null;
    const at = currentRung(entry.ladder, agent.current_model, agent.current_effort);
    return { ladder: entry.ladder, at, source: entry.source, reportedAt: entry.reportedAt };
  }

  #aboveCurrentRung(agent, candidate) {
    const rung = this.agentRung(agent, candidate.project_root);
    if (!rung || rung.at < 0) return false;
    const assessment = this.db.prepare(`
      SELECT level FROM complexity_assessments WHERE assignment_id = ? AND invalidated_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(candidate.id);
    if (!assessment) return false;
    return requiredRung(assessment.level, rung.ladder.length) > rung.at;
  }

  // What is waiting for a stronger session, in the words the human will recognise. Returned with the
  // idle answer so "nothing for me" can never be mistaken for "the work is finished".
  workAboveCurrentRung(agentId) {
    const agent = this.getAgent(agentId);
    if (!agent) return null;
    const rooms = this.#claimableTaskIds(agentId);
    if (!rooms.length) return null;
    const placeholders = rooms.map(() => "?").join(", ");
    const queued = this.db.prepare(`
      SELECT a.id, a.title, a.task_id, t.title AS task_title, p.root AS project_root
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE a.status = 'queued' AND a.task_id IN (${placeholders})
    `).all(...rooms);
    const held = [];
    let rung = null;
    for (const candidate of queued) {
      rung = rung || this.agentRung(agent, candidate.project_root);
      if (!rung || rung.at < 0) return null;
      if (!this.#aboveCurrentRung(agent, candidate)) continue;
      const assessment = this.db.prepare(`
        SELECT level FROM complexity_assessments WHERE assignment_id = ? AND invalidated_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(candidate.id);
      held.push({
        assignmentId: candidate.id,
        title: candidate.title,
        taskId: candidate.task_id,
        taskTitle: candidate.task_title,
        level: assessment?.level || null,
        needs: rungLabel(rung.ladder[requiredRung(assessment?.level, rung.ladder.length)]),
      });
    }
    if (!held.length) return null;
    const needed = [...new Set(held.map((item) => item.needs).filter(Boolean))];
    return {
      running: rungLabel(rung.ladder[rung.at]),
      needs: needed,
      assignments: held.slice(0, 10),
      count: held.length,
      message: `${held.length} assignment${held.length === 1 ? "" : "s"} on this board ${held.length === 1 ? "needs" : "need"} ${needed.join(" or ")}, and this session is running ${rungLabel(rung.ladder[rung.at])}.`,
      humanAction: "Start a fresh session on that model and join this same task. Nothing is lost and nothing needs replanning: the task, its queue, its history and its memory are all still here, and the new session picks up exactly where this one stopped.",
    };
  }

  claimNextAssignment(agentId) {
    this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("Agent is disconnected. Connect again.");
    // T0.3 — an agent may hold one write claim plus a bounded number of read-only claims. A writer
    // is capped at one because that is the lease invariant; readers take no lease, so capping them
    // only throttled review. The read cap is a guard against one agent draining the review queue and
    // starving its teammates, not a correctness rule.
    const held = this.db.prepare(`
      SELECT requires_write FROM assignments WHERE agent_id = ? AND status = 'claimed'
    `).all(agentId);
    const holdsWriteClaim = held.some((row) => row.requires_write);
    if (held.length >= MAX_CONCURRENT_READ_CLAIMS + 1) return null;
    // This prevents an agent invoked for one project/task from silently claiming another's work,
    // and stops an observer from taking on execution it only joined to watch.
    const memberRooms = this.#claimableTaskIds(agentId);
    const claimRooms = this.#claimRoomsFor(agent);
    if (!claimRooms.length) {
      this.db.prepare("UPDATE agents SET status = CASE WHEN status = 'busy' THEN status ELSE 'waiting' END, last_seen = ? WHERE id = ?").run(now(), agentId);
      return null;
    }
    const predicates = this.#claimPredicates({ agentName: agent.name, memberRooms, claimRooms, holdsWriteClaim });
    const assignment = this._transaction(() => {
      // The eligible queue is the conjunction of the named predicates above — membership,
      // targeting, dependencies and review gating — each of which whyNotClaimable can also evaluate
      // on its own to say which one held an assignment back. The write lease is not part of it: it
      // is no longer project-wide, so it is resolved per path in the loop below and non-overlapping
      // writers run in parallel.
      // The write lease and the runtime gate are resolved per candidate below rather than in SQL,
      // so a fixed window would let work that *is* claimable hide behind a screenful of lease-blocked
      // rows — the scan would hand out nothing while whyNotClaimable correctly reported the item as
      // claimable. Page instead of truncating, so the two can only disagree on a board larger than
      // any this server is meant to hold.
      const readCandidatePage = (offset) => this.db.prepare(`
        ${DEPENDENCY_CLOSURE_CTE}
        SELECT a.*, t.project_id, t.title AS task_title, t.description AS task_description,
          t.session_policy AS task_session_policy,
          t.version AS task_version, t.required_approvals, p.root AS project_root, p.name AS project_name
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN projects p ON p.id = t.project_id
        WHERE ${predicates.map((predicate) => predicate.sql).join("\n          AND ")}
        -- Targeting still wins: work addressed to this agent by name is meant for it. Priority then
        -- orders the rest, and creation time breaks the remaining ties exactly as before. Priority
        -- deliberately sits *inside* the candidate ordering rather than around the predicates, so it
        -- reorders what is claimable and can never make unclaimable work claimable — a human wanting
        -- something sooner is not a reason to skip a dependency, a lease or the review gate.
        ORDER BY CASE WHEN a.target_agent_name IS NOT NULL THEN 0 ELSE 1 END, a.priority DESC, a.created_at ASC
        LIMIT ? OFFSET ?
      `).all(...predicates.flatMap((predicate) => predicate.params), CANDIDATE_PAGE_SIZE, offset);
      const heldLeases = this.#heldWriteLeases();
      const stamp = now();
      const candidates = [];
      for (let offset = 0; offset < CANDIDATE_SCAN_CEILING; offset += CANDIDATE_PAGE_SIZE) {
        const page = readCandidatePage(offset);
        if (!page.length) break;
        candidates.push(...page);
        if (page.length < CANDIDATE_PAGE_SIZE) break;
      }
      if (!candidates.length) {
        this.db.prepare("UPDATE agents SET status = 'waiting', last_seen = ? WHERE id = ?").run(now(), agentId);
        return null;
      }
      for (const candidate of candidates) {
        // A write assignment is claimable only if its declared paths don't overlap a write
        // lease already held by another agent in the same project. Undeclared paths mean the
        // whole project, which conflicts with everything (backward-compatible single lease).
        if (candidate.requires_write) {
          const scopes = this.#resolveScopesOnDisk(candidate.project_root, this._writeScopeFor(candidate.id));
          const conflict = heldLeases.some((lease) => lease.projectId === candidate.project_id
            && lease.scopes.some((held) => scopes.some((want) => this.#scopesOverlap(held, want))));
          if (conflict) continue;
        }
        // A verifying assignment is never handed to whoever wrote the version it examines. Resolved
        // per candidate rather than as a SQL predicate for the same reason the write lease is: it
        // depends on who authored the current version and on who is connected right now, neither of which the scan's
        // single query can see.
        if (candidate.verifies && this._verifierIsAuthor(agentId, candidate)) continue;
        // Above this session's rung: skipped, not blocked. The agent goes on to take everything it
        // *can* do, and only when nothing claimable is left does it go idle saying what remains and
        // what that work needs. Stopping at the first hard item instead would strand work the
        // current model was perfectly capable of finishing.
        if (this.#aboveCurrentRung(agent, candidate)) continue;
        const claimToken = randomBytes(18).toString("base64url");
        const result = this.db.prepare(`
          UPDATE assignments
          SET status = 'claimed', agent_id = ?, claimed_at = ?, claim_generation = claim_generation + 1, claim_token_hash = ?
          WHERE id = ? AND status = 'queued'
        `).run(agentId, stamp, this.#hashToken(claimToken), candidate.id);
        if (!result.changes) continue;
        const claimGeneration = this.db.prepare("SELECT claim_generation FROM assignments WHERE id = ?").get(candidate.id).claim_generation;
        if (candidate.task_session_policy === "per_assignment") {
          this.db.prepare(`UPDATE agents SET status = 'busy', current_task_id = ?, last_seen = ?,
            fresh_task_id = NULL WHERE id = ?`)
            .run(candidate.task_id, stamp, agentId);
        } else {
          this.db.prepare("UPDATE agents SET status = 'busy', current_task_id = ?, last_seen = ? WHERE id = ?")
            .run(candidate.task_id, stamp, agentId);
        }
        // An agent reaches this room by joining it or by being invited into it by name. The
        // invited case has no membership row yet, so record one now that it has committed to the
        // work — otherwise it would claim the item and immediately lose sight of the room it is in.
        this.db.prepare(`
          INSERT OR IGNORE INTO task_members (task_id, agent_id, role, joined_at) VALUES (?, ?, 'contributor', ?)
        `).run(candidate.task_id, agentId, stamp);
        this._syncTaskStatus(candidate.task_id, stamp);
        const writeScope = candidate.requires_write ? this._writeScopeFor(candidate.id) : [];
        this._event(candidate.task_id, agentId, "assignment.claimed", `${agent.name} claimed: ${candidate.title}`, {
          assignmentId: candidate.id,
          role: candidate.role,
          requiresWrite: Boolean(candidate.requires_write),
          writeScope,
          claimGeneration,
        });
        const dependencies = this._dependenciesFor(candidate.id);
        // Work that was sent back arrives saying so, with the reviewer's reason and findings
        // attached. Without this the author would re-claim an assignment whose title and description
        // describe the *original* task and have to go hunting through the timeline for what was
        // actually wrong with it — which is most of what made blunt blocking feel like a dead end.
        return {
          ...candidate,
          agent_id: agentId, status: "claimed", claimed_at: stamp,
          checklist: this._checklistFor(candidate.id), writeScope,
          dependsOn: dependencies.map((item) => item.id), blockedBy: [],
          claimToken, claimGeneration,
          ...(candidate.rework_requested_at ? {
            rework: {
              count: Number(candidate.rework_count || 0),
              requestedAt: candidate.rework_requested_at,
              summary: candidate.rework_summary || null,
              findings: this._findingsFor(candidate.id),
              next: "This work was sent back for changes. Address the summary and every finding below, then report again — reporting without addressing them will simply be sent back.",
            },
          } : {}),
        };
      }
      this.db.prepare("UPDATE agents SET status = 'waiting', last_seen = ? WHERE id = ?").run(now(), agentId);
      return null;
    });
    if (assignment) this._changed("assignment.claimed", assignment.task_id);
    return assignment;
  }

  // Every reason the scheduler will not hand this assignment to this agent, in the order the
  // candidate scan applies them — the whole chain, not just the first. The scan used to skip a
  // candidate and throw the reason away, which is how two hard deadlocks (a verifier whose own
  // write access excluded it from every scan, and work aimed at a teammate who had left) both
  // presented as an idle agent sitting next to claimable work with blockedBy: []. Pass no agentId
  // for the agent-agnostic view the dashboard shows on a queued item; pass one to answer the
  // question an idle agent actually has, which is "why can *I* not claim this?".
  whyNotClaimable(assignmentId, agentId = null, { refreshLiveness = true } = {}) {
    // claimNextAssignment reaps dead sessions and recovers their orphaned claims before it looks at
    // the queue. Answering without doing the same made the explanation report work as "held by
    // someone else" that the very next claim call handed straight over. Only when an agent is
    // actually asking: the dashboard's agent-agnostic call is a read, and the server already runs a
    // periodic reaper for it.
    if (agentId && refreshLiveness) {
      this.#reapStaleAgents();
      this.#recoverOrphanedClaims();
    }
    const assignment = this.db.prepare(`
      SELECT a.*, t.status AS task_status, t.project_id, t.version AS task_version, p.root AS project_root
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      WHERE a.id = ?
    `).get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    const agent = agentId ? this.getAgent(agentId) : null;
    const reasons = [];
    // blocking:false marks a fact worth surfacing that does not itself stop a claim, so a caller
    // never invents a stall out of an advisory note (an absent target *widens* who may claim).
    const add = (code, detail, facts = {}, blocking = true) => { reasons.push({ code, detail, blocking, ...facts }); };

    if (agent) {
      if (agent.status === "disconnected") {
        add("agent_disconnected", `“${agent.name}” is disconnected; connect to DevTeam again before claiming.`);
      }
      // One *write* claim per agent, plus a bounded number of read-only ones (T0.3).
      const heldAll = this.db.prepare("SELECT id, title, requires_write FROM assignments WHERE agent_id = ? AND status = 'claimed'").all(agent.id);
      const heldThis = heldAll.find((row) => row.id === assignment.id);
      const heldWriter = heldAll.find((row) => row.requires_write);
      if (heldThis) {
        add("agent_holds_claim", `“${agent.name}” already holds this claim.`,
          { heldAssignmentId: heldThis.id, heldTitle: heldThis.title });
      } else if (heldAll.length >= MAX_CONCURRENT_READ_CLAIMS + 1) {
        add("agent_holds_claim", `“${agent.name}” is already holding ${heldAll.length} assignments, which is as many as one agent takes at once.`,
          { heldAssignmentId: heldAll[0].id, heldTitle: heldAll[0].title, heldCount: heldAll.length });
      } else if (heldWriter && assignment.requires_write) {
        add("agent_holds_write_claim", `“${agent.name}” already holds the write lease for “${heldWriter.title}”; an agent takes one piece of write work at a time, though it may still review.`,
          { heldAssignmentId: heldWriter.id, heldTitle: heldWriter.title });
      }
    }

    // Ask the candidate scan's own predicates, one at a time, which of them this assignment fails.
    // These are not a second opinion about the queue: they are the scan's SQL, run singly, so the
    // explanation can never call an item fine that the query would have skipped, or the reverse.
    const failed = new Set(this.#failedClaimPredicates(assignment, agent));
    const targetName = assignment.target_agent_name;

    if (failed.has("assignment_not_queued")) {
      const holder = assignment.agent_id
        ? (this.db.prepare("SELECT name FROM agents WHERE id = ?").get(assignment.agent_id)?.name || null)
        : null;
      add("assignment_not_queued", holder
        ? `This assignment is ${assignment.status}, held by “${holder}”, not waiting in the queue.`
        : `This assignment is ${assignment.status}, not waiting in the queue.`,
      { status: assignment.status, holder });
    }
    if (failed.has("room_not_claimable")) {
      // Belonging to *no* room at all is a different situation from being in the wrong one, and it
      // is the one a fresh session lands in. Say which it is, and name the rooms it could join, so
      // "there is work on the board and I am doing nothing" is never a silent empty answer.
      const rooms = this._memberTaskIds(agent.id);
      if (!rooms.length) {
        add("room_membership_required", `“${agent.name}” has not joined any task room, so no work is claimable anywhere; call devteam_join with the intended taskId first.`,
          { taskId: assignment.task_id, availableTasks: this.roomStatusForAgent(agent.id).activeTasks });
      } else {
        add("room_not_claimable", `“${agent.name}” is not a claiming member of this task room and holds no invitation into it; join as a contributor first.`, { taskId: assignment.task_id });
      }
    }
    if (failed.has("task_closed")) {
      add("task_closed", `Its task is ${assignment.task_status}; a closed task hands out no work.`, { taskStatus: assignment.task_status });
    }
    if (failed.has("targeted_elsewhere")) {
      add("targeted_elsewhere", `Targeted at “${targetName}”, who is connected and holds it exclusively.`, { targetAgentName: targetName });
    }
    if (targetName && !this.db.prepare("SELECT 1 FROM agents WHERE lower(name) = lower(?) AND status != 'disconnected' LIMIT 1").get(targetName)) {
      // Not a blocker: an absent target returns the item to the general queue rather than letting it
      // sit claimable-by-nobody. Reported anyway, because "nobody named X is here" explains a lot.
      add("target_absent", `Targeted at “${targetName}”, who is not connected; any member of the room may claim it.`, { targetAgentName: targetName }, false);
    }
    // An invitation authorizes exactly the item(s) addressed to this agent by name and nothing else
    // in that room. Skipped for an agent that is not in the room at all: it already heard that, and
    // hearing "your invitation does not stretch this far" on top of it would be untrue.
    if (failed.has("room_invitation_only") && !failed.has("room_not_claimable")) {
      add("room_invitation_only", `“${agent.name}” reached this room only by an invitation addressed to it by name, so it may claim the assignment(s) targeting it — not this one.`, { taskId: assignment.task_id });
    }
    if (failed.has("dependency_pending")) {
      const pending = this.#pendingDependencies(assignment.id);
      add("dependency_pending", `Waiting on ${pending.length} unfinished ${pending.length === 1 ? "dependency" : "dependencies"}: ${pending.map((dependency) => `“${dependency.title}” (${dependency.status})`).join(", ")}.`,
        { dependsOn: pending.map((dependency) => ({ id: dependency.id, title: dependency.title, status: dependency.status })) });
    }
    if (failed.has("awaiting_writer")) {
      const writers = this.#blockingWriters(assignment.id);
      add("awaiting_writer", `Verification waits for the writer “${writers[0].title}” to finish${writers.length > 1 ? ` (and ${writers.length - 1} more)` : ""}.`, { writers });
    }
    // Not a predicate: independence depends on who authored the current version and on who is connected, neither of
    // which the scan's single query can see, so it is resolved here exactly as the scan resolves it.
    if (assignment.verifies) {
      if (agent && this._verifierIsAuthor(agent.id, assignment)) {
        add("verifier_is_author", `“${agent.name}” wrote version ${assignment.task_version}, so it cannot verify it; an independent teammate is free to take this one.`,
          { version: assignment.task_version });
      } else if (!agent) {
        // The dashboard asks about the item rather than about a claimant, and "the people in this
        // room who wrote it cannot check it" is a fact about the item. Reported non-blocking, for
        // the same reason an absent target is: an independent teammate may be free to take this the
        // very next second, and calling it blocked would put the explanation at odds with a scan
        // that is about to hand it over. Both branches read the same two author sets the scan
        // reads, so the item can never be skipped for a reason this cannot name.
        const authors = this._currentVersionAuthors(assignment.task_id, assignment.task_version);
        const connected = this._connectedParticipants(assignment.task_id);
        const excluded = [...connected].filter((agentId) => authors.has(agentId));
        if (excluded.length && this._independentClaimantExists(assignment, authors, null)) {
          add("verifier_is_author", `Held for an independent teammate: ${excluded.length} of the contributors in this room wrote version ${assignment.task_version} and cannot verify their own work.`,
            { version: assignment.task_version, excludedAuthors: excluded.length }, false);
        }
      }
    }

    if (assignment.requires_write) {
      const wanted = this.#resolveScopesOnDisk(assignment.project_root, this._writeScopeFor(assignment.id));
      for (const lease of this.#heldWriteLeases()) {
        if (lease.id === assignment.id || lease.projectId !== assignment.project_id) continue;
        const overlaps = [];
        for (const holdScope of lease.scopes) {
          for (const wantScope of wanted) {
            if (this.#scopesOverlap(holdScope, wantScope)) overlaps.push({ held: holdScope, wanted: wantScope });
          }
        }
        if (!overlaps.length) continue;
        // Write leases are project-wide, so the blocker may live in a task room the caller has no
        // business seeing. The overlapping *paths* are what makes the stall legible and they are
        // already visible in this room; the other room's assignment title, id and holder are not.
        const sameRoom = lease.taskId === assignment.task_id;
        const pathSummary = overlaps.map((pair) => `${scopeLabel(pair.wanted)} vs ${scopeLabel(pair.held)}`).join(", ");
        add("write_lease_conflict", sameRoom
          ? `Its write lease overlaps one “${lease.holder || "another agent"}” already holds for “${lease.title}”: ${pathSummary}.`
          : `Its write lease overlaps one another agent already holds in a different task room in this project: ${pathSummary}.`,
        sameRoom
          ? { conflictingAssignmentId: lease.id, conflictingTitle: lease.title, holder: lease.holder, paths: overlaps, sameRoom }
          : { conflictingAssignmentId: null, conflictingTitle: null, holder: null, paths: overlaps, sameRoom });
      }
    }

    return {
      assignmentId: assignment.id,
      taskId: assignment.task_id,
      title: assignment.title,
      role: assignment.role,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      claimable: reasons.every((reason) => !reason.blocking),
      reasons,
    };
  }

  // "There is work on the board and I am doing nothing" — answered in one call. Every queued item
  // in the rooms this agent can reach, each with its full chain, plus whatever it can claim right
  // now. Membership is still the boundary: rooms the agent never joined and was never invited into
  // stay invisible, exactly as they are to the scan.
  whyNoClaimableWork(agentId, taskId = null) {
    const agent = this.getAgent(agentId);
    const invited = this.db.prepare(`
      SELECT DISTINCT a.task_id FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.status = 'queued' AND a.target_agent_name IS NOT NULL
        AND lower(a.target_agent_name) = lower(?)
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all(agent.name).map((row) => row.task_id);
    // Observer rooms are included so an observer is told *why* it may not claim, rather than being
    // shown an empty board it has no way to interpret.
    const rooms = [...new Set([...this._memberTaskIds(agentId), ...invited])]
      .filter((room) => !taskId || room === taskId);
    if (taskId && !rooms.includes(taskId)) this.assertMembership(agentId, taskId);
    this.#reapStaleAgents();
    this.#recoverOrphanedClaims();
    const queued = rooms.flatMap((room) => this.db.prepare(`
      SELECT a.id FROM assignments a WHERE a.task_id = ? AND a.status = 'queued' ORDER BY a.created_at ASC
    `).all(room).map((row) => this.whyNotClaimable(row.id, agentId, { refreshLiveness: false })));
    const held = this.db.prepare("SELECT id, title FROM assignments WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(agentId);
    // An agent in no room sees an empty board even when the server is busy. Without this the answer
    // to "why is there nothing for me?" is an empty list, which reads as "the team has no work".
    const roomStatus = rooms.length ? null : this.roomStatusForAgent(agentId);
    // A blocked room has no queued rows at all, so the honest answer to "why is there nothing for
    // me?" used to be an empty list — indistinguishable from a finished team. Name the block and who
    // can lift it, or the agent starts inventing workarounds for it.
    const blockedRooms = rooms.map((room) => this.blockedRecovery(room)).filter(Boolean);
    return {
      agentId,
      agentName: agent.name,
      rooms,
      ...(blockedRooms.length ? { blockedRooms, next: blockedRooms[0].agentAction } : {}),
      ...(roomStatus && roomStatus.activeTasks.length
        ? {
            membershipRequired: true,
            availableTasks: roomStatus.activeTasks,
            next: "You have joined no task room, so nothing is claimable. Call devteam_join with the intended taskId from availableTasks.",
          }
        : {}),
      holdingClaim: held ? { assignmentId: held.id, title: held.title } : null,
      queuedCount: queued.length,
      claimable: queued.filter((entry) => entry.claimable).map((entry) => entry.assignmentId),
      assignments: queued,
    };
  }

  // The room an assignment belongs to, without computing anything about it. Lets a caller authorize
  // *before* doing the work, and answer "no such assignment" and "not your room" identically so the
  // explainer is not an existence oracle.
  assignmentRoom(assignmentId) {
    return this.db.prepare("SELECT task_id FROM assignments WHERE id = ?").get(assignmentId)?.task_id || null;
  }

  // Membership check for the explanation surfaces: an agent may ask about an assignment in a room it
  // belongs to, or one it was invited into by name. Anything else stays out of reach, so the
  // explainer can never be used to enumerate another team's work.
  assertExplainable(agentId, taskId) {
    if (!agentId) return;
    if (this._memberTaskIds(agentId).includes(taskId)) return;
    const agent = this.getAgent(agentId);
    const invited = this.db.prepare(`
      SELECT 1 FROM assignments a WHERE a.task_id = ? AND a.status = 'queued'
        AND a.target_agent_name IS NOT NULL AND lower(a.target_agent_name) = lower(?) LIMIT 1
    `).get(taskId, agent.name);
    if (!invited) throw new Error("You are not a member of this task room. Call devteam_join first.");
  }

  // T2.6 — the three things a human could not do once work was running.
  //
  // Before this, the only mid-flight controls were block (stops everything), force-release (takes a
  // lease away) and message (advisory). All three are blunt: nothing could say "do this one first"
  // or "stop that, it is no longer worth doing".

  // Re-prioritise a queued assignment. Higher goes first; the rest of the ordering is unchanged, so
  // priority breaks ties rather than overriding dependencies, leases or the review gate — none of
  // which are preferences a human should be able to skip by wanting something sooner.
  prioritizeAssignment({ taskId, assignmentId, priority }) {
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!assignment) throw new Error("Assignment not found in this task.");
    const value = Math.max(-100, Math.min(100, Math.trunc(Number(priority) || 0)));
    this.db.prepare("UPDATE assignments SET priority = ? WHERE id = ?").run(value, assignmentId);
    this._event(taskId, null, "assignment.prioritized",
      `Priority for “${assignment.title}” set to ${value}.`, { assignmentId, priority: value });
    this._changed("assignment.prioritized", taskId);
    return { assignmentId, taskId, priority: value };
  }

  // Ask a running agent to stop. Cooperative on purpose: killing a writer mid-edit is how a working
  // tree gets left half-written, and DevTeam has no way to know where in its work an agent is. The
  // flag is returned on the agent's next heartbeat or tool call, and the agent reports what it has.
  // If it never comes back, the ordinary liveness machinery handles it exactly as before.
  requestCancel({ taskId, assignmentId, reason = "" }) {
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!assignment) throw new Error("Assignment not found in this task.");
    if (assignment.status !== "claimed") throw new Error("Only work someone is actually doing can be cancelled; queued work can be deleted or re-prioritised instead.");
    const stamp = now();
    const cleanReason = String(reason || "").trim().slice(0, 1000) || "The human asked for this work to stop.";
    this.db.prepare("UPDATE assignments SET cancel_requested_at = ?, cancel_reason = ? WHERE id = ?").run(stamp, cleanReason, assignmentId);
    this._event(taskId, assignment.agent_id, "assignment.cancel_requested",
      `Stop requested for “${assignment.title}”: ${cleanReason}`, { assignmentId, reason: cleanReason });
    this._changed("assignment.cancel_requested", taskId);
    return { assignmentId, taskId, cancelRequested: true, reason: cleanReason };
  }

  // What a claimed assignment's holder should be told on its next call: that it has been asked to
  // stop. Returned by heartbeat and by devteam_next.
  steeringFor(agentId) {
    const held = this.db.prepare(`
      SELECT a.id, a.title, a.task_id, a.cancel_requested_at, a.cancel_reason
      FROM assignments a WHERE a.agent_id = ? AND a.status = 'claimed' LIMIT 1
    `).get(agentId);
    if (!held?.cancel_requested_at) return null;
    return {
      assignmentId: held.id,
      title: held.title,
      taskId: held.task_id,
      cancelRequested: true,
      reason: held.cancel_reason,
      next: "Stop as soon as you can do so safely. Report what you have with devteam_report — status=blocked if it is incomplete — rather than abandoning the claim.",
    };
  }

  // Currently-held write leases (claimed write assignments owned by a live agent on a live task),
  // with their normalized path scopes, for per-path conflict resolution.
  #heldWriteLeases() {
    return this.db.prepare(`
      SELECT a.id, a.title, a.task_id AS taskId, ag.name AS holder, t.project_id AS projectId, p.root AS root
      FROM assignments a
      JOIN tasks t ON t.id = a.task_id
      JOIN projects p ON p.id = t.project_id
      JOIN agents ag ON ag.id = a.agent_id
      WHERE a.status = 'claimed' AND a.requires_write = 1
        AND ag.status != 'disconnected'
        AND t.status NOT IN ('accepted', 'blocked', 'cancelled')
    `).all().map((row) => ({
      id: row.id, title: row.title, taskId: row.taskId, holder: row.holder, projectId: row.projectId,
      scopes: this.#resolveScopesOnDisk(row.root, this._writeScopeFor(row.id)),
    }));
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
  _writeScopeFor(assignmentId) {
    const row = this.db.prepare("SELECT paths FROM assignment_write_scopes WHERE assignment_id = ?").get(assignmentId);
    const declared = fromJson(row?.paths, []);
    const normalized = Array.isArray(declared) ? [...new Set(declared.map((p) => this.#normalizeScope(p)))] : [];
    return normalized.length ? normalized : [""];
  }

  _dependenciesFor(assignmentId) {
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
    // teammate (returned by their next devteam_next / tool call); an undirected one is a
    // timeline note anyone can read via devteam_next with want=state.
    const enriched = { ...metadata };
    let directedTo = null;
    if (metadata.target && String(metadata.target).trim()) {
      enriched.targetLabel = metadata.targetLabel || String(metadata.target).trim();
      enriched.target = String(metadata.target).trim().toLowerCase();
      enriched.senderName = agent.name;
      directedTo = enriched.targetLabel;
    }
    this._transaction(() => {
      this._event(taskId, agentId, type, message.trim(), enriched);
      this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(now(), agentId);
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), taskId);
    });
    this.markMessagesSeen(agentId);
    this._changed(type, taskId);
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
        nextAction: "Do not write further under this claim. Call devteam_next to pick up current work, or devteam_join with your resumeToken if you are returning to an earlier session.",
      },
    };
  }

  // T2.1 — an agent that finds its work is too big can divide it.
  //
  // "Divide work among themselves" was the one thing in the stated goal that the system did not
  // support at all: a planner created assignments by hand, and an agent that claimed one and
  // discovered it was three days of work had no move. It could grind through it, or report blocked
  // and wait for a human-shaped triage step. Neither is what a team does.
  //
  // The design constraint that shapes everything here: **splitting must not cost the splitter its
  // lease**. An agent that has to release its claim to reorganise the work will not do it — it will
  // grind on instead — and in the gap another agent can take the paths it was midway through
  // editing. So the parent stays claimed by the same agent, at the same generation, throughout.
  async completeAssignment({ agentId, assignmentId, message, status = "done", changedFiles = [], checks = [], nextStatus = "waiting", claimToken = null }) {
    const agent = this.getAgent(agentId);
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    // Lease fencing: the owning session (session-bound identity already blocks other agents) and,
    // when supplied, the fencing token must match the live claim. A stale report — from a session
    // whose lease was force-released or moved on resume — gets a structured conflict, not a write.
    const ownedByCaller = assignment.agent_id === agentId && assignment.status === "claimed";
    const tokenMatches = claimToken == null || (assignment.claim_token_hash && this.#hashToken(claimToken) === assignment.claim_token_hash);
    if (!ownedByCaller || !tokenMatches) return this.#claimConflict(assignment, agentId);
    // This assignment already has a report's checks running. Refusing the second one is not a race
    // guard for its own sake: an accepted report spawns real processes in the project root, so a
    // retried or duplicated call would run the suite twice over one working tree and record
    // whichever finished last. The claim is untouched, so the agent loses nothing by waiting.
    if (assignment.verifying_at) {
      return {
        completed: false,
        verifying: { assignmentId, taskId: assignment.task_id, since: assignment.verifying_at },
        reason: "DevTeam is still running the checks from your previous report on this assignment. Wait for that call to return instead of reporting again.",
      };
    }
    const cleanChanged = [...new Set(changedFiles.map((item) => String(item).trim()).filter(Boolean))].slice(0, 200);
    const task = this.getTask(assignment.task_id);
    // Anything the agent asked DevTeam to verify is run *now*, before a single row is written, so a
    // failure cannot become a permanently green record that approvals are then built on top of.
    // Running it takes real time and no longer holds the event loop, so the assignment carries a
    // verifying flag for that window: the board can show "checks running", the duplicate report
    // above is refused, and a crash mid-verification leaves a flag that startup clears rather than
    // a claim nobody can settle.
    const runsCommands = this._reportRunsCommands(task, checks);
    let jobId = null;
    if (runsCommands) {
      this.db.prepare("UPDATE assignments SET verifying_at = ? WHERE id = ?").run(now(), assignmentId);
      // T0.4 — the same window, recorded durably. verifying_at answers "is this assignment busy
      // right now"; the job row answers "what was this server part-way through when it died", which
      // is a question only a row that outlives the process can answer.
      jobId = this.#startJob({
        kind: "verified_checks",
        taskId: assignment.task_id,
        assignmentId,
        agentId,
        detail: { commands: this._reportedCheckCommands(task, checks), title: assignment.title },
      });
      this._event(assignment.task_id, agentId, "assignment.verifying",
        `DevTeam is running the checks ${agent.name} reported for “${assignment.title}”.`, { assignmentId, role: assignment.role, jobId });
      this._changed("assignment.verifying", assignment.task_id);
    }
    let checkRecords;
    try {
      checkRecords = await this._gradeReportedChecks(assignment, task, checks);
    } finally {
      if (runsCommands) {
        this.db.prepare("UPDATE assignments SET verifying_at = NULL WHERE id = ?").run(assignmentId);
        this.#finishJob(jobId, { state: "finished", outcome: `Ran ${checkRecords?.filter((record) => record.verified).length ?? 0} verified check(s).` });
      }
    }
    // The claim can move while those checks run. A force-release and a resume
    // all reassign it, and none of them wait for verification — so settling against the row read
    // before the await would write a report on a lease this caller no longer holds. Re-fence against
    // the row as it stands now, including the generation, which every one of those paths bumps.
    const current = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId);
    if (!current) throw new Error("Assignment not found.");
    const stillOwned = current.agent_id === agentId
      && current.status === "claimed"
      && Number(current.claim_generation) === Number(assignment.claim_generation)
      && (claimToken == null || (current.claim_token_hash && this.#hashToken(claimToken) === current.claim_token_hash));
    if (!stillOwned) return this.#claimConflict(current, agentId);
    const cleanChecks = checkRecords.map((record) => record.label).slice(0, 100);
    const failedChecks = checkRecords.filter((record) => record.status === "failed");
    // A verified failure cannot be reported as done. The claim is deliberately left intact: the
    // agent fixes the work and reports again rather than losing its lease over a caught overclaim.
    // status=blocked is still allowed through — reporting a genuine failure is the honest path.
    if (status !== "blocked" && failedChecks.length) {
      const stamp = now();
      let regressions = [];
      this._transaction(() => {
        // A refused report is still evidence, and is in fact where a regression is usually first
        // seen: the agent that trips over someone else's breakage is the one running the suite.
        const detected = this._recordCheckBaselines({
          taskId: assignment.task_id, assignmentId, records: checkRecords, version: task?.version, stamp,
        });
        regressions = this._openRegressions({
          taskId: assignment.task_id, assignmentId, regressions: detected, stamp, projectId: task?.project_id,
        });
        this._storeReportedChecks(assignmentId, assignment.task_id, checkRecords, stamp);
        this._event(assignment.task_id, agentId, "assignment.check_failed",
          `${agent.name} reported “${assignment.title}” as done, but ${failedChecks.length === 1 ? "a check" : `${failedChecks.length} checks`} DevTeam ran failed.`, {
            assignmentId,
            role: assignment.role,
            checks: cleanChecks,
            checkRecords,
            ...(regressions.length ? { regressions: regressions.map((item) => item.label) } : {}),
          });
      });
      this._changed("assignment.check_failed", assignment.task_id);
      // Distinguish "you broke this" from "you found this broken". Every failing check being the
      // reporter's fault was never true, and telling an agent to fix a regression it did not cause
      // is how a team wastes an afternoon.
      const notYourFault = regressions.filter((regression) => regression.fixAssignmentId);
      return {
        completed: false,
        checksFailed: {
          assignmentId,
          taskId: assignment.task_id,
          failed: failedChecks.map((record) => ({
            label: record.label, command: record.command, exitCode: record.exitCode,
            durationMs: record.durationMs, timedOut: Boolean(record.timedOut), output: record.output,
          })),
          reason: "DevTeam ran the commands you reported and they did not pass, so this cannot be recorded as done. Fix the work and report again, or report status=blocked with what you found.",
        },
        ...(regressions.length ? {
          regressions,
          regressionNote: notYourFault.length
            ? `${notYourFault.length === 1 ? "A check" : `${notYourFault.length} checks`} that used to pass now fails, and the change that broke it was not yours. A fix assignment has been queued for whoever made it. Do not chase it — fix only what your own work needs and report again.`
            : "A check that used to pass now fails. Nothing in this task changed files since it was last green, so it is most likely your own work in progress.",
        } : {}),
        checks: checkRecords,
      };
    }
    const unverifiedFiles = this.#unverifiedChangedFiles(task?.project_root, cleanChanged);
    this.markMessagesSeen(agentId);
    let version;
    let followUpAssignmentId = null;
    let regressions = [];
    this._transaction(() => {
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
      // Work that was sent back has now been reported again, so the findings that sent it back stop
      // being outstanding. They are marked resolved rather than deleted: "this was reworked twice
      // and here is what for" is exactly the history a reviewer wants on the next pass. Whether the
      // rework is *good* is the reviewer's call — it can send it back again, which is the point.
      if (status !== "blocked") {
        this.db.prepare("UPDATE assignment_findings SET resolved_at = ?, resolved_by_assignment_id = ? WHERE assignment_id = ? AND resolved_at IS NULL")
          .run(stamp, assignmentId, assignmentId);
        // It is no longer queued *as* rework. rework_count is deliberately left standing: how many
        // times this went back is a fact about the work, and the next reviewer should see it.
        this.db.prepare("UPDATE assignments SET rework_requested_at = NULL, rework_summary = NULL WHERE id = ?").run(assignmentId);
      }
      // A passing run repairs the baseline and closes any regression it was breaking, so ordinary
      // work quietly resolving a breakage does not leave it open on the board forever.
      regressions = this._openRegressions({
        taskId: assignment.task_id, assignmentId, projectId: task?.project_id, stamp,
        regressions: this._recordCheckBaselines({
          taskId: assignment.task_id, assignmentId, records: checkRecords, version, stamp,
        }),
      });
      this._storeReportedChecks(assignmentId, assignment.task_id, checkRecords, stamp);
      this._event(assignment.task_id, agentId, status === "blocked" ? "assignment.blocked" : "assignment.completed", message.trim(), {
        assignmentId,
        role: assignment.role,
        changedFiles: cleanChanged,
        checks: cleanChecks,
        // The structured form says which of those lines DevTeam actually ran. Consumers that only
        // understand the strings keep working; consumers that can tell the difference now can.
        checkRecords,
        version,
        ...(unverifiedFiles.length ? { unverifiedFiles } : {}),
      });
      if (status === "blocked") {
        // An assignment-level blocker is a triage signal, not permission to stop every teammate.
        // Queue a fresh planner item so the team can re-scope or ask the human while sibling work
        // and write leases continue. Only the explicit blockTask/devteam_stuck path is task-wide.
        followUpAssignmentId = randomUUID();
        this.db.prepare(`
          INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at, plans)
          VALUES (?, ?, ?, ?, ?, 0, 'queued', ?, 1)
        `).run(
          followUpAssignmentId,
          assignment.task_id,
          `Resolve blocker: ${assignment.title}`,
          `Review the blocker reported for "${assignment.title}": ${message.trim()}. Re-scope the work, create a replacement assignment, or use devteam_stuck only if the entire task genuinely requires human input.`,
          this.planningRoleFor(task.project_id),
          stamp,
        );
        this._event(assignment.task_id, agentId, "assignment.created", `Resolve blocker: ${assignment.title}`, {
          assignmentId: followUpAssignmentId,
          role: this.planningRoleFor(task.project_id),
          requiresWrite: false,
          blockedAssignmentId: assignment.id,
        });
        this.db.prepare("UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ? WHERE id = ?")
          .run(stamp, agentId);
        this._syncTaskStatus(assignment.task_id, stamp);
      } else {
        const disconnect = nextStatus === "disconnected";
        this.db.prepare("UPDATE agents SET status = ?, current_task_id = NULL, last_seen = ?, disconnected_at = ? WHERE id = ?")
          .run(disconnect ? "disconnected" : "waiting", stamp, disconnect ? stamp : null, agentId);
        this._syncTaskStatus(assignment.task_id, stamp);
      }
    });
    this._changed(status === "blocked" ? "assignment.blocked" : "assignment.completed", assignment.task_id);
    return {
      completed: true,
      taskId: assignment.task_id,
      assignmentId,
      status,
      version,
      changedFiles: cleanChanged,
      checks: checkRecords,
      verifiedChecks: checkRecords.filter((record) => record.verified).length,
      ...(regressions.length ? { regressions } : {}),
      agent: agent.name,
      ...(status === "blocked" ? { taskBlocked: false, followUpAssignmentId } : {}),
    };
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
    this._event(taskId, null, "agent.standdown", note, { agents: affected.map((a) => a.name) });
  }

  // `kind` defaults only for the human, who blocks from a dashboard button and is not choosing
  // between six overloaded meanings. Agents are made to name it at the MCP boundary.
  blockTask({ agentId = null, taskId, reason, kind = "needs-human" }) {
    if (agentId) this.getAgent(agentId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const blockKind = String(kind || "needs-human").trim();
    if (!BLOCK_KINDS.includes(blockKind)) {
      throw new Error(`"${blockKind}" is not a kind of blocker. Use one of: ${BLOCK_KINDS.join(", ")}.`);
    }
    const openWork = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')
    `).get(taskId).count);
    if (!openWork && BLOCK_KINDS_NEEDING_OPEN_WORK.includes(blockKind)) {
      throw new Error(`Nothing is open on "${task.title}", so there is no work in flight for a ${blockKind} blocker to stop. Finishing is not blocking: if the work is done, approve the current version and let the human accept it. If you genuinely need the human, block with kind "needs-human" and say exactly what you need from them.`);
    }
    const stamp = now();
    this._transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?").run(stamp, taskId);
      this.db.prepare(`
        UPDATE assignments SET status = 'blocked', completed_at = COALESCE(completed_at, ?), claim_token_hash = NULL
        WHERE task_id = ? AND status IN ('queued', 'claimed')
      `).run(stamp, taskId);
      this._event(taskId, agentId, "task.blocked", reason.trim(), { kind: blockKind });
      this.#standDownTaskAgents(taskId, stamp, "Task was blocked; co-workers were released to other work.");
    });
    this._changed("task.blocked", taskId);
    return { blocked: true, taskId, reason: reason.trim(), kind: blockKind };
  }

  // A blocked task is the one dead end that genuinely needs the human: no MCP tool can reopen it.
  // Nothing used to say so, so agents inferred the capability was missing from DevTeam entirely and
  // advised deleting and recreating the task — losing its whole ledger to work around a button they
  // could not see. The dashboard banner and every agent-facing surface read this one descriptor, so
  // the way out is stated in the same words wherever someone hits the wall.
  blockedRecovery(taskId) {
    const task = this.getTask(taskId);
    if (!task || task.status !== "blocked") return null;
    const blockEvent = this.db.prepare(`
      SELECT message, metadata, created_at, author_name, author_kind FROM events
      WHERE task_id = ? AND type = 'task.blocked' ORDER BY id DESC LIMIT 1
    `).get(taskId);
    // Blocks recorded before the kind existed have none; say so rather than inventing one.
    const blockKind = fromJson(blockEvent?.metadata, {}).kind || null;
    const strandedWork = this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status = 'blocked'
    `).get(taskId).count;
    return {
      taskId,
      taskTitle: task.title,
      version: task.version,
      reason: blockEvent?.message || null,
      kind: blockKind,
      blockedBy: blockEvent?.author_kind === "human" ? "the human" : (blockEvent?.author_name || null),
      blockedAt: blockEvent?.created_at || null,
      strandedAssignments: Number(strandedWork),
      resumableBy: this.taskMemberNames(taskId),
      humanAction: 'Resume this task from the DevTeam dashboard — the "Task blocked" banner at the top of the task, or the "Resume blocked task" button at the foot of the team panel. Resuming reopens the task at the next version and queues one fresh planning assignment; name an agent to send that plan straight to them.',
      agentAction: "Only the human can resume a blocked task; no MCP tool can. Say which task needs resuming and why, then stop and wait. Do not delete and recreate the task, do not open a duplicate for the same work, and do not approve or accept anything to route around the block.",
    };
  }

  // The error an agent hits when it tries to work around a block — filing a fresh assignment, a
  // proposal, a continuation. A bare "Task is already blocked." is what sent one agent looking for a
  // capability that exists, so the refusal names the one move that works instead.
  closedTaskError(task, action) {
    if (task.status !== "blocked") return `Task is already ${task.status}.`;
    return `Task "${task.title}" is blocked, so you cannot ${action}. Only the human can resume it, from the DevTeam dashboard — no MCP tool can, and this is not a missing feature to route around. Ask them to resume this task and say why; do not delete and recreate it, and do not open a duplicate task for the same work.`;
  }

  blockedRoomsForAgent(agentId) {
    return this._memberTaskIds(agentId).map((room) => this.blockedRecovery(room)).filter(Boolean);
  }

  taskMemberNames(taskId) {
    return this.db.prepare(`
      SELECT ag.name FROM task_members m JOIN agents ag ON ag.id = m.agent_id
      WHERE m.task_id = ? ORDER BY m.joined_at ASC
    `).all(taskId).map((row) => row.name);
  }

  // Resuming with a target answers the case that produced this feature: the review had to go back to
  // one specific agent, and dropping the fresh plan into the open queue is how it went to the wrong
  // one in the first place. An unmatched name is refused rather than stored, since the scheduler
  // matches targets by name and a typo would strand the plan nobody can claim.
  unblockTask({ taskId, reason, targetAgentName = null }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (task.status !== "blocked") throw new Error("Only a blocked task can be resumed.");
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) throw new Error("A resume reason is required.");
    const requestedTarget = String(targetAgentName || "").trim();
    let target = null;
    if (requestedTarget) {
      target = this.db.prepare("SELECT name FROM agents WHERE lower(name) = lower(?)").get(requestedTarget)?.name || null;
      if (!target) {
        const known = this.db.prepare("SELECT name FROM agents ORDER BY name ASC").all().map((row) => row.name);
        throw new Error(`No agent named "${requestedTarget}" is known to DevTeam.${known.length ? ` Known agents: ${known.join(", ")}.` : ""}`);
      }
    }
    const stamp = now();
    const assignmentId = randomUUID();
    const planningRoleName = this.planningRoleFor(task.project_id);
    const routing = target
      ? ` This plan is addressed to ${target}: route the work it creates to ${target} unless the project state makes that impossible, and say so if it does.`
      : "";
    let version;
    this._transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'planning', version = version + 1, updated_at = ? WHERE id = ?")
        .run(stamp, taskId);
      this.db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, plans)
        VALUES (?, ?, 'Plan resumed task', ?, ?, 0, ?, 'queued', ?, 1)
      `).run(assignmentId, taskId, `The human resumed this blocked task: ${cleanReason}. Inspect the current project state and create fresh implementation and review assignments; do not revive stale claims.${routing}`, planningRoleName, target, stamp);
      version = this.db.prepare("SELECT version FROM tasks WHERE id = ?").get(taskId).version;
      this._event(taskId, null, "task.unblocked", `Human resumed the task: ${cleanReason}`, { reason: cleanReason, version, targetAgentName: target });
      this._event(taskId, null, "assignment.created", "Plan resumed task", {
        assignmentId,
        role: planningRoleName,
        requiresWrite: false,
        targetAgentName: target,
        resumed: true,
      });
    });
    this._changed("task.unblocked", taskId);
    return { resumed: true, taskId, assignmentId, version, status: "planning", targetAgentName: target };
  }

  // `acceptStranded` is the human confirming they know work was stopped mid-flight and are closing the
  // task anyway. It is never assumed.
  acceptTaskByHuman({ taskId, summary, acceptStranded = false }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    if (task.status === "cancelled") throw new Error("Cannot accept a cancelled task.");
    if (task.status === "accepted") return { accepted: true, taskId, version: task.version, humanOverride: true };
    // A blocked task used to be unacceptable, full stop — and the only way out was Resume, which
    // bumps the version, clears the approvals and queues a fresh planning assignment. That is the
    // right treatment for work that genuinely stopped. It is absurd for a task an agent blocked to
    // *mean finished*, which on this board was six of them: closing already-finished work should not
    // require replanning it. Twenty tasks are sitting blocked with three resumes ever recorded, and
    // this is a large part of why.
    let strandedAssignments = 0;
    if (task.status === "blocked") {
      strandedAssignments = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status = 'blocked'
      `).get(taskId).count);
      // Nothing was in flight when it stopped, so there is no unfinished work to bury. Where there
      // was, say exactly how much and make the human ask for it a second time — accepting is how a
      // stalled piece of work would get quietly lost.
      if (strandedAssignments && !acceptStranded) {
        throw new Error(`"${task.title}" was blocked with ${strandedAssignments} assignment${strandedAssignments === 1 ? "" : "s"} still in flight. Resume it to finish that work, or accept again confirming you are closing it with that work unfinished.`);
      }
    } else if (task.status !== "review") {
      throw new Error("Human acceptance is available only when the task is ready for review.");
    }
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
    this._transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, taskId);
      this._event(taskId, null, "task.accepted",
        `Human accepted version ${task.version}${task.status === "blocked" ? " from blocked" : ""}: ${cleanSummary}`, {
          summary: cleanSummary,
          version: task.version,
          approvalCount,
          requiredApprovals: task.required_approvals,
          humanOverride: true,
          ...(task.status === "blocked" ? { acceptedFromBlocked: true, strandedAssignments } : {}),
        });
      this.db.prepare(`
        UPDATE agents SET status = 'waiting', current_task_id = NULL, last_seen = ?
        WHERE current_task_id = ? AND status != 'disconnected'
      `).run(stamp, taskId);
    });
    this._changed("task.accepted", taskId);
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
    this._transaction(() => {
      eventId = this._event(taskId, null, "human.message", message.trim(), {
        target: targetKey,
        targetLabel: targetKey === "all" ? "all agents" : normalized,
        ...(replyTo ? { replyTo: Number(replyTo) } : {}),
      });
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now(), taskId);
    });
    this._changed("human.message", taskId);
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
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(this.closedTaskError(task, "continue it"));
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) throw new Error("A continuation message is required.");
    const normalized = String(target || "all").trim() || "all";
    const targetKey = normalized.toLowerCase();
    const firstLine = cleanMessage.split("\n")[0].slice(0, 120) || "new request";
    const stamp = now();
    let result;
    this._transaction(() => {
      const eventId = this._event(taskId, null, "human.message", cleanMessage, {
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
      const planningRoleName = this.planningRoleFor(task.project_id);
      const title = `Plan follow-up: ${firstLine}`;
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, plans)
        VALUES (?, ?, ?, ?, ?, 0, NULL, 'queued', ?, 1)
      `).run(assignmentId, taskId, title, `Plan the follow-up requested in chat: "${firstLine}". Split it into implementation and review work as needed.`, planningRoleName, stamp);
      this._event(taskId, byAgentId, "assignment.created", title, { assignmentId, role: planningRoleName, requiresWrite: false, targetAgentName: null, continuesEvent: eventId });
      this._syncTaskStatus(taskId, stamp);
      const version = this.db.prepare("SELECT version FROM tasks WHERE id = ?").get(taskId).version;
      result = { taskId, eventId, reopened, version, assignmentId };
    });
    this._changed("task.continued", taskId);
    return result;
  }

  // --- Shared blackboard: a task-scoped, versioned key/document store that is the team's working
  // memory — goals, decisions, facts, open questions, per-file ownership — so agents read shared
  // state instead of re-deriving it from scrollback or trusting each other's summaries. Writes use
  // optimistic concurrency (pass the version you read; a mismatch is reported, not silently
  // clobbered) and carry provenance. A structured "world" document is just the value under one key. ---

  // Knowledge maintenance, all membership-scoped through a task room like every other agent action.

}

// The clusters that live in their own files, composed onto the prototype after the class body so
// that every call site — inside this file and out — reads exactly as it did when they were declared
// here. Order does not matter: no two mixins define the same name.
Object.assign(DevTeamStore.prototype, checksMethods, knowledgeMethods, consensusMethods, viewMethods);
