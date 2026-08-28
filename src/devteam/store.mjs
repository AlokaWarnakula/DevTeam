import { EventEmitter } from "node:events";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodeGraph } from "./codegraph.mjs";
import { KnowledgeVault } from "./knowledge.mjs";
import { buildBudgetedBrief, clipUtf8, DEFAULT_BRIEF_BUDGET } from "./brief.mjs";
import { DEFAULT_ROLES, loadProjectRoles, planningRole, roleBehaviour, ROLES_CONFIG_PATH } from "./roles.mjs";
import { currentRung, ladderIsStale, loadLadders, requiredRung, rungLabel, saveLadder } from "./models.mjs";
import { hashToken, mintToken, normalizeTokenLabel, tokensMatch } from "./access.mjs";
import {
  boundedCheckpointText,
  buildCheckpointCapsule,
  DEFAULT_CHECKPOINT_BUDGET_BYTES,
} from "./checkpoint.mjs";
import {
  assessAssignment,
  COMPLEXITY_POLICY_VERSION,
  normalizeRuntimeProfile,
  resolveRuntimeRequirement,
} from "./runtime/index.mjs";
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
// Whether an assignment reads the work rather than changing it — and therefore waits for pending
// writers, earns the right to approve, and puts its task in review — is a column on the row,
// resolved from the project's role config when the assignment was created (see roles.mjs). It is
// deliberately NOT a list of role names here: a project that calls its reviewing role `fact-checker`
// or `structural-engineer` must schedule identically, and no domain vocabulary belongs in this SQL.
const VERIFIES = "verifies = 1";
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

