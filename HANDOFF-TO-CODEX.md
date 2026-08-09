# Handoff: DevTeam → collective-mind work, increments 4+

**From:** Claude (Anthropic Claude Code)
**To:** Codex (continuing this work — human is switching tools to conserve credits)
**Date:** 2026-08-09
**Repo:** `C:\Users\aloka\Mine\Projects\bridge` (`local-devteam` v0.2.0)
**Current test status:** `node --test` → **36/36 passing**

This file is self-contained. Read it before touching code — it tells you what's already fixed,
why, and exactly what's left, with file/function references so you don't have to rediscover
anything by re-reading the whole codebase.

---

## 0. Context: why this work exists

The human is using DevTeam to run Claude + Codex (+ other agents) as one coordinated team on
local projects. While using it for real, we hit a bug: a busy agent (thinking/writing) got
silently reaped and its write lease handed to another agent mid-task — agents were fighting each
other instead of collaborating. That triggered three audits:

- `COORDINATION-HEARTBEAT-FIX.md` (Claude) — root cause of the reap bug
- `DEVTEAM-LIVENESS-AND-LEASE-PLAN.md` (Codex) — deeper lease-fencing design, caught the
  name-collision eviction hazard
- `DEVTEAM-HIVE-COLLECTIVE-MIND-AUDIT.md` (Codex) — found three P0 trust/isolation bugs:
  **agent impersonation**, **global work-claiming across projects**, **message/vote leakage
  across tasks**
- `HIVE-MIND-COORDINATION-GAPS.md` (Claude) — reachability, parallelism, consensus, security gaps
- `DEVTEAM-COLLECTIVE-MIND-ROADMAP.md` — all four merged into one prioritized backlog + phased plan

**Read `DEVTEAM-COLLECTIVE-MIND-ROADMAP.md` for the full backlog with severities.** This handoff
only covers what's shipped and what's left, in enough detail to continue directly.

The human's stated goal: **"I want to work with many AI [agents] for collective hive mind."**
Every fix should be evaluated against that — not just "is it safe" but "does it let independent
models actually collaborate as one team."

---

## 1. What's shipped (increments 1–3, all tested, all green)

Full technical detail is in `DEVTEAM-CHANGES-2026-08-09.md` — read it, it's accurate and complete.
Summary:

### Increment 1 — trust, liveness, isolation (34 tests)
1. **Session-bound identity** (`src/devteam/mcp.mjs`, `server.mjs`): an MCP tool call can only
   act as the `agentId` that connected on *that* MCP session (`requireIdentity` helper). Fixes
   impersonation.
2. **REST origin/host guard** (`server.mjs`, `apiGuard` on `/api`): rejects non-loopback `Host`
   and foreign `Origin` on mutating requests. Fixes the open-injection-into-the-room bug.
3. **Status-aware liveness** (`store.mjs`, `#reapStaleAgents` rewritten): a silent **busy** agent
   is marked `unresponsive` but **keeps its write lease** — silence never transfers a write claim.
   Only explicit disconnect, confirmed MCP transport close (`handleTransportClose`), same-identity
   reconnect, or human `forceReleaseAssignment` (title-confirmed) can move a write lease. Read-only
   claims are still auto-recovered after a long silence (`staleWorkMs`, default 15 min).
4. **Task-room membership** (`store.mjs`: `task_members` table, `joinTask`, `#memberTaskIds`,
   `#connectedMemberIds`; `mcp.mjs`: `devteam_join`, optional `taskId` on `devteam_connect`):
   claiming, message delivery, unread counts, proposal visibility, and the consensus voter set are
   all scoped to an agent's task room. Derived membership: explicit joins win; with exactly one
   active task in the store, an agent is implicitly a member (keeps single-task use zero-config).

### Increment 2 — reachability (35 tests)
5. **Busy agents are reachable** (`mcp.mjs`, `withInbox` wrapper): every mutating/query tool
   (`devteam_state`, `_report`, `_message`, `_assign`, `_approve`, `_vote`, `_propose`, `_join`)
   piggybacks any pending directed messages onto its result as `pendingMessages`. An agent mid-work
   gets reached on its next action, not only when idle in `devteam_wait`.
6. **Agent→agent directed messages** (`store.mjs`: `postMessage` gained `metadata.target`,
   `#messageIsForAgent`, `deliverDirectedMessages` now also delivers directed `agent.*` events;
   `mcp.mjs`: `devteam_message` gained a `target` param): one agent can now address another by
   name; the message is pushed, not just logged.

