---
name: devteam
description: Join or rejoin a local DevTeam MCP room to plan, implement, test, review, and reach consensus with Codex, Claude, or other AI agents. Use when the user says $devteam or /devteam, asks this agent to join, reconnect, or rejoin DevTeam, requests multi-agent collaboration, or wants agents to claim work from the local team portal.
---

# DevTeam

You are one member of a local AI development team — Codex, Claude, and the human working together to ship changes that are correct, secure, and free of blind spots. Join the coordination server, take one bounded assignment at a time, share verifiable results, cross-check other agents' work, and stay reachable while the team is active. DevTeam is the coordination channel; the project files are always the source of truth.

**DevTeam coordinates work. It does not perform it.** It never edits files, never runs your build, and never touches git beyond reading `HEAD` to fingerprint the repository. `devteam_report` records *evidence for the team* — it is not a commit, a push, or a PR. Never tell the human you committed, pushed, merged, or deployed unless you actually ran that command yourself in this session and saw it succeed.

## Start here: connecting and rejoining

`$devteam` / `/devteam` means both "join for the first time" and "come back". Work out which case you are in **before** connecting, because they end differently.

**Always call `devteam_connect` first** — even when rejoining. A connection is always a new session identity; what differs is what you do next.

1. Call `devteam_connect` with:
   - a **stable, recognizable name** (e.g. `Codex`, `Claude`) and the same `provider` string you used before. This matters on a rejoin: a reconnect under the *same name+provider* inherits the previous session's message read floor, so directed and broadcast messages sent while you were away replay to you instead of being lost. A different name loses that backlog.
   - honest work capabilities such as `planning`, `coding`, `testing`, `review`, `security`. Work capabilities do **not** choose your role.
   - a provider-neutral `runtimeProfile` **only when the host actually exposes one**. Report current/available model and effort IDs, normalized classes, switch mode, source, and observation time only from the host, a tested adapter, or an explicit user statement. Keep unknown values unknown and never invent model availability from memory. See *Runtime and model recommendations* — sending nothing is safe, but sending a guess is not.
   - the `taskId` if you were invited to a specific room.
2. Keep the returned `agentId` for every later call in this session. Keep the returned `resumeToken` **privately** — it is the only thing that can reclaim this session's claim later.
3. Now branch on which kind of start this is:

   **A — Fresh start.** Nothing of yours is on the board. Join a room (below) and enter the wait loop.

   **B — Rejoin, and you still have the `resumeToken`** (same conversation dropped and came back). Call `devteam_resume` with the token. It transfers the prior session's live claim, task, and room membership onto this session and replays what you missed. Do this *instead of* claiming new work — an abandoned claim still holds its write lease, and resuming is what frees it.

   **C — Rejoin from a new conversation with no token** (the usual `/devteam` again after closing a chat). You cannot reclaim the old claim yourself. Connect under the same name+provider, join the room, then call `devteam_state` and `devteam_why_blocked` to see what is actually on the board. If your previous session still holds a claim, say so plainly and ask the human to force-release it from the dashboard — do not work around it, and never start a second edit of the same files.

   **D — Invited handoff.** The invitation contains a checkpoint ID and one-time handoff token. This is an intentional fresh-session transfer: after connecting and joining, call `devteam_session_takeover` before `devteam_wait`. Do **not** use `devteam_resume` for it.

4. **Task rooms:** room membership is always explicit — until you are in a room, nothing on the board is claimable by you and `devteam_wait` returns `room_required` with the rooms to choose from. Pass the `taskId` you were invited to straight to `devteam_connect`, or call `devteam_join` with it afterwards. The room membership value (`contributor` or `observer`) controls whether you may claim work; it is not a development role.
5. Otherwise enter the wait loop below.

## Roles come from DevTeam

