# DevTeam → Collective Mind: consolidated improvement roadmap

**Author:** Claude (Anthropic Claude Code), DevTeam agent
**Date:** 2026-08-09
**Repository:** `C:\Users\aloka\Mine\Projects\bridge` (`local-devteam` v0.2.0)
**Merges four reports:**
- `COORDINATION-HEARTBEAT-FIX.md` (Claude) — liveness/reap root cause
- `DEVTEAM-LIVENESS-AND-LEASE-PLAN.md` (Codex) — lease fencing, session binding, resume
- `HIVE-MIND-COORDINATION-GAPS.md` (Claude) — reachability, parallelism, consensus, security
- **DevTeam collective-mind audit (Codex)** — impersonation, no task-room, cross-task leak

This is the single source of truth going forward. It (1) verifies Codex's latest audit
against the code, (2) merges every finding into one prioritized backlog, (3) defines the
target architecture for a real collective mind, and (4) gives a phased, file-level plan.

---

## 1. Verdict

DevTeam today is a **shared task queue + event timeline + advisory project-wide write lock**.
That is enough to *coordinate* agents; it is **not** enough to make Claude, Codex, and other
models operate as one trustworthy collective intelligence. The blockers fall into three
buckets, in priority order:

1. **Trust & isolation (P0):** identities are spoofable, work routing is global, and
   messages/votes leak across tasks. Until these are fixed, *nothing built on top can be
   trusted* — "independent consensus" has no meaning if an agent can impersonate another or
   vote on a task it never joined.
2. **Liveness & ownership:** a thinking agent is reaped and its write lease silently
   transfers (the original bug that started this).
3. **Hive capability:** reachability, real parallelism, robust consensus, and shared memory.

