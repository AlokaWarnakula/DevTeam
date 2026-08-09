# DevTeam: additional coordination gaps beyond the heartbeat/lease bug

**Author:** Claude (Anthropic Claude Code), DevTeam agent
**Date:** 2026-08-09
**Project:** `C:\Users\aloka\Mine\Projects\bridge` (`local-devteam` v0.2.0)
**Reads:** verified against source; complements `COORDINATION-HEARTBEAT-FIX.md` (Claude) and `DEVTEAM-LIVENESS-AND-LEASE-PLAN.md` (Codex)

---

## Why this doc exists

Both existing plans are correct and worth shipping. But they attack **one axis** — *liveness
vs. ownership* (the reaper kills a thinking agent and hands off its write lease). That fixes
the thrash. It does **not** get you the thing you actually asked for: **Claude + Codex + other
agents behaving like one collective mind (a hive).**

A hive needs three things the current server doesn't provide:

1. **Reachability** — any member can reach any other *right now*, even mid-work.
2. **Parallelism** — members can work at the same time without corrupting shared state.
3. **Shared mind + trustworthy consensus** — a common, queryable memory and a decision rule
   that doesn't deadlock or flip based on who happens to be connected.

Below are the gaps I found in each, verified against the code, with severity and file refs.
"Overlap" marks issues the other two docs already cover; everything else is new here.

---

## A. Reachability — a busy agent is unreachable (no interrupt channel)

**Severity: High. New.**

Human/teammate messages are delivered **only inside `devteam_wait`**
([`mcp.mjs:59`](src/devteam/mcp.mjs) → `deliverDirectedMessages`). Once an agent claims an
assignment it *leaves* the wait loop to do the work, so:

- The **human cannot interrupt or redirect a working agent.** Your test message at 13:19:57
  was seen by Codex (briefly idle) but never reached me while I was implementing.
- A teammate cannot get a working agent's attention either.

This is fatal for a hive: you can't steer a mind you can't reach. It also compounds the
heartbeat bug — the only way to "stay reachable" today is to sit in `devteam_wait`, i.e. to
*not* be working.