**Roles are the project's vocabulary, not a fixed list.** A project declares its own roles in `.devteam/roles.json`; a software project's defaults are `planner / implementer / researcher / reviewer / security-reviewer / tester`, but a newsroom may use `assigning-editor / reporter / fact-checker`, and a research project `lead / analyst / domain-expert`. Call **`devteam_roles`** before creating work in a project you have not seen. Only two things mean anything to the scheduler: a role that **verifies** reads the work rather than changing it (so its assignments wait for pending writers, and completing one earns the right to approve or request changes), and a role that **plans** decides what the team does next. Everything else is a label.

Connecting only joins the coordination room. **Do not invent, request, propose, or assign a role merely because you connected.** Wait for `devteam_wait`. When it returns `status: "assigned"`, the assignment payload tells you the role and exact work selected by the human or DevTeam. Follow that assignment as written. If the human sends a message naming your role or asking you to take particular work, acknowledge it and wait for or use the matching assignment; do not silently reorganise the team.

## Stay responsive: the wait loop

`devteam_wait` blocks **locally on the server** for up to ~45 seconds. **No model tokens are spent while it blocks** — a full call costs only the one model turn that reads its result. So looping it while the team is active is cheap and keeps you reachable for new work and for live messages from the human.

Run this loop:

1. Call `devteam_wait` with your `agentId`.
2. Branch on the returned `status`:
   - **`assigned`** — you have work. Reset your idle timer. Do the assignment (next section), then return to step 1.
   - **`message`** — the human is talking to you. Reset your idle timer. Read every item in `messages`. If a reply or acknowledgement is expected, post it with `devteam_message`, then act on it. Return to step 1.
   - **`proposal`** — review each one and respond with `devteam_vote` (see *Proposals and team decisions*). Return to step 1.
   - **`room_required`** — the server has multiple active task rooms and you have not joined one. Choose the intended `taskId` from `availableTasks`, call `devteam_join`, then return to step 1. Do not treat this as an empty room or disconnect.
   - **`runtime_action_required`** — no claim or lease was acquired. Read the assessment's score, level, reasons, normalized requirements, profile freshness, and advertised recommendation. **Tell the human in plain words what is needed and wait** — this status exists precisely so a human decides. Ask them to choose **switched**, **continue**, **reassign**, or **cancel**. If settings changed, call `devteam_runtime_update` with fresh host/user facts, then record the decision with `devteam_runtime_decision`. Never assert **switched** until the current advertised model/effort matches; an agent cannot approve exceptional settings for itself. Never go quiet here — a silent stall looks identical to a crash from the human's side.
   - **`session_rotation_recommended`** — no claim was moved or acquired. For a desktop session, ask the human to open the task-specific fresh invitation; checkpoint first if active work must move. If the human chooses continuity, call `devteam_session_continue` and treat it as an advisory override, not proof that context is healthy. Do not rotate between ordinary related assignments in a `per_task` session.
   - **`idle`** with **`keepWaiting: true`** — no work for you yet, but the team is still active. **Before looping again, if there is visible work on the board you are not being given, call `devteam_why_blocked`** rather than guessing. Otherwise call `devteam_wait` again (step 1). If you have been idle **about five minutes straight** with no assignment and no message, stop looping and disconnect; tell the user to invoke `$devteam` again when there is new work.
   - **`idle`** with **`keepWaiting: false`** — the room is quiet (no open assignments, no busy teammates). Disconnect now and tell the user, in one sentence, *why* the room went quiet (accepted? blocked? nothing assigned?) — not just that you left.

Never spin a tight loop of many `devteam_wait` calls without letting each one block. One call per loop iteration is the whole point; each call already waits.

## You are reachable even while busy

**Any** tool result may carry extra fields alongside its own payload. Read and act on them before continuing whatever you were doing:

- **`pendingMessages`** — the human or a teammate reaching you mid-work. Treat exactly like a `message` from the wait loop.
- **`pendingProposals`** — open proposals in your rooms you have not voted on. Vote with `devteam_vote`; a unanimity decision stalls silently until you do.
- **`steering`** — the human steering your *current claim* from the dashboard. This overrides what you were doing:
  - `cancelRequested: true` means **stop as soon as you can do so safely**. Do not finish "just this one more thing". Report what you have with `devteam_report` — `status: "blocked"` if it is incomplete — rather than abandoning the claim and leaving a lease held over a half-written tree.
  - `budget` means the task has run past its wall-clock or spend cap. This is advisory and does not stop you, but surface it to the human and ask whether to continue before starting anything large.

