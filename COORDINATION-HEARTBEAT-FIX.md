# DevTeam Coordination Bug: "Agents can't work together because a working agent gets disconnected while thinking"

**Author:** Claude (Anthropic Claude Code), acting as a DevTeam agent
**Date:** 2026-08-09
**Project:** `C:\Users\aloka\Mine\Projects\bridge` (`local-devteam` v0.2.0)
**Status:** Diagnosis + proposed fix plan (no server code changed yet)

---

## TL;DR

DevTeam decides whether an agent is alive by looking at **`last_seen`**, and `last_seen`
is only refreshed when the agent **calls a DevTeam MCP tool**. But an agent that has
*claimed* an assignment leaves the `devteam_wait` loop and goes off to do the actual
work — reading files, **thinking**, writing a large file, running checks — and makes
**no DevTeam tool calls the entire time**.

If that quiet stretch exceeds **120 seconds** ([`store.mjs:235`](src/devteam/store.mjs)),
the reaper declares the agent's *"heartbeat expired,"* marks it `disconnected`, and
**requeues its claimed assignment**. Another agent (Codex) instantly claims it. When the
first agent's turn finally returns, it's already dead — its work is orphaned, and two
agents have been fighting over the same assignment.

**In short: doing real work looks identical to crashing.** The liveness check punishes
exactly the behaviour it should protect.

---

## What we actually observed (this session)

This is not hypothetical — it happened while implementing the "3D Sea" task
(`taskId 559c0750…`). From the DevTeam timeline:

| Event | Time (UTC) | What happened |
|------:|------------|---------------|
| 52 | 13:18:48 | **Claude** claimed *Implement the single-file Three.js sea world* (write-leased) |
| 53 | 13:19:57 | Human posted a test message to all agents |
| 55 | 13:21:05 | `agent.disconnected` — **"Claude disconnected and released unfinished work."** reason: **"Agent heartbeat expired."**, `releasedAssignments: 1` |
| 56 | 13:21:05 | **Codex** claimed the *same* implementation assignment |
| —  | 13:23:42 | On reconnect, **Claude** was handed the *same* assignment **again** (Codex had by then also lost it) |

So within ~5 minutes the single write-leased implementation assignment bounced
**Claude → Codex → Claude**, and **no `index.html` was ever produced**. That is the
thrash the user described: *"you can not work together because you are disconnected when
thinking; then codex picks up."*

Note the timing: I was reaped after **~2m17s** of silence (13:18:48 → 13:21:05) — the
120 s threshold plus one 30 s server sweep. That is a completely normal amount of time to
spend reading the project and generating a large single-file Three.js app. **The task was
never going to fit inside the liveness budget.**

---

## Root cause (code walk-through)

### 1. Liveness == "recently called a tool", nothing else

`last_seen` is bumped only inside store methods that an agent triggers:

- `heartbeat()` — [`store.mjs:728`](src/devteam/store.mjs) — `UPDATE agents SET last_seen = ? …`
- `devteam_wait` calls `heartbeat` on entry and every ~750 ms **while it is blocking** —
  [`mcp.mjs:55`](src/devteam/mcp.mjs) and [`mcp.mjs:86`](src/devteam/mcp.mjs)
- Other tools (`devteam_state`, `devteam_message`, `claimNextAssignment`, …) bump it as a
  side effect.

There is **no** transport-level or out-of-band heartbeat. If the model isn't calling a
DevTeam tool, the server has no evidence the agent is alive.

### 2. The reaper's threshold is tuned for *waiting*, not *working*

```js
// src/devteam/store.mjs:235
#reapStaleAgents(staleMilliseconds = 120_000) {
  const staleBefore = new Date(Date.now() - staleMilliseconds).toISOString();
  const staleAgents = this.db.prepare(`
    SELECT * FROM agents WHERE status != 'disconnected' AND last_seen < ?
  `).all(staleBefore);
  ...
  // releases claims + marks agent disconnected
}
```

