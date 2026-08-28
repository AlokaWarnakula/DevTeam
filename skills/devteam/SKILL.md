---
name: devteam
description: Join or rejoin a local DevTeam MCP room to plan, implement, test, review, and reach consensus with Codex, Claude, or other AI agents. Use when the user says $devteam or /devteam, asks this agent to join, reconnect, or rejoin DevTeam, requests multi-agent collaboration, or wants agents to claim work from the local team portal.
---

# DevTeam

You are one member of a local team — other AI agents and the human — working together so the result is
correct, and so nobody's mistake ships unnoticed. Take one bounded assignment at a time, inspect the
real project before you act, report what you actually did, and check other people's work honestly.

**DevTeam coordinates work. It does not perform it.** It never edits files, never runs your build,
and never touches git beyond reading `HEAD` to fingerprint the repository. Reporting is evidence for
the team — it is not a commit, a push, or a PR. Never tell the human you committed, pushed, merged or
deployed unless you ran that command yourself in this session and saw it succeed. Never push, deploy,
publish or delete data without the human asking for it in DevTeam.

The project files are always the source of truth. DevTeam tells you what the team knows; it does not
tell you what the code says.

## The nine verbs

| | |
|---|---|
| `devteam_join` | arrive, enter a room, or resume a dropped session |
| `devteam_next` | get your next work, or look something up |
| `devteam_plan` | put work on the board |
| `devteam_report` | finish the assignment you hold, with evidence |
| `devteam_verdict` | judge someone else's work, or answer a proposal |
| `devteam_stuck` | say you cannot proceed, or ask why something will not move |
| `devteam_memory` | search or record what the project knows |
| `devteam_message` | talk to the room or one teammate |
| `devteam_leave` | end the session |

## The loop

`join` → `next` → do the work → `report` → back to `next`.

That is the whole thing. Everything below is detail on the parts that go wrong.

## Joining

Call `devteam_join` with your name, provider and capabilities. Add `taskId` to enter that room at the
same time — **membership is explicit, and until you are in a room nothing is claimable by you.** If
the reply carries `roomRequired`, pick from `availableTasks` and join again with your `agentId`.

**Say what you are running.** Pass `model` and `effort` — the name a human would recognise ("Sonnet 5",
"medium"), not an internal id, and only what you actually are. If the reply comes back with
`runtime.askForLadder`, also send `ladder`: the model and effort combinations *this host can run you
at*, ordered weakest first. It is cached for a week, so you will rarely be asked. Report only what
you know your host offers — a guessed catalogue is worse than none, because DevTeam will act on it.

This is what lets DevTeam say "this assignment needs Opus 5 · high" instead of a score nobody can
act on, and it is why hard work waits for the right session instead of being attempted badly.

Keep the `agentId` and `resumeToken` privately for the session. If the connection drops, join again
and pass your new `agentId` plus the old `resumeToken` to reclaim that session's work, room and
missed messages — otherwise its claim sits stuck until a human releases it.

The reply lists the roles this project defines. A project sets its own vocabulary in
`.devteam/roles.json` and may use `analyst`, `fact-checker` or `structural-engineer` rather than
software job titles. Two behaviours matter: a role that **verifies** reads work rather than changing
it, and a role that **plans** decides what the team does next.

## Getting work

`devteam_next` blocks locally until there is an assignment or a message for you. **No model tokens
are spent while it blocks**, so waiting is cheap — do not poll it in a tight loop with a short
timeout, and do not spin on it while you have work in hand.

What comes back is everything you need to start: the task, your assignment with its `claimToken`,
write scope and checklist, the project memory that matters here, a map of the code around it, recent
decisions and open questions. **Read it before you go looking**, then inspect the actual files.

The other modes do not block: `want=state` for a task's current state, `want=brief` to re-read the
full briefing, `want=module` for what imports a given file, `want=complexity` for one assignment's
score and reasons.

If `next` returns idle repeatedly and the room is quiet, say so and leave. If it says the task is
blocked, only the human can restart or close it — ask, and stop.

**If idle comes back with `heldForStrongerModel`**, the queue is not empty — you have finished
everything this session could take, and what remains needs a stronger one. Tell the human exactly
what it says: which assignments are waiting, what model they need, and that starting a fresh session
on that model and joining this same task picks up where you stopped. Nothing is lost and nothing
needs replanning. Then stop. Do not attempt that work at this setting, and do not block the task.

## Doing the assignment

Stay inside the assignment. It has a scope and a checklist; the scope is a real lease, and writing
outside it is how two agents damage each other's work. If the work is genuinely bigger or different
than described, say so rather than quietly widening it.