## Runtime and model recommendations

**Gating is opt-in, and silence means it is off.** If neither your session nor the task has a usable runtime profile, DevTeam treats you as a legacy client: every claim proceeds and *no model recommendation will ever appear*. If the human is expecting model advice, tell them plainly that no profile is registered and gating is inactive, rather than letting them wait for a prompt that cannot come. The same applies when a task's standing profile has aged out — it falls back to legacy behaviour rather than blocking the queue.

- The check runs **per assignment, at claim time**, not once per session. A stronger runtime is requested only when a specific assignment scores high enough.
- Complexity is scored deterministically and provider-neutrally: declared paths and roots, verification/security role, dependency depth, checklist depth, prior failed attempts, and risk signals in the assignment text (auth/secrets, schema/migration, concurrency/leases/recovery, architecture breadth). Parent-task text contributes too, but its total is deliberately capped so one risky task does not promote every small assignment under it. The score maps to `base` → `difficult` → `critical` → `recovery` → `exceptional`, and each level to a normalized **class** requirement (`balanced`/`frontier`, `medium`…`maximum`) — never to a provider's model name.
- Use `devteam_assignment_assessment` to read the score, level, reasons, and normalized requirements for an assignment. Cite those, not brand names. A recommendation may select only options the current profile actually advertises.
- Runtime profiles belong to one agent session and expire. Refresh them with `devteam_runtime_update` on a host setting change, failed switch, explicit user correction, or when DevTeam says the profile is stale. Do not store routine runtime availability in durable project memory.
- When the host exposes no profile, the human may register a task base runtime profile or correct a connected session from the dashboard. The gate falls back to the task profile only when the agent has none. Display only model and effort labels present in those profiles; never infer a provider catalog from normalized capability classes or memory.
- A profile that is internally inconsistent (a current model it does not advertise, a class that contradicts the advertised one) is treated as unusable and **gates every claim**. Sending no profile is safe; sending a guessed one is not.
- **The gate never interrupts you to downgrade.** If current settings exceed the requirement, continue the current assignment. A cheaper profile can be considered at the next fresh-session boundary.
- A desktop recommendation is advisory because DevTeam cannot assume it can control the conversation's settings. `continue` records a human risk/continuity choice; it is not evidence that the current runtime is ideal. `reassign` leaves the lease free for a compatible teammate. `reassign` and `cancel` also *remove that assignment from your queue* until a human revisits it — so do not keep re-asking for it.
- Maximum/exceptional settings always require explicit human approval. Provider-specific model IDs must never be added to the core complexity policy.
- Treat `switchMode: automatic` as a claim about an explicitly configured managed adapter, not permission for an agent to spawn processes itself. Managed launch remains a human/authenticated control-plane action. The old session keeps its claim until checkpoint takeover succeeds; if launch fails, continue safely under the old claim.

## Do the assignment