120 s is fine for a **waiting** agent — it re-pings every ≤45 s inside `devteam_wait`. It
is far too short for a **busy** agent that legitimately goes silent for minutes. The query
does **not distinguish the two states** — `status != 'disconnected'` reaps `busy` and
`waiting` agents with the same stopwatch.

### 3. The server sweeps this on a timer, so no one has to be "looking"

```js
// src/devteam/server.mjs:166
const reaper = setInterval(() => {
  try { store.reapAndRecover(); } catch { /* … */ }
}, 30_000);
```

Plus a **lazy** reap runs at the top of `claimNextAssignment` ([`store.mjs:775`](src/devteam/store.mjs))
and other hot paths. So the moment *any* other agent calls `devteam_wait`, a stale
worker is reaped — which is why Codex grabbing the room triggered my eviction.

### 4. Releasing a claim silently transfers the write lease

`#releaseAgentClaims` ([`store.mjs:212`](src/devteam/store.mjs)) requeues the assignment
(`status='queued', agent_id=NULL`) and flips the agent to `disconnected`. The write-lease
guard in `claimNextAssignment` only blocks a new claimant if a **non-disconnected** agent
holds a write claim:

```js
// src/devteam/store.mjs:797-808
a.requires_write = 0 OR NOT EXISTS (
  SELECT 1 FROM assignments busy
  JOIN agents busy_agent ON busy_agent.id = busy.agent_id
  WHERE busy.status = 'claimed' AND busy.requires_write = 1
    AND busy_agent.status != 'disconnected'   -- <— the reaped agent no longer counts
    …
)
```

So the instant I'm marked `disconnected`, the guard forgets I existed and Codex may claim
the write lease **while my model turn is still running and about to write the same file.**
The "one write lease at a time" invariant holds in the *database* but is **violated in
wall-clock time** across the reap boundary. Two agents can write `index.html`
concurrently.

### 5. Reconnect creates a *new identity*, so the worker can't resume

On reconnect, `registerAgent` only reuses a row that is **not** disconnected
([`store.mjs:671`](src/devteam/store.mjs)); the reaped agent is `disconnected`, so a
**brand-new `agentId` row** is inserted. The returning worker therefore cannot reclaim its
own in-flight assignment by identity — it can only re-enter the queue and race for it. (I
watched my own `agentId` change from `84bfab90…` to `8af2a2b1…`.)

### 6. The system already assumes turns take *minutes*

`core.mjs` (autonomous runner) sets `turnTimeoutMs: 900000` — **15 minutes** —
([`core.mjs:27`](src/core.mjs)) as the budget for a single agent turn. The liveness reaper
uses **120 s**. These two numbers describe the same thing (how long one agent turn can
take) and are off by **7.5×**. The reaper is simply mis-calibrated relative to the
project's own expectations.

---

## Why it's harmful

1. **Work never completes (thrash).** The assignment ping-pongs between agents, each of
   whom is reaped before finishing. Net progress can be zero while burning tokens.
2. **Write-lease safety is violated in practice.** Two agents can edit the same file
   across a reap boundary — the exact data race the lease exists to prevent.
3. **Orphaned work + wasted tokens.** The reaped agent finishes generating a full file,
   then gets *"Agent is disconnected. Connect again."* from `devteam_report`
   ([`store.mjs:778`](src/devteam/store.mjs)). All that output is thrown away.
4. **It's invisible to the victim.** Nothing warns the worker it's about to be reaped; it
   only discovers it when a later tool call fails.
5. **It gets worse with harder tasks.** The bigger/more thoughtful the work, the longer
   the silent stretch, the more certain the reap. The system penalises depth.

The deep issue: **liveness (is the process/connection alive?) is conflated with activity
(is it calling DevTeam tools right now?).** A thinking agent is alive but silent.

---

## Ideas to improve (ranked)

### ★ Fix 1 — Make the stale threshold status-aware (smallest change, biggest win)

Give `busy` agents (those holding a claimed assignment) a work-sized grace period; keep
the short window only for `waiting` agents (which re-ping every ≤45 s anyway).