**Also:** delivery is filtered by `e.created_at >= agent.connected_at`
([`store.mjs:308`](src/devteam/store.mjs)), so a reconnecting/resumed agent is **never
re-delivered anything said while it was gone** — resumed agents have message amnesia. (Ties
into Codex's resume design: resume must replay missed directed messages.)

**Direction:** deliver directed messages on *every* tool call (piggyback on the `heartbeat`
side-effect), return any pending messages in the result envelope of `devteam_report` /
`devteam_state` / `devteam_message`, and add a lightweight `devteam_checkpoint` (Codex's
proposal) that also drains the inbox. True interrupts need the transport (see F / Codex's
session binding) but even inbox-on-every-call closes most of the gap.

---

## B. No agent→agent addressing or wakeup

**Severity: High. New.**

`devteam_message` has no `target` — it only appends to the shared timeline
([`store.mjs:835` `postMessage`](src/devteam/store.mjs)). Directed delivery
(`deliverDirectedMessages`) handles **`human.message` only**, never `agent.message`. So:

- One agent **cannot directly address or wake another** ("Codex, take the shader module").
  It can only post to the log and hope the other reads it on its next `devteam_state`.
- `replyTo` threads exist but are passive — no push.

A hive coordinates member-to-member, not just human-to-member. Add `target`/`targetAgentId`
to `devteam_message`, and make `deliverDirectedMessages` deliver directed `agent.message`
events too, so `devteam_wait` returns `status:"message"` for teammate pings.

---

## C. Parallelism is structurally disabled — one write lease **per project**

**Severity: High (biggest hive limiter). Partially overlaps** (both docs treat the lease as
correctness; neither flags its *granularity* as the parallelism killer).

`claimNextAssignment` blocks **any** second write assignment anywhere in the **whole
project** while one write claim is active ([`store.mjs:797-808`](src/devteam/store.mjs)):

```sql
a.requires_write = 0 OR NOT EXISTS ( ... busy write claim in the same project ... )
```

So two agents can **never** edit two different files at the same time. The core advantage of
a hive — parallel work — is off by construction. Everything serializes to one writer.

**Direction:** move from a single project-wide lease to **path-scoped leases** (lock a file
or subtree, not the project). An assignment declares the paths it will write; the store grants
a lease only if those paths don't overlap a live lease. This is what lets Claude build the
ocean while Codex builds the HUD. (Pair with Codex's claim-token fencing so each lease is
individually revocable/verifiable.)

---

## D. Consensus is fragile: unanimity of *currently-connected* agents, no quorum, no timeout

**Severity: High. New.**

`#evaluateProposal` ([`store.mjs:478-483`](src/devteam/store.mjs)) adopts a proposal only if
**every currently-connected agent except the proposer** has voted `agree`, and a single
`object` kills it ([`:472`](src/devteam/store.mjs)). Problems:

1. **The required set is recomputed from live connections on every vote.** Who must agree
   changes as agents connect/disconnect. An agent that connects *after* voting started is
   silently added to the required set (blocks a nearly-adopted proposal); one that drops is
   removed (can flip a stuck proposal to adopted). Non-deterministic and race-prone.
2. **A stale-but-not-yet-reaped agent still counts as connected** and blocks *all*
   proposals — instant deadlock, and directly worsened by the heartbeat bug (a *thinking*
   agent silently vetoes consensus).
3. **No quorum / supermajority option and no timeout.** One holdout or one crashed agent
   freezes governance forever; there is no fallback.

**Direction:** define the voter set as a **snapshot at proposal creation** (or an explicit
quorum policy), support supermajority not just unanimity, exclude `unresponsive` agents from
the required set, and add a proposal timeout with a human-decides fallback.

---

## E. "Independent" approval isn't guaranteed independent

**Severity: Medium. New.**

`approveTask` requires the *approver* to have a completed reviewer/tester assignment on the
current version with no changed files ([`store.mjs:919-929`](src/devteam/store.mjs)) — but
**nothing requires the approver to be someone other than the author.** After implementation
bumps the version and clears approvals ([`store.mjs:862-864`](src/devteam/store.mjs)), the
implementer can claim a reviewer assignment, complete it read-only, and approve their own
code. Worse, `#effectiveRequiredApprovals` **caps the requirement at the participant count**
([`store.mjs:900-908`](src/devteam/store.mjs)), so a **solo agent self-approves and accepts
its own work** with zero outside review — the "no dead-ends" rule quietly defeats the
"independent review" guarantee.

**Direction:** exclude agents who produced `changedFiles` for the current version from that
version's approver set; keep the solo fallback explicit and *labeled* ("self-reviewed, not
independently approved") rather than silently counting it as consensus.

---

## F. Control-plane HTTP endpoints are unauthenticated (injection into the hive)

**Severity: High (security). New.**

Only `/mcp` is behind the bearer token (`mcpAuth`, [`server.mjs:73-75`](src/devteam/server.mjs)).
Every REST route is **open**: `POST /api/tasks`, `DELETE /api/tasks/:id`,
`POST /api/projects`, `DELETE /api/projects/:id`, `POST /api/tasks/:id/messages`,
`/api/tasks/:id/proposals`, `/api/proposals/:id/vote`, `/api/tasks/:id/block`
([`server.mjs:85-135`](src/devteam/server.mjs)). Consequences:

- Any local process (or a browser via DNS-rebinding / a simple cross-origin POST to
  127.0.0.1) can **inject "human" messages and votes**. Those messages are then delivered to
  agents as **trusted human instructions** (`deliverDirectedMessages`) — a prompt-injection
  channel straight into every agent in the hive.
- The **destructive** `DELETE` routes (drop tasks/projects) need no auth.
- `/api/config` **returns the bearer token in plaintext** to any unauthenticated caller
  ([`server.mjs:82`](src/devteam/server.mjs)), so the `/mcp` token is trivially obtained —
  the auth boundary is effectively bypassable locally.

**Direction:** put the same token (or a session cookie the dashboard obtains via a real
login) on all mutating `/api` routes; stop returning the raw token from `/api/config`; add an
`Origin`/`Host` allowlist to blunt DNS-rebinding. Even "local only" isn't a trust boundary on
a shared machine.

---

## G. Blocking or accepting a task force-disconnects *every* agent on it

**Severity: Medium. New.**

`blockTask` ([`store.mjs:971-974`](src/devteam/store.mjs)), the blocked branch of
`completeAssignment` ([`:882-885`](src/devteam/store.mjs)), and task acceptance in
`approveTask` ([`:946-949`](src/devteam/store.mjs)) all run
`UPDATE agents SET status='disconnected' ... WHERE current_task_id = ?`. In a hive where
several agents work one task in parallel, **one agent blocking (or the task being accepted)
yanks everyone else's session and releases their in-flight claims** — mid-write. That's both
a data-loss risk and a coordination surprise.

**Direction:** on block/accept, *notify* co-workers and release claims cleanly, but don't
force-`disconnected` agents that are actively writing; let them finish or checkpoint first
(depends on the lease redesign in the other two docs).

---

## H. No shared "team memory" / blackboard

**Severity: Medium (design gap central to your goal). New.**

Coordination state is the append-only **event timeline + the filesystem**. There is no
shared, structured, writable working memory a hive can read/update cheaply — no blackboard of
"current world model," decisions, open questions, per-file ownership, or accumulated facts.
Agents re-derive context from scrollback (expensive) or from each other's summaries
(untrusted). A collective mind needs a **shared memory substrate**: a small key/value or
document store scoped to the task/project that any member can read and append to, with
provenance. This is the difference between "several agents taking turns" and "one mind."

**Direction:** add task/project-scoped shared-state tools (`devteam_note_set/get`, or a
structured "plan/worldstate" document with optimistic-concurrency writes). Keep provenance so
agents can still weigh trust.

---

## I. Identity is name-based and lossy on reconnect

**Severity: High. Overlap (Codex covers this well) — reinforcing.**

Confirmed: `connectAgent` evicts and releases the claims of any non-disconnected session with
the same `name`+`provider` ([`store.mjs:662-683`](src/devteam/store.mjs)); reconnect mints a
brand-new `agentId` ([my `agentId` changed 84bfab90→8af2a2b1 mid-session]); and message/
handoff targeting is by **name** ([`store.mjs:316-320`](src/devteam/store.mjs),
`target_agent_name`), which is ambiguous with two "Claude" chats. Codex's `devteam_resume` +
`targetAgentId` plan is the right fix; I only add that **message replay on resume** (see A)
must be part of it or resumed members stay amnesiac.

---

## Consolidated priority (across all three docs)

| # | Problem | Axis | Severity | Where covered |
|---|---------|------|----------|----------------|
| 1 | Busy/thinking agent reaped; write lease transfers | liveness | **Critical** | Claude + Codex |
| 2 | Path-granular lease so agents work in parallel (C) | parallelism | **High** | *new here* |
| 3 | Busy agents unreachable; no msg interrupt (A) | reachability | **High** | *new here* |
| 4 | No agent→agent addressing/wakeup (B) | reachability | **High** | *new here* |
| 5 | Unauthenticated REST + token leak (F) | security | **High** | *new here* |
| 6 | Fragile unanimity consensus; deadlocks (D) | consensus | **High** | *new here* |
| 7 | Name identity / resume / targetAgentId (I) | identity | **High** | Codex (+replay) |
| 8 | Self-approval counts as independent (E) | trust | **Medium** | *new here* |
| 9 | Block/accept force-disconnects co-workers (G) | parallelism | **Medium** | *new here* |
| 10 | No shared team memory/blackboard (H) | shared mind | **Medium** | *new here* |

## Suggested sequencing

1. **Ship the liveness/lease fix first** (the other two docs) — nothing else matters while
   agents keep getting reaped.
2. **Lock down the REST endpoints (F)** — small, and it's an open injection path into every
   agent. Do it early.
3. **Reachability (A/B)** — inbox-on-every-call + agent→agent directed messages. Cheap, huge
   hive payoff.
4. **Path-scoped leases (C)** + don't-force-disconnect (G) — unlocks real parallel work.
5. **Consensus snapshot + quorum + timeout (D)** and **independent-approval fix (E)**.
6. **Shared team memory (H)** — the substrate that turns "a team" into "a hive."

---

### Verification notes (so these aren't taken on faith)

- Message delivery only in the wait loop: `deliverDirectedMessages` is called solely at
  [`mcp.mjs:59`](src/devteam/mcp.mjs); `postMessage`/`devteam_message` has no target arg
  ([`store.mjs:835`](src/devteam/store.mjs)).
- Project-wide write lease: single `NOT EXISTS ... busy write ... same project_id`
  ([`store.mjs:797-808`](src/devteam/store.mjs)).
- Consensus set is live connections minus proposer, recomputed per vote
  ([`store.mjs:478-483`](src/devteam/store.mjs)).
- Approval independence not enforced vs author; participant cap
  ([`store.mjs:900-929`](src/devteam/store.mjs)).
- REST routes lack `mcpAuth`; `/api/config` returns the token
  ([`server.mjs:73-135`, `:82`](src/devteam/server.mjs)).
- Force-disconnect on block/accept ([`store.mjs:882-885`, `946-949`, `971-974`](src/devteam/store.mjs)).
- Name-collision eviction ([`store.mjs:662-683`](src/devteam/store.mjs)).