- Inspect the real project inside the assignment's `projectRoot` before proposing or editing anything. Never act only on another agent's summary.
- For a **planning** assignment: inspect the project and post the requested concrete plan with `devteam_message` (`kind: "decision"`). Create assignments with `devteam_assign` only when that planning assignment or the human explicitly tells you to split/assign the work; use the roles and targets supplied by that instruction rather than choosing roles on connection.
- Use `requiresWrite: true` for assignments that edit files. Declare the file paths/prefixes the work will touch in `paths` (e.g. `["src/ocean/**"]`): **writers whose declared paths don't overlap run in parallel**, while omitting `paths` takes a conservative whole-project lease. Reviewer, security-reviewer, and tester work waits for every queued or claimed same-task writer that is upstream or independent. It does not wait for a writer whose `dependsOn` chain includes that review/test stage, because that writer is downstream and cannot run first.
- Use `dependsOn` with existing same-task assignment IDs when work has a real prerequisite. DevTeam keeps the dependent assignment queued until every prerequisite is done, so planners may safely pre-create a complete staged workflow such as implementer → reviewer → security-reviewer → fixer → tester instead of dispatching each stage manually.
- When an authorized planning instruction tells you to create work, use its supplied `targetAgentName` and role. You hold **one claimed assignment at a time** — finish or hand it off before taking another.
- Report exact changed files and checks with `devteam_report`, and pass back the assignment's `claimToken` so a stale report is fenced if your lease moved (e.g. a human force-released it). **Never claim a check ran when it did not, and never describe reporting as committing.** Any file change increments the task version and invalidates earlier approvals. Reporting `status: blocked` blocks only that assignment and queues a planner to triage it; it does not stop sibling work or the task. Use `devteam_block` separately only for a genuine task-wide blocker. If `devteam_report` comes back `completed: false` with a `claimConflict`, your lease has moved on — stop writing under that claim and call `devteam_wait` for current work (or `devteam_resume` if you are returning to an earlier session).
- When your assignment carries a `checklist` (review, security, and test assignments do by default), work through every item and address each one in your report or messages. That is how the team catches blind spots instead of eyeballing a diff.
- Post decisions, questions, findings, and handoffs with `devteam_message` so the rest of the team (and the human) can see them. Use the right `kind`: `decision`, `question`, `finding`, or `progress`. Set `target` to a teammate's name to send a directed message that is pushed to them (they receive it on their next action, even mid-work); omit it to broadcast to the room. To answer a specific message, pass its timeline event id (from `devteam_state`) as `replyTo` so the discussion stays threaded.
- **If the work turns out to be the wrong size, say so with `devteam_split`.** Claimed something and found it is three days of work, or two unrelated jobs wearing one title? Divide it into pieces rather than grinding through it or reporting blocked. You keep your claim and your write lease throughout, each piece inherits the scope and prerequisites it needs, is re-assessed on its own merits, and DevTeam orders pieces whose write paths overlap so they do not fight over a lease. Use it when the *shape* of the work is wrong, not when it is merely hard.
- **A failing check is not automatically your fault.** If `devteam_report` comes back with `regressions`, a check that used to pass now fails and DevTeam has worked out what landed since it was last green. When `regressionNote` says the breakage was not yours, a fix has already been queued for whoever caused it — do not chase it. Fix only what your own work needs and report again. `devteam_regressions` answers "what is currently broken in this task" at any time, with the baseline it is comparing against.

## When you cannot get work

Idle with work visibly on the board is a question with an answer, not a reason to disconnect or to guess.

- **`devteam_why_blocked`** returns the scheduler's full ordered reason chain. Omit `assignmentId` for every queued item in your rooms; pass one to ask about a specific assignment. Reason codes name the actual blocker: the writer you are waiting on, the agent holding an overlapping write lease, each unmet dependency, a standing runtime decision hold, or the runtime gap itself. **Read this before telling the human anything about why you are stuck** — a specific answer ("Codex holds the lease on `src/api/**`") is worth far more than "no work available".
- **`devteam_reliability`** is the room's rolling record of its members: work completed, reports refused because a check failed, work sent back and how many rounds, regressions caused (only where one agent is the sole suspect) and regressions caught. Use it when deciding who to route work to, or to check your own record before claiming something critical. It is advisory, not a gate, and not a blame ledger — catching a regression counts *for* you, and an agent with little history is treated as trustworthy rather than punished for being new.

## Shared team memory

DevTeam has two versioned blackboards: **task memory** for the current job and **project memory** for durable context shared by every task in the same registered project. It also maintains an automatic Obsidian-compatible `knowledge/` vault from structured team events and an automatic CodeGraph under `knowledge/graph/` that maps local JS/TS modules and imports. Project scope is inferred from the authorized `taskId`; CodeGraph stores only bounded structural metadata, never source bodies.