const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const fromJson = (value, fallback = null) => {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
};

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
  // performs none of the startup recovery: reaping orphaned claims, expiring checkpoints and
  // re-deriving task status are the server's job, and doing them from a CLI peek would move work
  // around behind a live scheduler's back. That was already happening before the lock existed.
  constructor(dataDir, { liveness = {}, knowledge = {}, codegraph = {}, checkpoint = {}, checks = {}, exclusive = true } = {}) {
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
    this.checkpoint = {
      capsuleBytes: DEFAULT_CHECKPOINT_BUDGET_BYTES,
      ttlMs: 30 * 60 * 1000,
      maxTtlMs: 24 * 60 * 60 * 1000,
      ...checkpoint,
    };
    // Everything below moves state: it belongs to the process that owns the directory, never to a
    // CLI looking in while that process is running.
    if (!exclusive) return;
    this.#expireSessionCheckpoints();
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
      this.#event(job.task_id, null, "job.interrupted",
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

      CREATE TABLE IF NOT EXISTS session_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        assignment_id TEXT NULL REFERENCES assignments(id) ON DELETE SET NULL,
        from_agent_id TEXT NOT NULL,
        from_agent_name TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        checkpoint_generation INTEGER NOT NULL,
        capsule TEXT NOT NULL,
        status TEXT NOT NULL,
        handoff_token_hash TEXT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        claimed_by_agent_id TEXT NULL,
        claimed_at TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runtime_profiles (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        profile TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        observed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS complexity_assessments (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        assignment_version INTEGER NOT NULL,
        task_version INTEGER NOT NULL,
        evidence_hash TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        score INTEGER NOT NULL,
        level TEXT NOT NULL,
        reasons TEXT NOT NULL,
        requirements TEXT NOT NULL,
        created_at TEXT NOT NULL,
        invalidated_at TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
        agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
        assessment_id TEXT NOT NULL REFERENCES complexity_assessments(id) ON DELETE CASCADE,
        recommendation TEXT NOT NULL,
        choice TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NULL,
        human_approved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        expires_at TEXT NULL
      );

      -- The per-project allowlist of commands DevTeam may run to verify a reported check. Empty
      -- means verification is off for the project and every check stays agent-asserted. Rows are a
      -- pinned snapshot, never a live read of package.json: see the note in checks.mjs.
      CREATE TABLE IF NOT EXISTS project_check_commands (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        argv TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, name)
      );

      -- What a report actually claimed, and what DevTeam found when it looked.
      CREATE TABLE IF NOT EXISTS assignment_checks (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        label TEXT NOT NULL,
        requested_command TEXT NULL,
        command TEXT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        exit_code INTEGER NULL,
        duration_ms INTEGER NULL,
        output TEXT NULL,
        created_at TEXT NOT NULL,
        superseded_at TEXT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assignment_checks ON assignment_checks(assignment_id, created_at);

      -- What a reviewer wants changed, attached to the assignment it wants changed. Kept as rows
      -- rather than prose in an event so the author is handed the list when it re-claims the work,
      -- the card can show what is outstanding, and a later pass can tell resolved from outstanding.
      CREATE TABLE IF NOT EXISTS assignment_findings (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        requested_by_agent_id TEXT NULL,
        requested_by_name TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        detail TEXT NOT NULL,
        path TEXT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT NULL,
        resolved_by_assignment_id TEXT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assignment_findings ON assignment_findings(assignment_id, created_at);

      -- What each verified check last did, per task. Keyed by the *command* rather than the label,
      -- because a label is agent-written prose and the argv is the pinned allowlist entry — two
      -- agents describing the same suite differently must still compare against the same baseline.
      -- Only verified results are ever recorded here: an agent's assertion proves nothing and must
      -- not be able to establish, or quietly repair, a baseline.
      CREATE TABLE IF NOT EXISTS check_baselines (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        command_key TEXT NOT NULL,
        status TEXT NOT NULL,
        label TEXT,
        assignment_id TEXT,
        task_version INTEGER NOT NULL DEFAULT 1,
        last_passed_at TEXT,
        last_passed_assignment_id TEXT,
        -- The event id the timeline had reached when this check was last green. Attribution walks
        -- forward from here by *id* rather than by timestamp: several events routinely share a
        -- millisecond, and an ISO comparison then silently drops a suspect, turning an ambiguous
        -- attribution into a confident and wrong one.
        last_passed_event_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (task_id, command_key)
      );

      -- A check that used to pass and now does not, with who is suspected and what was done about it.
      CREATE TABLE IF NOT EXISTS check_regressions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        command_key TEXT NOT NULL,
        label TEXT,
        detected_by_assignment_id TEXT,
        last_passed_assignment_id TEXT,
        suspects TEXT NOT NULL,
        fix_assignment_id TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_check_regressions_task ON check_regressions(task_id, created_at DESC);

      -- T4.2: what an assignment cost, as the agent reported it. Agent-asserted by nature — DevTeam
      -- cannot observe another process's token use — and labeled that way everywhere it surfaces.
      CREATE TABLE IF NOT EXISTS assignment_usage (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        assignment_id TEXT,
        agent_id TEXT,
        agent_name TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_cents INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assignment_usage_task ON assignment_usage(task_id, created_at DESC);

      -- T0.4: work that outlives the call which started it.
      --
      -- Verified checks run off the event loop, so a report can be minutes in flight. Before this
      -- the only trace was assignments.verifying_at, which startup cleared — so a crash mid-suite
      -- left a record claiming nothing had ever been running. That is the one thing a coordination
      -- server must not do: forget that it was part-way through something.
      --
      -- This is deliberately a *record*, not a queue. Nothing here is ever picked back up: re-running
      -- a suite after a restart would run it against a working tree that has moved on, under a claim
      -- that may now belong to somebody else. Recovery closes the row, says so on the timeline, and
      -- leaves the decision to report again with the agent that still holds the claim.
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,                    -- 'verified_checks' today; the column is the seam
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        assignment_id TEXT,
        agent_id TEXT,
        state TEXT NOT NULL,                   -- 'running' | 'finished' | 'interrupted'
        detail TEXT,                           -- JSON: what it was running, for the timeline
        instance_id TEXT NOT NULL,             -- which server process started it
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT
      );
      -- T4.1: named, revocable credentials. Only the hash is kept, so this table is a list of who
      -- may connect, never a list of live secrets. The shared token in the metadata table still
      -- works for the single-user localhost case it was designed for.
      CREATE TABLE IF NOT EXISTS access_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_jobs_running ON jobs(state, started_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
      CREATE INDEX IF NOT EXISTS idx_assignments_queue ON assignments(status, target_agent_name, created_at);
      CREATE INDEX IF NOT EXISTS idx_assignments_task_status ON assignments(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(type, created_at);
      CREATE INDEX IF NOT EXISTS idx_agents_status_seen ON agents(status, last_seen);
      CREATE INDEX IF NOT EXISTS idx_receipts_agent ON message_receipts(agent_id, delivered_at, seen_at);
      CREATE INDEX IF NOT EXISTS idx_proposals_task_status ON proposals(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_task_members_agent ON task_members(agent_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_task_status
        ON session_checkpoints(task_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_assignment_status
        ON session_checkpoints(assignment_id, status, checkpoint_generation DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_profiles_expiry ON agent_runtime_profiles(expires_at);
      CREATE INDEX IF NOT EXISTS idx_complexity_assignment ON complexity_assessments(assignment_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_decisions_gate ON runtime_decisions(assignment_id, agent_id, created_at DESC);
      PRAGMA optimize;
    `);
    // Additive columns for databases created before consensus snapshots/quorum/timeout existed.
    for (const [table, column, ddl] of [
      ["proposals", "required_ratio", "REAL NOT NULL DEFAULT 1"],
      ["proposals", "escalated_at", "TEXT"],
      ["agents", "resume_token_hash", "TEXT"],  // hashed at rest; the raw token is returned once at connect
      ["agents", "message_floor", "TEXT"],       // on resume, replay messages back to the original session's start
      ["assignments", "claim_generation", "INTEGER NOT NULL DEFAULT 0"], // bumped every (re)claim, for lease fencing
      ["assignments", "claim_token_hash", "TEXT"],                        // hashed fencing token for the live claim
      ["assignments", "assignment_version", "INTEGER NOT NULL DEFAULT 1"],
      ["assignments", "complexity_override", "TEXT"],
      ["tasks", "session_policy", "TEXT NOT NULL DEFAULT 'manual'"],
      ["tasks", "session_policy_version", "INTEGER NOT NULL DEFAULT 1"],
      ["tasks", "base_runtime_profile", "TEXT"],
      ["agents", "session_generation", "INTEGER NOT NULL DEFAULT 1"],
      ["agents", "fresh_task_id", "TEXT"],
      ["agents", "replaced_by_agent_id", "TEXT"],
      ["agents", "session_policy_ack_task_id", "TEXT"],
      // What this session reports it is running right now. Free text in the agent's own words: it is
      // the one party that actually knows, and DevTeam compares it only against that provider's own
      // reported ladder, never across vendors.
      ["agents", "current_model", "TEXT"],
      ["agents", "current_effort", "TEXT"],
      ["events", "author_name", "TEXT"],                                   // who wrote it, kept even after the agent row is purged
      ["events", "author_kind", "TEXT"],
      ["projects", "check_sandbox", "INTEGER NOT NULL DEFAULT 0"],       // confine node checks to the project root
      ["assignment_checks", "superseded_at", "TEXT"],           // only the latest report attempt describes the work as it stands                                   // 'human' or 'agent', so authorship never depends on a nullable FK
      ["assignments", "verifying_at", "TEXT"],                  // set while DevTeam is running this report's checks off the event loop
      ["assignments", "rework_count", "INTEGER NOT NULL DEFAULT 0"], // how many times a reviewer has sent this work back
      ["assignments", "rework_requested_at", "TEXT"],           // set while it is queued *as rework*; cleared when reported again
      ["assignments", "rework_summary", "TEXT"],                // why it went back, handed to the author on re-claim
      // Role behaviour, resolved from the project's role config when the assignment is created. The
      // scheduler keys off these rather than off role *names*, so a project can call its reviewing
      // role `fact-checker` without a single name reaching any SQL. See roles.mjs.
      ["assignments", "verifies", "INTEGER NOT NULL DEFAULT 0"],
      ["assignments", "plans", "INTEGER NOT NULL DEFAULT 0"],
      // T2.4: whether this approval came from someone other than the version's author, recorded on
      // the row rather than recomputed, so the record cannot drift as agents come and go.
      ["approvals", "independent", "INTEGER NOT NULL DEFAULT 1"],
      ["approvals", "verified_evidence", "INTEGER NOT NULL DEFAULT 0"],
      // T2.6: human steering. Priority orders the queue; the cancel flag is read cooperatively by
      // the holder.
      ["assignments", "priority", "INTEGER NOT NULL DEFAULT 0"],
      ["assignments", "cancel_requested_at", "TEXT"],
      ["assignments", "cancel_reason", "TEXT"],
    ]) {
      try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); } catch { /* already present */ }
    }
    // Rows written before role behaviour was a column carry the software role names that used to be
    // hardcoded. Backfill them from exactly those names, once, so an existing database schedules
    // identically after the upgrade. Guarded by a metadata key rather than repeated on every start:
    // re-deriving these from config each boot would silently rewrite the snapshot an assignment was
    // created under whenever a project edited its roles.
    if (!this.db.prepare("SELECT value FROM metadata WHERE key = 'role_behaviour_backfilled'").get()) {
      this.db.exec(`
        UPDATE assignments SET verifies = 1
          WHERE lower(role) IN ('reviewer', 'security-reviewer', 'tester');
        UPDATE assignments SET plans = 1 WHERE lower(role) = 'planner';
      `);
      this.db.prepare("INSERT INTO metadata (key, value) VALUES ('role_behaviour_backfilled', ?)").run(now());
    }
    // One agent may hold at most one claimed assignment at a time. Self-heal any legacy
    // double-claims (keep the earliest) before enforcing it at the schema level, so the
    // unique index can be created even on a database that predates this rule.
    // T0.3 — one *write* claim per agent, not one claim. The invariant that matters is about write
    // leases: two agents must never hold overlapping write scopes, and one agent holding two write
    // leases is how it hoards them. Read-only work — review, testing, research — takes no lease at
    // all, so capping it bought nothing and cost real throughput on exactly the review-heavy
    // workflows this server exists for.
    //
    // The old index (any claim) is dropped in favour of one scoped to writers. Legacy double-*write*
    // claims are healed first, exactly as before, so the narrower index can be created on a database
    // that predates the rule.
    this.db.exec(`
      DROP INDEX IF EXISTS idx_one_claim_per_agent;
      UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL
      WHERE status = 'claimed' AND requires_write = 1 AND agent_id IS NOT NULL AND rowid NOT IN (
        SELECT MIN(rowid) FROM assignments
        WHERE status = 'claimed' AND requires_write = 1 AND agent_id IS NOT NULL GROUP BY agent_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_write_claim_per_agent
        ON assignments(agent_id) WHERE status = 'claimed' AND requires_write = 1 AND agent_id IS NOT NULL;
    `);
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

  // Authorship is denormalized onto the row at write time. agent_id is a nullable foreign key that
  // gets cleared when an agent is purged from the roster, so it cannot be the record of who spoke:
  // relying on it silently reattributed every purged agent's message to the human.
  #event(taskId, agentId, type, message, metadata = {}) {
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

  #changed(type, taskId = null) {
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

  #syncTaskStatus(taskId, stamp = now()) {
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
    for (const task of taskIds) this.#syncTaskStatus(task.id, stamp);
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
    const forgetBefore = new Date(Date.now() - this.liveness.forgetMs).toISOString();
    const stamp = now();
    const affectedTasks = new Set();
    let presenceChanged = false;
    let purged = false;
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
        this.db.prepare("UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE id = ?").run(row.id);
        this.#event(row.task_id, null, "assignment.released", `${row.agent_name}'s read-only assignment was recovered after a long silence.`, { assignmentId: row.id, reason: "stale-readonly-recovery" });
        this.#syncTaskStatus(row.task_id, stamp);
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
    for (const taskId of affectedTasks) this.#changed("assignment.released", taskId);
    if (presenceChanged || purged) this.#changed("agent.disconnected");
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
        UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL
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
    return this.teamActivity(this.#memberTaskIds(agentId));
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

  // Did this assignment read the work rather than change it? Asked of the assignment row rather than
  // of the role name recorded on the event, so a project that renamed its reviewing role still earns
  // approval standing, and a role renamed *after* the fact cannot retroactively grant it.
  #assignmentVerifies(assignmentId) {
    if (!assignmentId) return false;
    return Boolean(this.db.prepare("SELECT verifies FROM assignments WHERE id = ?").get(assignmentId)?.verifies);
  }

  #resolveChecklist(projectId, role, provided) {
    if (Array.isArray(provided)) return provided.map((item) => String(item).trim()).filter(Boolean).slice(0, 40);
    const checklist = this.roleBehaviour(projectId, role).checklist;
    return checklist.length ? checklist : null;
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
    if (["accepted", "blocked", "cancelled"].includes(task.status)) throw new Error(this.closedTaskError(task, "open a proposal on it"));
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
          this.#cancelReadyCheckpointsForAssignment(assignment.id);
          this.db.prepare("UPDATE assignments SET target_agent_name = ?, status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE id = ?").run(target, assignment.id);
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
    this.#changed("project.updated");
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  }

  // A base runtime profile is human-entered. Reject a value that claims to be a full runtime
  // profile but cannot normalize, so an unusable note is refused at the point the human can still
  // fix it rather than silently ignored later by the gate. A bare {modelClass, effortClass} hint
  // stays accepted: the session-handoff capsule has always read that shorter shape.
  #validatedBaseRuntimeProfile(value) {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Base runtime profile must be an object or null.");
    if (value.providerId || value.availableModels || value.currentModel) {
      normalizeRuntimeProfile({ ...value, source: "user" });
    }
    return value;
  }

  createTask({ projectId, title, description, requiredApprovals = 2, sessionPolicy = "per_task", baseRuntimeProfile = null }) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    const taskId = randomUUID();
    const plannerAssignmentId = randomUUID();
    const stamp = now();
    const approvals = Math.max(1, Math.min(8, Number(requiredApprovals) || 2));
    const planningRoleName = this.planningRoleFor(projectId);
    this.#transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, status, version, required_approvals,
          session_policy, session_policy_version, base_runtime_profile, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'planning', 1, ?, ?, 1, ?, ?, ?)
      `).run(taskId, projectId, title.trim(), description.trim(), approvals,
        ["manual", "per_task", "adaptive", "per_assignment"].includes(sessionPolicy) ? sessionPolicy : "per_task",
        baseRuntimeProfile ? json(this.#validatedBaseRuntimeProfile(baseRuntimeProfile)) : null, stamp, stamp);
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, status, created_at, plans)
        VALUES (?, ?, ?, ?, ?, 0, 'queued', ?, 1)
      `).run(plannerAssignmentId, taskId, "Create the implementation plan", "Inspect the project, propose a concrete plan, then assign implementation and review work to the team.", planningRoleName, stamp);
      this.#event(taskId, null, "task.created", `Task created: ${title.trim()}`, { projectId, requiredApprovals: approvals });
    });
    this.assignmentAssessment({ assignmentId: plannerAssignmentId });
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
  updateTask(taskId, { title = undefined, description = undefined, requiredApprovals = undefined, sessionPolicy = undefined, baseRuntimeProfile = undefined } = {}) {
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
    const nextBaseProfile = baseRuntimeProfile === undefined ? task.base_runtime_profile : (baseRuntimeProfile == null ? null : json(this.#validatedBaseRuntimeProfile(baseRuntimeProfile)));
    if (nextTitle === task.title && nextDescription === task.description && nextApprovals === task.required_approvals
      && nextPolicy === task.session_policy && nextBaseProfile === task.base_runtime_profile) {
      return this.getTask(taskId);
    }
    const changed = [
      nextTitle !== task.title ? "title" : null,
      nextDescription !== task.description ? "description" : null,
      nextApprovals !== task.required_approvals ? "approvals" : null,
      nextPolicy !== task.session_policy ? "session policy" : null,
      nextBaseProfile !== task.base_runtime_profile ? "base runtime profile" : null,
    ].filter(Boolean);
    const stamp = now();
    this.#transaction(() => {
      this.db.prepare(`UPDATE tasks SET title = ?, description = ?, required_approvals = ?, session_policy = ?,
        session_policy_version = session_policy_version + ?, base_runtime_profile = ?, updated_at = ? WHERE id = ?`)
        .run(nextTitle, nextDescription, nextApprovals, nextPolicy, nextPolicy === task.session_policy ? 0 : 1, nextBaseProfile, stamp, taskId);
      this.#event(taskId, null, "task.updated", `Task details edited (${changed.join(", ")}).`, { changed, requiredApprovals: nextApprovals, sessionPolicy: nextPolicy });
    });
    this.#changed("task.updated", taskId);
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
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE agents SET current_task_id = NULL
        WHERE current_task_id IN (SELECT id FROM tasks WHERE project_id = ?)
      `).run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    for (const deletedTaskId of deletedTaskIds) this.briefHealth.delete(deletedTaskId);
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
    this.briefHealth.delete(taskId);
    try {
      this.knowledge.exportProject(task.project_id);
      this.knowledgeErrors.delete(`project:${task.project_id}`);
    } catch (error) {
      this.knowledgeErrors.set(`project:${task.project_id}`, { message: error.message, at: now() });
    }
    this.#changed("task.deleted", taskId);
    return { deleted: true, taskId, title: task.title, filesDeleted: false };
  }

  #hashToken(token) {
    return createHash("sha256").update(String(token)).digest("hex");
  }

  #tokenHashMatches(token, expectedHash) {
    if (!expectedHash || !token) return false;
    const actual = Buffer.from(this.#hashToken(token), "hex");
    const expected = Buffer.from(String(expectedHash), "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // The repository's current HEAD, used as a drift fingerprint on session checkpoints. Bounded at
  // two seconds and asynchronous for the same reason verified checks are: this server is one
  // process, and a git probe that blocked it stalled every other agent's MCP call, the dashboard,
  // SSE and the heartbeats that decide who still holds a write lease. A project that is not a git
  // repository (or has no commits) simply has no fingerprint — that is a supported state, not an
  // error, so every failure path answers null rather than throwing.
  #repositoryHead(projectRoot) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn("git", ["-C", projectRoot, "rev-parse", "HEAD"], { windowsHide: true, shell: false });
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { child.kill("SIGKILL"); settle(null); }, 2_000);
      child.stdout?.on("data", (chunk) => { if (out.length < 200) out += chunk.toString("utf8"); });
      child.on("error", () => settle(null));
      child.on("close", (code) => {
        const head = code === 0 ? out.trim() : "";
        settle(/^[0-9a-f]{40,64}$/i.test(head) ? head.toLowerCase() : null);
      });
    });
  }

  // T1.4 — git is optional, so drift detection cannot depend on it.
  //
  // A checkpoint's fingerprint is how a fresh session learns the workspace moved under it. That was
  // git HEAD plus the task version, which for a project that is not a repository — a research folder,
  // a manuscript, a data directory — collapses to the task version alone: nothing notices files
  // changing outside DevTeam's knowledge.
  //
  // The substitute is a bounded digest of the work's own scope: each file's project-relative path,
  // size and mtime. It is not a content hash and does not try to be — it answers "did this move
  // while I was away", which is exactly what a fingerprint is for, at a cost that stays flat on a
  // large tree because it walks the declared write scope rather than the project.
  #workspaceDigest(projectRoot, scopes) {
    if (!projectRoot) return null;
    const root = path.resolve(projectRoot);
    const parts = [];
    let seen = 0;
    const visit = (absolute, relative, depth) => {
      if (seen >= 400 || depth > 6) return;
      let info;
      try { info = statSync(absolute, { throwIfNoEntry: false }); } catch { return; }
      if (!info) return;
      if (info.isDirectory()) {
        let entries;
        try { entries = readdirSync(absolute, { withFileTypes: true }); } catch { return; }
        for (const entry of entries.slice(0, 200)) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          visit(path.join(absolute, entry.name), `${relative}/${entry.name}`, depth + 1);
        }
        return;
      }
      if (!info.isFile()) return;
      seen += 1;
      parts.push(`${relative}:${info.size}:${Math.trunc(info.mtimeMs)}`);
    };
    // An empty scope means the whole project; walking all of it would be unbounded, so that case
    // digests the project's top level only. A declared scope is the useful case and the common one.
    const targets = (Array.isArray(scopes) && scopes.length ? scopes : [""]).slice(0, 20);
    for (const scope of targets) {
      const relative = String(scope || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const absolute = relative ? path.resolve(root, relative) : root;
      if (absolute !== root && !absolute.startsWith(root + path.sep)) continue;
      visit(absolute, relative || ".", relative ? 0 : 5);
    }
    if (!parts.length) return null;
    return createHash("sha256").update(parts.sort().join("\n")).digest("hex").slice(0, 32);
  }

  // Whether this project is a git repository at all. Surfaced rather than inferred, so a non-repo
  // project reads as "git is not in play here" instead of "git said nothing".
  #isRepository(projectRoot) {
    if (!projectRoot) return false;
    try { return Boolean(statSync(path.join(projectRoot, ".git"), { throwIfNoEntry: false })); }
    catch { return false; }
  }

  #checkpointRecord(row, { includeCapsule = false } = {}) {
    if (!row) return null;
    const capsule = fromJson(row.capsule, {});
    return {
      id: row.id,
      taskId: row.task_id,
      assignmentId: row.assignment_id || null,
      fromAgentId: row.from_agent_id,
      fromAgentName: row.from_agent_name,
      taskVersion: Number(row.task_version),
      checkpointGeneration: Number(row.checkpoint_generation),
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedByAgentId: row.claimed_by_agent_id || null,
      claimedAt: row.claimed_at || null,
      capsuleMeta: capsule.capsuleMeta || null,
      nextAction: capsule.nextAction || null,
      repositoryFingerprint: capsule.repositoryFingerprint || null,
      ...(includeCapsule ? { capsule } : {}),
    };
  }

  #cancelReadyCheckpointsForAssignment(assignmentId) {
    if (!assignmentId) return 0;
    return this.db.prepare(`
      UPDATE session_checkpoints SET status = 'cancelled', handoff_token_hash = NULL
      WHERE assignment_id = ? AND status = 'ready'
    `).run(assignmentId).changes;
  }

  #cancelReadyCheckpointsForAgent(agentId) {
    if (!agentId) return 0;
    return this.db.prepare(`
      UPDATE session_checkpoints SET status = 'cancelled', handoff_token_hash = NULL
      WHERE from_agent_id = ? AND status = 'ready'
    `).run(agentId).changes;
  }

  #expireSessionCheckpoints() {
    const stamp = now();
    const expired = this.db.prepare(`
      SELECT id, task_id FROM session_checkpoints
      WHERE status = 'ready' AND expires_at <= ?
    `).all(stamp);
    if (!expired.length) return [];
    this.#transaction(() => {
      for (const checkpoint of expired) {
        this.db.prepare(`
          UPDATE session_checkpoints
          SET status = 'expired', handoff_token_hash = NULL
          WHERE id = ? AND status = 'ready'
        `).run(checkpoint.id);
        this.#event(checkpoint.task_id, null, "session.checkpoint_expired", "A session checkpoint expired without transferring ownership.", {
          checkpointId: checkpoint.id,
        });
      }
    });
    for (const taskId of new Set(expired.map((item) => item.task_id))) this.#changed("session.checkpoint_expired", taskId);
    return expired;
  }

  #checkpointInput(values, maxItems, maxBytes, counters, key) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => boundedCheckpointText(value, maxBytes, counters, key))
      .filter(Boolean))].slice(0, maxItems);
  }

  async createSessionCheckpoint({
    agentId,
    taskId,
    assignmentId = null,
    decisions = [],
    blockers = [],
    checks = [],
    failedApproaches = [],
    nextAction = "",
    expiresInMs = null,
  }) {
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("A disconnected session cannot create a checkpoint.");
    this.assertMembership(agentId, taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    let assignment = assignmentId
      ? this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId)
      : this.db.prepare("SELECT * FROM assignments WHERE task_id = ? AND agent_id = ? AND status = 'claimed' LIMIT 1").get(taskId, agentId);
    if (assignmentId && !assignment) throw new Error("The assignment does not belong to this task.");
    if (assignment && (assignment.status !== "claimed" || assignment.agent_id !== agentId)) {
      throw new Error("Only the session that owns an active assignment may checkpoint that claim.");
    }
    const counters = { clipped: {}, redacted: 0 };
    const safe = (value, bytes, key) => boundedCheckpointText(value, bytes, counters, key);
    const supplied = {
      decisions: this.#checkpointInput(decisions, 30, 800, counters, "decisions"),
      blockers: this.#checkpointInput(blockers, 30, 800, counters, "blockers"),
      checks: this.#checkpointInput(checks, 50, 600, counters, "checks"),
      failedApproaches: this.#checkpointInput(failedApproaches, 30, 800, counters, "failedApproaches"),
    };
    const eventRows = this.db.prepare(`
      SELECT id, type, message, metadata, created_at FROM events
      WHERE task_id = ? ORDER BY id DESC LIMIT 200
    `).all(taskId).map((event) => ({ ...event, metadata: fromJson(event.metadata, {}) }));
    const automaticDecisions = eventRows
      .filter((event) => ["agent.decision", "proposal.adopted"].includes(event.type))
      .map((event) => safe(event.message, 800, "automaticDecisions"));
    const repliedTo = new Set(eventRows.map((event) => Number(event.metadata?.replyTo || 0)).filter(Boolean));
    const unresolvedQuestions = eventRows
      .filter((event) => event.type === "agent.question" && !repliedTo.has(event.id))
      .map((event) => safe(event.message, 800, "unresolvedQuestions"));
    const reports = eventRows.filter((event) => ["assignment.completed", "assignment.blocked"].includes(event.type));
    const changedFiles = reports.flatMap((event) => Array.isArray(event.metadata.changedFiles) ? event.metadata.changedFiles : [])
      .map((file) => safe(file, 400, "changedFiles"));
    const automaticChecks = reports.flatMap((event) => Array.isArray(event.metadata.checks) ? event.metadata.checks : [])
      .map((check) => safe(check, 600, "automaticChecks"));
    const automaticBlockers = eventRows
      .filter((event) => ["assignment.blocked", "task.blocked"].includes(event.type))
      .map((event) => safe(event.message, 800, "automaticBlockers"));
    const memoryKeys = [
      ...this.db.prepare("SELECT key FROM blackboard WHERE task_id = ? ORDER BY key ASC LIMIT 100").all(taskId)
        .map((row) => ({ scope: "task", key: safe(row.key, 240, "taskMemoryKeys") })),
      ...this.db.prepare("SELECT key FROM project_blackboard WHERE project_id = ? ORDER BY key ASC LIMIT 100").all(task.project_id)
        .map((row) => ({ scope: "project", key: safe(row.key, 240, "projectMemoryKeys") })),
    ];
    let codeContext = [];
    try { codeContext = this.codegraph.enabled ? this.codegraph.codeContext(taskId, { assignmentId: assignment?.id || null, maxBytes: 4_096 }) : []; }
    catch { codeContext = []; }
    const codePaths = [...new Set(codeContext.flatMap((module) => [module.path, ...(module.imports || []), ...(module.importedBy || [])])
      .map((file) => safe(file, 400, "codePaths")))];
    const knowledge = this.knowledge.relevant(task.project_id, taskId, 20, {
      taskTitle: task.title,
      taskDescription: task.description,
      taskVersion: task.version,
      assignmentTitle: assignment?.title,
      assignmentDescription: assignment?.description,
      role: assignment?.role,
      declaredPaths: assignment?.requires_write ? this.#writeScopeFor(assignment.id) : [],
      codePaths,
    }).map((note) => ({
      id: note.id,
      title: safe(note.title, 360, "knowledgeTitles"),
      status: note.status,
      whyIncluded: safe(note.whyIncluded, 300, "knowledgeReasons"),
      relatedFiles: (note.relatedFiles || []).slice(0, 12).map((file) => safe(file, 300, "knowledgePaths")),
    }));
    const dependencies = assignment ? this.#dependenciesFor(assignment.id) : [];
    const derivedNextAction = nextAction || (assignment
      ? `Continue ${assignment.title}: ${assignment.description}`
      : `Inspect the task state and continue toward: ${task.title}`);
    const ttl = expiresInMs == null
      ? Math.max(1, Number(this.checkpoint.ttlMs) || 30 * 60 * 1000)
      : Math.min(Math.max(60_000, Number(expiresInMs) || 0), Math.max(60_000, Number(this.checkpoint.maxTtlMs) || 24 * 60 * 60 * 1000));
    const checkpointId = randomUUID();
    const handoffToken = randomBytes(24).toString("base64url");
    const stamp = now();
    const expiresAt = new Date(Date.parse(stamp) + ttl).toISOString();
    const repositoryHead = await this.#repositoryHead(task.project_root);
    const runtimeProfile = this.runtimeProfile(agentId);
    const runtimeAssessment = assignment ? this.assignmentAssessment({ assignmentId: assignment.id }) : null;
    const runtimeResolution = runtimeAssessment && runtimeProfile
      ? resolveRuntimeRequirement(runtimeAssessment.requirements, runtimeProfile)
      : null;
    const compactRuntimeProfile = runtimeProfile ? {
      schemaVersion: Number(runtimeProfile.schemaVersion) || 1,
      providerId: safe(runtimeProfile.providerId, 120, "runtimeProviderId"),
      currentModel: runtimeProfile.currentModel ? safe(runtimeProfile.currentModel, 160, "runtimeModel") : null,
      currentEffort: runtimeProfile.currentEffort ? safe(runtimeProfile.currentEffort, 120, "runtimeEffort") : null,
      currentModelClass: runtimeProfile.currentModelClass,
      currentEffortClass: runtimeProfile.currentEffortClass,
      switchMode: runtimeProfile.switchMode,
      source: runtimeProfile.source,
      observedAt: runtimeProfile.observedAt,
      expiresAt: runtimeProfile.expiresAt,
      stale: Boolean(runtimeProfile.stale),
      validationIssues: (runtimeProfile.validationIssues || []).slice(0, 10),
    } : null;
    const advertisedRecommendation = runtimeResolution?.recommendation ? {
      modelId: safe(runtimeResolution.recommendation.modelId, 160, "recommendedModel"),
      modelLabel: safe(runtimeResolution.recommendation.modelLabel, 200, "recommendedModelLabel"),
      modelClass: runtimeResolution.recommendation.modelClass,
      effortId: safe(runtimeResolution.recommendation.effortId, 120, "recommendedEffort"),
      effortLabel: safe(runtimeResolution.recommendation.effortLabel, 160, "recommendedEffortLabel"),
      effortClass: runtimeResolution.recommendation.effortClass,
    } : null;
    const baseRuntimeProfile = fromJson(task.base_runtime_profile, null);
    const nextSessionRecommendation = runtimeAssessment ? {
      assessmentId: runtimeAssessment.id,
      level: runtimeAssessment.level,
      requirements: runtimeAssessment.requirements,
      satisfied: Boolean(runtimeResolution?.satisfied),
      selection: advertisedRecommendation,
      reason: runtimeResolution?.reason || "No authoritative runtime profile is available; confirm settings in the fresh session.",
    } : (baseRuntimeProfile && typeof baseRuntimeProfile === "object" ? {
      level: "task_base",
      requirements: {
        modelClass: safe(baseRuntimeProfile.modelClass || "unknown", 80, "baseRuntimeModelClass"),
        effortClass: safe(baseRuntimeProfile.effortClass || "unknown", 80, "baseRuntimeEffortClass"),
      },
      satisfied: false,
      selection: null,
      reason: "Confirm the task's base runtime preference against the fresh session's advertised capabilities.",
    } : null);
    let checkpointRow;
    this.#transaction(() => {
      const liveTask = this.getTask(taskId);
      if (!liveTask) throw new Error("Task not found.");
      if (assignment) {
        const liveAssignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignment.id);
        if (!liveAssignment || liveAssignment.status !== "claimed" || liveAssignment.agent_id !== agentId
          || liveAssignment.claim_generation !== assignment.claim_generation) {
          throw new Error("The assignment claim changed while the checkpoint was being created. Re-read the task and try again.");
        }
        assignment = liveAssignment;
      }
      const generation = Number(this.db.prepare(`
        SELECT COALESCE(MAX(checkpoint_generation), 0) + 1 AS generation
        FROM session_checkpoints WHERE task_id = ?
      `).get(taskId).generation);
      const capsule = buildCheckpointCapsule({
        limitBytes: this.checkpoint.capsuleBytes,
        counters,
        core: {
          schemaVersion: 1,
          checkpoint: { id: checkpointId, generation, fromAgent: { id: agent.id, name: safe(agent.name, 200, "agentName") } },
          task: {
            id: task.id,
            title: safe(task.title, 500, "taskTitle"),
            goal: safe(task.description, 1_600, "taskGoal"),
            status: task.status,
            version: Number(task.version),
            project: {
              id: task.project_id,
              name: safe(task.project_name, 300, "projectName"),
              root: safe(task.project_root, 1_200, "projectRoot"),
            },
          },
          assignment: assignment ? {
            id: assignment.id,
            title: safe(assignment.title, 500, "assignmentTitle"),
            description: safe(assignment.description, 1_200, "assignmentDescription"),
            role: safe(assignment.role, 100, "assignmentRole"),
            requiresWrite: Boolean(assignment.requires_write),
            writeScope: (assignment.requires_write ? this.#writeScopeFor(assignment.id) : []).slice(0, 30).map((item) => safe(item, 300, "writeScope")),
            checklist: this.#checklistFor(assignment.id).slice(0, 30).map((item) => safe(item, 300, "checklist")),
            dependsOn: dependencies.slice(0, 30).map((item) => ({ id: item.id, title: safe(item.title, 300, "dependencyTitles"), status: item.status })),
            claimGeneration: Number(assignment.claim_generation),
          } : null,
          nextAction: safe(derivedNextAction, 1_200, "nextAction"),
          currentRuntime: { provider: safe(agent.provider, 200, "agentProvider"), profile: compactRuntimeProfile },
          nextSessionRecommendation,
          repositoryFingerprint: {
            taskVersion: Number(task.version),
            gitHead: repositoryHead,
            // Git is optional. Without it the fingerprint would be the task version alone, so a
            // scope digest carries the same signal for a project that is not a repository.
            isRepository: this.#isRepository(task.project_root),
            workspaceDigest: this.#workspaceDigest(task.project_root, assignment ? this.#writeScopeFor(assignment.id) : []),
          },
        },
        sections: [
          { key: "decisions", items: [...supplied.decisions, ...automaticDecisions], maxItems: 30 },
          { key: "unresolvedQuestions", items: unresolvedQuestions, maxItems: 20 },
          { key: "changedFiles", items: [...new Set(changedFiles)], maxItems: 100 },
          { key: "checks", items: [...supplied.checks, ...automaticChecks], maxItems: 60 },
          { key: "blockers", items: [...supplied.blockers, ...automaticBlockers], maxItems: 30 },
          { key: "failedApproaches", items: supplied.failedApproaches, maxItems: 30 },
          { key: "memoryKeys", items: memoryKeys, maxItems: 60 },
          { key: "knowledge", items: knowledge, maxItems: 12 },
          { key: "codePaths", items: codePaths, maxItems: 40 },
        ],
      });
      this.db.prepare(`
        UPDATE session_checkpoints
        SET status = 'cancelled', handoff_token_hash = NULL
        WHERE task_id = ? AND from_agent_id = ? AND status = 'ready'
      `).run(taskId, agentId);
      this.db.prepare(`
        INSERT INTO session_checkpoints (
          id, task_id, assignment_id, from_agent_id, from_agent_name, task_version,
          checkpoint_generation, capsule, status, handoff_token_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
      `).run(
        checkpointId, taskId, assignment?.id || null, agentId, agent.name, task.version,
        generation, json(capsule), this.#hashToken(handoffToken), stamp, expiresAt,
      );
      this.#event(taskId, agentId, "session.checkpoint_created", `${agent.name} created a bounded session checkpoint.`, {
        checkpointId,
        assignmentId: assignment?.id || null,
        checkpointGeneration: generation,
        taskVersion: Number(task.version),
        capsuleBytes: capsule.capsuleMeta.bytes,
        expiresAt,
      });
      this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(stamp, agentId);
      checkpointRow = this.db.prepare("SELECT * FROM session_checkpoints WHERE id = ?").get(checkpointId);
    });
    this.#changed("session.checkpoint_created", taskId);
    return { checkpoint: this.#checkpointRecord(checkpointRow, { includeCapsule: true }), handoffToken };
  }

  sessionCheckpointsForTask(taskId, { limit = 20 } = {}) {
    if (!this.getTask(taskId)) throw new Error("Task not found.");
    this.#expireSessionCheckpoints();
    return this.db.prepare(`
      SELECT * FROM session_checkpoints WHERE task_id = ?
      ORDER BY checkpoint_generation DESC LIMIT ?
    `).all(taskId, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((row) => this.#checkpointRecord(row));
  }

  sessionCheckpointGet({ agentId = null, taskId, checkpointId }) {
    if (agentId) {
      this.getAgent(agentId);
      this.assertMembership(agentId, taskId);
    }
    this.#expireSessionCheckpoints();
    const row = this.db.prepare("SELECT * FROM session_checkpoints WHERE id = ? AND task_id = ?").get(checkpointId, taskId);
    if (!row) throw new Error("Session checkpoint not found for this task.");
    return this.#checkpointRecord(row, { includeCapsule: true });
  }

  cancelSessionCheckpoint({ agentId = null, taskId, checkpointId, reason = "Session rotation cancelled." }) {
    if (agentId) {
      this.getAgent(agentId);
      this.assertMembership(agentId, taskId);
    }
    const row = this.db.prepare("SELECT * FROM session_checkpoints WHERE id = ? AND task_id = ?").get(checkpointId, taskId);
    if (!row) throw new Error("Session checkpoint not found for this task.");
    if (agentId && row.from_agent_id !== agentId) throw new Error("Only the checkpointing session may cancel its handoff.");
    if (row.status !== "ready") throw new Error(`Only a ready checkpoint can be cancelled; this checkpoint is ${row.status}.`);
    const message = boundedCheckpointText(reason, 800);
    this.#transaction(() => {
      this.db.prepare(`
        UPDATE session_checkpoints SET status = 'cancelled', handoff_token_hash = NULL
        WHERE id = ? AND status = 'ready'
      `).run(checkpointId);
      this.#event(taskId, agentId, "session.checkpoint_cancelled", message || "Session rotation cancelled.", { checkpointId });
    });
    this.#changed("session.checkpoint_cancelled", taskId);
    return this.#checkpointRecord(this.db.prepare("SELECT * FROM session_checkpoints WHERE id = ?").get(checkpointId));
  }

  async takeoverSessionCheckpoint({ agentId, taskId, checkpointId, handoffToken }) {
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("A disconnected session cannot take over work.");
    this.assertMembership(agentId, taskId);
    if (!this.#claimableTaskIds(agentId).includes(taskId)) throw new Error("Observers cannot take over an assignment claim.");
    if (!handoffToken || !String(handoffToken).trim()) throw new Error("A handoff token is required.");
    const token = String(handoffToken).trim();
    const stamp = now();
    let outcome;
    this.#transaction(() => {
      const checkpoint = this.db.prepare("SELECT * FROM session_checkpoints WHERE id = ? AND task_id = ?").get(checkpointId, taskId);
      if (!checkpoint) {
        outcome = { error: "The checkpoint or handoff token is invalid for this task." };
        return;
      }
      if (checkpoint.status !== "ready") {
        outcome = { error: "This checkpoint is no longer ready. Handoff tokens are one-time and cannot be replayed." };
        return;
      }
      if (checkpoint.from_agent_id === agentId) {
        outcome = { error: "Session takeover requires a distinct fresh agent session. Use devteam_join with a resumeToken only when restoring the same conversation." };
        return;
      }
      if (checkpoint.expires_at <= stamp) {
        this.db.prepare("UPDATE session_checkpoints SET status = 'expired', handoff_token_hash = NULL WHERE id = ?").run(checkpoint.id);
        this.#event(taskId, null, "session.checkpoint_expired", "A session checkpoint expired without transferring ownership.", { checkpointId });
        outcome = { error: "This checkpoint has expired. The original claim was not transferred.", expired: true };
        return;
      }
      if (!this.#tokenHashMatches(token, checkpoint.handoff_token_hash)) {
        outcome = { error: "The checkpoint or handoff token is invalid for this task." };
        return;
      }
      const task = this.getTask(taskId);
      if (!task || ["accepted", "blocked", "cancelled"].includes(task.status)) {
        outcome = { error: "This task is not active, so its checkpoint cannot transfer ownership." };
        return;
      }
      const existingClaim = this.db.prepare("SELECT id FROM assignments WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(agentId);
      if (existingClaim) {
        outcome = { error: "Finish or release this fresh session's existing assignment before taking over another." };
        return;
      }
      const capsule = fromJson(checkpoint.capsule, {});
      const expectedClaimGeneration = Number(capsule.assignment?.claimGeneration ?? -1);
      const oldLiveClaim = this.db.prepare("SELECT id FROM assignments WHERE agent_id = ? AND status = 'claimed' LIMIT 1").get(checkpoint.from_agent_id);
      if ((checkpoint.assignment_id && oldLiveClaim && oldLiveClaim.id !== checkpoint.assignment_id)
        || (!checkpoint.assignment_id && oldLiveClaim)) {
        outcome = { error: "The original session moved to different work after this checkpoint. Create a new checkpoint." };
        return;
      }
      let assignmentResult = null;
      let claimToken = null;
      if (checkpoint.assignment_id) {
        const assignment = this.db.prepare(`
          SELECT a.*, t.project_id, p.root AS project_root
          FROM assignments a JOIN tasks t ON t.id = a.task_id JOIN projects p ON p.id = t.project_id
          WHERE a.id = ? AND a.task_id = ?
        `).get(checkpoint.assignment_id, taskId);
        const transferableLiveClaim = assignment?.status === "claimed"
          && assignment.agent_id === checkpoint.from_agent_id
          && Number(assignment.claim_generation) === expectedClaimGeneration;
        const recoverableReleasedClaim = assignment?.status === "queued"
          && assignment.agent_id == null
          && Number(assignment.claim_generation) === expectedClaimGeneration;
        if (!transferableLiveClaim && !recoverableReleasedClaim) {
          outcome = { error: "The checkpoint's assignment claim is stale or has moved. Ownership was not transferred." };
          return;
        }
        if (recoverableReleasedClaim && assignment.requires_write) {
          const scopes = this.#resolveScopesOnDisk(assignment.project_root, this.#writeScopeFor(assignment.id));
          const conflict = this.#heldWriteLeases().some((lease) => lease.id !== assignment.id
            && lease.projectId === assignment.project_id
            && lease.scopes.some((held) => scopes.some((wanted) => this.#scopesOverlap(held, wanted))));
          if (conflict) {
            outcome = { error: "The released assignment now conflicts with another active write lease. Ownership was not transferred." };
            return;
          }
        }
        claimToken = randomBytes(18).toString("base64url");
        this.db.prepare(`
          UPDATE assignments
          SET status = 'claimed', agent_id = ?, claimed_at = ?, claim_generation = claim_generation + 1,
              claim_token_hash = ?
          WHERE id = ?
        `).run(agentId, stamp, this.#hashToken(claimToken), assignment.id);
        const claimed = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignment.id);
        assignmentResult = {
          ...claimed,
          checklist: this.#checklistFor(claimed.id),
          writeScope: claimed.requires_write ? this.#writeScopeFor(claimed.id) : [],
          dependsOn: this.#dependenciesFor(claimed.id).map((item) => item.id),
          claimGeneration: Number(claimed.claim_generation),
          claimToken,
        };
      }
      this.db.prepare(`
        UPDATE session_checkpoints
        SET status = 'claimed', handoff_token_hash = NULL, claimed_by_agent_id = ?, claimed_at = ?
        WHERE id = ? AND status = 'ready'
      `).run(agentId, stamp, checkpoint.id);
      this.db.prepare(`
        UPDATE session_checkpoints
        SET status = 'cancelled', handoff_token_hash = NULL
        WHERE id != ? AND task_id = ? AND from_agent_id = ? AND status = 'ready'
      `).run(checkpoint.id, taskId, checkpoint.from_agent_id);
      this.db.prepare(`
        UPDATE agents SET status = ?, current_task_id = ?, last_seen = ?, disconnected_at = NULL WHERE id = ?
      `).run(assignmentResult ? "busy" : "waiting", assignmentResult ? taskId : null, stamp, agentId);
      this.db.prepare(`
        UPDATE agents
        SET status = 'disconnected', current_task_id = NULL, last_seen = ?, disconnected_at = ?, resume_token_hash = NULL
        WHERE id = ? AND id != ?
      `).run(stamp, stamp, checkpoint.from_agent_id, agentId);
      this.#event(taskId, agentId, "session.checkpoint_claimed", `${agent.name} safely took over a session checkpoint.`, {
        checkpointId: checkpoint.id,
        assignmentId: checkpoint.assignment_id || null,
        fromAgentId: checkpoint.from_agent_id,
        claimGeneration: assignmentResult?.claimGeneration || null,
      });
      this.#syncTaskStatus(taskId, stamp);
      outcome = {
        checkpoint: this.#checkpointRecord(this.db.prepare("SELECT * FROM session_checkpoints WHERE id = ?").get(checkpoint.id), { includeCapsule: true }),
        assignment: assignmentResult,
        oldSessionRetired: checkpoint.from_agent_id !== agentId,
        taskVersionNow: Number(task.version),
      };
    });
    if (outcome.expired) this.#changed("session.checkpoint_expired", taskId);
    if (outcome.error) throw new Error(outcome.error);
    const currentHead = await this.#repositoryHead(this.getTask(taskId).project_root);
    const fingerprint = outcome.checkpoint.capsule?.repositoryFingerprint || {};
    const warnings = [];
    if (Number(fingerprint.taskVersion) !== Number(outcome.taskVersionNow)) warnings.push("The task version changed since the checkpoint. Re-read the task and inspect the current files before writing.");
    if (fingerprint.gitHead && currentHead && fingerprint.gitHead !== currentHead) warnings.push("Git HEAD changed since the checkpoint. Inspect the repository diff before writing.");
    // A project with no git still gets a drift signal, from the digest of the work's own scope.
    const currentDigest = fingerprint.workspaceDigest
      ? this.#workspaceDigest(this.getTask(taskId).project_root, outcome.assignment?.id ? this.#writeScopeFor(outcome.assignment.id) : [])
      : null;
    if (fingerprint.workspaceDigest && currentDigest && fingerprint.workspaceDigest !== currentDigest) {
      warnings.push("Files in this assignment's scope changed since the checkpoint. Re-read them before writing.");
    }
    this.#changed("session.checkpoint_claimed", taskId);
    return {
      takenOver: true,
      taskId,
      ...outcome,
      repositoryFingerprintNow: { taskVersion: outcome.taskVersionNow, gitHead: currentHead, workspaceDigest: currentDigest },
      warnings,
      next: "Read the bounded capsule, verify the repository and task state, then continue under the newly issued claim token.",
    };
  }

  #runtimeProfileRecord(row) {
    if (!row) return null;
    const profile = fromJson(row.profile, null);
    try {
      const normalized = normalizeRuntimeProfile({
        ...profile,
        source: profile?.source || row.source,
        observedAt: profile?.observedAt || row.observed_at,
        expiresAt: profile?.expiresAt || row.expires_at,
      });
      return { ...normalized, stale: Date.parse(normalized.expiresAt) <= Date.now() };
    } catch {
      return {
        schemaVersion: Number(row.schema_version) || 0,
        providerId: "invalid-stored-profile",
        currentModel: null,
        currentEffort: null,
        currentModelClass: "unknown",
        currentEffortClass: "unknown",
        availableModels: [],
        switchMode: "unknown",
        source: "agent_estimate",
        confidence: 0,
        observedAt: row.observed_at,
        expiresAt: row.expires_at,
        stale: Date.parse(row.expires_at) <= Date.now(),
        validationIssues: ["stored_profile_invalid"],
      };
    }
  }

  runtimeProfile(agentId) {
    this.getAgent(agentId);
    return this.#runtimeProfileRecord(this.db.prepare("SELECT * FROM agent_runtime_profiles WHERE agent_id = ?").get(agentId));
  }

  updateRuntimeProfile({ agentId, profile, force = false }) {
    const agent = this.getAgent(agentId);
    if (agent.status === "disconnected") throw new Error("A disconnected session cannot update its runtime profile.");
    const normalized = normalizeRuntimeProfile(profile);
    const existing = this.runtimeProfile(agentId);
    if (!force && existing && !existing.stale && existing.confidence > normalized.confidence) {
      throw new Error(`A fresh ${existing.source} runtime profile outranks this ${normalized.source} update. Refresh it from the authoritative source or use an explicit human correction.`);
    }
    const stamp = now();
    this.db.prepare(`
      INSERT INTO agent_runtime_profiles (
        agent_id, profile, schema_version, source, confidence, observed_at, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        profile = excluded.profile, schema_version = excluded.schema_version, source = excluded.source,
        confidence = excluded.confidence, observed_at = excluded.observed_at,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `).run(agentId, json(normalized), normalized.schemaVersion, normalized.source, normalized.confidence,
      normalized.observedAt, normalized.expiresAt, stamp);
    const taskId = agent.current_task_id || this.#memberTaskIds(agentId)[0] || null;
    if (taskId) this.#event(taskId, agentId, "runtime.profile_updated", `${agent.name} updated its runtime profile from ${normalized.source}.`, {
      source: normalized.source, switchMode: normalized.switchMode, expiresAt: normalized.expiresAt,
      modelClass: normalized.currentModelClass, effortClass: normalized.currentEffortClass,
    });
    this.#changed("runtime.profile_updated", taskId);
    return normalized;
  }

  #dependencyDepth(assignmentId, seen = new Set()) {
    if (seen.has(assignmentId)) return 0;
    seen.add(assignmentId);
    const dependencies = this.#dependenciesFor(assignmentId);
    if (!dependencies.length) return 0;
    return 1 + Math.max(...dependencies.map((item) => this.#dependencyDepth(item.id, new Set(seen))));
  }

  #assessmentRecord(row) {
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
  // not one of them produced a word of advice, because model gating needs a registered profile and
  // there has never been one. So the brief says the quiet part: nobody is going to stop you, the
  // judgement is yours, and here is the one move that works.
  #assessmentForBrief(row, { gated = false } = {}) {
    const record = this.#assessmentRecord(row);
    if (!record) return null;
    const demanding = ["difficult", "critical", "recovery", "exceptional"].includes(record.level);
    return {
      level: record.level,
      score: record.score,
      reasons: (record.reasons || []).slice(0, 3).map((reason) => reason.detail || String(reason)),
      guidance: demanding && !gated
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
      paths: assignment.requires_write ? this.#writeScopeFor(assignment.id) : [],
      checklist: this.#checklistFor(assignment.id),
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
      && Number(current.assignment_version) === Number(assignment.assignment_version)) return this.#assessmentRecord(current);
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
    this.#event(assignment.task_id, agentId, "assignment.complexity_assessed", `Assessed “${assignment.title}” as ${assessed.level} (${assessed.score}).`, {
      assignmentId, assessmentId: id, score: assessed.score, level: assessed.level,
      requirements: assessed.requirements, invalidatedAssessmentId: current?.id || null,
    });
    this.emit("change", { type: "assignment.complexity_assessed", taskId: assignment.task_id, at: stamp });
    return this.#assessmentRecord(this.db.prepare("SELECT * FROM complexity_assessments WHERE id = ?").get(id));
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
    this.#changed("assignment.complexity_override", assignment.task_id);
    return assessment;
  }

  #runtimeDecisionRecord(row) {
    return row ? {
      id: row.id, taskId: row.task_id, assignmentId: row.assignment_id, agentId: row.agent_id,
      assessmentId: row.assessment_id, recommendation: fromJson(row.recommendation, null),
      choice: row.choice, actor: row.actor, reason: row.reason, humanApproved: Boolean(row.human_approved),
      createdAt: row.created_at, expiresAt: row.expires_at,
    } : null;
  }

  runtimeDecision({ agentId = null, assignmentId, assessmentId = null, choice, actor = null, reason = "", humanApproved = false }) {
    if (!["switched", "continue", "reassign", "cancel"].includes(choice)) throw new Error("Runtime choice must be switched, continue, reassign, or cancel.");
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ?").get(assignmentId);
    if (!assignment) throw new Error("Assignment not found.");
    if (agentId) { this.getAgent(agentId); this.assertMembership(agentId, assignment.task_id); }
    const assessment = this.assignmentAssessment({ agentId, assignmentId });
    if (assessmentId && assessment.id !== assessmentId) throw new Error("The assignment assessment changed. Review the current recommendation before deciding.");
    const profile = agentId ? this.runtimeProfile(agentId) : null;
    const resolution = resolveRuntimeRequirement(assessment.requirements, profile);
    if (choice === "switched" && !resolution.satisfied) throw new Error("The refreshed runtime profile still does not satisfy this assessment. Update the current host settings first or choose Continue anyway.");
    if (assessment.requirements.humanApprovalRequired && ["switched", "continue"].includes(choice) && !humanApproved) {
      throw new Error("Exceptional runtime settings require explicit human approval.");
    }
    const stamp = now();
    const expiresAt = ["reassign", "cancel"].includes(choice) ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null;
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO runtime_decisions (
        id, task_id, assignment_id, agent_id, assessment_id, recommendation, choice,
        actor, reason, human_approved, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, assignment.task_id, assignmentId, agentId, assessment.id, json(resolution), choice,
      String(actor || (agentId ? "agent" : "human")).trim().slice(0, 120), String(reason || "").trim().slice(0, 1000) || null,
      humanApproved ? 1 : 0, stamp, expiresAt);
    this.#event(assignment.task_id, agentId, "runtime.decision_recorded", `Runtime decision for “${assignment.title}”: ${choice}.`, {
      assignmentId, assessmentId: assessment.id, choice, actor: actor || (agentId ? "agent" : "human"), humanApproved: Boolean(humanApproved),
    });
    if (choice === "switched") this.#event(assignment.task_id, agentId, "runtime.switch_verified", `Runtime switch verified for “${assignment.title}”.`, { assignmentId, assessmentId: assessment.id });
    this.#changed("runtime.decision_recorded", assignment.task_id);
    return this.#runtimeDecisionRecord(this.db.prepare("SELECT * FROM runtime_decisions WHERE id = ?").get(id));
  }

  // A task's base runtime profile is the human's standing statement about the session they run
  // this task in ("I start these chats on Sonnet 5, medium effort"). It is always read back as a
  // `user` claim regardless of what was stored, so a saved note can never impersonate a host or
  // adapter observation and outrank a live session profile.
  #taskBaseRuntimeProfile(taskId) {
    const stored = fromJson(this.db.prepare("SELECT base_runtime_profile FROM tasks WHERE id = ?").get(taskId)?.base_runtime_profile, null);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
    try {
      const normalized = normalizeRuntimeProfile({ ...stored, source: "user" });
      return { ...normalized, stale: Date.parse(normalized.expiresAt) <= Date.now() };
    } catch {
      // A loose or malformed note is not evidence of anything; it must never gate work.
      return null;
    }
  }

  #runtimeGate(agent, candidate) {
    // Candidate selection already authorizes either contributor membership or an exact targeted
    // invitation. Assess without re-running the stricter room-membership check so a targeted agent
    // can pass the runtime gate before its membership is persisted by the eventual claim.
    const assessment = this.assignmentAssessment({ assignmentId: candidate.id });
    const agentProfile = this.runtimeProfile(agent.id);
    // Fall back to the task's standing profile only when the session itself advertises nothing.
    const baseProfile = agentProfile ? null : this.#taskBaseRuntimeProfile(candidate.task_id);
    const profile = agentProfile || baseProfile;
    const profileSource = agentProfile ? "agent" : baseProfile ? "task_base" : null;
    // Runtime profiles were added after DevTeam's original connect handshake. A session that did
    // not send one, on a task with no usable base profile, remains a legacy client and keeps the
    // old claim behavior; once a session opts into runtime discovery, stale/estimated/insufficient
    // data is always gated and never guessed.
    if (!profile) return { allowed: true, assessment, profile: null, resolution: null, legacyUnprofiled: true, profileSource: null };
    // A standing declaration that has aged out is not evidence about the current session — but it
    // must not stall the queue either. Aging out returns the agent to legacy behavior and asks the
    // dashboard for a refresh, rather than blocking every claim on a stale human note.
    if (baseProfile?.stale) {
      return { allowed: true, assessment, profile: null, resolution: null, legacyUnprofiled: true, profileSource: null, baseProfileStale: true };
    }
    const resolution = resolveRuntimeRequirement(assessment.requirements, profile);
    const decisionRow = this.db.prepare(`
      SELECT * FROM runtime_decisions
      WHERE assignment_id = ? AND assessment_id = ? AND (agent_id = ? OR agent_id IS NULL)
      ORDER BY created_at DESC LIMIT 1
    `).get(candidate.id, assessment.id, agent.id);
    const decision = this.#runtimeDecisionRecord(decisionRow);
    if (decision && ["reassign", "cancel"].includes(decision.choice)
      && (!decision.expiresAt || Date.parse(decision.expiresAt) > Date.now())) return { skip: true, decision };
    if (resolution.satisfied || decision?.choice === "continue") return { allowed: true, assessment, profile, resolution, decision, profileSource };
    const priorRecommendation = this.db.prepare(`
      SELECT id FROM events WHERE task_id = ? AND type = 'runtime.switch_recommended'
        AND json_extract(metadata, '$.assignmentId') = ? AND json_extract(metadata, '$.assessmentId') = ?
        AND json_extract(metadata, '$.agentId') = ? LIMIT 1
    `).get(candidate.task_id, candidate.id, assessment.id, agent.id);
    return {
      runtimeActionRequired: true,
      status: "runtime_action_required",
      taskId: candidate.task_id,
      assignment: { id: candidate.id, title: candidate.title, role: candidate.role, requiresWrite: Boolean(candidate.requires_write) },
      assessment,
      runtimeProfile: profile,
      profileSource,
      resolution,
      alreadyRecommended: Boolean(priorRecommendation),
      actions: ["switched", "continue", "reassign", "cancel"],
      advisory: profile?.switchMode !== "automatic",
      humanApprovalRequired: Boolean(assessment.requirements.humanApprovalRequired),
      leaseAcquired: false,
    };
  }

  connectAgent({ name, provider, capabilities = [], runtimeProfile = null, sessionGeneration = 1, freshTaskId = null, model = null, effort = null }) {
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
    this.#changed("agent.connected");
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
    if (runtimeProfile) this.updateRuntimeProfile({ agentId: id, profile: runtimeProfile });
    return { ...this.getAgent(id), runtimeProfile: this.runtimeProfile(id), room, resumeToken };
  }

  sessionRotationRecommendation(agentId) {
    const agent = this.getAgent(agentId);
    if (!this.runtimeProfile(agentId)) return null;
    const rooms = this.#claimableTaskIds(agentId);
    for (const taskId of rooms) {
      const task = this.getTask(taskId);
      if (!task || !["per_task", "adaptive", "per_assignment"].includes(task.session_policy)) continue;
      if (agent.fresh_task_id === taskId || agent.session_policy_ack_task_id === taskId) continue;
      const eligible = Number(this.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status = 'queued'").get(taskId).count);
      if (!eligible) continue;
      return {
        status: "session_rotation_recommended", taskId, sessionPolicy: task.session_policy,
        sessionGeneration: Number(agent.session_generation || 1),
        reason: task.session_policy === "per_assignment"
          ? "This experimental task policy recommends a fresh session for each assignment."
          : "This task uses a fresh-session policy and the current profiled session was not started for this task.",
        actions: ["create_checkpoint", "continue_current_session"],
        next: "Open a fresh task-specific session or explicitly continue this session. Active claims are never released by this recommendation.",
      };
    }
    return null;
  }

  continueCurrentSession({ agentId, taskId }) {
    this.assertMembership(agentId, taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.db.prepare("UPDATE agents SET session_policy_ack_task_id = ?, last_seen = ? WHERE id = ?").run(taskId, now(), agentId);
    this.#event(taskId, agentId, "session.rotation_continued", "The human chose to continue the current session despite the fresh-session recommendation.", { sessionPolicy: task.session_policy });
    this.#changed("session.rotation_continued", taskId);
    return { continued: true, taskId, advisory: true };
  }

  recordManagedLaunch({ taskId, agentId = null, adapterId, pid = null, status, message }) {
    this.assertMembership(agentId, taskId);
    this.#event(taskId, agentId, `runtime.managed_${status}`, message, { adapterId, pid });
    this.#changed(`runtime.managed_${status}`, taskId);
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
        this.#cancelReadyCheckpointsForAssignment(priorClaim.id);
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

  // The tasks an agent is a member of — exactly the rooms it explicitly joined, and nothing else.
  // There is deliberately no implicit "sole active task" fallback: it made single-task use
  // zero-config at the price of an agent's room silently changing meaning the moment a second task
  // appeared, which read as "the board stopped handing out work" with nothing to explain it.
  // devteam_join are the ways in; roomStatusForAgent says so out loud.
  #memberTaskIds(agentId) {
    return this.db.prepare("SELECT task_id FROM task_members WHERE agent_id = ?").all(agentId).map((row) => row.task_id);
  }

  // Connected agents that belong to a given task (used to scope proposal consensus).
  #connectedMemberIds(taskId) {
    const connected = this.db.prepare("SELECT id FROM agents WHERE status != 'disconnected'").all().map((row) => row.id);
    return connected.filter((id) => this.#memberTaskIds(id).includes(taskId));
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
        runtimeProfile: this.#runtimeProfileRecord(this.db.prepare("SELECT * FROM agent_runtime_profiles WHERE agent_id = ?").get(row.id)),
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
    const affectedTaskIds = this.#transaction(() => this.#purgeAgent(agentId));
    for (const taskId of affectedTaskIds) this.#changed("assignment.released", taskId);
    this.#changed("agent.forgotten");
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
    this.#cancelReadyCheckpointsForAgent(agentId);
    if (claimedTaskIds.length) {
      this.db.prepare(
        "UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE agent_id = ? AND status = 'claimed'",
      ).run(agentId);
      for (const taskId of claimedTaskIds) {
        this.#event(taskId, null, "assignment.released", `${name}'s work returned to the queue when the agent was removed.`, { reason: "agent-forgotten" });
        this.#syncTaskStatus(taskId, stamp);
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
    this.#transaction(() => {
      this.#cancelReadyCheckpointsForAssignment(assignmentId);
      this.db.prepare("UPDATE assignments SET status = 'queued', agent_id = NULL, claimed_at = NULL, claim_token_hash = NULL WHERE id = ?").run(assignmentId);
      this.#event(assignment.task_id, assignment.agent_id, "assignment.released", reason, { assignmentId, reason: "force-release", requiresWrite: Boolean(assignment.requires_write) });
      this.#syncTaskStatus(assignment.task_id, stamp);
    });
    this.#changed("assignment.released", assignment.task_id);
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
    const resolvedChecklist = this.#resolveChecklist(task.project_id, assignment.role, checklist);
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
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, verifies, plans)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(assignment.id, taskId, assignment.title, assignment.description, assignment.role, assignment.requiresWrite, assignment.targetAgentName, assignment.createdAt,
        behaviour.verifies ? 1 : 0, behaviour.plans ? 1 : 0);
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
        verifies: behaviour.verifies,
        requiresWrite: Boolean(assignment.requiresWrite),
        targetAgentName: assignment.targetAgentName,
        checklist: resolvedChecklist || [],
        writePaths,
        dependsOn: dependencyIds,
      });
    });
    this.assignmentAssessment({ assignmentId: assignment.id });
    this.#changed("assignment.created", taskId);
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
        this.#event(taskId, agentId, "agent.progress",
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
  #rungLabelFor(projectId, level) {
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
    const assignment = this.#transaction(() => {
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
      let firstRuntimeGate = null;
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
          const scopes = this.#resolveScopesOnDisk(candidate.project_root, this.#writeScopeFor(candidate.id));
          const conflict = heldLeases.some((lease) => lease.projectId === candidate.project_id
            && lease.scopes.some((held) => scopes.some((want) => this.#scopesOverlap(held, want))));
          if (conflict) continue;
        }
        // A verifying assignment is never handed to whoever wrote the version it examines. Resolved
        // per candidate rather than as a SQL predicate for the same reason the write lease is: it
        // depends on session lineage and on who is connected right now, neither of which the scan's
        // single query can see.
        if (candidate.verifies && this.#verifierIsAuthor(agentId, candidate)) continue;
        // Above this session's rung: skipped, not blocked. The agent goes on to take everything it
        // *can* do, and only when nothing claimable is left does it go idle saying what remains and
        // what that work needs. Stopping at the first hard item instead would strand work the
        // current model was perfectly capable of finishing.
        if (this.#aboveCurrentRung(agent, candidate)) continue;
        const gate = this.#runtimeGate(agent, candidate);
        if (gate.skip) continue;
        // Preserve the queue's targeted-first ordering for recommendations, but do not let one
        // incompatible item hide later work this agent can legally claim right now.
        if (!gate.allowed) {
          firstRuntimeGate ||= gate;
          continue;
        }
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
            fresh_task_id = NULL, session_policy_ack_task_id = NULL WHERE id = ?`)
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
        // Work that was sent back arrives saying so, with the reviewer's reason and findings
        // attached. Without this the author would re-claim an assignment whose title and description
        // describe the *original* task and have to go hunting through the timeline for what was
        // actually wrong with it — which is most of what made blunt blocking feel like a dead end.
        return {
          ...candidate,
          agent_id: agentId, status: "claimed", claimed_at: stamp,
          checklist: this.#checklistFor(candidate.id), writeScope,
          dependsOn: dependencies.map((item) => item.id), blockedBy: [],
          claimToken, claimGeneration,
          ...(candidate.rework_requested_at ? {
            rework: {
              count: Number(candidate.rework_count || 0),
              requestedAt: candidate.rework_requested_at,
              summary: candidate.rework_summary || null,
              findings: this.#findingsFor(candidate.id),
              next: "This work was sent back for changes. Address the summary and every finding below, then report again — reporting without addressing them will simply be sent back.",
            },
          } : {}),
        };
      }
      if (firstRuntimeGate) return firstRuntimeGate;
      this.db.prepare("UPDATE agents SET status = 'waiting', last_seen = ? WHERE id = ?").run(now(), agentId);
      return null;
    });
    // A gate encountered while scanning must not count as delivered if later compatible work was
    // claimed. Record the recommendation only when the gate is the result returned to the caller.
    if (assignment?.runtimeActionRequired && !assignment.alreadyRecommended) {
      this.#event(assignment.taskId, agentId, "runtime.switch_recommended", `Runtime action is required before “${assignment.assignment.title}” can be claimed.`, {
        assignmentId: assignment.assignment.id,
        assessmentId: assignment.assessment.id,
        agentId,
        level: assignment.assessment.level,
        requirements: assignment.assessment.requirements,
        recommendation: assignment.resolution.recommendation,
      });
    }
    if (assignment) this.#changed(
      assignment.runtimeActionRequired ? "runtime.switch_recommended" : "assignment.claimed",
      assignment.task_id || assignment.taskId,
    );
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
      const rooms = this.#memberTaskIds(agent.id);
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
    // Not a predicate: independence depends on session lineage and on who is connected, neither of
    // which the scan's single query can see, so it is resolved here exactly as the scan resolves it.
    if (assignment.verifies) {
      if (agent && this.#verifierIsAuthor(agent.id, assignment)) {
        add("verifier_is_author", `“${agent.name}” wrote version ${assignment.task_version}, so it cannot verify it; an independent teammate is free to take this one.`,
          { version: assignment.task_version });
      } else if (!agent) {
        // The dashboard asks about the item rather than about a claimant, and "the people in this
        // room who wrote it cannot check it" is a fact about the item. Reported non-blocking, for
        // the same reason an absent target is: an independent teammate may be free to take this the
        // very next second, and calling it blocked would put the explanation at odds with a scan
        // that is about to hand it over. Both branches read the same two lineage sets the scan
        // reads, so the item can never be skipped for a reason this cannot name.
        const authors = this.#currentVersionAuthorLineages(assignment.task_id, assignment.task_version);
        const connected = this.#connectedParticipantLineages(assignment.task_id);
        const excluded = [...connected].filter((lineage) => authors.has(lineage));
        if (excluded.length && this.#independentClaimantExists(assignment, authors, null)) {
          add("verifier_is_author", `Held for an independent teammate: ${excluded.length} of the contributors in this room wrote version ${assignment.task_version} and cannot verify their own work.`,
            { version: assignment.task_version, excludedAuthors: excluded.length }, false);
        }
      }
    }

    if (assignment.requires_write) {
      const wanted = this.#resolveScopesOnDisk(assignment.project_root, this.#writeScopeFor(assignment.id));
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

    if (agent) {
      const gate = this.#runtimeGate(agent, assignment);
      if (gate.skip) {
        add("runtime_decision_hold", `A standing runtime decision (${gate.decision.choice}) removes this assignment from “${agent.name}”'s queue until a human revisits it.`, { decision: gate.decision });
      } else if (gate.runtimeActionRequired) {
        const current = gate.resolution?.current;
        const wanted = gate.resolution?.recommendation;
        const runningLabel = current
          ? `${current.modelLabel || current.modelId || current.modelClass}${current.effortLabel || current.effortId ? ` at ${current.effortLabel || current.effortId} effort` : ""}`
          : "a runtime profile DevTeam cannot read";
        const neededLabel = wanted
          ? `${wanted.modelLabel || wanted.modelId || wanted.modelClass}${wanted.effortLabel || wanted.effortId ? ` at ${wanted.effortLabel || wanted.effortId} effort` : ""}`
          : `the ${gate.assessment.requirements.modelClass} model class at ${gate.assessment.requirements.effortClass} effort, which this session advertises no way to reach`;
        add("runtime_gate", `“${agent.name}” is running ${runningLabel}; this ${gate.assessment.level} assignment needs ${neededLabel}.`, {
          level: gate.assessment.level,
          assessmentId: gate.assessment.id,
          requirements: gate.assessment.requirements,
          current: current || null,
          recommendation: wanted || null,
          profileSource: gate.profileSource || null,
          humanApprovalRequired: Boolean(gate.humanApprovalRequired),
        });
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
    const rooms = [...new Set([...this.#memberTaskIds(agentId), ...invited])]
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
    if (this.#memberTaskIds(agentId).includes(taskId)) return;
    const agent = this.getAgent(agentId);
    const invited = this.db.prepare(`
      SELECT 1 FROM assignments a WHERE a.task_id = ? AND a.status = 'queued'
        AND a.target_agent_name IS NOT NULL AND lower(a.target_agent_name) = lower(?) LIMIT 1
    `).get(taskId, agent.name);
    if (!invited) throw new Error("You are not a member of this task room. Call devteam_join first.");
  }

  // The commands DevTeam is allowed to run for this project. This is the whole authority: an empty
  // list means nothing is ever executed and every reported check stays visibly agent-asserted.
  // Whether this project confines its checks. Off by default: turning it on can break a suite that
  // reaches outside the project root, so it is the human's decision like the allowlist itself.
  projectCheckSandbox(projectId) {
    return Boolean(this.db.prepare("SELECT check_sandbox FROM projects WHERE id = ?").get(projectId)?.check_sandbox);
  }

  projectCheckCommands(projectId) {
    return this.db.prepare("SELECT name, argv FROM project_check_commands WHERE project_id = ? ORDER BY name ASC")
      .all(projectId)
      .map((row) => ({ name: row.name, argv: fromJson(row.argv, []) }))
      .filter((entry) => Array.isArray(entry.argv) && entry.argv.length);
  }

  // What the project's package.json offers, so a human can see what enabling verification would
  // allow *before* enabling it. Reading this executes nothing and authorizes nothing.
  availableCheckCommands(projectId) {
    const project = this.db.prepare("SELECT root FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    return this.#derivableCheckCommands(project.root);
  }

  // Everything this project *could* offer: what it declares for itself in .devteam/checks.json, plus
  // whatever is derivable from package.json if it happens to be a Node package. Declared entries win
  // on a name collision — a human writing the file is a stronger statement of intent than a script
  // body DevTeam parsed. Every entry has its local-binary shim resolved here, so what the dashboard
  // shows before enabling is exactly the argv that would run.
  #derivableCheckCommands(projectRoot) {
    const declared = projectDeclaredCommands(projectRoot);
    const derived = packageScriptCommands(projectRoot).map((entry) => ({ ...entry, source: "package.json" }));
    const byName = new Map();
    for (const entry of [...derived, ...declared]) {
      byName.set(entry.name, { ...entry, argv: resolveLocalBinary(projectRoot, entry.argv) });
    }
    return [...byName.values()].slice(0, CHECK_ALLOWLIST_LIMIT);
  }

  // Turn verification on (or off) for a project. Passing no commands snapshots the project's own
  // package.json scripts; passing an explicit list stores exactly that; passing an empty list turns
  // verification back off. Snapshotting is what keeps this safe — an agent that later edits a script
  // body changes nothing, because the argv DevTeam runs was pinned here by a human.
  setProjectCheckCommands({ projectId, commands = null, sandbox = null }) {
    const project = this.db.prepare("SELECT id, root FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("Project not found.");
    const requested = commands === null ? this.#derivableCheckCommands(project.root) : commands;
    if (!Array.isArray(requested)) throw new Error("Check commands must be a list.");
    const entries = [];
    const seen = new Set();
    for (const candidate of requested.slice(0, CHECK_ALLOWLIST_LIMIT)) {
      const entry = normalizeCheckCommand(candidate);
      if (!entry) throw new Error(`Unusable check command: ${JSON.stringify(candidate)?.slice(0, 120)}. A command is a name plus an argv list whose program is a bare executable name.`);
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      // A human typing `eslint` means the one installed in this project. Resolve it here, at the
      // moment of pinning, so the stored argv is runnable rather than a name that fails to spawn.
      entries.push({ ...entry, argv: resolveLocalBinary(project.root, entry.argv) });
    }
    const stamp = now();
    this.#transaction(() => {
      this.db.prepare("DELETE FROM project_check_commands WHERE project_id = ?").run(projectId);
      for (const entry of entries) {
        this.db.prepare("INSERT INTO project_check_commands (project_id, name, argv, created_at) VALUES (?, ?, ?, ?)")
          .run(projectId, entry.name, json(entry.argv), stamp);
      }
      if (sandbox !== null) this.db.prepare("UPDATE projects SET check_sandbox = ? WHERE id = ?").run(sandbox ? 1 : 0, projectId);
    });
    this.#changed("project.check_commands");
    return {
      projectId, commands: entries, verificationEnabled: entries.length > 0,
      sandbox: this.projectCheckSandbox(projectId),
    };
  }

  // What a report claimed and what DevTeam found. Every record says whether it was verified, so an
  // unverified assertion can never be displayed as if DevTeam had confirmed it.
  #checksFor(assignmentId) {
    return this.db.prepare(`
      SELECT label, requested_command, command, verified, status, exit_code, duration_ms, output, created_at
      FROM assignment_checks WHERE assignment_id = ? AND superseded_at IS NULL
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId).map((row) => ({
      label: row.label,
      requestedCommand: row.requested_command,
      command: fromJson(row.command, null),
      verified: Boolean(row.verified),
      status: row.status,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      output: row.output,
      // The dashboard and the task detail payload both read this, so an unverified claim is labeled
      // wherever it is shown rather than only where someone remembered to label it.
      agentAsserted: !row.verified,
      createdAt: row.created_at,
    }));
  }

  // Normalize what an agent reported, then verify whatever it asked DevTeam to verify. A check is a
  // plain string (an assertion, as before) or { label, command } where command *selects* an entry
  // from the project's allowlist. The selected entry's argv is what runs; the agent's text never is.
  async #gradeReportedChecks(assignment, task, checks) {
    const allowlist = task?.project_id ? this.projectCheckCommands(task.project_id) : [];
    const sandbox = task?.project_id ? this.projectCheckSandbox(task.project_id) : false;
    const records = [];
    let executed = 0;
    // The configured timeout is the budget for the *report*, not for each command in it. Checks no
    // longer block the event loop, so this is no longer about keeping the server alive — it is about
    // keeping one report bounded: the refusal path deliberately leaves the claim intact, so ten
    // allowlisted checks at the default timeout could otherwise be replayed forever, each round
    // holding a write lease for twenty minutes while the rest of the team waited on those paths.
    const budgetStartedAt = Date.now();
    const remainingBudget = () => this.checkTimeoutMs - (Date.now() - budgetStartedAt);
    for (const item of Array.isArray(checks) ? checks.slice(0, 100) : []) {
      const isObject = item && typeof item === "object" && !Array.isArray(item);
      const requested = isObject ? String(item.command ?? "").trim() : "";
      const label = String((isObject ? (item.label ?? item.command ?? "") : item) ?? "").trim();
      if (!label) continue;
      const record = { label: label.slice(0, 500), requestedCommand: requested ? requested.slice(0, 200) : null, command: null, verified: false, status: "asserted", exitCode: null, durationMs: null, output: null };
      const entry = requested ? matchCheckCommand(allowlist, requested) : null;
      if (requested && !entry) {
        // The agent asked for something the human never allowlisted. Recorded plainly as
        // unavailable: DevTeam refuses to run it *and* refuses to call it verified.
        record.status = "unavailable";
        record.output = allowlist.length
          ? "No allowlisted command matches this name for the project."
          : "Command verification is not enabled for this project.";
      } else if (entry && executed >= VERIFIED_CHECKS_PER_REPORT) {
        record.status = "unavailable";
        record.output = `Only ${VERIFIED_CHECKS_PER_REPORT} commands are executed per report.`;
      } else if (entry && remainingBudget() <= 1000) {
        record.status = "unavailable";
        record.output = `The ${this.checkTimeoutMs}ms verification budget for this report was already spent.`;
      } else if (entry) {
        executed += 1;
        record.command = entry.argv;
        Object.assign(record, await runVerifiedCheck({
          argv: entry.argv,
          cwd: task.project_root,  // pinned to the project root; nothing selects a working directory
          timeoutMs: remainingBudget(),
          sandbox,
        }));
      }
      records.push(record);
    }
    return records;
  }

  // T2.3 — regression awareness.
  //
  // Verified checks always produced the raw material (exit codes over time) but nothing compared two
  // runs, so nothing in DevTeam ever noticed that agent B broke what agent A delivered. A team that
  // cannot see that cannot cover for each other; it is just several agents in one room.
  //
  // The comparison is per task, per *command*, and only over verified results. A label is prose an
  // agent chose; the argv is the allowlist entry DevTeam actually ran, so two agents describing the
  // same suite differently still compare against the same baseline, and an assertion can neither
  // establish a baseline nor quietly repair one.
  #checkCommandKey(record) {
    return Array.isArray(record.command) ? json(record.command) : null;
  }

  // Who plausibly broke it. Not "the agent that reported the failure" — that agent is usually the one
  // who *found* it — but whoever changed files between the last time this check passed and now.
  // Deliberately a list: with more than one writer in that window, naming one would be a guess
  // dressed up as a finding, so the honest answer is the set and its size.
  #regressionSuspects(taskId, sinceEventId, excludeAssignmentIds) {
    const excluded = new Set([excludeAssignmentIds].flat().filter(Boolean));
    const rows = this.db.prepare(`
      SELECT e.metadata, e.agent_id, e.author_name, e.created_at
      FROM events e
      WHERE e.task_id = ? AND e.type = 'assignment.completed' AND e.id > ?
      ORDER BY e.id ASC
    `).all(taskId, Number(sinceEventId) || 0);
    const suspects = new Map();
    for (const row of rows) {
      const metadata = fromJson(row.metadata, {});
      const changed = Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
      if (!changed.length) continue;                          // a read-only report changed nothing
      // Neither the report that surfaced the failure nor the one that last made this check green.
      // The mark is taken before a passing report writes its own completion event, so without the
      // second exclusion the assignment that fixed a check becomes a suspect for breaking it.
      if (excluded.has(metadata.assignmentId)) continue;
      const assignment = this.db.prepare("SELECT title FROM assignments WHERE id = ?").get(metadata.assignmentId);
      if (!assignment) continue;
      suspects.set(metadata.assignmentId, {
        assignmentId: metadata.assignmentId,
        title: assignment.title,
        author: row.author_name || null,
        authorAgentId: row.agent_id || null,
        changedFiles: changed.slice(0, 20),
        completedAt: row.created_at,
      });
    }
    return [...suspects.values()];
  }

  // Compare this report's verified checks against the task's baseline, record the new baseline, and
  // return whatever regressed. Called on both report paths — a refused report is still evidence, and
  // is in fact the path on which a regression is most often first seen.
  #recordCheckBaselines({ taskId, assignmentId, records, version, stamp }) {
    const regressions = [];
    for (const record of records) {
      if (!record.verified) continue;                          // assertions never touch a baseline
      if (!["passed", "failed"].includes(record.status)) continue; // 'unavailable' is not a result
      const commandKey = this.#checkCommandKey(record);
      if (!commandKey) continue;
      const previous = this.db.prepare("SELECT * FROM check_baselines WHERE task_id = ? AND command_key = ?").get(taskId, commandKey);
      const regressed = previous?.status === "passed" && record.status === "failed";
      if (regressed) {
        const suspects = this.#regressionSuspects(taskId, previous.last_passed_event_id,
          [assignmentId, previous.last_passed_assignment_id]);
        regressions.push({
          id: randomUUID(),
          commandKey,
          label: record.label,
          command: record.command,
          lastPassedAt: previous.last_passed_at || previous.updated_at,
          lastPassedAssignmentId: previous.last_passed_assignment_id || previous.assignment_id || null,
          suspects,
        });
      }
      // Where the timeline stands right now. Captured before this report writes its own completion
      // event, so the mark never includes the report that set it.
      const timelineMark = Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE task_id = ?").get(taskId).id) || 0;
      this.db.prepare(`
        INSERT INTO check_baselines (task_id, command_key, status, label, assignment_id, task_version, last_passed_at, last_passed_assignment_id, last_passed_event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, command_key) DO UPDATE SET
          status = excluded.status, label = excluded.label, assignment_id = excluded.assignment_id,
          task_version = excluded.task_version, updated_at = excluded.updated_at,
          -- Only a pass moves the "last green" mark. Keeping it pinned is what lets the *next*
          -- failure still name the whole window of changes since things actually worked.
          last_passed_at = CASE WHEN excluded.status = 'passed' THEN excluded.updated_at ELSE check_baselines.last_passed_at END,
          last_passed_assignment_id = CASE WHEN excluded.status = 'passed' THEN excluded.assignment_id ELSE check_baselines.last_passed_assignment_id END,
          last_passed_event_id = CASE WHEN excluded.status = 'passed' THEN excluded.last_passed_event_id ELSE check_baselines.last_passed_event_id END
      `).run(taskId, commandKey, record.status, record.label, assignmentId, Number(version) || 1,
        record.status === "passed" ? stamp : (previous?.last_passed_at || null),
        record.status === "passed" ? assignmentId : (previous?.last_passed_assignment_id || null),
        record.status === "passed" ? timelineMark : (previous?.last_passed_event_id || 0),
        stamp);
      // A check going green again closes whatever it broke, so the board does not accumulate
      // regressions that were quietly fixed by ordinary work.
      if (record.status === "passed") {
        this.db.prepare("UPDATE check_regressions SET resolved_at = ? WHERE task_id = ? AND command_key = ? AND resolved_at IS NULL")
          .run(stamp, taskId, commandKey);
      }
    }
    return regressions;
  }

  // Record the regressions and, where the breakage is attributable to work *other* than the report
  // that surfaced it, route a fix back to whoever did it. This is the mechanism that turns a group of
  // agents into a team that covers for each other: the agent that tripped over the breakage is told
  // it is not theirs to chase, and the agent that caused it is handed the work.
  #openRegressions({ taskId, assignmentId, regressions, stamp, projectId }) {
    const opened = [];
    for (const regression of regressions) {
      // One open fix per broken check. Without this, every subsequent report that runs the same
      // failing suite would queue another near-identical assignment.
      const existing = this.db.prepare(`
        SELECT fix_assignment_id FROM check_regressions
        WHERE task_id = ? AND command_key = ? AND resolved_at IS NULL AND fix_assignment_id IS NOT NULL LIMIT 1
      `).get(taskId, regression.commandKey);
      let fixAssignmentId = null;
      const soleSuspect = regression.suspects.length === 1 ? regression.suspects[0] : null;
      if (!existing && regression.suspects.length) {
        fixAssignmentId = randomUUID();
        const behaviour = this.roleBehaviour(projectId, "implementer");
        const suspectSummary = soleSuspect
          ? `“${soleSuspect.title}”${soleSuspect.author ? ` (${soleSuspect.author})` : ""}`
          : `${regression.suspects.length} pieces of work`;
        this.db.prepare(`
          INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, verifies, plans)
          VALUES (?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?, ?)
        `).run(
          fixAssignmentId, taskId,
          `Fix the regression in “${regression.label}”`,
          [
            `The check “${regression.label}” passed before and now fails.`,
            `It was last green before ${suspectSummary} landed.`,
            regression.suspects.length === 1
              ? `Changed files: ${soleSuspect.changedFiles.join(", ")}.`
              : `Changed files across that window: ${[...new Set(regression.suspects.flatMap((suspect) => suspect.changedFiles))].slice(0, 20).join(", ")}.`,
            regression.suspects.length > 1
              ? "More than one piece of work landed in that window, so this attribution is a starting point, not a verdict — check before assuming."
              : "",
            "Restore the check to passing without reverting unrelated work.",
          ].filter(Boolean).join(" "),
          "implementer", soleSuspect?.author || null, stamp,
          behaviour.verifies ? 1 : 0, behaviour.plans ? 1 : 0,
        );
        // Scope the fix to the files the suspects actually touched. Left unscoped it would take a
        // whole-project lease and block every unrelated writer in the room — a regression fix that
        // stops the rest of the team is a worse outcome than the regression.
        const scope = [...new Set(regression.suspects.flatMap((suspect) => suspect.changedFiles))].slice(0, 50);
        if (scope.length) {
          this.db.prepare("INSERT OR REPLACE INTO assignment_write_scopes (assignment_id, paths) VALUES (?, ?)")
            .run(fixAssignmentId, json(scope));
        }
        this.#event(taskId, null, "assignment.created", `Fix the regression in “${regression.label}”`, {
          assignmentId: fixAssignmentId, role: "implementer", requiresWrite: true,
          targetAgentName: soleSuspect?.author || null, regressionOf: regression.commandKey, writePaths: scope,
        });
      }
      this.db.prepare(`
        INSERT INTO check_regressions (id, task_id, command_key, label, detected_by_assignment_id, last_passed_assignment_id, suspects, fix_assignment_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(regression.id, taskId, regression.commandKey, regression.label, assignmentId,
        regression.lastPassedAssignmentId, json(regression.suspects), fixAssignmentId, stamp);
      this.#event(taskId, null, "check.regressed",
        `“${regression.label}” passed before and now fails${soleSuspect ? `, first failing after “${soleSuspect.title}”` : ""}.`, {
          label: regression.label,
          command: regression.command,
          suspects: regression.suspects.map((suspect) => ({ assignmentId: suspect.assignmentId, title: suspect.title, author: suspect.author })),
          fixAssignmentId,
          detectedByAssignmentId: assignmentId,
        });
      opened.push({
        id: regression.id,
        label: regression.label,
        command: regression.command,
        lastPassedAt: regression.lastPassedAt,
        suspects: regression.suspects.map((suspect) => ({ assignmentId: suspect.assignmentId, title: suspect.title, author: suspect.author, changedFiles: suspect.changedFiles })),
        fixAssignmentId,
        attribution: regression.suspects.length === 1 ? "single" : (regression.suspects.length ? "ambiguous" : "unattributed"),
      });
    }
    return opened;
  }

  // T4.3 — replay a task as a narrative.
  //
  // The events were always there and always rich, but reading them meant reading a table. When a task
  // has gone wrong, the question is "where did this turn", and answering it needs the story in order:
  // what was assigned, who took it, what they reported, what DevTeam actually ran, who reviewed it,
  // what went back, what regressed.
  //
  // Read-only and derived entirely from the record — it invents nothing and, in particular, does not
  // re-grade anything. A check that was agent-asserted at the time still reads as asserted here.
  taskReplay(taskId, { limit = 1000 } = {}) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const events = this.db.prepare(`
      SELECT id, type, message, metadata, created_at, author_name, author_kind
      FROM events WHERE task_id = ? ORDER BY id ASC LIMIT ?
    `).all(taskId, Math.max(1, Math.min(5_000, Number(limit) || 1000)));

    const escape = (value) => String(value ?? "").replace(/\r/g, "").trim();
    const lines = [
      `# ${task.title}`,
      "",
      `**Project:** ${task.project_name || task.project_id}  `,
      `**Status:** ${task.status} · version ${task.version} · ${task.required_approvals} approval${task.required_approvals === 1 ? "" : "s"} required  `,
      `**Opened:** ${task.created_at}`,
      "",
      escape(task.description) || "_No description._",
      "",
      "---",
      "",
      "## What happened",
      "",
    ];

    let currentVersion = 1;
    for (const event of events) {
      const metadata = fromJson(event.metadata, {}) || {};
      const who = event.author_name || (event.author_kind === "human" ? "The human" : "DevTeam");
      const when = escape(event.created_at);
      // A version bump is the spine of the story: everything after it is review of different work.
      if (Number(metadata.version) && Number(metadata.version) !== currentVersion) {
        currentVersion = Number(metadata.version);
        lines.push("", `### Version ${currentVersion}`, "");
      }
      const detail = [];
      if (Array.isArray(metadata.changedFiles) && metadata.changedFiles.length) {
        detail.push(`changed \`${metadata.changedFiles.slice(0, 12).join("`, `")}\``);
      }
      if (Array.isArray(metadata.checkRecords) && metadata.checkRecords.length) {
        detail.push(metadata.checkRecords.slice(0, 8).map((record) => {
          const label = escape(record.label);
          if (!record.verified) return `${label} _(asserted, not run)_`;
          return `${label} **${record.status}**${record.exitCode == null ? "" : ` (exit ${record.exitCode})`}`;
        }).join("; "));
      }
      if (Array.isArray(metadata.findings) && metadata.findings.length) {
        detail.push(`findings: ${metadata.findings.slice(0, 8).map((finding) => escape(finding.detail)).join("; ")}`);
      }
      if (metadata.role) detail.push(`role ${escape(metadata.role)}`);
      const suffix = detail.length ? ` — ${detail.join(" · ")}` : "";
      const body = escape(event.message);
      const headline = body.split("\n")[0].slice(0, 300);
      lines.push(`- \`${when}\` **${escape(who)}** · _${escape(event.type)}_ — ${headline}${suffix}`);
      // Keep a report's own prose, indented, when it says more than its first line.
      const rest = body.split("\n").slice(1).filter(Boolean).slice(0, 6);
      for (const extra of rest) lines.push(`  > ${extra.slice(0, 300)}`);
    }

    const usage = this.taskUsage(taskId);
    const regressions = this.openRegressions(taskId);
    lines.push("", "---", "", "## Where it stands", "");
    lines.push(`- **Status:** ${task.status}, version ${task.version}`);
    const approvals = this.db.prepare(`
      SELECT ag.name, ap.version, ap.independent FROM approvals ap JOIN agents ag ON ag.id = ap.agent_id WHERE ap.task_id = ?
    `).all(taskId);
    lines.push(`- **Approvals on the current version:** ${approvals.filter((a) => Number(a.version) === Number(task.version)).length}`
      + (approvals.some((a) => !a.independent) ? " (includes a self-review)" : ""));
    if (regressions.length) {
      lines.push(`- **Broken checks:** ${regressions.map((item) => escape(item.label)).join(", ")}`);
    }
    if (usage) {
      lines.push(`- **Reported cost:** $${usage.totalCostUsd.toFixed(2)} across ${usage.reports} report${usage.reports === 1 ? "" : "s"} _(agent-reported, not measured)_`);
    }
    if (events.length >= Math.min(5_000, Number(limit) || 1000)) {
      lines.push("", `_Truncated at ${events.length} events._`);
    }
    return { taskId, title: task.title, events: events.length, markdown: `${lines.join("\n")}\n` };
  }

  // T4.2 — what the work cost.
  //
  // Nothing recorded it, so "which agent burned what on which assignment" was unanswerable, and the
  // wall-clock budget from T2.6 was the only cap available.
  //
  // Reported by the agent, and labeled as reported. DevTeam cannot measure another process's token
  // use and does not pretend to: these are the agent's own figures, exactly like an unverified check,
  // and the payload says so wherever it is shown. A number that looks measured but is asserted is
  // worse than an obviously asserted one.
  #recordUsage({ taskId, assignmentId, agentId, agentName, usage, stamp }) {
    if (!usage || typeof usage !== "object") return null;
    const bounded = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.min(Math.trunc(number), 1_000_000_000) : null;
    };
    const inputTokens = bounded(usage.inputTokens);
    const outputTokens = bounded(usage.outputTokens);
    // `null` means "not reported" and must not become a zero-cost row: a task showing $0.00 spent
    // because every agent omitted the figure reads as free, which is the opposite of the truth.
    const costCents = usage.costUsd != null && Number.isFinite(Number(usage.costUsd)) && Number(usage.costUsd) >= 0
      ? Math.min(10_000_000, Math.round(Number(usage.costUsd) * 100))
      : null;
    const model = String(usage.model || "").trim().slice(0, 120) || null;
    if (inputTokens === null && outputTokens === null && costCents === null) return null;
    this.db.prepare(`
      INSERT INTO assignment_usage (id, task_id, assignment_id, agent_id, agent_name, model, input_tokens, output_tokens, cost_cents, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), taskId, assignmentId, agentId || null, agentName || null, model,
      inputTokens, outputTokens, costCents, stamp);
    return { model, inputTokens, outputTokens, costUsd: costCents === null ? null : costCents / 100 };
  }

  // What a task has cost so far, per agent and in total. Every figure here is agent-reported.
  taskUsage(taskId) {
    const rows = this.db.prepare(`
      SELECT agent_name, model,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cost_cents), 0) AS cost_cents,
             COUNT(*) AS reports
      FROM assignment_usage WHERE task_id = ?
      GROUP BY agent_name, model ORDER BY cost_cents DESC, agent_name ASC
    `).all(taskId);
    if (!rows.length) return null;
    const total = rows.reduce((sum, row) => ({
      inputTokens: sum.inputTokens + Number(row.input_tokens),
      outputTokens: sum.outputTokens + Number(row.output_tokens),
      costCents: sum.costCents + Number(row.cost_cents),
      reports: sum.reports + Number(row.reports),
    }), { inputTokens: 0, outputTokens: 0, costCents: 0, reports: 0 });
    return {
      agentAsserted: true,
      note: "Reported by the agents themselves. DevTeam cannot measure another process's token use and does not pretend to.",
      byAgent: rows.map((row) => ({
        agentName: row.agent_name, model: row.model,
        inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
        costUsd: Number(row.cost_cents) / 100, reports: Number(row.reports),
      })),
      totalInputTokens: total.inputTokens,
      totalOutputTokens: total.outputTokens,
      totalCostUsd: total.costCents / 100,
      reports: total.reports,
    };
  }

  // T2.6 — the three things a human could not do once work was running.
  //
  // Before this, the only mid-flight controls were block (stops everything), force-release (takes a
  // lease away) and message (advisory). All three are blunt: nothing could say "do this one first",
  // "stop that, it is no longer worth doing", or "this task has had enough of my afternoon".

  // Re-prioritise a queued assignment. Higher goes first; the rest of the ordering is unchanged, so
  // priority breaks ties rather than overriding dependencies, leases or the review gate — none of
  // which are preferences a human should be able to skip by wanting something sooner.
  prioritizeAssignment({ taskId, assignmentId, priority }) {
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!assignment) throw new Error("Assignment not found in this task.");
    const value = Math.max(-100, Math.min(100, Math.trunc(Number(priority) || 0)));
    this.db.prepare("UPDATE assignments SET priority = ? WHERE id = ?").run(value, assignmentId);
    this.#event(taskId, null, "assignment.prioritized",
      `Priority for “${assignment.title}” set to ${value}.`, { assignmentId, priority: value });
    this.#changed("assignment.prioritized", taskId);
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
    this.#event(taskId, assignment.agent_id, "assignment.cancel_requested",
      `Stop requested for “${assignment.title}”: ${cleanReason}`, { assignmentId, reason: cleanReason });
    this.#changed("assignment.cancel_requested", taskId);
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

  // T2.5 — what the team has learned about each of its members.
  //
  // Nothing tracked whose work got sent back, who reported checks that failed verification, or whose
  // changes caused regressions. A team learns who to trust with what; a queue cannot.
  //
  // Derived on read from the event log and the tables the earlier items already fill, rather than
  // maintained as counters. That is the important design call: a counter can drift from the timeline
  // and then quietly libel an agent, and there is no way to notice. Deriving is slower and always
  // agrees with the record. Scoped by agent *name*, not session id, because a reliability record
  // that resets every time a desktop chat reconnects is worthless.
  agentReliability(agentName, { windowDays = 30 } = {}) {
    const name = String(agentName || "").trim();
    if (!name) return null;
    const since = new Date(Date.now() - Math.max(1, Number(windowDays) || 30) * 86_400_000).toISOString();

    const completed = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'assignment.completed' AND lower(author_name) = lower(?) AND created_at >= ?
    `).get(name, since).count);

    // Reports DevTeam refused because a command it ran did not pass. This is the honest-overclaim
    // signal: the agent said done, and the evidence said otherwise.
    const refusedByChecks = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE type = 'assignment.check_failed' AND lower(author_name) = lower(?) AND created_at >= ?
    `).get(name, since).count);

    // Work of this agent's that a reviewer sent back, and how many rounds it took.
    const reworked = this.db.prepare(`
      SELECT a.rework_count AS rounds FROM assignments a
      WHERE a.rework_count > 0 AND a.id IN (
        SELECT json_extract(e.metadata, '$.assignmentId') FROM events e
        WHERE e.type = 'assignment.completed' AND lower(e.author_name) = lower(?) AND e.created_at >= ?
      )
    `).all(name, since).map((row) => Number(row.rounds) || 0);
    const reworkRounds = reworked.reduce((total, rounds) => total + rounds, 0);

    // Regressions this agent's work is the sole suspect for. Ambiguous ones are deliberately not
    // counted against anyone: attributing a shared window to one name would be a guess, and a guess
    // that follows someone around as a reliability number is worse than no number.
    const regressionsCaused = this.db.prepare(`
      SELECT suspects FROM check_regressions WHERE created_at >= ?
    `).all(since).filter((row) => {
      const suspects = fromJson(row.suspects, []);
      return suspects.length === 1 && String(suspects[0]?.author || "").toLowerCase() === name.toLowerCase();
    }).length;

    // Regressions this agent found by running the checks. The counterpart signal, and the reason
    // this is not a blame ledger: noticing breakage is a contribution, and a record that only ever
    // counts faults teaches agents not to run checks.
    const regressionsCaught = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM check_regressions r
      JOIN events e ON e.type = 'assignment.check_failed'
        AND json_extract(e.metadata, '$.assignmentId') = r.detected_by_assignment_id
      WHERE r.created_at >= ? AND lower(e.author_name) = lower(?)
    `).get(since, name).count);

    const approvals = this.db.prepare(`
      SELECT independent FROM approvals ap
      JOIN agents ag ON ag.id = ap.agent_id
      WHERE lower(ag.name) = lower(?) AND ap.created_at >= ?
    `).all(name, since);

    const attempts = completed + refusedByChecks;
    return {
      agentName: name,
      windowDays: Math.max(1, Number(windowDays) || 30),
      completed,
      refusedByChecks,
      reworkedAssignments: reworked.length,
      reworkRounds,
      averageReworkRounds: completed ? Number((reworkRounds / completed).toFixed(2)) : 0,
      regressionsCaused,
      regressionsCaught,
      approvals: approvals.length,
      independentApprovals: approvals.filter((approval) => approval.independent).length,
      // A single number for ordering and for the gate. Deliberately conservative: an agent with very
      // little history sits near the top rather than being punished for being new, because a
      // reliability score that suppresses newcomers starves the very work that would give it data.
      cleanReportRate: attempts ? Number((completed / attempts).toFixed(2)) : 1,
      sample: attempts,
    };
  }

  // Every agent the room has an opinion about, for the dashboard.
  teamReliability({ windowDays = 30 } = {}) {
    const names = this.db.prepare(`
      SELECT DISTINCT author_name AS name FROM events
      WHERE author_kind = 'agent' AND author_name IS NOT NULL
      ORDER BY author_name ASC LIMIT 50
    `).all().map((row) => row.name);
    return names.map((name) => this.agentReliability(name, { windowDays })).filter(Boolean);
  }

  // Open regressions for a task, for the dashboard and for an agent asking what is currently broken.
  openRegressions(taskId) {
    return this.db.prepare(`
      SELECT id, command_key, label, detected_by_assignment_id, suspects, fix_assignment_id, created_at
      FROM check_regressions WHERE task_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 20
    `).all(taskId).map((row) => ({
      id: row.id,
      label: row.label,
      command: fromJson(row.command_key, null),
      detectedByAssignmentId: row.detected_by_assignment_id,
      suspects: fromJson(row.suspects, []),
      fixAssignmentId: row.fix_assignment_id,
      createdAt: row.created_at,
    }));
  }

  // The check baseline for a task: what each verified command last did, and when it was last green.
  checkBaseline(taskId) {
    return this.db.prepare(`
      SELECT command_key, status, label, task_version, last_passed_at, updated_at
      FROM check_baselines WHERE task_id = ? ORDER BY label ASC
    `).all(taskId).map((row) => ({
      label: row.label,
      command: fromJson(row.command_key, null),
      status: row.status,
      taskVersion: row.task_version,
      lastPassedAt: row.last_passed_at,
      updatedAt: row.updated_at,
    }));
  }

  #storeReportedChecks(assignmentId, taskId, records, stamp) {
    // A rejected report leaves the claim intact so the agent can fix the work and report again, so
    // an assignment accumulates one batch per attempt. Only the latest attempt describes the work as
    // it now stands: without this, an assignment that failed a check and then passed it would go on
    // showing the failure forever, and "did a check fail here?" would answer yes about work that is
    // green. Earlier attempts are kept, marked superseded, so the history is still on record.
    this.db.prepare("UPDATE assignment_checks SET superseded_at = ? WHERE assignment_id = ? AND superseded_at IS NULL")
      .run(stamp, assignmentId);
    for (const record of records) {
      this.db.prepare(`
        INSERT INTO assignment_checks (
          id, assignment_id, task_id, label, requested_command, command,
          verified, status, exit_code, duration_ms, output, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), assignmentId, taskId, record.label, record.requestedCommand, record.command ? json(record.command) : null,
        record.verified ? 1 : 0, record.status, record.exitCode ?? null, record.durationMs ?? null, record.output ?? null, stamp,
      );
    }
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
      scopes: this.#resolveScopesOnDisk(row.root, this.#writeScopeFor(row.id)),
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
        nextAction: "Do not write further under this claim. Call devteam_next to pick up current work, or devteam_join with your resumeToken if you are returning to an earlier session.",
      },
    };
  }

  // Whether this report will actually execute anything. A report whose checks are all plain
  // assertions runs no processes and settles in one turn, so it never enters the verifying window —
  // flagging it would put a "checks running" state on the board for work nobody is checking.
  #reportRunsCommands(task, checks) {
    return this.#reportedCheckCommands(task, checks).length > 0;
  }

  // The allowlisted commands this report will actually execute. Both the verifying window and the
  // durable job row are about *these*, so they are derived once rather than being decided twice by
  // two nearly-identical predicates that could drift apart.
  #reportedCheckCommands(task, checks) {
    if (!Array.isArray(checks) || !checks.length) return [];
    const allowlist = task?.project_id ? this.projectCheckCommands(task.project_id) : [];
    if (!allowlist.length) return [];
    const commands = [];
    for (const item of checks.slice(0, 100)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const requested = String(item.command ?? "").trim();
      const label = String(item.label ?? item.command ?? "").trim();
      if (label && requested && matchCheckCommand(allowlist, requested)) commands.push(requested);
    }
    return [...new Set(commands)];
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
  async completeAssignment({ agentId, assignmentId, message, status = "done", changedFiles = [], checks = [], nextStatus = "waiting", claimToken = null, usage = null }) {
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
    const runsCommands = this.#reportRunsCommands(task, checks);
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
        detail: { commands: this.#reportedCheckCommands(task, checks), title: assignment.title },
      });
      this.#event(assignment.task_id, agentId, "assignment.verifying",
        `DevTeam is running the checks ${agent.name} reported for “${assignment.title}”.`, { assignmentId, role: assignment.role, jobId });
      this.#changed("assignment.verifying", assignment.task_id);
    }
    let checkRecords;
    try {
      checkRecords = await this.#gradeReportedChecks(assignment, task, checks);
    } finally {
      if (runsCommands) {
        this.db.prepare("UPDATE assignments SET verifying_at = NULL WHERE id = ?").run(assignmentId);
        this.#finishJob(jobId, { state: "finished", outcome: `Ran ${checkRecords?.filter((record) => record.verified).length ?? 0} verified check(s).` });
      }
    }
    // The claim can move while those checks run. A force-release, a resume and a checkpoint takeover
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
      this.#transaction(() => {
        // A refused report is still evidence, and is in fact where a regression is usually first
        // seen: the agent that trips over someone else's breakage is the one running the suite.
        const detected = this.#recordCheckBaselines({
          taskId: assignment.task_id, assignmentId, records: checkRecords, version: task?.version, stamp,
        });
        regressions = this.#openRegressions({
          taskId: assignment.task_id, assignmentId, regressions: detected, stamp, projectId: task?.project_id,
        });
        this.#storeReportedChecks(assignmentId, assignment.task_id, checkRecords, stamp);
        this.#event(assignment.task_id, agentId, "assignment.check_failed",
          `${agent.name} reported “${assignment.title}” as done, but ${failedChecks.length === 1 ? "a check" : `${failedChecks.length} checks`} DevTeam ran failed.`, {
            assignmentId,
            role: assignment.role,
            checks: cleanChecks,
            checkRecords,
            ...(regressions.length ? { regressions: regressions.map((item) => item.label) } : {}),
          });
      });
      this.#changed("assignment.check_failed", assignment.task_id);
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
    let reportedUsage = null;
    this.#transaction(() => {
      const stamp = now();
      this.#cancelReadyCheckpointsForAssignment(assignmentId);
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
      regressions = this.#openRegressions({
        taskId: assignment.task_id, assignmentId, projectId: task?.project_id, stamp,
        regressions: this.#recordCheckBaselines({
          taskId: assignment.task_id, assignmentId, records: checkRecords, version, stamp,
        }),
      });
      this.#storeReportedChecks(assignmentId, assignment.task_id, checkRecords, stamp);
      reportedUsage = this.#recordUsage({
        taskId: assignment.task_id, assignmentId, agentId, agentName: agent.name, usage, stamp,
      });
      this.#event(assignment.task_id, agentId, status === "blocked" ? "assignment.blocked" : "assignment.completed", message.trim(), {
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
        this.#event(assignment.task_id, agentId, "assignment.created", `Resolve blocker: ${assignment.title}`, {
          assignmentId: followUpAssignmentId,
          role: this.planningRoleFor(task.project_id),
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
      checks: checkRecords,
      verifiedChecks: checkRecords.filter((record) => record.verified).length,
      ...(regressions.length ? { regressions } : {}),
      ...(reportedUsage ? { usage: reportedUsage } : {}),
      agent: agent.name,
      ...(status === "blocked" ? { taskBlocked: false, followUpAssignmentId } : {}),
    };
  }

  // A checkpoint takeover creates a fresh session id, but it does not create a new independent
  // participant. Follow claimed checkpoint links back to the original session in that lineage.
  #participantLineage(agentId) {
    let current = agentId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const predecessor = this.db.prepare(`
        SELECT from_agent_id FROM session_checkpoints
        WHERE claimed_by_agent_id = ? AND status = 'claimed'
        ORDER BY claimed_at DESC, checkpoint_generation DESC LIMIT 1
      `).get(current);
      if (!predecessor?.from_agent_id) break;
      current = predecessor.from_agent_id;
    }
    return current || agentId;
  }

  #connectedParticipantLineages(taskId) {
    const members = this.db.prepare(`
      SELECT tm.agent_id FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.status != 'disconnected'
    `).all(taskId);
    return new Set(members.map((member) => this.#participantLineage(member.agent_id)));
  }

  #currentVersionAuthorLineages(taskId, version) {
    const authors = this.db.prepare(`
      SELECT agent_id, metadata FROM events
      WHERE task_id = ? AND type = 'assignment.completed' AND agent_id IS NOT NULL
    `).all(taskId).filter((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version && Array.isArray(metadata.changedFiles) && metadata.changedFiles.length > 0;
    });
    return new Set(authors.map((author) => this.#participantLineage(author.agent_id)));
  }

  #approvalLineages(taskId, version) {
    const approvals = this.db.prepare("SELECT agent_id FROM approvals WHERE task_id = ? AND version = ?").all(taskId, version);
    return new Set(approvals.map((approval) => this.#participantLineage(approval.agent_id)));
  }

  #eligibleIndependentApproverLineages(taskId, version) {
    const authors = this.#currentVersionAuthorLineages(taskId, version);
    return new Set([...this.#connectedParticipantLineages(taskId)].filter((lineage) => !authors.has(lineage)));
  }

  // Reviewer ≠ author, asked at claim time. approveTask has always refused a self-approval, but
  // refusing it *only* there meant the author was handed the review claim, read the whole diff, and
  // then found the single exit was to block the assignment: seven blocked assignments on this board
  // are exactly that refusal, the most recent from 2026-08-27, and they are why 264 completed
  // assignments produced two requests for changes. Enforcing it where the claim is handed out costs
  // the team nothing and is the difference between independent review and a rubber stamp.
  //
  // No dead-ends, the same rule the rest of consensus follows: with no independent teammate
  // connected, the author still gets the work and the acceptance is labeled selfReviewed rather than
  // the assignment sitting claimable-by-nobody.
  #verifierIsAuthor(agentId, assignment) {
    const authors = this.#currentVersionAuthorLineages(assignment.task_id, assignment.task_version);
    if (!authors.has(this.#participantLineage(agentId))) return false;
    return this.#independentClaimantExists(assignment, authors, agentId);
  }

  // "Could somebody else actually take this, right now?" — deliberately not "does an independent
  // teammate exist". The difference is a deadlock, and the property suite found it on the first try:
  // a teammate who is connected but already holding as much work as it can take will never claim
  // this item, so excluding the author on its behalf leaves the assignment queued forever with a
  // reason that reads like a promise nobody is going to keep.
  //
  // Asked through the full explanation surface rather than a hand-rolled subset of it, so this can
  // never drift from what the scan will really do with that teammate.
  //
  // The recursion terminates at one level: whyNotClaimable consults #verifierIsAuthor in turn, but
  // only for the teammates asked about here, and those are non-authors by construction — the lineage
  // test above returns false for them before reaching this method again.
  #independentClaimantExists(assignment, authors, excludeAgentId) {
    const members = this.db.prepare(`
      SELECT tm.agent_id FROM task_members tm
      JOIN agents agent ON agent.id = tm.agent_id
      WHERE tm.task_id = ? AND tm.role = 'contributor' AND agent.status != 'disconnected'
    `).all(assignment.task_id);
    for (const member of members) {
      if (member.agent_id === excludeAgentId) continue;
      if (authors.has(this.#participantLineage(member.agent_id))) continue;
      if (this.whyNotClaimable(assignment.id, member.agent_id, { refreshLiveness: false }).claimable) return true;
    }
    return false;
  }

  // No dead-ends: configured consensus cannot exceed the independent teammates who could
  // actually approve now. With none available, one honest self-review remains sufficient.
  #effectiveRequiredApprovals(taskId, configured, version) {
    const eligible = this.#eligibleIndependentApproverLineages(taskId, version).size;
    return Math.max(1, Math.min(configured, eligible || 1));
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
        && this.#assignmentVerifies(metadata.assignmentId)
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
    if (!reviewEvidence) throw new Error("Approval requires a completed, read-only reviewer or tester assignment on the current task version.");
    // T2.4: where a project has verification enabled, an approval must rest on something DevTeam
    // actually ran. Without this, "verified checks" and "an agent said so" carry identical weight at
    // the one moment that decides whether work ships — which is where the distinction matters most.
    // Projects with no allowlist are unaffected: nothing to verify means nothing to require.
    const verificationEnabled = this.projectCheckCommands(task.project_id).length > 0;
    const verifiedEvidence = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignment_checks c
      JOIN assignments a ON a.id = c.assignment_id
      WHERE a.task_id = ? AND c.superseded_at IS NULL AND c.verified = 1 AND c.status = 'passed'
    `).get(taskId).count) > 0;
    if (verificationEnabled && !verifiedEvidence) {
      throw new Error("This project runs verified checks, and nothing on this task version has passed one. Run an allowlisted check and report it before approving.");
    }
    // Reviewer ≠ author: when the team is more than one agent, the author of the current version
    // cannot approve it — an independent teammate must. A genuine solo run is still allowed to
    // finish (no dead-ends), but its acceptance is labeled selfReviewed so it is never mistaken
    // for independent consensus.
    const authorLineages = this.#currentVersionAuthorLineages(taskId, task.version);
    const approverLineage = this.#participantLineage(agentId);
    const eligibleIndependent = this.#eligibleIndependentApproverLineages(taskId, task.version);
    if (authorLineages.has(approverLineage) && eligibleIndependent.size > 0) {
      throw new Error("The author of the current version cannot approve it; an independent reviewer or tester must.");
    }
    let outcome;
    this.#transaction(() => {
      const stamp = now();
      // Independence is recorded on the approval, not recomputed later. Whether the approver was the
      // author is a fact about the moment of approving; recomputing it lets the record change as
      // agents connect and disconnect, which is exactly when it must not.
      const independent = !authorLineages.has(approverLineage);
      this.db.prepare(`
        INSERT INTO approvals (task_id, agent_id, version, summary, created_at, independent, verified_evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, agent_id, version) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at,
          independent = excluded.independent, verified_evidence = excluded.verified_evidence
      `).run(taskId, agentId, task.version, summary.trim(), stamp, independent ? 1 : 0, verifiedEvidence ? 1 : 0);
      this.#event(taskId, agentId, "task.approved",
        `${agent.name} approved version ${task.version}${independent ? "" : " (self-review: no independent teammate was available)"}.`,
        { summary: summary.trim(), version: task.version, independent, verifiedEvidence });
      const approvalLineages = this.#approvalLineages(taskId, task.version);
      const approvalCount = approvalLineages.size;
      const openAssignments = Number(this.db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')").get(taskId).count);
      const effectiveRequired = this.#effectiveRequiredApprovals(taskId, task.required_approvals, task.version);
      const accepted = approvalCount >= effectiveRequired && openAssignments === 0;
      // Honest labeling: rotating one session through a checkpoint cannot manufacture consensus.
      const independentApprovalCount = [...approvalLineages].filter((lineage) => !authorLineages.has(lineage)).length;
      const selfReviewed = authorLineages.size > 0 ? independentApprovalCount === 0 : approvalLineages.size <= 1;
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

  // A reviewer that finds problems used to have two moves, and both were wrong. Approving anyway is
  // dishonest; `status=blocked` closes the *reviewer's own* assignment and queues a coarse planner
  // item, so the fix routes through a human-shaped triage step instead of back to the person who
  // wrote the code. This is the third move: send the work itself back to its author, with the
  // findings attached, without stopping the task or disturbing anyone else's claim.
  //
  // What it deliberately does NOT do: create a new assignment. The original row is reopened, so its
  // title, description, checklist, write scope, dependencies and whole event history stay attached
  // to the work rather than being scattered across a chain of near-duplicate follow-ups. Reopening
  // clears the claim and its fencing token exactly as a force-release does, so a late report from
  // the author's previous session is refused instead of landing on top of the rework.
  requestChanges({ agentId = null, taskId, assignmentId, summary, findings = [] }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    if (["blocked", "cancelled", "accepted"].includes(task.status)) {
      throw new Error(`Cannot request changes on a ${task.status} task.`);
    }
    const agent = agentId ? this.getAgent(agentId) : null;
    const assignment = this.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, taskId);
    if (!assignment) throw new Error("Assignment not found in this task room.");
    if (assignment.status !== "done") {
      throw new Error(`Only completed work can be sent back for changes; this assignment is ${assignment.status}.`);
    }
    const cleanSummary = String(summary || "").trim();
    if (!cleanSummary) throw new Error("Say what needs to change.");
    // Earning the right to send work back is the same act as earning the right to approve it: an
    // independent read-only verifier assignment on the current version. The alternative is holding
    // that verifier claim right now — the reviewer that finds the problem mid-review should not have
    // to finish and file its own report before it can say so.
    if (agentId && !this.#hasReviewStanding(agentId, taskId, task.version)) {
      throw new Error("Requesting changes needs a completed or in-progress read-only reviewer or tester assignment on the current task version.");
    }
    const cleanFindings = (Array.isArray(findings) ? findings : []).slice(0, 50).map((item) => {
      const isObject = item && typeof item === "object" && !Array.isArray(item);
      return {
        detail: String((isObject ? item.detail : item) ?? "").trim().slice(0, 2000),
        path: isObject && item.path ? String(item.path).trim().slice(0, 500) : null,
      };
    }).filter((item) => item.detail);
    const authorName = assignment.agent_id
      ? (this.db.prepare("SELECT name FROM agents WHERE id = ?").get(assignment.agent_id)?.name || null)
      : null;
    let outcome;
    this.#transaction(() => {
      const stamp = now();
      const reworkCount = Number(assignment.rework_count || 0) + 1;
      // Back to queued, addressed to whoever wrote it. Targeting is a preference, not a lock: the
      // existing scheduler rule returns a targeted item to the general queue once nobody by that
      // name is connected, so rework never becomes unclaimable because its author went home.
      this.db.prepare(`
        UPDATE assignments
        SET status = 'queued', agent_id = NULL, completed_at = NULL, claim_token_hash = NULL,
            target_agent_name = COALESCE(?, target_agent_name),
            rework_count = ?, rework_requested_at = ?, rework_summary = ?
        WHERE id = ?
      `).run(authorName, reworkCount, stamp, cleanSummary, assignmentId);
      for (const finding of cleanFindings) {
        this.db.prepare(`
          INSERT INTO assignment_findings (id, assignment_id, task_id, requested_by_agent_id, requested_by_name, task_version, detail, path, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), assignmentId, taskId, agentId, agent?.name || "the human", Number(task.version), finding.detail, finding.path, stamp);
      }
      // The version under review was just judged not good enough, so approvals built on it no longer
      // describe a settled state. Clearing them is the same principle as version-invalidates-
      // approvals: if the rework changes files the version bumps and they would have gone anyway,
      // and if it changes none they would otherwise have survived a reviewer saying "not yet".
      const clearedApprovals = this.db.prepare("DELETE FROM approvals WHERE task_id = ? AND version = ?").run(taskId, task.version).changes;
      this.#cancelReadyCheckpointsForAssignment(assignmentId);
      this.#event(taskId, agentId, "assignment.changes_requested",
        `${agent?.name || "The human"} sent “${assignment.title}” back for changes: ${cleanSummary}`, {
          assignmentId,
          role: assignment.role,
          author: authorName,
          version: Number(task.version),
          reworkCount,
          clearedApprovals,
          findings: cleanFindings,
        });
      this.#syncTaskStatus(taskId, stamp);
      outcome = {
        changesRequested: true,
        taskId,
        assignmentId,
        title: assignment.title,
        routedTo: authorName,
        reworkCount,
        clearedApprovals,
        findings: cleanFindings,
        version: Number(task.version),
      };
    });
    this.#changed("assignment.changes_requested", taskId);
    return {
      ...outcome,
      next: outcome.routedTo
        ? `“${outcome.title}” is queued again and addressed to ${outcome.routedTo}. It stays claimable by the rest of the room if they are not connected.`
        : `“${outcome.title}” is queued again for whoever picks it up.`,
    };
  }

  // Whether this agent has earned a say on the current version: it either completed a read-only
  // verifier assignment on it (the same evidence approveTask requires) or is holding one right now.
  #hasReviewStanding(agentId, taskId, version) {
    const holding = this.db.prepare(`
      SELECT 1 FROM assignments
      WHERE task_id = ? AND agent_id = ? AND status = 'claimed' AND requires_write = 0
        AND ${VERIFIES} LIMIT 1
    `).get(taskId, agentId);
    if (holding) return true;
    return this.db.prepare(`
      SELECT metadata FROM events
      WHERE task_id = ? AND agent_id = ? AND type = 'assignment.completed'
      ORDER BY id DESC
    `).all(taskId, agentId).some((event) => {
      const metadata = fromJson(event.metadata, {});
      return metadata.version === version
        && this.#assignmentVerifies(metadata.assignmentId)
        && (!Array.isArray(metadata.changedFiles) || metadata.changedFiles.length === 0);
    });
  }

  // Outstanding findings for an assignment: what the author is being asked to fix. Resolved rows are
  // kept so the history of a reworked piece of work stays legible.
  #findingsFor(assignmentId, { includeResolved = false } = {}) {
    return this.db.prepare(`
      SELECT id, requested_by_name, task_version, detail, path, created_at, resolved_at
      FROM assignment_findings
      WHERE assignment_id = ?${includeResolved ? "" : " AND resolved_at IS NULL"}
      ORDER BY created_at ASC, rowid ASC
    `).all(assignmentId);
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
    this.#transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?").run(stamp, taskId);
      this.db.prepare(`
        UPDATE assignments SET status = 'blocked', completed_at = COALESCE(completed_at, ?), claim_token_hash = NULL
        WHERE task_id = ? AND status IN ('queued', 'claimed')
      `).run(stamp, taskId);
      this.db.prepare(`
        UPDATE session_checkpoints SET status = 'cancelled', handoff_token_hash = NULL
        WHERE task_id = ? AND status = 'ready'
      `).run(taskId);
      this.#event(taskId, agentId, "task.blocked", reason.trim(), { kind: blockKind });
      this.#standDownTaskAgents(taskId, stamp, "Task was blocked; co-workers were released to other work.");
    });
    this.#changed("task.blocked", taskId);
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
    return this.#memberTaskIds(agentId).map((room) => this.blockedRecovery(room)).filter(Boolean);
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
    this.#transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'planning', version = version + 1, updated_at = ? WHERE id = ?")
        .run(stamp, taskId);
      this.db.prepare("DELETE FROM approvals WHERE task_id = ?").run(taskId);
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, plans)
        VALUES (?, ?, 'Plan resumed task', ?, ?, 0, ?, 'queued', ?, 1)
      `).run(assignmentId, taskId, `The human resumed this blocked task: ${cleanReason}. Inspect the current project state and create fresh implementation and review assignments; do not revive stale claims.${routing}`, planningRoleName, target, stamp);
      version = this.db.prepare("SELECT version FROM tasks WHERE id = ?").get(taskId).version;
      this.#event(taskId, null, "task.unblocked", `Human resumed the task: ${cleanReason}`, { reason: cleanReason, version, targetAgentName: target });
      this.#event(taskId, null, "assignment.created", "Plan resumed task", {
        assignmentId,
        role: planningRoleName,
        requiresWrite: false,
        targetAgentName: target,
        resumed: true,
      });
    });
    this.#changed("task.unblocked", taskId);
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
    this.#transaction(() => {
      this.db.prepare("UPDATE tasks SET status = 'accepted', updated_at = ? WHERE id = ?").run(stamp, taskId);
      this.#event(taskId, null, "task.accepted",
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
    if (["blocked", "cancelled"].includes(task.status)) throw new Error(this.closedTaskError(task, "continue it"));
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
      const planningRoleName = this.planningRoleFor(task.project_id);
      const title = `Plan follow-up: ${firstLine}`;
      this.db.prepare(`
        INSERT INTO assignments (id, task_id, title, description, role, requires_write, target_agent_name, status, created_at, plans)
        VALUES (?, ?, ?, ?, ?, 0, NULL, 'queued', ?, 1)
      `).run(assignmentId, taskId, title, `Plan the follow-up requested in chat: "${firstLine}". Split it into implementation and review work as needed.`, planningRoleName, stamp);
      this.#event(taskId, byAgentId, "assignment.created", title, { assignmentId, role: planningRoleName, requiresWrite: false, targetAgentName: null, continuesEvent: eventId });
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
      // Every result carries what points at it, so a decision is read together with what depended
      // on it rather than looking equally isolated however load-bearing it turns out to be.
      notes: this.knowledge.search(task.project_id, taskId, { query, category, status, limit })
        .map((note) => ({ ...note, backlinks: this.knowledge.backlinks(note.id, { limit: 5 }) })),
    };
  }

  // An agent recording something it learned, as a first-class vault note rather than prose in a
  // report. Membership-scoped like every other task-shaped action, and written under the agent's own
  // name so the timeline and the note agree about who claimed it.
  knowledgeWrite({ agentId = null, taskId, category, title, body, confidence = "medium", relatedFiles = [] }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const author = agent?.name || "the human";
    const eventId = this.#event(taskId, agentId, "agent.finding", `${author} recorded: ${String(title || "").trim()}`, {
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
    this.#changed("knowledge.written", taskId);
    return { ...result, vaultPath: path.join(task.project_root, "knowledge") };
  }

  // Knowledge maintenance, all membership-scoped through a task room like every other agent action.

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
  }

  // Say a note still holds. This is the only thing that resets its age, which is what keeps the
  // decay honest: re-reading a note is not confirmation, checking it against the project is.
  knowledgeConfirm({ agentId = null, taskId, noteId }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const result = this.knowledge.confirmNote(task.project_id, noteId, { author: agent?.name || "the human" });
    if (!result.confirmed) throw new Error("Note not found in this project.");
    this.#event(taskId, agentId, "agent.finding", `${agent?.name || "The human"} confirmed a knowledge note still holds.`, { noteId, confirmed: true });
    this.#changed("knowledge.confirmed", taskId);
    return result;
  }

  // Mark notes as disagreeing. Both drop to `disputed`, which briefs and searches already exclude, so
  // a contested fact stops being served as truth immediately rather than once someone resolves it.
  knowledgeDispute({ agentId = null, taskId, noteIds, reason }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const result = this.knowledge.disputeNotes(task.project_id, noteIds, reason);
    if (!result.disputed) throw new Error("Give at least two note IDs from this project that disagree.");
    this.#event(taskId, agentId, "agent.finding",
      `${agent?.name || "The human"} flagged ${result.disputed} knowledge notes as contradicting each other.`,
      { noteIds: result.noteIds, reason: String(reason || "").slice(0, 500) });
    this.#changed("knowledge.disputed", taskId);
    return { ...result, next: "Disputed notes are excluded from briefings until resolved. Decide which is right and write over the other, or raise it with devteam_propose." };
  }

  // Offer a note to other projects, or withdraw it.
  knowledgeShare({ agentId = null, taskId, noteId, shared = true }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    const agent = agentId ? this.getAgent(agentId) : null;
    const result = this.knowledge.shareNote(task.project_id, noteId, { shared });
    this.#event(taskId, agentId, "agent.finding",
      `${agent?.name || "The human"} ${shared ? "shared a lesson with other projects" : "withdrew a lesson from other projects"}.`,
      { noteId, shared: Boolean(shared) });
    this.#changed("knowledge.shared", taskId);
    return result;
  }

  // Lessons other projects have chosen to share. Kept out of the ordinary knowledge path on purpose:
  // an agent asks for them, and every one says where it came from and that it needs confirming here.
  knowledgeShared({ agentId = null, taskId, query = "", limit = 10 }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    return { notes: this.knowledge.sharedFromOtherProjects(task.project_id, { query, limit }) };
  }

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
  }

  codeGraphSearch({ agentId = null, taskId, path: modulePath }) {
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    this.assertMembership(agentId, taskId);
    return {
      automated: this.codegraph.enabled,
      graphPath: path.join(task.project_root, "knowledge", "graph"),
      ...this.codegraph.neighborhood(taskId, modulePath),
    };
  }

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
  }

  // The one-line version of whyNotClaimable, for a card with room for a single sentence. It
  // delegates rather than re-deriving the cases, so the hold shown on the dashboard and the chain
  // an agent reads over MCP can never disagree. Dependencies are left out here only because the
  // same card already lists them as blockedBy.
  #schedulingHold(assignment) {
    if (assignment.status !== "queued") return null;
    const HOLD_PRECEDENCE = ["awaiting_writer", "write_lease_conflict", "verifier_is_author", "target_absent"];
    const { reasons } = this.whyNotClaimable(assignment.id);
    for (const code of HOLD_PRECEDENCE) {
      const hold = reasons.find((reason) => reason.code === code);
      if (hold) return { reason: hold.code, detail: hold.detail };
    }
    return null;
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
      const assessment = this.#assessmentRecord(this.db.prepare(`
        SELECT * FROM complexity_assessments WHERE assignment_id = ? AND invalidated_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(assignment.id));
      const runtimeDecision = this.#runtimeDecisionRecord(this.db.prepare(`
        SELECT * FROM runtime_decisions WHERE assignment_id = ? ORDER BY created_at DESC LIMIT 1
      `).get(assignment.id));
      return {
        ...assignment,
        checklist: this.#checklistFor(assignment.id),
        writeScope: assignment.requires_write ? this.#writeScopeFor(assignment.id) : [],
        dependsOn: dependencies.map((item) => item.id),
        blockedBy: dependencies.filter((item) => item.status !== "done"),
        checks: this.#checksFor(assignment.id),
        findings: this.#findingsFor(assignment.id),
        resolvedFindings: this.#findingsFor(assignment.id, { includeResolved: true }).filter((finding) => finding.resolved_at),
        schedulingHold: this.#schedulingHold(assignment),
        assessment,
        // The score in the words the human uses for their own models. "Base · Score 0" is DevTeam's
        // vocabulary, not anyone else's; "Needs Sonnet 5 · medium" is the same fact said usefully.
        needsRung: assessment ? this.#rungLabelFor(task.project_id, assessment.level) : null,
        runtimeDecision,
      };
    });
    // The roles this project understands travel with the task, so the dashboard's assignment form
    // offers the project's own vocabulary rather than a hardcoded list of software job titles.
    const roleCatalogue = this.roleCatalogue(task.project_id);
    const members = this.db.prepare(`
      SELECT m.role, ag.id AS agent_id, ag.name AS agent_name, ag.provider AS agent_provider, ag.status
      FROM task_members m JOIN agents ag ON ag.id = m.agent_id
      WHERE m.task_id = ? ORDER BY m.joined_at ASC
    `).all(taskId).map((member) => ({ ...member, runtimeProfile: this.#runtimeProfileRecord(
      this.db.prepare("SELECT * FROM agent_runtime_profiles WHERE agent_id = ?").get(member.agent_id),
    ) }));
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
    const knowledgeLifecycle = Object.fromEntries(["verified", "inferred", "disputed", "stale", "archived"].map((status) => [status, 0]));
    for (const row of this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM knowledge_notes WHERE project_id = ? GROUP BY status
    `).all(task.project_id)) knowledgeLifecycle[row.status] = Number(row.count);
    const codeGraphState = this.codegraph.projectState(task.project_id);
    const sessionCheckpoints = this.sessionCheckpointsForTask(taskId);
    return {
      ...task, assignments, approvals, events, proposals, blackboard, projectBlackboard, knowledge, members, sessionCheckpoints, roleCatalogue,
      blockedRecovery: this.blockedRecovery(taskId),
      regressions: this.openRegressions(taskId), checkBaseline: this.checkBaseline(taskId),
      reliability: this.teamReliability(), usage: this.taskUsage(taskId),
      // What this server has been running for the task, including anything a restart cut short.
      jobs: this.jobs(taskId, { limit: 10 }),
      knowledgeVault: {
        automated: this.knowledge.enabled,
        path: path.join(task.project_root, "knowledge"),
        noteCount: knowledge.length,
        error: this.knowledgeErrors.get(taskId) || this.knowledgeErrors.get(`project:${task.project_id}`) || null,
      },
      codeGraph: {
        automated: this.codegraph.enabled,
        path: path.join(task.project_root, "knowledge", "graph"),
        moduleCount: codeGraphState?.moduleCount || 0,
        edgeCount: codeGraphState?.edgeCount || 0,
        truncated: Boolean(codeGraphState?.truncated),
        indexedAt: codeGraphState?.indexedAt || null,
        error: this.codegraphErrors.get(`project:${task.project_id}`) || null,
      },
      memoryHealth: {
        brief: this.briefHealth.get(taskId) || {
          version: 1,
          bytes: null,
          limitBytes: DEFAULT_BRIEF_BUDGET.totalBytes,
          truncated: null,
          included: {},
          omitted: {},
          clipped: {},
          generatedAt: null,
        },
        taskMemoryCount: blackboard.length,
        projectMemoryCount: projectBlackboard.length,
        knowledge: knowledgeLifecycle,
        knowledgeError: this.knowledgeErrors.get(taskId) || this.knowledgeErrors.get(`project:${task.project_id}`) || null,
        graphIndexedAt: codeGraphState?.indexedAt || null,
        graphTruncated: Boolean(codeGraphState?.truncated),
        graphError: this.codegraphErrors.get(`project:${task.project_id}`) || null,
      },
    };
  }

  taskBrief(agentId, taskId, {
    currentAssignment: assignmentOverride = null,
    assignmentKey = "currentAssignment",
    responseCore = {},
    pendingMessages = [],
    pendingProposals = [],
  } = {}) {
    this.getAgent(agentId);
    this.assertMembership(agentId, taskId);
    const task = this.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    const errorKey = task ? `project:${task.project_id}` : null;
    try {
      this.codegraph.reconcileTask(taskId);
      if (errorKey) this.codegraphErrors.delete(errorKey);
    } catch (error) {
      if (errorKey) this.codegraphErrors.set(errorKey, { message: error.message, at: now() });
      this.emit("codegraph-error", { taskId, type: "codegraph.brief", error });
    }
    const clipped = {};
    const clip = (value, maxBytes, key) => {
      const result = clipUtf8(value, maxBytes);
      if (result.truncated) clipped[key] = (clipped[key] || 0) + 1;
      return result.value;
    };
    const boundedPendingMessages = (Array.isArray(pendingMessages) ? pendingMessages : []).slice(0, 50).map((message) => ({
      id: message.id,
      taskId: message.taskId,
      message: clip(message.message, 1_200, "pendingMessageBodies"),
      from: clip(message.from, 200, "pendingMessageAuthors"),
      target: clip(message.target, 200, "pendingMessageTargets"),
      broadcast: Boolean(message.broadcast),
      at: message.at,
    }));
    const boundedPendingProposals = (Array.isArray(pendingProposals) ? pendingProposals : []).slice(0, 20).map((proposal) => ({
      id: proposal.id,
      taskId: proposal.taskId,
      kind: proposal.kind,
      summary: clip(proposal.summary, 800, "pendingProposalSummaries"),
      proposer: proposal.proposer ? clip(proposal.proposer, 200, "pendingProposalAuthors") : null,
      details: proposal.details,
    }));
    const assignmentRows = this.db.prepare(`
      SELECT a.id, a.task_id, substr(a.title, 1, 1200) AS title,
             substr(a.description, 1, 2400) AS description, a.role, a.requires_write,
             a.target_agent_name, a.agent_id, a.status, a.created_at, a.claimed_at,
             a.claim_generation, ag.name AS agent_name
      FROM assignments a LEFT JOIN agents ag ON ag.id = a.agent_id
      WHERE a.task_id = ? AND a.status IN ('queued', 'claimed')
      ORDER BY a.created_at ASC LIMIT 80
    `).all(taskId);
    const assignmentTotal = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM assignments WHERE task_id = ? AND status IN ('queued', 'claimed')
    `).get(taskId).count);
    const dependencySummary = (assignmentId, maxItems = 12) => {
      const dependencies = this.#dependenciesFor(assignmentId);
      return {
        dependsOn: dependencies.slice(0, maxItems).map((item) => item.id),
        blockedBy: dependencies.filter((item) => item.status !== "done").slice(0, maxItems).map((item) => ({
          id: item.id,
          title: clip(item.title, 240, "assignmentDependencyTitles"),
          status: item.status,
          role: item.role,
        })),
        omitted: Math.max(0, dependencies.length - maxItems),
      };
    };
    const openAssignments = assignmentRows.map((assignment) => {
      const dependencies = dependencySummary(assignment.id, 8);
      return {
        id: assignment.id,
        title: clip(assignment.title, 360, "assignmentTitles"),
        description: clip(assignment.description, 900, "assignmentDescriptions"),
        role: clip(assignment.role, 100, "assignmentRoles"),
        status: assignment.status,
        agent: assignment.agent_name ? clip(assignment.agent_name, 200, "assignmentAgentNames") : null,
        dependsOn: dependencies.dependsOn,
        blockedBy: dependencies.blockedBy,
      };
    });
    let currentSource = assignmentOverride;
    if (!currentSource) {
      currentSource = this.db.prepare(`
        SELECT a.*, ag.name AS agent_name FROM assignments a
        LEFT JOIN agents ag ON ag.id = a.agent_id
        WHERE a.task_id = ? AND a.agent_id = ? AND a.status = 'claimed' LIMIT 1
      `).get(taskId, agentId) || null;
    }
    const mandatoryOmitted = {};
    let currentAssignment = null;
    if (currentSource) {
      const dependencies = dependencySummary(currentSource.id, 20);
      const checklist = (Array.isArray(currentSource.checklist) ? currentSource.checklist : this.#checklistFor(currentSource.id));
      const writeScope = currentSource.requires_write
        ? (Array.isArray(currentSource.writeScope) ? currentSource.writeScope : this.#writeScopeFor(currentSource.id))
        : [];
      mandatoryOmitted.currentAssignmentChecklist = Math.max(0, checklist.length - 12);
      mandatoryOmitted.currentAssignmentWriteScope = Math.max(0, writeScope.length - 12);
      mandatoryOmitted.currentAssignmentDependencies = dependencies.omitted;
      currentAssignment = {
        id: currentSource.id,
        task_id: currentSource.task_id,
        taskId: currentSource.task_id,
        title: clip(currentSource.title, 500, "currentAssignmentTitle"),
        description: clip(currentSource.description, 1_600, "currentAssignmentDescription"),
        role: clip(currentSource.role, 100, "currentAssignmentRole"),
        status: currentSource.status,
        requires_write: Number(Boolean(currentSource.requires_write)),
        requiresWrite: Boolean(currentSource.requires_write),
        target_agent_name: currentSource.target_agent_name || null,
        agent_id: currentSource.agent_id || null,
        agent: currentSource.agent_name ? clip(currentSource.agent_name, 200, "currentAssignmentAgent") : null,
        claimed_at: currentSource.claimed_at || null,
        checklist: checklist.slice(0, 12).map((item) => clip(item, 180, "currentAssignmentChecklistItems")),
        writeScope: writeScope.slice(0, 12).map((item) => clip(item, 300, "currentAssignmentWriteScopeItems")),
        dependsOn: dependencies.dependsOn,
        blockedBy: dependencies.blockedBy,
        task_title: clip(currentSource.task_title || task.title, 600, "currentAssignmentTaskTitle"),
        task_description: clip(currentSource.task_description || task.description, 2_003, "currentAssignmentTaskDescription"),
        task_version: Number(currentSource.task_version ?? task.version),
        required_approvals: Number(currentSource.required_approvals ?? task.required_approvals),
        project_root: clip(currentSource.project_root || task.project_root, 2_000, "currentAssignmentProjectRoot"),
        project_name: clip(currentSource.project_name || task.project_name, 400, "currentAssignmentProjectName"),
        claimGeneration: Number(currentSource.claimGeneration ?? currentSource.claim_generation ?? 0),
        assessment: this.#assessmentForBrief(this.db.prepare(`
          SELECT * FROM complexity_assessments WHERE assignment_id = ? AND invalidated_at IS NULL
          ORDER BY created_at DESC LIMIT 1
        `).get(currentSource.id), { gated: Boolean(this.runtimeProfile(agentId)) }),
        runtimeProfile: this.runtimeProfile(agentId),
        ...(currentSource.claimToken ? { claimToken: currentSource.claimToken } : {}),
      };
    }
    const taskMemoryTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM blackboard WHERE task_id = ?").get(taskId).count);
    const taskMemory = this.db.prepare(`
      SELECT key, substr(value, 1, 4096) AS value, version, updated_by_name, updated_at
      FROM blackboard WHERE task_id = ? ORDER BY key ASC LIMIT 80
    `).all(taskId).map((note) => ({
      scope: "task",
      key: clip(note.key, 300, "taskMemoryKeys"),
      value: clip(note.value, 2_003, "taskMemoryValues"),
      version: note.version,
      updatedBy: note.updated_by_name ? clip(note.updated_by_name, 200, "taskMemoryAuthors") : null,
      updatedAt: note.updated_at,
    }));
    const projectMemoryTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM project_blackboard WHERE project_id = ?").get(task.project_id).count);
    const projectMemory = this.db.prepare(`
      SELECT key, substr(value, 1, 4096) AS value, version, updated_by_name, updated_at
      FROM project_blackboard WHERE project_id = ? ORDER BY key ASC LIMIT 80
    `).all(task.project_id).map((note) => ({
      scope: "project",
      key: clip(note.key, 300, "projectMemoryKeys"),
      value: clip(note.value, 2_003, "projectMemoryValues"),
      version: note.version,
      updatedBy: note.updated_by_name ? clip(note.updated_by_name, 200, "projectMemoryAuthors") : null,
      updatedAt: note.updated_at,
    }));
    const knowledgeTotal = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM knowledge_notes
      WHERE project_id = ? AND status IN ('verified', 'inferred')
    `).get(task.project_id)?.count || 0);
    const openProposalTotal = Number(this.db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE task_id = ? AND status = 'open'").get(taskId).count);
    const pendingProposalIds = new Set(boundedPendingProposals.filter((proposal) => proposal.taskId === taskId).map((proposal) => proposal.id));
    const openProposals = this.db.prepare(`
      SELECT id, kind, substr(summary, 1, 1600) AS summary FROM proposals
      WHERE task_id = ? AND status = 'open' ORDER BY created_at ASC LIMIT 30
    `).all(taskId).filter((proposal) => !pendingProposalIds.has(proposal.id)).map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      summary: clip(proposal.summary, 800, "proposalSummaries"),
      votes: this.db.prepare(`
        SELECT voter_name, vote, substr(comment, 1, 600) AS comment, created_at
        FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at ASC LIMIT 20
      `).all(proposal.id).map((vote) => ({ ...vote, comment: vote.comment ? clip(vote.comment, 300, "proposalVoteComments") : null })),
    }));
    const recentTypes = ["human.message", "agent.decision", "agent.finding", "task.blocked", "task.unblocked", "task.accepted"];
    const typePlaceholders = recentTypes.map(() => "?").join(", ");
    const recentTotal = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE task_id = ? AND type IN (${typePlaceholders})`).get(taskId, ...recentTypes).count);
    const recent = this.db.prepare(`
      SELECT recent.*, ag.name AS agent_name FROM (
        SELECT id, agent_id, type, substr(message, 1, 1600) AS message, created_at
        FROM events WHERE task_id = ? AND type IN (${typePlaceholders})
        ORDER BY id DESC LIMIT 12
      ) recent LEFT JOIN agents ag ON ag.id = recent.agent_id ORDER BY recent.id ASC
    `).all(taskId, ...recentTypes).map((event) => ({
      id: event.id,
      type: event.type,
      from: event.agent_name ? clip(event.agent_name, 200, "activityAuthors") : "human",
      message: clip(event.message, 800, "activityMessages"),
      at: event.created_at,
    }));
    const unresolvedWhere = `
      q.task_id = ? AND q.type = 'agent.question' AND NOT EXISTS (
        SELECT 1 FROM events reply
        WHERE reply.task_id = q.task_id AND CAST(json_extract(reply.metadata, '$.replyTo') AS INTEGER) = q.id
      )
    `;
    const unresolvedTotal = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events q WHERE ${unresolvedWhere}`).get(taskId).count);
    const unresolvedQuestions = this.db.prepare(`
      SELECT recent.*, ag.name AS agent_name FROM (
        SELECT q.id, q.agent_id, substr(q.message, 1, 1600) AS message, q.created_at
        FROM events q WHERE ${unresolvedWhere} ORDER BY q.id DESC LIMIT 10
      ) recent LEFT JOIN agents ag ON ag.id = recent.agent_id ORDER BY recent.id ASC
    `).all(taskId).map((event) => ({
      id: event.id,
      from: event.agent_name ? clip(event.agent_name, 200, "questionAuthors") : "agent",
      message: clip(event.message, 800, "questionMessages"),
      at: event.created_at,
    }));
    let codeContext = this.codegraph.enabled ? [] : null;
    try { codeContext = this.codegraph.codeContext(taskId, { assignmentId: currentAssignment?.id || null, maxBytes: DEFAULT_BRIEF_BUDGET.codeContextBytes }); }
    catch (error) {
      if (errorKey) this.codegraphErrors.set(errorKey, { message: error.message, at: now() });
      this.emit("codegraph-error", { taskId, type: "codegraph.context", error });
    }
    const recentChangedFiles = this.db.prepare(`
      SELECT metadata FROM events WHERE task_id = ?
        AND type IN ('assignment.completed', 'assignment.blocked') ORDER BY id DESC LIMIT 30
    `).all(taskId).flatMap((event) => {
      const metadata = fromJson(event.metadata, {});
      return Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
    });
    const codePaths = (codeContext || []).flatMap((module) => [module.path, ...(module.imports || []), ...(module.importedBy || [])]);
    const projectKnowledge = this.knowledge.relevant(task.project_id, taskId, 30, {
      taskTitle: task.title,
      taskDescription: task.description,
      taskVersion: task.version,
      taskUpdatedAt: task.updated_at,
      assignmentTitle: currentAssignment?.title,
      assignmentDescription: currentAssignment?.description,
      role: currentAssignment?.role,
      checklist: currentAssignment?.checklist || [],
      declaredPaths: [...(currentAssignment?.writeScope || []), ...recentChangedFiles],
      codePaths,
      memoryKeys: [...taskMemory.map((note) => note.key), ...projectMemory.map((note) => note.key)],
      unresolvedQuestions: unresolvedQuestions.map((question) => question.message),
      blockers: (currentAssignment?.blockedBy || []).map((blocker) => blocker.title),
    }).map((note) => ({
      ...note,
      title: clip(note.title, 360, "knowledgeTitles"),
      // Only the few notes that carry a body pay for one. The rest arrive as a headline and a
      // wikilink, which devteam_memory reads in full when the agent decides it matters.
      ...(note.body === undefined ? {} : { body: clip(note.body, 1_400, "knowledgeBodies") }),
      relatedFiles: (note.relatedFiles || []).slice(0, 8).map((file) => clip(file, 400, "knowledgePaths")),
    }));
    const sessionCheckpoint = this.db.prepare(`
      SELECT * FROM session_checkpoints WHERE task_id = ? AND status IN ('ready', 'claimed')
      ORDER BY CASE status WHEN 'ready' THEN 0 ELSE 1 END, checkpoint_generation DESC LIMIT 1
    `).get(taskId);
    const brief = buildBudgetedBrief({
      core: {
        ...responseCore,
        task: {
          id: task.id,
          title: clip(task.title, 600, "taskTitle"),
          description: clip(task.description, 2_003, "taskDescription"),
          status: task.status,
          version: task.version,
          project: {
            id: task.project_id,
            name: clip(task.project_name, 400, "projectName"),
            root: clip(task.project_root, 2_000, "projectRoot"),
          },
        },
        sessionCheckpoint: sessionCheckpoint ? this.#checkpointRecord(sessionCheckpoint) : null,
        [assignmentKey]: currentAssignment,
        claimInstructions: "Retain the claim token privately, inspect the current project state before writing, stay inside the declared write scope, and pass the token to devteam_report so stale work is fenced.",
      },
      clipped,
      omitted: mandatoryOmitted,
      sections: [
        { key: "openAssignments", group: "assignments", items: openAssignments, totalCount: assignmentTotal, maxItems: 30, maxBytes: DEFAULT_BRIEF_BUDGET.assignmentBytes },
        { key: "taskMemory", group: "taskMemory", items: taskMemory, totalCount: taskMemoryTotal, maxItems: 20, maxBytes: DEFAULT_BRIEF_BUDGET.taskMemoryBytes },
        { key: "projectMemory", group: "projectMemory", items: projectMemory, totalCount: projectMemoryTotal, maxItems: 16, maxBytes: DEFAULT_BRIEF_BUDGET.projectMemoryBytes },
        { key: "projectKnowledge", group: "knowledge", items: projectKnowledge, totalCount: knowledgeTotal, maxItems: 12, maxBytes: DEFAULT_BRIEF_BUDGET.knowledgeBytes },
        { key: "codeContext", group: "codeContext", items: codeContext || [], emptyValue: this.codegraph.enabled ? [] : null, totalCount: codeContext?.length || 0, maxItems: 30, maxBytes: DEFAULT_BRIEF_BUDGET.codeContextBytes },
        { key: "pendingMessages", group: "activity", items: boundedPendingMessages, totalCount: Array.isArray(pendingMessages) ? pendingMessages.length : 0, maxItems: 20, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "pendingProposals", group: "activity", items: boundedPendingProposals, totalCount: Array.isArray(pendingProposals) ? pendingProposals.length : 0, maxItems: 10, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "openProposals", group: "activity", items: openProposals, totalCount: Math.max(0, openProposalTotal - pendingProposalIds.size), maxItems: 10, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "recent", group: "activity", items: recent, totalCount: recentTotal, maxItems: 12, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
        { key: "unresolvedQuestions", group: "activity", items: unresolvedQuestions, totalCount: unresolvedTotal, maxItems: 10, maxBytes: DEFAULT_BRIEF_BUDGET.activityBytes },
      ],
    });
    const health = {
      ...brief.briefMeta,
      generatedAt: now(),
      assignmentId: currentAssignment?.id || null,
      delivery: assignmentKey === "assignment" ? "automatic" : "requested",
    };
    const previous = this.briefHealth.get(taskId);
    this.briefHealth.set(taskId, health);
    if (!previous || previous.bytes !== health.bytes || previous.truncated !== health.truncated
      || JSON.stringify(previous.omitted) !== JSON.stringify(health.omitted)) {
      this.emit("change", { type: "brief.health", taskId, at: health.generatedAt });
    }
    return brief;
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
  // room the agent belongs to, so a no-taskId devteam_next with want=state never hands a non-member another
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
