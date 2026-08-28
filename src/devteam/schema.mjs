// The database schema, and every migration that has ever been applied to it.
//
// Extracted from DevTeamStore verbatim. It was 388 lines inside a class whose other 170 methods
// are about scheduling and consensus, and it touched exactly one thing on `this` — the database
// handle. A free function taking that handle says so, and keeps the store's own file about what
// the store does rather than about what its tables look like.
//
// Every statement is idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and
// ALTER TABLE ADD COLUMN guarded by try/catch. It runs on every open, not just on a fresh one.
export function applySchema(db) {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_complexity_assignment ON complexity_assessments(assignment_id, created_at DESC);
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
    ["agents", "session_generation", "INTEGER NOT NULL DEFAULT 1"],
    ["agents", "fresh_task_id", "TEXT"],
    ["agents", "replaced_by_agent_id", "TEXT"],
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
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); } catch { /* already present */ }
  }
  // Rows written before role behaviour was a column carry the software role names that used to be
  // hardcoded. Backfill them from exactly those names, once, so an existing database schedules
  // identically after the upgrade. Guarded by a metadata key rather than repeated on every start:
  // re-deriving these from config each boot would silently rewrite the snapshot an assignment was
  // created under whenever a project edited its roles.
  if (!db.prepare("SELECT value FROM metadata WHERE key = 'role_behaviour_backfilled'").get()) {
    db.exec(`
      UPDATE assignments SET verifies = 1
        WHERE lower(role) IN ('reviewer', 'security-reviewer', 'tester');
      UPDATE assignments SET plans = 1 WHERE lower(role) = 'planner';
    `);
    db.prepare("INSERT INTO metadata (key, value) VALUES ('role_behaviour_backfilled', ?)").run(new Date().toISOString());
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
  db.exec(`
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