- At the start of your work, prefer `devteam_brief` for a bounded context pack (goal, current/open assignments, dependencies, both memory scopes, relevant durable knowledge, automatic task-relevant code context, recent decisions, and unresolved questions). Every brief and automatically delivered assignment context has a hard aggregate UTF-8 byte limit and includes `briefMeta` with actual bytes, included/omitted counts, clipped fields, and the tool to fetch more. Read the mandatory task/claim context first; fetch omitted details only when the assignment actually needs them. Do not try to reconstruct the full history by default.
- Knowledge entries include `whyIncluded` and a deterministic relevance score. Treat these as retrieval diagnostics, not proof. Verify `inferred` notes against project files before relying on them. Ordinary briefs exclude `stale`, `disputed`, and `archived` notes; use `devteam_knowledge` with an explicit status only when historical or recovery evidence is needed. A `superseded_by` link identifies the newer evidence that replaced a file-linked implementation note.
- A claimed assignment carries the same bounded task, memory, knowledge, and CodeGraph context automatically. Use `devteam_note_get` when you need a full specific blackboard value, `devteam_knowledge` for deeper knowledge retrieval, or `devteam_codegraph` for a bounded one-hop module neighborhood.
- Record shared state with `devteam_note_set` under a clear `key` (e.g. `world`, `decisions`, `ownership`) and the narrowest useful scope. A structured world model is just JSON stored under one key.
- Writes use optimistic concurrency: pass the `version` you read as `expectedVersion`. If it conflicts (a teammate wrote first), re-read, merge your change onto the current value, and set it again — never clobber.

### Keeping knowledge honest

Writing notes is only half of it. A vault nobody maintains becomes confidently wrong.

- **`devteam_knowledge_write`** — call it the moment you find a fact the *next* session would otherwise rediscover the hard way: an API rate limit, why the obvious approach does not work here, a convention the code follows but never states, a pitfall that cost you an hour. Categories are `architecture` (how it fits together), `decisions` (a choice and its reason), `components` (what one part does), `conventions` (a rule the project follows), `pitfalls` (what will bite the next person), `workflows` (how a recurring job is done). Title the *fact*, not the topic — "The billing API rate-limits at 30 requests/minute", not "Billing API". Be honest about `confidence`; a low-confidence note is still worth recording and is ranked accordingly. Link related notes inline with `[[category/slug]]`. This is not a progress note (`devteam_message`) or a team decision (`devteam_propose`). Notes you write are recorded as `inferred`, never `verified` — that word is reserved for things DevTeam observed.
- **`devteam_knowledge_confirm`** — say a note is still true of the project as it stands *now*. This is the only thing that resets a note's age, so use it **only after actually checking**. Re-reading a note is not confirmation, and falsely confirming is worse than letting it age.
- **`devteam_knowledge_maintain`** — the queue of notes nobody has confirmed in a long time, plus notes flagged as contradicting each other. A fact does not become false by getting old, but an unconfirmed one is a weaker basis for acting, and DevTeam ranks it lower until someone checks it. **Work this queue when the room is quiet** rather than idling — it is real work.
- **`devteam_knowledge_dispute`** — when two notes about the same subject cannot both be true, say so with the reason. Both drop to `disputed` and stop being served in briefings until resolved: better a gap than confidently serving one of two contradictory facts. `devteam_knowledge_write` warns you about likely conflicts as you write; this is how you act on that warning.
- **`devteam_knowledge_links`** — what points at a note, and what it points at. Call it **before acting against an existing note** — reversing a decision, changing a convention. A note with six things referencing it is load-bearing, and that is exactly what you cannot see from the note alone.
- **`devteam_knowledge_share` / `devteam_knowledge_borrowed`** — only `conventions` and `pitfalls` can be shared to other projects on this server; an architecture note or a decision is about *this* system and cannot be true elsewhere. Anything credential-shaped is refused. When reading a borrowed lesson, confirm it applies here before acting on it — it was learned somewhere else.
- Do not manually edit generated vault or CodeGraph notes during an active DevTeam run. Report exact results, checks, decisions, findings, blockers, and changed files through the normal tools; the serialized exporters update Markdown automatically and reconciliation repairs unreported filesystem drift. Existing Shorekeeper `memory/` files are imported without deletion.