**Design principle to preserve (from Codex's audit, and I agree):** the goal is *shared
facts, goals, decisions, evidence, and progress* — **not forced agreement**. Diversity of
perspective between models is the value; don't collapse it. Consensus mechanisms should make
disagreement *legible and resolvable*, not impossible.

---

## 2. Codex's audit — verified

I re-checked each P0 against the source (not taken on faith):

### P0-1 — One MCP client can impersonate another agent ✅ confirmed
- `createDevTeamMcpServer(store)` receives **only the store** ([`mcp.mjs:24`](src/devteam/mcp.mjs));
  the MCP SDK passes per-call session context (`extra`, incl. `sessionId`) as the handler's
  second arg, and **every tool ignores it** — `safe(async (args) => …)` uses only the
  caller-supplied fields ([`mcp.mjs:14-20`](src/devteam/mcp.mjs)).
- Each tool trusts `agentId` from the args and calls `store.getAgent(agentId)` with no
  session check (e.g. `devteam_message` → `postMessage`, [`store.mjs:835`](src/devteam/store.mjs)).
- Auth is a **single shared bearer token** for all clients ([`server.mjs:42-47`](src/devteam/server.mjs)),
  and agent IDs are visible in dashboard state (`/api/state`).
- **⇒ Any client can act as any agent: speak, vote, approve, disconnect, create work.**
  Provenance on the timeline is meaningless until `agentId` is bound to the MCP session that
  created it. **Severity: P0 — collective integrity failure.**

### P0-2 — No task-room / membership; work-claiming is global ✅ confirmed
- `claimNextAssignment(agentId)` scans **all** queued assignments across **all** tasks and
  projects; the only filters are `target_agent_name`, role gating, and the write lease
  ([`store.mjs:780-811`](src/devteam/store.mjs)). No project/task/room/subscription filter.
- **⇒ An agent invoked for project Beta can claim project Alpha's work.** No way to join as
  observer/auditor/specialist; multiple teams on one server contaminate each other.
  **Severity: P0 — unsafe work routing.**

### P0-3 — Messages and governance leak across tasks ✅ confirmed
- `deliverDirectedMessages(agentId)` selects `human.message` events with **no task scoping**
  ([`store.mjs:301-320`](src/devteam/store.mjs)) — a broadcast in Task A reaches an agent
  working Task B.
- `openProposalsForAgent(agent)` returns open proposals from **any** task
  ([`store.mjs:523-534`](src/devteam/store.mjs)) — an agent is asked to vote on unrelated
  tasks; and `#evaluateProposal` counts *all* connected agents as required voters
  ([`store.mjs:478`](src/devteam/store.mjs)), so cross-task members can block/curry a vote.
  **Severity: P0/P1 — governance contamination.**

Codex also reiterated **non-independent review** (matches finding E in the hive-gaps doc) and
**self-reported file changes** (see new finding below). Both confirmed.

---

## 3. Consolidated backlog (all four docs, one list)

| # | Problem | Bucket | Severity | Source |
|--:|---------|--------|:--------:|--------|
| 1 | `agentId` not bound to MCP session → **impersonation** | trust | **P0** | Codex audit |
| 2 | Unauthenticated REST routes + `/api/config` leaks token | trust | **P0** | Claude (hive-gaps F) |
| 3 | Global work-claiming; **no task-room membership** | isolation | **P0** | Codex audit |
| 4 | Messages/proposals **leak across tasks** | isolation | **P0/P1** | Codex audit |
| 5 | Thinking agent reaped; **write lease transfers** | liveness | **P0** | Claude + Codex |
| 6 | Same name+provider connect **evicts** prior session; name-based identity | identity | **High** | Codex (lease) + Claude |
| 7 | Busy agents **unreachable** (msgs only in `devteam_wait`) | reachability | **High** | Claude (A) |
| 8 | **No agent→agent** addressing/wakeup | reachability | **High** | Claude (B) |
| 9 | **One write lease per project** kills parallelism | parallelism | **High** | Claude (C) |
| 10 | Consensus = unanimity of *currently-connected*; no quorum/timeout | consensus | **High** | Claude (D) |
| 11 | "Independent" approval **not** enforced vs author; solo self-approve | trust | **Medium** | Codex + Claude (E) |
| 12 | Block/accept **force-disconnects** co-workers mid-write | parallelism | **Medium** | Claude (G) |
| 13 | Shared changes tracked only by **self-report** (`changedFiles`) | trust | **Medium** | Codex audit |
| 14 | **No shared team memory / blackboard** | shared mind | **Medium** | Claude (H) |
| 15 | Resume has **message amnesia** (`created_at >= connected_at`) | reachability | **Medium** | Claude (A/I) |

---

## 4. Target architecture (the eight ingredients → concrete mechanisms)

Codex named the ingredients; here is how each maps to a concrete change in this codebase.

1. **Authenticated individual identities** — bind `agentId` ⇄ `mcp-session-id` at
   `devteam_connect`; every tool derives the acting agent from the *session*, not from args.
   Optionally per-agent tokens. Fixes #1, #6.
2. **Explicit room membership** — an agent `joins` a task (or project) room; `devteam_wait`
   and `claimNextAssignment` are scoped to joined rooms; roles can be `observer`/`auditor`
   (no claim). Fixes #3, #4.
3. **One structured, versioned shared world model** — a task-scoped blackboard document
   (goals, decisions, facts, open questions, per-file ownership) with optimistic-concurrency
   writes and provenance. Fixes #14; underpins real synthesis.
4. **Capability-aware allocation** — match assignments to declared capabilities; `claimNext`
   prefers a capability fit and honors observer/auditor roles. (Extends current
   `target_agent_name`.)
5. **Independent execution & criticism** — path-scoped leases so members work in parallel
   (#9); enforce reviewer ≠ author (#11); keep model diversity (don't auto-agree).
6. **Evidence-backed synthesis** — verify `changedFiles` against the filesystem (hash/mtime
   or git) instead of trusting self-report (#13); attach evidence to approvals.
7. **Safe conflict & recovery** — lease generations/claim tokens + structured `claim_conflict`
   (Codex's lease plan); don't force-disconnect co-workers (#12); human force-release is
   audited.
8. **Durable, compressed memory** — periodically compress the timeline into the blackboard
   (decisions/outcomes) so long tasks don't rely on unbounded scrollback (#14/#15).

---

## 5. Phased roadmap

### Phase 0 — Trust & isolation (P0, do first; nothing is reliable until this lands)
- **Session-bound identity (#1):** thread the SDK's per-call `extra.sessionId` into the
  tools; at `connect`, record `agentId → sessionId`; reject any tool call whose
  `agentId` doesn't match the calling session. *(Small, high-leverage; also gives you the
  session handle Codex's lease/resume work needs.)*
- **Authenticate the control plane (#2):** put the bearer token (or a dashboard login
  cookie) on all mutating `/api/*` routes; stop returning the raw token from `/api/config`;
  add an `Origin`/`Host` allowlist (anti DNS-rebinding).
- **Task-room membership (#3, #4):** add `devteam_join(taskId, role)`; scope
  `claimNextAssignment`, `deliverDirectedMessages`, `openProposalsForAgent`, and the
  consensus voter set to the joined task; support `observer`/`auditor` (no claim, can
  message/review).

### Phase 1 — Liveness & ownership (the original bug)
Ship the merged Claude+Codex plan:
- status-aware reaping (busy → `unresponsive`, keep the claim);
- assignment leases with `claim_generation` + hashed `claim_token`; structured
  `claim_conflict` on stale `devteam_report`;
- MCP transport-close → grace/recovery (reuses Phase 0 session binding);
- resumable connect (`devteam_resume`), stop evicting on name collision (#6), replay missed
  messages on resume (#15).

### Phase 2 — Reachability
- Deliver directed messages on **every** tool call (piggyback `heartbeat`), and return
  pending messages in `devteam_report`/`devteam_state` envelopes (#7).
- Add `target`/`targetAgentId` to `devteam_message` and deliver directed `agent.message`
  events so `devteam_wait` returns teammate pings (#8).

### Phase 3 — Parallelism
- **Path-scoped leases (#9):** assignments declare write paths; grant a lease only if paths
  don't overlap a live lease — replaces the project-wide lock so agents edit different files
  at once.
- Don't force-disconnect co-workers on block/accept (#12); notify + clean release instead.

### Phase 4 — Consensus, evidence, shared mind
- Consensus voter set = **snapshot at proposal creation**, support quorum/supermajority,
  exclude `unresponsive`, add a timeout + human-decides fallback (#10).
- Enforce **reviewer ≠ author** for the current version; label solo self-review honestly (#11).
- **Verify `changedFiles`** against the filesystem/git before accepting a report (#13).
- **Shared blackboard** tools + timeline→memory compression (#14, #15).

---

## 6. File-by-file touch list

- `src/devteam/mcp.mjs` — accept the handler `extra` (session id); resolve acting agent from
  session; add `devteam_join`, `devteam_checkpoint`, `devteam_resume`; add `target` to
  `devteam_message`; return pending-message envelopes.
- `src/devteam/server.mjs` — auth on all `/api/*`; drop token from `/api/config`;
  Origin/Host allowlist; pass session context into `createDevTeamMcpServer`; map
  `agentId ↔ sessionId`; `transport.onclose` → store recovery hook; inject liveness config.
- `src/devteam/store.mjs` — session/identity binding checks; room scoping in
  `claimNextAssignment`/`deliverDirectedMessages`/`openProposalsForAgent`/`#evaluateProposal`;
  status-aware reaper; lease columns + tokens/generations; path-scoped lease logic;
  reviewer≠author + honest solo labeling; `changedFiles` verification; blackboard tables;
  remove name-collision eviction; resume + message replay.
- `public/app.js`, `public/styles.css` — render `unresponsive` (amber) vs `disconnected`;
  room membership + roles; blackboard view; recovery/force-release controls.
- `skills/devteam/SKILL.md`, `README.md`, `GUIDE.html` — document join/rooms, identity,
  checkpoint/resume, path leases, consensus rules. Resync installed skills **after** tests.
- `test/` — see matrix below.

---

## 7. Test matrix (merged, additive to the existing 29)

**Trust/isolation (Phase 0):**
1. Client B passing Client A's `agentId` is **rejected** (impersonation blocked).
2. Unauthenticated `POST/DELETE /api/*` is rejected; `/api/config` does not return the token.
3. An agent joined to Task B **cannot** claim Task A's assignment.
4. A Task-A broadcast is **not** delivered to a Task-B member; Task-A proposals are not
   offered to Task-B members and don't count in Task-A's voter set.

**Liveness/lease (Phase 1):** the full matrix from the two prior docs, incl. the 125-second
live-failure regression (busy writer silent > 120 s still owns its lease and can report).

**Reachability (Phase 2):** a message to a **busy** agent is delivered on its next tool call;
an `agent.message` with `targetAgentId` wakes the target's `devteam_wait`.

**Parallelism (Phase 3):** two agents hold non-overlapping path leases simultaneously;
overlapping paths are refused; block/accept does not disconnect an unrelated co-worker.

**Consensus/evidence (Phase 4):** late-joining agent doesn't retroactively block an adopted
proposal; quorum/timeout paths; author cannot approve own current version; a report whose
`changedFiles` don't match the filesystem is rejected.

---

## 8. What to keep

- The bounded-assignment + checklist model (good blind-spot coverage).
- The event timeline as an **audit log** (once provenance is trustworthy).
- Model **diversity**: independent execution and criticism, no forced agreement.
- SQLite/WAL single-process simplicity — none of the above requires a new datastore.

---

### One-line summary

**Make identity and rooms trustworthy first (P0), stop reaping thinking agents second, then
give the team reachability, real parallel leases, robust consensus, and a shared memory — in
that order — and DevTeam becomes a collective mind instead of a shared queue.**
