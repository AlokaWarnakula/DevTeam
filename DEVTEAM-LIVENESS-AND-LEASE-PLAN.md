# DevTeam liveness and work-lease redesign

Status: proposed implementation plan  
Scope: `C:\Users\aloka\Mine\Projects\bridge`  
Problem reproduced: 2026-08-09 against live task `559c0750-868c-4e14-8388-f467da8a06a0`

## Executive recommendation

DevTeam must stop treating the absence of an MCP tool call as proof that a busy agent has stopped working.

The current server uses one field, `agents.last_seen`, for two different questions:

1. Is the agent currently responsive in the room?
2. Does the agent still own an assignment and its write lease?

Those are not equivalent. After `devteam_wait` returns an assignment, a desktop agent can spend several minutes reasoning, editing, generating, running tests, or waiting on another tool. During that work there is no background heartbeat. The server currently expires the agent after 120 seconds, releases the assignment, and lets another agent claim it. The original agent can still be running and can still modify the shared filesystem, so this defeats the project-wide write-lease guarantee.

The recommended design separates short-lived **presence** from durable **assignment ownership**:

- Keep a short presence timeout for dashboard accuracy.
- Never release an active write assignment solely because `last_seen` is old.
- Give assignments an explicit, longer ownership lease with a unique claim token and a recovery state.
- Prefer explicit disconnect, a confirmed MCP transport close, authenticated resume, or human-approved force release over speculative takeover.
- Fence stale reports with a claim generation/token so two sessions cannot both complete the same assignment.

## Reproduction evidence

The live task timeline demonstrates the bug without inference:

| Event | Agent | Timestamp (UTC) | Result |
|---|---|---:|---|
| Assignment claimed | Claude | 13:18:48.768 | Implementation starts |
| Heartbeat expiry | Claude | 13:21:05.143 | Assignment released after about 136 seconds |
| Assignment claimed | Codex | 13:21:05.145 | Same assignment immediately changes owner |
| Heartbeat expiry | Codex | 13:23:10.651 | Assignment released after **125.506 seconds** |
| Assignment claimed | Claude | 13:23:42.153 | Same assignment changes owner again |
| Heartbeat expiry | Claude | 13:26:10.699 | Assignment released again |

Each disconnect event has metadata reason `Agent heartbeat expired.` and `releasedAssignments: 1`.

This matches the implementation:

- `src/devteam/store.mjs:235` reaps every non-disconnected agent whose `last_seen` is more than `120_000` ms old.
- `src/devteam/store.mjs:212` returns every claimed assignment owned by that agent to the queue.
- `src/devteam/server.mjs` runs the reaper every 30 seconds.
- `src/devteam/mcp.mjs:55-86` refreshes heartbeats while `devteam_wait` is blocking.
- `src/devteam/mcp.mjs:77-84` returns as soon as work is claimed. There is no heartbeat channel while the model performs the assignment.
- `src/devteam/store.mjs:774` reaps stale agents before a new claim, so a second agent actively triggers takeover.
- `src/devteam/store.mjs:849-853` later rejects the original worker's report because the assignment is no longer claimed by that session.

There is a second identity hazard at `src/devteam/store.mjs:665-675`: connecting a new session with the same display name and provider disconnects every existing matching session and releases its work. Display names are not safe session identifiers, especially when two Codex or Claude chats are intentionally connected.

## Why the current tests miss it

`npm test` currently passes all 29 tests. The stale-agent test deliberately backdates a busy writer and asserts that a replacement can take its assignment. That test encodes the unsafe behavior as a requirement.

Missing scenarios include:

- A real worker remains silent for more than 120 seconds while reasoning or running tools.
- The original worker writes after the server has reassigned the same write lease.
- Two sessions share the same `name` and `provider` but are different chats.
- A previously reaped worker attempts to report valid work.
- An MCP session remains open while no model-generated calls are made.

## Required safety invariant

> At most one agent may be authorized to modify a project at a time, and lack of model-generated MCP traffic alone must never transfer that authorization.

The server cannot revoke an agent's filesystem access. Therefore a false-positive takeover is more dangerous than a temporarily stuck lease. Recovery should favor safety and require stronger evidence than a two-minute quiet period.

## Proposed state model

### 1. Separate presence from work ownership

Keep agent presence as an operational signal:

- `waiting`: recently contacted the room and owns no assignment.
- `busy`: owns a current assignment and was recently active.
- `unresponsive`: owns an assignment but its presence heartbeat is old.
- `disconnected`: explicitly left or the owning transport was conclusively closed.

An `unresponsive` agent remains the assignment owner. The dashboard can warn the human, but `claimNextAssignment` must treat its claim—especially a write claim—as active.

### 2. Add an explicit assignment lease

Migrate `assignments` with:

```sql
claim_generation INTEGER NOT NULL DEFAULT 0,
claim_token_hash TEXT,
lease_state TEXT NOT NULL DEFAULT 'none',
lease_started_at TEXT,
lease_expires_at TEXT,
last_checkpoint_at TEXT,
recovery_requested_at TEXT
```