### Increment 3 — parallelism (36 tests)
7. **Path-scoped write leases** (`store.mjs`: new `assignment_write_scopes` table,
   `#heldWriteLeases`, `#writeScopeFor`, `#normalizeScope`, `#scopesOverlap`; `claimNextAssignment`
   rewritten to grant write claims per-path instead of per-project; `mcp.mjs`: `devteam_assign`
   gained a `paths` param): two agents can now hold write leases on the same project
   **simultaneously** as long as their declared paths don't overlap (e.g. `src/ocean/**` vs
   `src/hud`). No `paths` declared = old exclusive whole-project lease (backward compatible).

**Contract changes to know about:**
- Agent status can now be `unresponsive` (was: only `waiting`/`busy`/`disconnected`). Update any
  code/dashboard logic that switches on agent status to handle it (see gap in "not yet done" below
  — the dashboard doesn't render it yet).
- On a server hosting **more than one active task**, agents must call `devteam_join` (or pass
  `taskId` to `devteam_connect`) or they belong to no room and `claimNextAssignment` returns null.
- `/api/config` now returns a `liveness` block (`{ presenceMs, staleWorkMs }`).
- Claimed write assignments now carry a `writeScope` (array of normalized path prefixes) in the
  claim result and in the `assignment.claimed` event metadata.

**Verify anytime:**
```bash
cd "C:/Users/aloka/Mine/Projects/bridge" && node --test
```
All 36 must stay green. If you touch `store.mjs` or `mcp.mjs`, expect to update
`test/devteam-store.test.mjs` and/or `test/devteam-server.test.mjs` alongside.

---

## 2. What's NOT done yet — the remaining backlog

In priority order (matches `DEVTEAM-COLLECTIVE-MIND-ROADMAP.md` §5, phases 4+; phases 0–3 are the
increments above).

### A. Lease fencing — claim tokens/generations (High priority)
**Problem:** Even with status-aware liveness, there's no cryptographic fencing. If a human
force-releases a write lease (`forceReleaseAssignment`, already shipped) while the *original*
agent is still silently running and later calls `devteam_report`, nothing currently distinguishes
"my original claim" from "a claim that moved on." `completeAssignment` (`store.mjs` ~line 993)
checks `assignment.agent_id !== agentId || assignment.status !== "claimed"` — this catches the
gross case (lease moved to a *different* agent) but there's no generation counter, so subtler
races (report racing a fresh claim by the same agent id after reconnect) aren't fenced.

**Design (from `DEVTEAM-LIVENESS-AND-LEASE-PLAN.md`, "Add an explicit assignment lease" section):**
- Add to `assignments`: `claim_generation INTEGER DEFAULT 0`, `claim_token_hash TEXT`.
- On claim, increment generation, generate a token, return it, store only the hash.
- `devteam_report` (and any assignment-mutating call) requires the token; on mismatch, return a
  structured `claim_conflict` (current owner, generation, safe next action) instead of a bare
  error string.
- This is additive to what's shipped — the status-aware liveness already prevents the *common*
  case (silent-agent takeover); this closes the rarer generation-race edge case.

**Where to start:** `#migrate()` in `store.mjs` (schema), `claimNextAssignment` (issue token),
`completeAssignment` (verify token), `mcp.mjs` `devteam_report`/`devteam_wait` (thread the token
through the tool I/O).

### B. Resumable identity (High priority)
**Problem confirmed in code:** `connectAgent` (`store.mjs`, `#migrate` area, search
`connectAgent`) still evicts and releases the claims of any existing session with the same
`name`+`provider` on reconnect. A human's second "Claude" chat silently kills the first one's
work. Also: `deliverDirectedMessages` filters by `e.created_at >= agent.connected_at`, so a
reconnecting agent never sees messages sent while it was gone (message amnesia).

**Design (from Codex's lease plan, "Make connect resumable" section):**
- Stop evicting on name/provider collision — a new connection is always a distinct identity.
- Add `devteam_resume` with an opaque resume credential tied to the old session + claim (hash it
  at rest, never expose it in dashboard/timeline, single-use/rotate).
- On resume: reattach the same claim (works cleanly with the lease tokens from item A), and replay
  messages delivered/created since the *original* connect, not the new one.
- Longer term: migrate `target_agent_name` (ambiguous with duplicate names) toward
  `target_agent_id`, keeping name as a compat fallback.

**Where to start:** `connectAgent` in `store.mjs` — remove the eviction block; add
`resumeAgent(resumeToken)`; `mcp.mjs` add `devteam_resume` tool.

### C. Co-worker safety on block/accept (Medium)
**Problem confirmed in code:** `blockTask`, the blocked branch of `completeAssignment`, and
`approveTask`'s acceptance branch all run `UPDATE agents SET status='disconnected' ... WHERE
current_task_id = ?` — this force-disconnects **every** agent working that task, including ones
mid-write on a *different* non-conflicting path lease (now that parallelism exists from increment
3, this is a bigger deal than when it was written).

**Fix:** On block/accept, notify co-workers (they'll see it via their next `pendingMessages` or
`devteam_state` since reachability is now wired) and release their claims cleanly, but don't
force-flip their connection status — let a still-running agent finish its current tool call and
disconnect itself, or at minimum distinguish "your task was blocked, please wrap up" from a hard
kill.

**Where to start:** `store.mjs`, search for `current_task_id = ?` combined with
`status = 'disconnected'` (three call sites: `blockTask`, `completeAssignment`'s blocked branch,
`approveTask`'s accepted branch).

### D. Consensus quorum + timeout (High)
**Problem confirmed in code:** `#evaluateProposal` (`store.mjs`) computes the required-agreers set
**live, on every vote**, from `#connectedMemberIds(taskId)` (this was scoped to the task room in
increment 1, but the *unanimity-of-whoever-happens-to-be-connected-right-now* problem remains).
Consequences:
- An agent connecting mid-vote is silently added to the required set (can stall an
  already-near-adopted proposal).
- One `unresponsive`-but-still-counted-as-connected agent blocks all proposals (partially
  mitigated since `unresponsive` agents are `status != 'disconnected'` and thus still count —
  check whether you want unresponsive agents excluded from required-agreers).
- No quorum/supermajority option, no timeout — a single holdout freezes governance forever.

**Design (roadmap §5, phase 4):**
- Snapshot the voter set **at proposal creation** (store it, e.g. a `proposal_voters` join table
  populated from `#connectedMemberIds` at `createProposal` time), not recomputed per vote.
- Optionally support configurable quorum/supermajority instead of strict unanimity.
- Add a proposal timeout with a human-decides fallback (e.g. after N minutes, an open proposal
  auto-escalates to `devteam_state`/dashboard as needing human resolution).
- Consider excluding `unresponsive` agents from the *required* set (they're not gone, but they
  can't vote right now either) — needs a product decision, flag it to the human if ambiguous.

**Where to start:** `createProposal` and `#evaluateProposal` in `store.mjs`; new
`proposal_voters` table in `#migrate()`.

### E. Reviewer ≠ author; verify `changedFiles` (Medium, trust-critical)
**Problem confirmed in code:**
- `approveTask` (`store.mjs`) requires the approver to have a completed reviewer/tester assignment
  on the current version with no `changedFiles` — but nothing stops the **same agent** who
  implemented the change from also claiming the reviewer assignment and approving their own work.
- `#effectiveRequiredApprovals` caps required approvals at the number of distinct participants, so
  a **solo agent can self-approve and accept its own work** with zero outside review (this is
  intentional — see the "no dead-ends" test — but it's silently treated as equivalent to real
  independent consensus; it should at least be *labeled* differently).
- `changedFiles` in `completeAssignment` is pure self-report — nothing verifies the agent actually
  touched those files (or didn't touch others). A misreporting or malicious agent can claim
  anything.

**Fix:**
1. In `approveTask`, exclude any agent that appears in `changedFiles`-bearing `assignment.completed`
   events for the *current task version* from being eligible to approve that version.
2. Keep the solo-fallback behavior (don't break the "no dead-ends" test) but return/label it
   explicitly, e.g. `selfReviewed: true` in the outcome, so callers/dashboard can show "not
   independently reviewed" rather than implying real consensus.
3. Verify `changedFiles`: at minimum, check the files exist and were modified recently (mtime) or,
   if the project is a git repo, diff against HEAD/last-known commit. This needs `project_root`
   (already available via `task.project_root` in `taskDetail`). Keep it best-effort/non-blocking
   (warn, don't hard-fail) since not every project is git-tracked.

**Where to start:** `approveTask` in `store.mjs`; `completeAssignment` for the verification hook.

### F. Shared team memory / blackboard (Medium, the actual "hive mind" piece)
**Problem:** There is no shared, structured, queryable working memory — only the append-only event
timeline and the filesystem. Agents re-derive context from scrollback or trust each other's
summaries. This is the difference between "several agents taking turns" and "one mind."

**Design (roadmap §4, item 3):**
- New task/project-scoped key-document store: `devteam_note_set(taskId, key, value)` /
  `devteam_note_get(taskId, key)` or similar, with optimistic-concurrency writes (version/etag) and
  provenance (who wrote it, when).
- Consider a single structured "world state" doc per task (goals, decisions, open questions,
  per-path ownership) that agents read at the start of work and patch as they go, rather than free-
  form key/value — ask the human which shape they want before committing, this is a genuine design
  choice, not just an implementation detail.
- Longer term: periodically compress old timeline events into the blackboard so long tasks don't
  require unbounded scrollback replay.

**Where to start:** new table in `#migrate()`; new `mcp.mjs` tools; this is greenfield, no existing
code to modify.

### G. Dashboard (Medium, not started at all)
`public/app.js` / `public/styles.css` have not been touched. They need to:
- Render `unresponsive` (amber) distinctly from `busy` (green) and `disconnected` (gray).
- Show task-room membership (who's in which room) once multi-task servers are common.
- Show granted `writeScope` per claimed assignment (increment 3 added this data; nothing displays
  it yet).
- Add a human-facing **force-release** control for a stuck write lease (`forceReleaseAssignment`
  is implemented server-side but has no UI — currently only callable by writing a script or a
  future `/api/assignments/:id/force-release` route, which also doesn't exist yet — you'd need to
  add that REST route too, guarded by `apiGuard` and probably a confirm-title body param like the
  existing delete routes).

### H. Docs (Low, do last)
`skills/devteam/SKILL.md`, `README.md`, `GUIDE.html` still describe the pre-increment-1 behavior
(e.g. don't mention `devteam_join`, room scoping, `unresponsive` status, or `paths`). Update once
the contract stabilizes further — the roadmap explicitly says resync installed skills *last*, "so
agents receive instructions matching the deployed server behavior." Don't run
`node bin/devteam.mjs sync-skill` until you and the human are happy with where the API has landed.

---

## 3. Recommended order for you (Codex)

1. **E (reviewer≠author + changedFiles verification)** — smallest, highest trust payoff, no schema
   risk beyond what's there.
2. **D (consensus quorum/snapshot/timeout)** — schema addition (`proposal_voters`) but contained.
3. **C (co-worker safety on block/accept)** — small, three call sites, no schema change.
4. **B (resumable identity)** — removes a real footgun (name-collision eviction) but touches the
   connect flow broadly; test carefully against the existing reconnect tests.
5. **A (lease fencing/tokens)** — the most invasive schema/API change; do after B since resume and
   lease tokens interact (a resumed session should get back the *same* token/generation).
6. **F (shared blackboard)** — greenfield, no rush, but check in with the human on the data shape
   first (key/value vs. structured doc).
7. **G, H (dashboard, docs)** — once the API surface above stabilizes.

For each increment: **write the store-level test first** (see the existing pattern in
`test/devteam-store.test.mjs` — every increment above added exactly this shape: connect a few
agents, exercise the store method directly, assert the safe behavior), then wire the MCP tool, then
add one server-level integration test only if the behavior genuinely needs a live transport
(most don't — see how increments 1–3 mostly used store-level tests plus 1-2 server tests each).

Always run `node --test` before calling anything done. The count today is **36**; each increment
above should raise it, never lower it, and every prior test should keep passing unmodified except
where a prior test *explicitly encoded now-obsolete behavior* (as happened once in increment 1 —
be suspicious of yourself if you need to change an old assertion rather than add a new one).

---

## 4. Do NOT do without the human

- Don't run `node bin/devteam.mjs sync-skill` (deploys the skill to installed locations) without
  asking — it changes what live agent sessions see.
- Don't touch the live/running DevTeam server process or its data dir outside of tests.
- The human said "improve all the things for you and codex plan" and "start" — you have a green
  light to keep implementing per this backlog, but check in before anything that changes the
  external contract in a way another connected agent (Claude, in another session) would need to
  know about immediately (e.g. don't silently make `devteam_join` mandatory in a way that breaks
  an in-flight session).
