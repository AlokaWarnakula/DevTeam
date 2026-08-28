# Prompt for the next session

Copy everything below the line into a fresh session (Claude or Codex) in
`C:\Users\aloka\Mine\Projects\DevTeam`.

---

You are working in DevTeam, a local Node + SQLite MCP coordination server with a browser dashboard
that lets AI agents work a project together. Everything is on `main`, tree clean, **277 tests
passing** (`npm test`). Read `REDESIGN.md` first — especially section 16, which is the cold-start
handoff — and `MEMORY.md`/`memory/` if you have access to it.

## The job, in two phases. Do NOT start phase B until phase A is finished and green.

### Phase A — delete the unreachable code in `src/devteam/store.mjs`

The file is **6,194 lines and 196 methods in a single class**. Several features were retired from the
MCP surface, the REST routes and the dashboard, but their implementations are still inside it. They
are unreachable — no tool, no route, no UI control can call them — so this is hygiene, not a bug
hunt, and nothing about behaviour should change.

Delete, in this order, one feature per commit, tests green between each:

1. `assignment_usage` — agent-reported cost. 0 rows. Entry point already removed from the report
   schema; `#recordUsage` and `taskUsage` remain.
2. The **budget cap** — `budget_minutes`, `budget_usd_cents`, `taskBudgetState`. 0 tasks ever used it.
3. The **runtime gate** — `#runtimeGate`, `runtimeProfile`, `runtimeDecision`, `agent_runtime_profiles`.
   0 profiles ever stored. **Do not touch `complexity_assessments`** — the score is live and feeds
   both the brief and the model ladder.
4. **Session checkpoints** — the largest, ~118 references. `checkpoint.mjs`, `session_checkpoints`,
   `createSessionCheckpoint`, `sessionCheckpointGet`, `cancelSessionCheckpoint`,
   `takeoverSessionCheckpoint`, `#checkpointRecord`, `#expireSessionCheckpoints`, and
   `test/devteam-checkpoint.test.mjs`.

**Three traps. Two of these already cost a previous session two reverted attempts.**

- **`#participantLineage` follows *claimed checkpoints*** to trace one identity across a session
  handoff, and **the "an agent may never verify work it authored" invariant depends on that
  lineage**. When checkpoints go, lineage collapses to identity. Make that change deliberately, in
  its own commit, and run `test/devteam-scheduler-properties.test.mjs` before and after.
- **The budget feeds `steeringFor`**, the live path that carries "stop, this is no longer worth
  doing" to a busy agent. `cancel_requested_at` is the primary signal there and **must survive**.
- **Never remove code by line number.** Two previous attempts spliced the wrong region because line
  numbers shifted between edits. Anchor on unique text, verify with `node -e "import('./src/devteam/store.mjs')"`,
  and re-grep after every change.

Do **not** delete these, despite having zero rows — each was checked and kept deliberately:

- **Named access tokens** — still reachable from the CLI; the answer for reaching DevTeam beyond
  localhost.
- **`project_check_commands`** — empty only because `.devteam/checks.json` was never written. It is
  the difference between "the tests pass" and "an agent said the tests pass".
- **Project-scoped blackboard** — one column's difference from task memory, and a real capability.

### Phase B — split `store.mjs` by composing mixins

Only after phase A. The method names already cluster: tasks + consensus (27), agents + sessions (16),
memory + briefs (12), scheduler + assignments (11), checks (8).

Use **mixins, not collaborator classes**. `store.mjs` keeps the class, the constructor, the
migrations and the shared privates (`#transaction`, `#event`, `#changed`, `#hashToken`); each cluster
becomes a file whose methods are composed onto the prototype. Reason: this is one class over one
SQLite connection with heavy private-method calls across clusters. Collaborator classes would force
every crossing private to become public — a real redesign of the internals, with the risk landing on
the work queue. Mixins change no call sites and mostly preserve `git blame`.

Private `#name` fields cannot cross a mixin boundary. Where a cluster needs one, either leave that
method in `store.mjs` or rename the member to a documented internal (`_name`) in its own commit —
never silently.

## Rules for the whole job

- `npm test` between every step. 277 passing is the floor; it must never go down except where you
  delete a test for a feature you removed, and then say so in the commit message.
- `npm run soak` and `npm run mutation` after phase A finishes and again after phase B.
  **`tools/mutate-scheduler.mjs` edits `store.mjs` in place — never run it with uncommitted changes
  to that file.**
- Never point a knowledge- or codegraph-enabled test at `process.cwd()`. That is what deleted this
  project's own knowledge vault once already; a vault now records its owner in
  `knowledge/.devteam-vault`, but do not lean on that guard.
- Line endings: blobs are LF, this machine checks out CRLF. `git status` may show files as modified
  with an empty `git diff` — that is the EOL artifact, not a change.
- One feature per commit. Commit messages should say what was removed and what proves it was
  unreachable, not just "cleanup".
- If something is reachable after all, stop and say so rather than deleting it.

## Done looks like

- `store.mjs` materially smaller, with no `session_checkpoints`, `agent_runtime_profiles`,
  `assignment_usage` or budget code left in it.
- The scheduler, the write leases, the author-cannot-verify-own-work invariant and the model ladder
  all behave exactly as before — same tests, same results.
- `npm test`, `npm run soak` and `npm run mutation` all green.
- A short section appended to `REDESIGN.md` recording what came out and how the file is now
  organised.

Start by reading `REDESIGN.md` section 16, then `git log --oneline -20` to see how this work has been
committed so far, then tell me your plan before you change anything.