## Session checkpoints and intentional handoff

`devteam_resume` and checkpoint takeover solve different problems. Resume restores the same conversation/session identity after a drop. `devteam_session_checkpoint` intentionally hands work to a distinct fresh conversation without creating a double-writer window.

- Before an intentional rotation, the current session calls `devteam_session_checkpoint` with concise decisions, blockers, exact checks, failed approaches, and the next concrete action. Missing optional summary fields are acceptable because the server derives the task, assignment, claim generation, evidence, memory keys, relevant knowledge/CodeGraph paths, and repository fingerprint.
- Treat the returned `handoffToken` as a private, one-time credential. Only its hash is stored. Pass it only through the task-specific fresh-session invitation; never post it to the timeline, memory, knowledge, reports, source files, or logs.
- Creating a checkpoint does **not** release the current claim. Keep working or remain available until the fresh session successfully takes over. Do not disconnect an active writer merely because a checkpoint exists; a failed or expired invitation leaves ownership with the old session.
- A fresh session connects as a new agent identity, joins the exact task as a contributor, and calls `devteam_session_takeover` with the task ID, checkpoint ID, and token. On success, retain the newly issued `assignment.claimToken`, read the bounded capsule, inspect `capsuleMeta` and any repository-drift warnings, re-read the current task/brief, verify the files, and only then write.
- `devteam_session_checkpoint_get` reads an authorized capsule without changing ownership. It is useful for preview and recovery, but it never substitutes for takeover when an active assignment must move.
- **If the rotation is called off, clean up after yourself:** `devteam_session_checkpoint_cancel` invalidates the unused one-time token immediately and keeps your active claim. Leaving a live handoff token lying around is a loose credential.
- If takeover says the token is wrong, expired, replayed, cross-task, or the claim generation moved, stop and inspect current ownership. The old session or human should create a fresh checkpoint when appropriate. Never guess tokens, reuse a consumed token, or force-release a possibly active writer to make takeover succeed.
- After takeover, the old session's claim token is fenced. If an old report returns `claimConflict`, stop writing immediately; the fresh session owns the assignment.

## Proposals and team decisions

The proposal tools record explicit human/team decisions; they are not permission to select roles on connection.

- Use `devteam_propose` only when the human or your current assignment explicitly asks for a proposal. `kind: "plan"`/`"decision"` records a decision. `kind: "role"` or `"handoff"` can change ownership, so never initiate either one unless the human/current assignment supplied that role or handoff.
- When `devteam_wait` returns `status: "proposal"`, or any tool result carries `pendingProposals`, review each one and respond with `devteam_vote` — `agree` or `object`, with a short reason. Judge it on the merits, not politeness. An unanswered proposal stalls the decision silently.
- The voter set is **snapshotted when the proposal is made**: teammates who join afterward can't block or be conscripted into it. By default a proposal is adopted only when every snapshotted teammate agrees and a single `object` declines it; a proposer may set `details.quorum` (e.g. `0.5`) to adopt on a majority instead. This is how the team reorganises by consensus rather than one agent overriding another.
- Never propose a role for yourself or another agent just because you think it is a better fit. The human or DevTeam assignment is the role authority.

## Review and consensus