```js
// src/devteam/store.mjs — #reapStaleAgents
#reapStaleAgents({ waitingMs = 120_000, busyMs = 900_000 } = {}) {
  const waitingBefore = new Date(Date.now() - waitingMs).toISOString();
  const busyBefore    = new Date(Date.now() - busyMs).toISOString();
  const staleAgents = this.db.prepare(`
    SELECT * FROM agents
    WHERE status != 'disconnected'
      AND ( (status = 'busy'    AND last_seen < ?)
         OR (status != 'busy'   AND last_seen < ?) )
  `).all(busyBefore, waitingBefore);
  ...
}
```

- **Why:** aligns the reaper with `turnTimeoutMs` (15 min) — the project's own definition
  of how long a turn may take. A working agent gets the time it actually needs.
- **Tradeoff:** a *truly* crashed busy agent now holds its claim longer (up to `busyMs`).
  Acceptable, and mitigated by Fix 2. Make both values configurable.

### ★ Fix 2 — Tie liveness to the live MCP session, not just `last_seen` (most correct)

The server already knows when a transport opens and closes
([`server.mjs:52-60`](src/devteam/server.mjs), `transport.onclose`). Record the mapping
`sessionId → agentId` at `devteam_connect`, and on `transport.onclose` release that
agent's claims immediately.

- **Why:** an agent that is *thinking* still holds an **open MCP session** → provably
  alive, even with zero tool calls. An agent whose client actually died closes the session
  → reap instantly. This removes the guesswork entirely and makes reaping both **faster**
  for real crashes and **impossible** for busy-but-alive agents.
- **Tradeoff:** needs plumbing (`store.attachSession(agentId, sessionId)` on connect;
  clear on close). Streamable-HTTP sessions can span requests, so verify the session truly
  closes only on client teardown, not between calls.

### Fix 3 — Grace/"suspended" state before requeue (don't hand off on first silence)

Instead of `busy → disconnected` in one step, add `busy → unresponsive (claim held) →
disconnected (claim released)` with a grace window. A brief silence never triggers a
handoff; only sustained silence does.

- **Why:** protects against a single long think without giving the claim away.
- **Tradeoff:** one more state to reason about in `#syncTaskStatus` and the dashboard.

### Fix 4 — Reclaim-on-reconnect for the same identity

When an agent reconnects with the same `(name, provider)` and it had an assignment
released by **heartbeat expiry** (not a clean `devteam_disconnect`) within the last N
minutes, reattach that assignment to the reconnected agent instead of minting a fresh
identity that competes for it.

- **Why:** lets the original worker resume its own in-flight work — no duplicated effort,
  no race. Would have let *me* finish `index.html` instead of fighting Codex for it.
- **Tradeoff:** must guard against a genuinely-dead agent's name being reused by a
  different process; scope the reattach to a short window and log it.

### Fix 5 — Guard the write lease on report (compare-and-set)

In `completeAssignment`/`devteam_report`, reject a report whose assignment was reassigned
since it was claimed (compare `agent_id` / a claim token). Surface a clear message so the
stale worker knows *why* and doesn't overwrite the new owner's work.

- **Why:** closes the double-write race directly, as defence-in-depth even after Fixes 1–2.
- **Tradeoff:** the stale worker loses its output — but that's strictly better than a
  silent clobber, and Fix 4 makes it rare.

### Fix 6 — Client-side keepalive during long work (complement, not a cure)

Encourage/allow the agent to call a cheap `devteam_state` or a dedicated
`devteam_heartbeat` periodically during multi-step work.

- **Why:** cheap insurance for *multi-tool* work stretches.
- **Hard limit:** it **cannot** save a single long *thinking* turn — during one model turn
  **no tool calls happen at all**, so the agent literally cannot ping mid-thought. This is
  exactly the user's scenario, and it's why the real fix must be **server-side (Fixes 1–2),
  not client discipline.**

### Fix 7 — Visibility

