# DevTeam changes — 2026-08-09 (increment 1)

Author: Claude (Anthropic Claude Code). All changes verified by `node --test` (34 tests, all passing).
This is the first implementation increment against `DEVTEAM-COLLECTIVE-MIND-ROADMAP.md`.

## What shipped

### 1. Trust: identity is bound to the MCP session (fixes impersonation P0-1)
- `createDevTeamMcpServer(store, session)` now carries a per-session identity scope; every tool
  (`wait`, `state`, `message`, `assign`, `propose`, `vote`, `report`, `approve`, `block`,
  `disconnect`, `join`) verifies the caller-supplied `agentId` matches the agent that connected
  on this session. `devteam_connect` binds it; `devteam_disconnect` clears it.
- `server.mjs` creates one identity scope per MCP session and passes it in.
- **Effect:** a client can no longer pass another agent's UUID to speak/vote/approve/disconnect
  as them. Timeline provenance is now trustworthy.
- Files: `src/devteam/mcp.mjs`, `src/devteam/server.mjs`.
- Test: *"an MCP session cannot act as an agent it did not connect as."*

### 2. Trust: local-only control plane (fixes REST injection P0-2 / hive-gaps F)
- New `apiGuard` on all `/api` routes: rejects non-loopback `Host` (blunts DNS-rebinding) and
  mutating requests carrying a foreign `Origin` (blocks a random web page from POSTing tasks,
  messages, or votes into the room). Native clients and the same-origin dashboard are unaffected.
- Files: `src/devteam/server.mjs`.
- Test: *"mutating API rejects cross-origin and non-local requests."*

### 3. Liveness: a thinking agent is no longer reaped (fixes the original P0)
- Presence and ownership are now separate. `#reapStaleAgents` was rewritten:
  - a **waiting** agent silent past `presenceMs` (120s) is disconnected (owns nothing);
  - a **busy** agent silent past `presenceMs` is marked **`unresponsive`** but **keeps its claim**;
  - **read-only** claims of a long-silent owner (`staleWorkMs`, 15m) are safely requeued;
  - **write** claims are **never** transferred by silence alone.
- New recovery paths that *are* allowed to move a write lease: explicit `devteam_disconnect`,
  a **confirmed MCP transport close** (`handleTransportClose`, wired to `transport.onclose`),
  a same-identity reconnect, or a human **`forceReleaseAssignment`** (title confirmation required).
- Thresholds are configurable (`new DevTeamStore(dir, { liveness })`, `startDevTeamServer({ liveness })`)
  and surfaced (non-secret) via `/api/config`.
- Files: `src/devteam/store.mjs`, `src/devteam/server.mjs`.
- Tests: *"a silent busy writer keeps its write lease; only explicit recovery transfers it"*,
  *"a long-silent read-only claim is recovered automatically."* (The old test that asserted the
  unsafe write-lease takeover was rewritten to assert the safe contract.)

### 4. Isolation: task-room membership (fixes global-claim P0-2 and cross-task leak P0-3)
- New `task_members` table + `joinTask(agentId, taskId, role)`; `devteam_join` tool and an optional
  `taskId` on `devteam_connect`.
- **Derived membership:** explicit joins win; if an agent joined nothing and there is exactly one
  active task in the store, it is implicitly in that sole room. This keeps the common single-task
  workflow zero-config while isolating multi-task/multi-project servers.
- Scoped to the agent's rooms: `claimNextAssignment`, `deliverDirectedMessages`,
  `#pendingMessageCount`, `openProposalsForAgent`, and the proposal consensus voter set
  (`#evaluateProposal` now counts only connected **members of that task**).
- **Effect:** an agent invoked for one task/project can no longer claim another's work, receive its
  messages, or be dragged into its votes.
- Files: `src/devteam/store.mjs`, `src/devteam/mcp.mjs`.
- Test: *"work, messages, and proposals are scoped to an agent's task room."*