On claim:

- Increment `claim_generation`.
- Generate a high-entropy `claimToken`; store only its hash.
- Return the token with the assignment.
- Set `lease_state = 'active'`.
- Use a configurable lease duration long enough for a genuine coding turn (recommended initial default: 30 minutes).

All assignment-mutating tools (`devteam_report`, handoff, block, and any future release endpoint) validate the current generation/token. A stale session receives a structured `claim_conflict` response containing the current assignment state and recovery instructions.

The token is fencing for server-side state; it cannot stop filesystem writes. That is why automatic write takeover still requires a conservative recovery policy.

### 3. Use two-stage expiry

Recommended defaults:

| Signal | Initial threshold | Effect |
|---|---:|---|
| Waiting presence silent | 120 seconds | Mark disconnected; no work is owned |
| Busy presence silent | 120 seconds | Mark `unresponsive`; retain assignment |
| Read-only assignment lease | 15 minutes | Mark recoverable after a short grace period |
| Write assignment lease | 30 minutes | Mark recovery requested; do **not** auto-transfer |
| Explicit disconnect | Immediate | Release owned assignment normally |
| Confirmed transport close | 30–60 second grace | Mark disconnected; release read-only work, put write work into recovery |
| Human force release | Immediate after confirmation | Increment generation and return assignment to queue |

Do not hard-code these values. Add server configuration and expose non-secret effective values from `/api/config`.

### 4. Bind agents to MCP sessions

`src/devteam/server.mjs` already owns the `StreamableHTTPServerTransport` lifecycle. Associate connected `agentId` values with their `mcp-session-id`:

- Pass session context into `createDevTeamMcpServer`.
- Register each `devteam_connect` result with the transport.
- On any request, refresh transport activity separately from agent presence.
- On `transport.onclose`, notify the store and start a short recovery grace period.
- Do not treat an idle but still-open transport as equivalent to a heartbeat; use it as supporting evidence only.

This provides a high-confidence fast path for real closes while preserving the longer fallback for silent crashes.

### 5. Make connect resumable and stop using names as identity

Change `devteam_connect` so a display-name collision does not evict an existing session.

Recommended contract:

- A new connection always creates a distinct session identity.
- The result includes a short display suffix for the dashboard, such as `Codex · a31f`.
- Add `devteam_resume` with an opaque resume credential tied to the old session and its claim.
- A successful resume keeps the same assignment, claim generation, and write lease.
- A new session without the resume credential cannot replace or release the old session merely by using the same name/provider.
- Targeting should move from ambiguous `target_agent_name` toward `target_agent_id`, retaining name targeting only as a compatibility fallback.

Resume credentials must be treated as secrets: return once, store hashed, never show them in the dashboard or timeline, and rotate them after use.

### 6. Add explicit recovery controls

Add a dashboard action and authenticated API route for an unresponsive assignment:

1. **Ping owner** — posts a directed message and records the recovery request.
2. **Wait** — keeps the lease protected.
3. **Force release** — requires assignment-title confirmation, records a reason, increments claim generation, and emits a prominent audit event.
4. **Resume owner** — copies a reconnect prompt; an authenticated resume reactivates the same claim.

For a write assignment, the UI must warn that force release can create overlapping filesystem edits if the old agent is still running.

## Tool and response changes

### `devteam_wait`

- Continue long-poll heartbeats while waiting.
- Return `claimToken`, `claimGeneration`, `leaseExpiresAt`, and `checkpointRecommendedAt` with an assignment.
- State clearly that the assignment remains owned while the agent is thinking.

### New `devteam_checkpoint`

Inputs: `agentId`, `assignmentId`, `claimToken`, optional progress summary.

Effects:

- Validates current ownership.
- Refreshes presence.
- Extends the assignment lease up to a configured maximum.
- Optionally emits a throttled progress event.

The skill should call it before a long test/build and between meaningful work stages. It is helpful but must not be required every two minutes, because model reasoning itself cannot run a background tool call.

### `devteam_report`

- Require the claim token after a compatibility period.
- If ownership changed, return a structured conflict rather than only `This assignment is not currently claimed by this agent.`
- Include current owner, generation, takeover timestamp, and safe next actions.

### `devteam_connect` / `devteam_resume`

- Do not replace sessions based on name/provider equality.
- Resume only with an opaque credential or an explicit, human-confirmed takeover.

### `devteam_state`

Expose presence and lease separately:

```json
{
  "presence": "unresponsive",
  "assignmentLease": {
    "state": "active",
    "generation": 3,
    "expiresAt": "...",
    "recoveryRequestedAt": null
  }
}
```

Never expose claim or resume tokens.

## File-by-file implementation plan

### Phase 1 — stop unsafe reassignment