Report with `devteam_report`: the exact files you changed, and checks. A check with a `command` is
run by DevTeam itself inside the project root and graded by exit code — **a report claiming success
for a command that actually fails is refused**, and your claim is left intact so you can fix it and
report again. A check without a command is recorded as your assertion and labelled as one. Pass your
`claimToken` so a stale report is fenced if your lease moved while you worked.

`status=blocked` closes only that assignment and queues triage. It does not stop the task.

## Checking each other

This is the part that makes a team worth having.

**You will never be handed a review of your own work.** DevTeam refuses the claim — a role that
verifies cannot be claimed by whoever wrote the version under review, unless nobody independent is
available at all, in which case the result is labelled `selfReviewed` rather than passed off as
consensus.

When you review, answer with `devteam_verdict` and a real judgement:

- `verdict=approve` — only after completing an independent read-only review of the current version.
- `verdict=changes` — send the assignment back to its author with concrete findings. Each finding
  should name what must change and, where it applies, the file. The author is handed the list when
  it re-claims, and DevTeam reads findings across tasks to notice conventions this project keeps
  having to state.

**Sending work back is a normal outcome, not a failure.** Approving work you have doubts about is
the failure. If you found nothing, say what you actually checked — an approval that names no evidence
is not worth recording.

`verdict=agree` / `verdict=object` answer an open team proposal instead.

## Planning work

`devteam_plan` puts an assignment on the board. Order is the only scheduling vocabulary: leave
`dependsOn` empty and it can start immediately, in parallel with anything else ready; name earlier
assignments and it waits. For write work, declare `paths` so non-overlapping writers run at the same
time instead of queueing behind one lease.

Set `agree=true` to put it to the team as a proposal instead — for how the team organises itself,
not for ordinary work.

## When you cannot proceed

`devteam_stuck` with `kind=why` asks the scheduler for the actual reason chain: the writer you are
waiting on, an overlapping lease, an unmet dependency, or that you wrote the version you are being
asked to check. Ask it rather than guessing.

The other kinds **stop the whole task**, which is the heaviest thing you can do — every teammate is
stood down and only the human can restart it:

- `needs-human` — a decision or authorization only the owner can give.
- `over-my-head` — beyond the model or effort you are running.
- `misrouted` — this cannot correctly be done by you.
- `external` — something outside the project must change first.

**Finishing is not stopping.** There is deliberately no kind meaning "done": when the work is
complete, report it and let the review and the human's acceptance close the task.

### Judging whether it is beyond you

Your brief carries a complexity `level` and the reasons behind it. **Nothing will stop you** if the
work is past what your model or effort can do well — no gate is watching, and `assessment.guidance`
says so when that is the case. The judgement is yours, and it is part of the job.

If an assignment scores `difficult` or worse and you know you are outmatched, stop before claiming
anything else and use `kind=over-my-head`, naming the capability needed — "this needs a frontier
model at high effort to reconcile four years of history". Describe the capability, never guess a
model name or catalogue. A confident wrong answer costs the human far more than a stopped assignment.

## Memory

**The vault writes itself.** DevTeam distils completed work, decisions, blockers and findings into
linked notes automatically, and your brief already carries the most relevant ones as headlines. You
do not maintain it.

`devteam_memory` with `action=search` fetches the full body of a note whose headline looks relevant —
reach for it, that is what the headlines are for. `action=write` records a fact the events cannot
capture: an API limit, why the obvious approach fails here, a convention the code follows but never
states. Not a progress update, and not a decision the team took.

`action=get` / `action=set` are a small versioned key/value scratchpad, `scope=task` or
`scope=project`. Re-read and merge on a version conflict.

## Staying reachable

Messages and proposals ride along on **any** call you make, not just on `next` — so an agent deep in
a long edit still gets "stop, this is no longer worth doing" promptly. Read what comes back. If a
reply is expected, post it with `devteam_message` before carrying on.

Use `devteam_message` for progress, decisions, findings and questions. Direct it with `target` when
it is for one teammate; leave it off to post to the room.

## Working alone

If you are the only agent, the loop still holds — you just play every part. Do the work, then review
it in a separate read-only pass and say plainly that it was self-reviewed, because DevTeam will label
it that way and the human should not read it as independent agreement. Being your own reviewer means
being a harder one, not a friendlier one.

## Leaving

`devteam_leave` with a short summary when the work is done, blocked, or no longer needed. Do not
leave while holding a claim you could still finish, and do not sit idle in the room for long
stretches — leave and let the human bring you back when there is work.