## Behavioural/contract changes to be aware of
- A busy agent that goes quiet now shows as **`unresponsive`** (not `disconnected`) and keeps its
  work. A crashed writer's lease is released by transport-close or human force-release, not by a
  timer — deliberately conservative (a false takeover can corrupt shared files; a stuck lease can't).
- On a **multi-task** server, agents should call `devteam_join` (or pass `taskId` to
  `devteam_connect`); otherwise they are members of no room and claim nothing.
- `/api/config` now includes a `liveness` block.

## Increment 2 — reachability + agent→agent messaging (shipped, 35 tests passing)

### 5. Reachability: a busy agent can be reached
- Directed/broadcast messages are now piggybacked onto whatever call an agent makes. A new
  `withInbox` wrapper in the MCP layer attaches a `pendingMessages` array to the results of
  `devteam_state`, `devteam_report`, `devteam_message`, `devteam_assign`, `devteam_approve`,
  `devteam_vote`, `devteam_propose`, and `devteam_join` (only when non-empty).
- **Effect:** an agent mid-work (not sitting in `devteam_wait`) still receives messages the next
  time it reports progress, reads state, or takes any action — the human and teammates can reach
  it promptly instead of only when it goes idle.
- Files: `src/devteam/mcp.mjs`.
- Test: *"a busy agent is reached with pending messages on its next action."*

### 6. Agent→agent directed messages
- `devteam_message` gained an optional `target` (teammate name). `postMessage`/`deliverDirectedMessages`
  now push a **directed** agent message to that teammate (returned by their next `devteam_wait`
  or tool-call inbox), while an **undirected** agent message stays a timeline note read via
  `devteam_state`. The sender never receives their own message; uninvolved teammates don't get it.
  Delivered messages carry a `from` field so the recipient knows who sent it. Unread counts
  (`#pendingMessageCount`) count directed agent messages too.
- Files: `src/devteam/store.mjs`, `src/devteam/mcp.mjs`.
- Test: *"an agent can direct a message to a specific teammate."*

## Increment 3 — parallelism: path-scoped write leases (shipped, 36 tests passing)

### 7. Non-overlapping writers run in parallel (fixes the single-project-lock limiter)
- Write assignments can declare the paths they'll touch (`paths`, e.g. `src/ocean/**`), stored in
  a new `assignment_write_scopes` table. `devteam_assign` gained a `paths` parameter; role
  proposals can carry `details.paths`.
- The write lease is no longer one-per-project. `claimNextAssignment` now fetches the eligible
  queue and grants a write claim only if the candidate's normalized path scopes don't overlap a
  write lease **already held by another agent in the same project** (`#heldWriteLeases`,
  `#writeScopeFor`, `#scopesOverlap`, `#normalizeScope`). Overlap is segment-aware prefix
  containment; trailing `/**`, `/*`, and slashes are normalized away.
- **Backward compatible:** a write assignment that declares no paths gets the whole-project scope
  (`""`), which conflicts with everything — identical to the old exclusive lease.
- The claimed-assignment result and `assignment.claimed` event now include the granted `writeScope`.
- **Effect:** Claude can build `src/ocean/**` while Codex builds `src/hud` at the same time; a
  writer whose paths overlap a live lease waits until it frees.
- Files: `src/devteam/store.mjs`, `src/devteam/mcp.mjs`.
- Test: *"write assignments with non-overlapping paths run in parallel; overlapping ones wait."*

## Not yet done (next increments, from the roadmap)
- **Lease fencing:** claim tokens/generations + structured `claim_conflict` on stale reports
  (Codex's lease plan) — full protection against a returning stale writer clobbering a new owner.
- **Resumable identity:** `devteam_resume` + stop using display-name eviction; replay missed
  messages on resume; migrate targeting to `targetAgentId`.
- **Co-worker safety:** stop force-disconnecting co-workers on block/accept (release cleanly instead).
- **Consensus:** snapshot the voter set at proposal creation; add quorum/supermajority + timeout.
- **Trust/quality:** enforce reviewer ≠ author; verify reported `changedFiles` against the FS.
- **Shared mind:** a task-scoped blackboard + timeline→memory compression.
- **Dashboard:** render `unresponsive` (amber) vs `disconnected`; room membership; write scopes;
  force-release control.
- **Docs:** update `skills/devteam/SKILL.md`, `README.md`, `GUIDE.html` and resync installed skills
  (a deploy step) once the contract settles.

## How to verify
```bash
cd "C:/Users/aloka/Mine/Projects/bridge" && node --test
```