Emit a distinct event/badge for *"quiet but presumed working"* vs *"reaped as dead,"* and
include *"idle for Ns"* in the reap event metadata. Humans watching the portal can then
tell a thinking agent apart from a crashed one.

---

## Recommended plan (phased)

**Phase 0 — Stop the bleeding (today, ~1 small diff)**
Ship **Fix 1** (status-aware threshold, `busyMs = 900_000` to match `turnTimeoutMs`, both
configurable). This alone eliminates the observed thrash for realistic task sizes.

**Phase 1 — Make liveness correct (this week)**
Add **Fix 2** (session-bound liveness). With sessions as the source of truth, real crashes
are reaped in seconds and busy-but-alive agents are never reaped. Keep the `last_seen`
timeout only as a fallback for transports that don't report close cleanly.

**Phase 2 — Safe hand-offs & resumption**
Add **Fix 4** (reclaim-on-reconnect) and **Fix 5** (compare-and-set on report). Optionally
**Fix 3** (grace state) if telemetry still shows premature releases.

**Phase 3 — Polish**
**Fix 6** (keepalive guidance in the skill) + **Fix 7** (dashboard visibility).

**Config to expose** (via `startDevTeamServer` options / `api/config`):
`reap.waitingMs` (default 120 000), `reap.busyMs` (default 900 000),
`reap.sweepMs` (default 30 000), `reclaimWindowMs` (default 300 000).

---

## Test plan

- **Unit (`test/devteam-store.test.mjs`):**
  - A `busy` agent with `last_seen` 3 min old is **not** reaped when `busyMs = 900_000`;
    a `waiting` agent with the same age **is**.
  - After `busyMs`, the busy agent **is** reaped and its claim requeued.
  - Reconnect within `reclaimWindowMs` **reattaches** the released assignment to the same
    `(name, provider)`; outside the window it does not.
  - `devteam_report` from a stale (reassigned) agent is **rejected**, not applied.
- **Integration (`test/devteam-server.test.mjs`):**
  - Simulate: agent claims a write-leased assignment → stays silent 3 min → a second agent
    calls `devteam_wait`. Assert the first agent **keeps** its claim and the second is told
    the lease is held.
  - Close a transport (`transport.onclose`) and assert the agent's claims release promptly
    (Fix 2).
- **Manual:** re-run the "3D Sea" task; confirm one agent implements `index.html`
  end-to-end without being reaped mid-build, and review/test unlock only after the write
  lease is *reported* done.

---

## Open questions for the human

1. Preferred **`busyMs`** — match `turnTimeoutMs` (15 min), or shorter (e.g. 8–10 min)?
2. Is **session-bound liveness (Fix 2)** acceptable given the Streamable-HTTP transport, or
   do you want to stay purely on `last_seen` with a longer busy window?
3. On heartbeat-expiry reconnect, should the agent **auto-reclaim** its old assignment
   (Fix 4), or should the human decide each time?

---

### Appendix — key references

- Reaper + threshold: [`src/devteam/store.mjs:235`](src/devteam/store.mjs) (`#reapStaleAgents`)
- Release/requeue claims: [`src/devteam/store.mjs:212`](src/devteam/store.mjs) (`#releaseAgentClaims`)
- Heartbeat write: [`src/devteam/store.mjs:728`](src/devteam/store.mjs) (`heartbeat`)
- Write-lease guard: [`src/devteam/store.mjs:797`](src/devteam/store.mjs) (`claimNextAssignment`)
- Reconnect identity: [`src/devteam/store.mjs:671`](src/devteam/store.mjs) (`registerAgent`)
- Wait-loop heartbeat: [`src/devteam/mcp.mjs:55`](src/devteam/mcp.mjs), [`:86`](src/devteam/mcp.mjs)
- Server periodic sweep: [`src/devteam/server.mjs:166`](src/devteam/server.mjs)
- Turn budget (15 min): [`src/core.mjs:27`](src/core.mjs) (`turnTimeoutMs`)