1. `src/devteam/store.mjs`
   - Introduce named, injected liveness configuration.
   - Change the stale reaper to distinguish waiting from busy agents.
   - Mark silent busy agents `unresponsive` without releasing claims.
   - Exclude `unresponsive` claimed writers from new write eligibility exactly as active busy writers are excluded.
   - Remove same-name/provider eviction from `connectAgent`.

2. `src/devteam/server.mjs`
   - Pass liveness configuration to the store.
   - Expose effective public thresholds from `/api/config`.

3. `public/app.js` and `public/styles.css`
   - Render `unresponsive` as amber, not disconnected.
   - Show “working, no recent checkpoint” and keep the assignment attached.

4. `test/devteam-store.test.mjs`
   - Replace the current expectation that a 120-second-old busy writer is automatically displaced.
   - Add regression tests proving the write lease stays exclusive.

This phase is the urgent correctness patch. It can ship before tokens/resume support.

### Phase 2 — durable leases and fencing

1. Add the assignment lease columns through an idempotent migration in `store.mjs`.
2. Generate and validate claim tokens.
3. Add `devteam_checkpoint` in `src/devteam/mcp.mjs`.
4. Return structured conflict details from stale report attempts.
5. Update `skills/devteam/SKILL.md`, `README.md`, and `GUIDE.html`.
6. Use `node bin/devteam.mjs sync-skill --dest ...` for each installed desktop skill only after tests pass.

### Phase 3 — session-aware recovery and resume

1. Track agent IDs per MCP transport in `server.mjs`.
2. Add transport-close grace handling in the store.
3. Add hashed resume credentials and `devteam_resume`.
4. Add human recovery endpoints and dashboard controls.
5. Migrate targeted assignments toward agent IDs.

## Regression test matrix

All timing tests should use an injected clock/configuration; they should not sleep in real time.

1. A waiting agent silent beyond the presence TTL disconnects.
2. A busy read-only agent silent beyond the presence TTL becomes `unresponsive` and retains its claim.
3. A busy writer silent beyond the presence TTL retains both assignment and project write lease.
4. A second agent cannot claim that assignment or another write assignment in the same project.
5. Explicit owner disconnect releases the assignment immediately.
6. Confirmed transport close follows the configured grace/recovery policy.
7. A checkpoint renews the matching generation and rejects an old token.
8. Force release increments generation and allows exactly one new claim.
9. The old owner's later report returns `claim_conflict` and cannot complete the new claim.
10. Two sessions with identical name/provider coexist without evicting each other.
11. An authenticated resume restores the original assignment without a new claim.
12. Resume tokens are hashed at rest and absent from snapshots/events.
13. Server restart preserves active/recovery lease state consistently.
14. Dashboard state distinguishes `busy`, `unresponsive`, and `disconnected`.
15. Existing planning, write serialization, review gating, approvals, messages, and proposals continue to pass.

Add an MCP integration test that claims an assignment, advances a fake clock past 120 seconds without another agent call, and verifies that the first session can still report successfully. This is the direct regression test for the live failure.

## Acceptance criteria

- A Codex or Claude assignment can spend at least 10 minutes in uninterrupted reasoning/tool work without being reassigned.
- No write assignment is automatically transferred solely because `last_seen` exceeded the presence TTL.
- A genuinely closed session can be recovered through explicit disconnect, transport-close recovery, resume, or audited human force release.
- Two same-name/provider sessions do not disconnect one another.
- Every ownership transfer increments a generation and leaves an audit event.
- A stale owner cannot complete or approve work for a newer claim generation.
- The dashboard accurately distinguishes “not recently responsive” from “no longer owns work.”
- The full automated suite passes, including the live-failure regression scenario.

## Why not use the simpler fixes?

### Only increase 120 seconds to 10 or 30 minutes

This reduces frequency but preserves the same race. A sufficiently long build, test, approval wait, or interrupted tool call will still cause unsafe reassignment.

### Ask the model to heartbeat every minute

The model cannot call an MCP tool while it is in the middle of reasoning or while a blocking tool is running. A skill instruction is not a background scheduler.

### Release work whenever the MCP session looks idle

Streamable HTTP session idleness is not proof that the desktop agent stopped executing. Session state is useful evidence, but not enough by itself to revoke a write lease.

### Never recover assignments automatically

That protects correctness but leaves crashed agents able to block a project forever. The proposed design keeps fast explicit recovery, session-close recovery, resumability, and an audited human override.

## Suggested delivery order

1. Ship Phase 1 first: busy/unresponsive separation and no automatic write takeover.
2. Add the exact 125-second live regression test before further refactoring.
3. Add lease generations/tokens and structured conflicts.
4. Add transport binding, resume, and human recovery UX.
5. Update and resync the packaged DevTeam skill last, so agents receive instructions matching the deployed server behavior.

The core idea is simple: **presence can expire automatically; ownership must be released deliberately or with strong evidence.** That makes the team slightly more conservative when a worker disappears, but it restores the guarantee that agents cannot unknowingly work on the same files at the same time.