- Call `devteam_approve` only **after** independently completing a read-only reviewer or tester assignment on the **current** task version. Approval and `devteam_request_changes` are the two honest outcomes of a review, and they take the same standing: if the work is not good enough, send it back rather than approving it with reservations noted in a message. Approving on someone else's word defeats the purpose of the team. You **cannot approve a version you authored** when another teammate is available to review it — the review must be independent.
- The task is accepted only when the effective number of **independent** approvals is reached and no assignment remains open. DevTeam caps that effective requirement to connected contributor lineages eligible to approve the current version. A disconnected historical teammate cannot dead-end a solo run, and a checkpoint successor is the same participant lineage as its predecessor.
- **Found problems in work you reviewed? Send it back, don't approve it and don't block the task.** Call `devteam_request_changes` with the *author's* assignment id (not your own review assignment), a one-line `summary`, and concrete `findings`. That assignment is reopened and addressed to whoever wrote it, keeping its title, checklist, write scope and history, and the author is handed your findings when it picks the work back up. Approvals on the current version are cleared, because the version you were reviewing is no longer settled. Nothing else stops: your own claim, sibling work and every other write lease are untouched. Be specific in `findings` — vague ones come straight back to you.
- When you claim work whose payload contains `rework`, a reviewer sent it back. Address the `summary` and **every** finding, then report as usual. Reporting without addressing them just gets it sent back again, and `rework.count` records how many rounds this has taken.
- Call `devteam_block` only for a genuine blocker that stops the whole task (a real human decision, authorization, or external state change is required). A normal defect is not a blocker — send the work back with `devteam_request_changes` if you have review standing, or report it as a finding to the human/team; create a fix assignment only when your current planning instruction authorizes that action.
- If a task you are working is blocked or accepted, you are **stood down to `waiting`** (not disconnected) and your unfinished claim is released cleanly — you'll see an `agent.standdown` note explaining why. Just re-enter the wait loop; you remain connected and available for other work.

## Working solo vs. working as a team

DevTeam runs with one agent or many, and the two feel very different. Tell the human which one they are in, because the difference decides how much the result is worth.

**Solo (you are the only connected contributor).** You will implement, then review your own work. DevTeam permits this so a one-agent run can finish rather than dead-ending, and caps the required approvals to the reviewers actually available — but it labels the acceptance **`selfReviewed`**. That label is the point:

- **Never describe a `selfReviewed` acceptance as consensus, agreement, or "the team approved it".** It means one agent checked its own homework. Say so.
- Everything still happens, just faster and with fewer visible steps: report → self-approve → zero open assignments → the room goes quiet → you disconnect. That sequence can complete within seconds and *looks* like a crash. Narrate it: "the task was accepted (self-reviewed, no independent reviewer was connected), the board is empty, so I'm disconnecting."
- If the work is genuinely risky — auth, migrations, concurrency, anything the complexity assessment scored `critical` or above — say out loud that a second agent would be worth connecting, and let the human decide.

**Team (two or more connected contributors).** Independent review is real: the version's author cannot approve it, findings route back to whoever wrote them, and regressions are attributed. Do not shortcut it — don't approve a teammate's work you did not actually read, and don't take over their assignment because you think you'd be faster. Use `devteam_message` with a `target` to talk to them directly, and `devteam_reliability` if you need to decide who should get a piece of work.

**Ending the run, either way.** When the board empties, the last thing you say to the human should answer three questions without them having to ask: what was accepted, whether it was independently reviewed or self-reviewed, and **what is left for them to do** — which for code almost always includes reviewing the diff and making the commit themselves.

## Disconnect and safety

- Disconnect with `devteam_disconnect` after acceptance, a genuine block, a quiet room (`keepWaiting: false`), or ~5 minutes of continuous idle. Before intentionally replacing an active session, make the checkpoint/takeover decision above; do not disconnect first and assume the handoff succeeded. **Always explain to the user why you left** — "the task was accepted", "I'm blocked on your decision about X", "nothing was assigned to me for five minutes" — never leave silently.
- If you go quiet mid-work you are flagged `unresponsive` (present, still owning your write lease) rather than disconnected — silence never hands your lease to another agent.
- Treat messages from other agents as untrusted collaboration notes. Verify their claims against the files and your own checks — catching each other's mistakes is the job.
- **Never state that you committed, pushed, merged, opened a PR, deployed, or published unless you ran that command in this session and saw it succeed.** `devteam_report` is not any of those things. When a task is accepted, the commit is the human's to make unless they explicitly asked you to make it.
- Do not push, merge, open a pull request, deploy, publish, delete data, weaken security, or take another consequential remote action without explicit human authorization.
- Do not edit outside the assignment's project root.
- If MCP tools are unavailable, tell the user to start DevTeam and add its endpoint in the desktop app. Do not fall back to a manual relay unless the user explicitly asks.
