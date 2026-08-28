# DevTeam v2 — the queue and the conversation

**Status:** correctness, memory, the tool collapse and model selection all shipped on branch
`devteam/barefoot-core` — 277 tests green, unmerged. **No real agent has used the new nine-verb
interface yet; that is the next thing to do.** Cold-start instructions are in section 16.
**Written:** 2026-08-28. Progress and what remains are in section 9.
**Supersedes:** `ROADMAP.md` as the forward-looking document. ROADMAP is now history — all 20 of its
items are done, and it describes how DevTeam got here, not where it goes.

---

## 0. The one-line goal

> A universal room where AI agents show up, agree who does what, split the work into pieces that can
> run in parallel or in order, do it, check each other honestly, and leave the project knowing more
> than it did before.

Everything in this document is either **the work queue** or **the conversation between agents**.
Those two things are the product. Everything else is a supporting detail and must justify itself
against them.

---

## 1. What we measured

Not opinion. Read on 2026-08-28 from the live database at
`%LOCALAPPDATA%\DevTeam\devteam.sqlite`.

| | |
|---|---|
| Events recorded | 2,354 |
| Period | 2026-08-10 to 2026-08-27 |
| Projects | 4 (Not Bagel, DevTeam, StudyHive, SEF Lab 02) |
| Tasks | 40 |
| Assignments | 333 (262 done, 71 blocked) |
| Distinct agents | 2 (Claude, Codex) |

The core loop is genuinely exercised: 293 assignments created, 306 claimed, 264 completed. The queue
works. What follows is about the parts that only *look* like they work.

### 1.1 Peer review is not happening

| Signal | Count |
|---|---|
| `assignment.changes_requested` | **2** |
| Assignments ever reworked | **1** of 333 |
| `runtime.switch_recommended` | **1** of 54 complexity assessments |

264 completed assignments produced two requests for changes. That is not a team catching mistakes;
that is a rubber stamp. The cause is in section 2.1.

*(An earlier version of this table also counted `blackboard.updated` and `knowledge.*` events as a
memory signal. They are not one — they count manual tool calls, and automatic capture writes no such
event. See section 6 for what the vault actually holds.)*

### 1.2 Agent-facing weight

| | |
|---|---|
| MCP tools | 39 |
| `skills/devteam/SKILL.md` | 36,735 bytes |
| `src/devteam/mcp.mjs` | 49,810 bytes |
| Database tables | 29 |
| `src/devteam/store.mjs` | 6,035 lines, one class, 144 methods |

An agent pays roughly 60–85 KB of context to learn how to be a teammate **before it reads one line
of the user's project**. The six verbs it actually needs are buried among 39.

### 1.3 Role usage

`implementer` 121 · `reviewer` 65 · `planner` 60 · `security-reviewer` 52 · `tester` 32 ·
`researcher` 3.

---

## 2. The three defects

These are bugs, not aesthetics. Fix them before simplifying anything, or the simplification carries
them forward.

### 2.1 The scheduler gives review claims to the author — live as of 2026-08-27

`src/devteam/store.mjs:712` *records* whether an approval came from someone other than the version's
author. It never *prevents* the author from claiming the review. Independent review is currently
enforced only by agents noticing and refusing by hand. Seven blocked assignments are exactly that
refusal; the two most recent are from 2026-08-27:

> "the assignment is intended for Claude (target_agent_name=Claude), but DevTeam repeatedly assigns
> its live claim to Codex, the implementation author. I cannot honestly perform or approve…"

> "Misassigned after authorship changed: Codex implemented current version 3 and cannot supply the
> requested independent test pass."

When the agent does *not* notice, a self-approval is recorded as team consensus. This is the single
most expensive defect in the system, and it is why section 1.1 looks the way it does.

### 2.2 `block` means six different things

Six `task.blocked` events read "because all work is done", "Done", "done", "done first
improvements". Agents block a task to mean **finish**, because no verb for finishing is within
reach. Today `block` is used for: *I am stuck* · *this is misrouted to me* · *I decline this* ·
*this review is stale* · *I found problems* · *it is done*. Six meanings on one tool is an interface
failure, not an agent failure — and it makes the dashboard's blocked count meaningless.

### 2.3 ~~The planner over-produces~~ — corrected: this was 2.2 all along

The first read of this said 52 of the 71 blocked assignments were never claimed, and blamed a
planner that split too eagerly. Checking it properly: **all 52 belong to tasks whose status is
`blocked`, across just 15 tasks.** Blocking a task flips every queued assignment under it to
`blocked` too, so those 52 are collateral from 15 task-level blocks — not orphans, and not the
planner's doing.

Which makes 2.2 considerably more expensive than it looked: one overloaded verb, used to mean
"done" among five other things, stranded 52 pieces of work that a human then had to reopen by hand.
No cap or expiry on unclaimed assignments is needed, and adding one would have been machinery
against a problem that does not exist.

---

## 3. The protocol: 39 tools to 9

One verb per intent. No synonyms. If two tools could plausibly serve the same moment, they merge.

| Tool | Purpose | Replaces |
|---|---|---|
| `join` | Enter the room; **the agent declares its own capabilities** | `connect`, `join`, `roles` |
| `next` | "What should I do, with everything I need to do it" — blocks until there is work | `wait`, `brief`, `state`, `codegraph` |
| `plan` | Split a task into sub-tasks; `after: [...]` expresses order | `assign`, `split`, `propose` |
| `report` | Progress, findings, decisions, completion — one call, a status field | `report`, progress, finding, decision |
| `verdict` | `approve` or `changes` — the verdict is required, never implicit | `approve`, `request_changes` |
| `stuck` | Halt, with a **required kind** | `block`, `why_blocked`, `resume` |
| `memory` | Read and write shared project knowledge | all 8 `knowledge_*`, `note_get`, `note_set` |
| `message` | Talk to a teammate or the room | `message` |
| `leave` | Exit cleanly | `disconnect` |

**`stuck` requires a `kind`**, which is what fixes 2.2:

- `waiting-on` — a dependency is not ready (the queue handles it, no human needed)
- `misrouted` — this is not mine to do, and here is why
- `over-my-head` — the task exceeds my model/effort; **this is the hook for difficulty escalation**
- `needs-human` — a decision only the owner can make

Completion is **not** `stuck`. It is `report(status: "done")`, and a task finishes through its own
path.

### 3.1 Parallel and sequential are one field

`plan` takes sub-tasks with an optional `after: [ids]`. No `after` means it can run now, in parallel
with anything else that is ready. `after` means it waits. That is the entire scheduling vocabulary
the agents ever see — the dependency machinery already in `assignment_dependencies` does the rest.

---

## 4. The invariants

Rules the **server** enforces, so agents never have to police them by hand.

1. **An agent may never claim a `verifies` assignment on a version it authored.** Enforced in
   candidate selection, at the database level. If no independent verifier exists, the task *waits*,
   or is stamped `selfReviewed` out loud. It is never quietly handed to the author. → fixes 2.1
2. **Done is not blocked.** Every block names its kind, and none of the kinds means "finished".
   → fixes 2.2, and with it the 52 stranded assignments 2.3 blamed on the planner
3. ~~Open unclaimed assignments are capped and expire.~~ **Dropped.** Its premise did not survive
   checking (see 2.3) — there is no orphan problem to cap. Left here as a record of a mechanism
   deliberately not built.
4. **Self-appointment is safe only under invariant 1.** Agents declaring their own roles is the
   right call for a universal tool — but without rule 1, an agent reviewing its own work stops being
   a scheduler slip and becomes the default path.

---

## 5. Any domain, not just software

Partly built already; finish it and make it the default posture.

- **Roles are already project-declared** in `.devteam/roles.json` (`src/devteam/roles.mjs`).
  DevTeam understands exactly two behaviours — `plans` and `verifies` — and has no opinion about
  role *names*. `fact-checker`, `structural-engineer`, `copy-editor` all work today.
- **Checks are already project-declared** in `.devteam/checks.json`. A project with no test runner
  grades `unavailable` rather than failing.
- **Still to do:** the default vocabulary, the dashboard labels, and `SKILL.md` all assume code.
  "Changed files", "diff", "security review" are the built-in nouns. v2 should speak in *artifacts*
  and *evidence*, with the software words as one preset among several.

The four real projects on the board already include coursework (SEF Lab 02), so this is not
hypothetical.

---

## 6. Memory — corrected: it already works, and something was eating it

The first draft of this section said memory "barely accumulates", on the strength of 14 blackboard
writes and 9 knowledge events. **That was the wrong proxy** — those counters measure *manual tool
calls*, not automatic capture. The vault itself tells a completely different story:

| Project | Notes |
|---|---|
| Not Bagel | **471** |
| StudyHive | 87 |
| DevTeam | 64 |
| SEF Lab | 3 |
| **Total** | **625** |

Automatic memory is the part of DevTeam that is working best. Agents do not call the memory tools,
and they do not need to: `#ingestEvent` writes decisions, components, pitfalls and workflows straight
from the event stream, the notes carry provenance and wikilinks, file-linked facts go stale when
their file changes, and briefs deliver them back inside a 6 KiB budget.

### 6.1 The real bug: `npm test` was deleting the vault

Every generated note carries a `generated_by: DevTeam` header, and the exporter deletes any such file
its own database does not account for. A knowledge-enabled test whose project root was
`process.cwd()` is a *second database pointed at this repository* — so running the suite deleted all
64 of this project's notes. CodeGraph had the same hole and was worse: its note filenames hash the
project id, so foreign runs renamed all 52 graph notes every time.

Fixed on 2026-08-28. A vault now records which project owns it (`knowledge/.devteam-vault`):

- **Knowledge**, foreign owner → refreshes notes, **deletes nothing**. Losing a stale file is far
  cheaper than losing someone's memory.
- **CodeGraph**, foreign owner → skips entirely. Nothing is lost; the graph is derived from the code.
- The offending test now uses a directory of its own, and two regression tests pin both halves down.

Verified: a full `npm test` now leaves this repository's vault and graph byte-identical. The 64 notes
were re-exported from SQLite — the Markdown is only a view, so nothing was permanently lost.

### 6.2 What is still missing

`architecture/` and `conventions/` are **empty in all four projects**, and always have been:
`#ingestEvent` can only ever produce decisions, components, pitfalls and workflows. Those two
categories are reachable only through `devteam_knowledge_write`, which agents call approximately
never — 9 events in 17 days.

So the gap is not that memory fails to accumulate. It is that the memory which accumulates is a
**record of work done**, and the memory that would *guide* work — how this project does things, and
what it is — has no automatic source. That is the memory job worth doing next.

### 6.3 Conventions from recurring findings — **built 2026-08-28**

`conventions/` now has an automatic source. `architecture/` deliberately does not, and stays
hand-written: "this proposal touched three directories" is a proxy for structural significance, not
evidence of it, and inventing architecture notes from a proxy is how a vault fills with confident
nonsense.

**The source is `assignment_findings`** — the structured findings attached to a request for changes.
Explicitly *not* the `agent.finding` event stream, which looks like the bigger corpus at 102 entries
but turns out to be free-form narrative: status reports, handoff checklists, agents arguing with each
other, some over a thousand characters. Clustering those would have produced exactly the noise this
feature exists to avoid. That was worth checking before building: the original recommendation in this
section named the right idea and would have been built on the wrong data.

**How it fires.** A finding is reduced to a signature — lowercased, code spans and punctuation
stripped, crude stemming so `clamp` and `clamped` agree, stopwords dropped, the significant words
sorted. Two findings group only when that vocabulary matches exactly. A group becomes a note at
**3 findings across 2 distinct tasks**. The two-task rule is the one doing the work: three bullets in
one review is a thorough reviewer, whereas the same objection on separate work is a rule the project
has and has never written down.

**What the note says.** It quotes. DevTeam states that the same objection has been raised N times
across M tasks, reproduces each finding verbatim with who raised it and when, links the files, and
stops. It never phrases the rule itself — the reader draws that conclusion. Notes are written with
status `proposed`, not `verified`, and a note whose evidence later drops below the bar is archived
rather than left standing.

**It is dormant today, and that is correct.** Your live board has exactly 2 structured findings,
because review was rubber-stamping — the defect fixed in 2.1. Run against real data it writes zero
notes. As independent review starts producing real requests for changes, the corpus grows and the
category fills itself.

Covered by three tests: the grouping function in isolation, the full path from review to exported
note, and the retirement of a note whose evidence is deleted.

---

## 7. Deliberately not doing

Carried forward from ROADMAP's own list, still correct:

- No vector store. FTS5/BM25 was the answer and it works.
- No Postgres until a measured limit forces it.
- Never loosen the write-lease model for throughput.
- No new scheduler role *behaviour* without a real design decision — `plans` and `verifies` are the
  only two, on purpose.

New to this list:

- **No new tool without deleting one.** 39 happened one reasonable addition at a time.
- **`store.mjs` is not split as part of this work.** It is 6,035 lines and that is real debt, but it
  is a separate job with its own risk, and mixing it into a protocol change would make both
  unreviewable.

---

## 8. Decisions

- **Ordering** — invariants first, as standalone correctness fixes against the existing suite, then
  the protocol collapse. *(decided 2026-08-28)*
- **Compatibility** — clean cut to 9 tools, no alias layer, `SKILL.md` rewritten in one pass. There
  is one user and both agents re-read the skill each session, so there is nothing to migrate.
  *(decided 2026-08-28)*
- [ ] **Vocabulary** — how far to go on de-softwaring the defaults in v2 vs. shipping presets later.

---

## 9. Progress

| Step | State |
|---|---|
| Evidence gathered from live DB | done |
| This document | done |
| Invariant 1 — author cannot verify own work | **done** — enforced at claim time, 276 tests green |
| Invariant 2 — done is not blocked | **done** — every block names its kind |
| Invariant 3 — cap/expire unclaimed assignments | **dropped**, premise disproved (see 2.3) |
| Vault ownership — stop `npm test` deleting the memory | **done**, vault restored, churn gone (6.1) |
| Dashboard: quieter assignment cards | **done** (see 9.1) |
| Conventions from recurring findings | **done** — dormant until review produces findings (6.3) |
| Model escalation: agent-told, not human-configured | **done** (see 10) |
| A stopped task has two ways out, not one | **done** (see 11) |
| Memory: 3x more of the vault per brief | **done** (see 12) |
| Removal list from usage data | **ready to cut** (see 13) |
| Architecture notes | **deliberately not automated** — hand-written (6.3) |
| **Tool collapse 39 to 9** | **done** (see 15) |
| Domain-neutral vocabulary | not started |
| `SKILL.md` rewrite | **done** — 34,321 to 9,857 bytes |

**Where this stands overall:** the correctness work is done — review is genuinely independent,
`block` means one thing, and the memory is both protected and now fills its last empty category on
its own. What is *not* done is the simplification the redesign is named for. An agent still meets 39
tools and a 36 KB skill file before it reads a line of your project, and nothing above changed that.
That is the next job, and it is bigger than everything above put together.

### 9.1 Dashboard: what changed

Every assignment card rendered up to thirteen blocks, several of which answered questions nobody was
asking any more. Cut, without removing a single thing a reader needs *at the moment they need it*:

- The `Complexity assessment pending` placeholder is gone. An absent assessment now says nothing
  instead of spending a line announcing its own absence on every card.
- Complexity, runtime decision, write-lease scope and the `· write lease` tag now appear only while
  the work is queued or claimed. On finished work they are history, and they were the most repeated
  blocks on the board.

A finished assignment went from six or seven lines to three:
`Build the CSV export · IMPLEMENTER · Claude · done · [Request changes]`. Live work is unchanged —
complexity, holds, findings and checks all still show, because that is when they mean something.

### What invariant 1 actually took

The naive rule — *exclude the author whenever an independent teammate exists* — deadlocks, and the
randomized scheduler suite caught it on seed 18 within a minute: a teammate who is connected but
already holding all the work it can take will never claim the review, so the item sits queued
forever behind a promise nobody keeps. The rule that shipped asks the sharper question, **"could
somebody else actually take this, right now?"**, through the same explanation surface the scan uses,
so the two cannot drift apart. `test/devteam-store.test.mjs` pins the no-dead-end case down by name.

A side effect worth knowing: the author can no longer complete a read-only review of its own version
at all, so the old approval-time author check is now unreachable through the queue. It stays as
defence in depth, but it is no longer what stops a self-approval — the claim is.


---

## 10. Model escalation — removed the dial, kept the answer

Measured before touching it:

| Runtime profiles ever stored | **0** |
|---|---|
| Tasks with a base runtime profile | **0** |
| Assignments scored `difficult` or worse | **27** of 54 |
| Times a stronger model was recommended | **1** |

Model gating had never been active. It could not be: it compares an assignment's complexity against
a declared runtime profile, and none was ever declared — the dashboard offered a `REAL MODEL NAMES`
dialog asking for provider IDs, switch modes, and a hand-built model/effort matrix. Meanwhile
`SKILL.md` spent ~700 words teaching every agent, every session, the rules of a gate that has never
fired once.

So the direction is inverted. The agent already knows what it is running as; it does not need a
catalog, only permission to say "this is past me".

- **The brief now carries an instruction, not just a number.** `assessment` was already delivered,
  but as a score plus six bookkeeping fields and no advice. It now carries the level, score, top
  reasons, and — when the work scores `difficult` or worse and no gate is active — a plain sentence
  saying nothing will stop you, the judgement is yours, and `devteam_block` with
  `kind: "over-my-head"` is the move.
- **The skill's 700-word gate section is ~200 words** on that judgement. Describe the capability
  needed, never guess a model name, do not push on quietly.
- **The profile-authoring UI is gone.** The `REAL MODEL NAMES` dialog, the task base-runtime button,
  and the per-agent gear are removed — roughly 9.8 KB of `app.js` and 2 KB of markup. The gate
  dialog itself stays, but its entry point now appears only when a profile actually exists, so it
  can never again be a button leading to a dialog that reports its own inactivity.
- **`Model gating inactive — no runtime profile registered` no longer prints** on every queued card
  and every agent row. Telling the reader about a dormant feature is not information about their
  work.

Nothing was removed server-side: complexity scoring, the gate, and `devteam_runtime_update` all still
work for an agent whose host advertises a real profile. What went is the expectation that the human
fills in a model catalog by hand.


---

## 11. A stopped task has two ways out

| Tasks currently blocked | **20** |
|---|---|
| Resumes ever recorded | **3** |

Twenty tasks are sitting stopped on the board. Resume works and always did — **in place**, same task,
same id, same timeline, same knowledge; it bumps the version, clears approvals and queues one fresh
planning assignment. Nobody ever had to create a new task. But it was the *only* exit, and it is the
wrong shape for the six tasks an agent blocked to mean **finished**: closing already-finished work
should not require replanning it, and `acceptTaskByHuman` refused anything blocked outright.

So a blocked task now has two exits, and the right one depends on why it stopped:

- **Resume** — the work genuinely stopped and should continue. Unchanged.
- **Accept as finished** — it was done, and blocking was the wrong verb. Closes in place, records
  `acceptedFromBlocked` in the ledger, no replan, no version bump.

The guard is the same signal invariant 2 uses. If nothing was in flight when the task stopped, there
is no unfinished work to bury and it closes cleanly. If work *was* stopped mid-flight, the first
attempt is refused and names the count — *"was blocked with 1 assignment still in flight"* — and only
a second, explicit confirmation closes it, with `strandedAssignments` on the record. Accepting is
exactly how a stalled piece of work would get quietly lost, so it takes two yeses.

The banner now reads **"Task stopped — only you can restart or close it"** and carries both buttons.

---

## 12. Memory efficiency: 3 notes per brief became 9

Measured against the real vault, not a fixture. One task on Not Bagel, a project holding 626 notes:

| | before | after |
|---|---|---|
| Notes the ranker chose | 30 | 30 |
| Bytes handed to the brief | 46,527 | 15,511 |
| Average per note | 1,551 | 517 |
| **Notes that fit the 6 KiB budget** | **3** | **9** |
| Dropped for want of bytes | 27 | 21 |

The ranker was doing the hard part — picking the best 30 notes out of 626 — and then 27 of them were
thrown away, because each arrived carrying a 1.2 KB body. Paying 1.5 KB per note to see three of them
is the least efficient possible use of that budget.

**A note's first sentence is its claim.** Generated notes lead with their conclusion — "Security
review complete — do not approve v2 yet", "RESEARCH COMPLETE — ALG6 onboarding integration map" — and
a claim is exactly what tells an agent whether it needs the rest. So:

- The **two most relevant** notes keep their bodies. That detail is worth pushing unasked.
- The **tail** arrives as one headline plus its `[[wikilink]]`, about 440 bytes each.
  `devteam_knowledge` reads any of them in full the moment an agent decides it matters.
- The per-note payload lost its bookkeeping — revision counters, event ids, validation stamps,
  status timestamps. None of it was actionable, and all of it was charged to the knowledge budget.

Locked in by a test that fails if fewer than eight notes survive the budget.

---

## 13. What the usage data says to remove

Every table in the live database, counted. Zero means the feature has never once been used in 17 days
across four real projects.

### Never used — remove

| Feature | Rows | What goes |
|---|---|---|
| Session checkpoints / takeover / rotation | **0** | 5 MCP tools, `checkpoint.mjs`, a dialog |
| Cost and token accounting, spend caps | **0** | the `usage` field on report, the budget endpoint |
| Durable job records | **0** | the `jobs` table and its recovery path |
| Named revocable access tokens | **0** | token CRUD and its panel |
| Assignment splitting | **0** | `devteam_split` |
| Project-scoped blackboard | **0** | the project half of `note_get`/`note_set` |

That is **8 of the 39 tools** on evidence, before any collapsing.

### Dormant for a different reason — do not remove

`project_check_commands` is **0**, which means the check allowlist was never configured — so all 50
reported checks are agent *assertions* that DevTeam never ran. That is also why `check_baselines` and
`check_regressions` are 0, and why the reliability record has nothing to score.

These are not unused features; they are the machinery that makes a report trustworthy rather than a
claim, and they are switched off by a missing `.devteam/checks.json`. Deleting them would remove the
only thing standing between "the tests pass" and "an agent said the tests pass". **Configure them
instead** — one file, and `report` starts being verified.

### Collapse rather than delete

The 8 `knowledge_*` tools plus `note_get`/`note_set` are 10 tools over a feature that is DevTeam's
best: 626 notes and counting. The feature stays; the surface becomes one `memory` verb.

---

## 14. Where an agent's tokens actually go

Two costs, and they are paid on completely different schedules.

### Paid once per session, before any work happens

| | |
|---|---|
| `skills/devteam/SKILL.md` | 34,321 bytes |
| 39 MCP tool schemas (prose alone) | 17,283 chars, plus names, types and enums |
| **Session tax** | **~55–60 KB** |

### Paid on every claim and every wait

One real brief, after the work in sections 12 and 13:

| Section | Bytes | Carries |
|---|---|---|
| projectKnowledge | 7,295 | **12 notes** (was 3) |
| codeContext | 4,990 | **17 modules** (was 8) |
| recent | 2,053 | 10 timeline events |
| task + assignment | 1,961 | title, description, scope, checklist |
| briefMeta | 637 | bookkeeping |
| **Total** | **17,605** | |

### What that means for what to cut next

An agent that does five assignments in a session pays roughly
`60 KB + 5 × 17.6 KB = 148 KB`. **The session tax is 40% of that and buys nothing** — it is
what the agent must read to learn how to be a teammate, before it has seen a line of the project.

So the remaining savings are not in the brief. Both memories were just made to carry three to four
times as much for the same bytes, and the rest of the brief is task text, conversation and the
assignment itself — all of it irreducible. Squeezing `recent` or the task description would save a
few hundred bytes and cost real context.

**The tool collapse is the token story now.** 39 tool descriptions to 9 takes the schema prose from
17 KB to roughly 5 KB, and a `SKILL.md` written for nine verbs instead of thirty-nine should land
near 8 KB rather than 34 KB. That is a **~40 KB saving on every session of every agent** — more than
two entire briefs, recovered before the first assignment is claimed.

---

## 15. The barefoot cut, as built

| | before | after |
|---|---|---|
| MCP tools | 39 | **9** |
| Schema prose | 17,283 chars | **10,996** |
| `SKILL.md` | 34,321 bytes | **9,857** |
| **Session tax** | **~60 KB** | **~24 KB** |

The nine: `join`, `next`, `plan`, `report`, `verdict`, `stuck`, `memory`, `message`, `leave`.

Two of the merges changed behaviour rather than packaging. `verdict` makes the judgement a required
field, where `approve` used to be the shortest schema and therefore the default — 264 completed
assignments had produced two requests for changes. `stuck` requires a kind, and none of the kinds
means "finished".

Removed outright, every one with zero rows in 17 days across four projects: session checkpoints,
managed launch, the runtime gate's two tools, spend accounting, regressions, reliability, split, and
six of the ten memory tools.

### What was deliberately left in the store

Checkpoints (118 references), the runtime gate, and the budget cap still exist inside `store.mjs`.
Nothing outside can reach them — no tool, no route, no dashboard control — so they cost zero tokens
and cannot be invoked. They are not deleted because each one threads through a live path:
`#participantLineage` follows claimed checkpoints, and the author-cannot-verify-own-work invariant
depends on that lineage; the runtime gate sits inside candidate selection; the budget feeds the
steering signal that carries "stop, this is no longer worth doing" to a busy agent.

Deleting them is a mechanical cleanup that deserves its own pass with the property suite watching,
not the tail end of a long session. An attempt during this one spliced the wrong lines twice and was
reverted both times — which is the argument for doing it separately, made concrete.

### What was kept despite zero rows

- **Named access tokens.** Still reachable from the CLI, and the answer for reaching DevTeam from
  anywhere but localhost. Zero rows means one token has been enough, not that the feature is dead.
- **Verified checks.** `project_check_commands` is empty, which is why all 50 reported checks are
  agent assertions DevTeam never ran. That is a missing `.devteam/checks.json`, not a dead feature —
  and it is the difference between "the tests pass" and "an agent said the tests pass".
- **Project-scoped memory.** One column's difference from task memory, and a real capability.

---

## 16. START HERE — next session

Written for a cold start, including one that is Codex rather than Claude. Everything below is on
branch `devteam/barefoot-core`, 277 tests green, unmerged and unpushed.

**The one thing worth knowing first:** the whole agent interface was rewritten — nine verbs replacing
thirty-nine — and **no real agent has used it yet**. All confidence comes from tests and from driving
the dashboard by hand. The first genuine two-agent session is the real test, and it is item 1.

### 1. Run one real session, and watch four things

Start Codex and Claude on a small task in a project that is *not* DevTeam itself. Then check:

- **Does review fire?** Someone should reach `devteam_verdict` with `verdict=changes` at least once.
  If a whole task completes with only approvals, ask why — that was the original defect, and the fix
  is that the *author is refused the review claim*, not that agents became stricter.
- **Is the author actually refused?** Have the implementer call `devteam_next` after finishing. It
  must not be handed the review of its own work. If it is, invariant 1 has regressed.
- **Does the ladder get reported?** After a join, look at `.devteam/models.json` in the project. If
  it is absent, agents ignored `runtime.askForLadder` and the model naming will stay silent.
- **Do the nine verbs read clearly?** Watch for an agent hunting for a tool that no longer exists —
  `devteam_wait`, `devteam_assign`, `devteam_approve`. That means `SKILL.md` or a description still
  points somewhere stale.

Expected failure modes, in order of likelihood: agents keep approving rather than requesting changes;
nobody reports a ladder; `plan` with `agree=true` is used for ordinary work.

### 2. `.devteam/checks.json` — the highest-value ten minutes

`project_check_commands` is **0**, so all 50 checks ever reported are agent *assertions* DevTeam never
ran. This is the difference between "the tests pass" and "an agent said the tests pass".

Two steps, and the second is the one people miss:

1. Write the file in the project root:

```json
{ "checks": [{ "name": "test", "argv": ["node", "--test"] }] }
```

**`npm test` is refused.** So are `npx`, `bash`, `sh`, `pnpm`, `yarn`, `deno` and anything else that
runs a command on your behalf — see `INDIRECTION_PROGRAMS` in `checks.mjs`. The program must be a bare
executable: `node`, `pytest`, `cargo`. Verify an entry is acceptable before trusting it:

```
node -e "import('./src/devteam/checks.mjs').then(m => console.log(m.normalizeCheckCommand({ name: 'test', argv: ['node','--test'] })))"
```

`null` means it was rejected.

2. **Enable it in the dashboard.** Edit project → *Verified checks* → tick "Let DevTeam run these
commands". Declaring makes a command *available*; only the human enabling it puts it in
`project_check_commands`. Confirm with:

```
select count(*) from project_check_commands;
```

Read the warning on that panel first: enabling verification lets any agent working in this project
run this project's code on your machine, at a moment of its choosing.

Once it is on, verified checks, check baselines, regression detection and the reliability record all
start working — four features that are currently dark for this one reason.

### 3. The 20 blocked tasks

They are history from before the fixes, and nothing clears them automatically. Each now has two
exits (section 11):

- Finished work that was blocked to *mean* finished → **Accept as finished** on the banner. Refused
  once if work was still in flight, with the count; a second confirmation closes it.
- Genuinely stopped work → **Resume**, which reopens at the next version with a fresh planning
  assignment.

Six of the twenty read "Done", "done", "because all work is done" — those are the accept case.

### 4. Deleting the retired store internals

Unreachable but still present in `store.mjs`: session checkpoints (~118 references), the runtime
gate, the budget cap, `assignment_usage`. No tool, route or dashboard control can reach any of them,
so they cost nothing at runtime and nothing in tokens — this is hygiene, not a bug.

**Two attempts during the barefoot session spliced the wrong lines and were reverted.** Learn from
that: do not remove these by line number. The traps, specifically:

- `#participantLineage` follows *claimed checkpoints* to trace one identity across a session
  handoff, and **invariant 1 — the author cannot verify their own work — depends on that lineage**.
  Removing checkpoints means lineage collapses to identity; make that change deliberately and run
  `test/devteam-scheduler-properties.test.mjs` before and after.
- The budget feeds `steeringFor`, which is the live path carrying "stop, this is no longer worth
  doing" to a busy agent. `cancel_requested_at` is the main signal there and must survive.
- Do it with the property suite watching, one feature per commit, tests between each.

### 5. Conventions will switch itself on

`#syncConventions` needs 3 findings sharing a signature across 2 distinct tasks. There are currently
**2 structured findings in total**, because review was rubber-stamping. Once item 1 is working, this
fills `conventions/` by itself. Nothing to do but check back.

### Still open from earlier sections

- **Domain-neutral vocabulary** (section 5) — roles and checks are project-configurable already, but
  the defaults and dashboard labels still say "changed files", "diff", "security review".
- `store.mjs` is 6,194 lines in one class. Item 4 shrinks it; splitting it is a separate decision.
  **Both are done — see section 17.**

## 17. The store.mjs cleanup and split, as built

Section 16 item 4 said the retired internals were hygiene, and that splitting the file was a
separate decision. Both are done. `store.mjs` went from **6,194 lines and 196 methods in one class**
to **2,462 lines**, across seven files. `npm test` 277 → 247, `npm run soak` and `npm run mutation`
green at every step.

### Phase A — what came out, and what proved it was unreachable

| Feature | Evidence it was dead | Cost |
|---|---|---|
| Task budget cap | `setTaskBudget` had no caller outside its own tests — no tool, route or dashboard control | −127 lines, −2 tests |
| `assignment_usage` | `usage` left the report schema in d10c94e, so `completeAssignment` always received `null` | −130 lines, −1 test |
| Session checkpoints | Tools and routes removed in b7f5b51/1121b2c; `server.mjs` still held an invitation builder nothing called | −1,122 lines, −10 tests |
| Runtime gate | No MCP path ever stored a profile; `updateRuntimeProfile` and `runtimeDecision` had only test callers | −1,100 lines, −16 tests |

Two things were **not** as the handoff described them, and both are worth remembering.

**The runtime gate was not merely dead — it was armable into a dead end.** `PATCH /api/tasks/:id`
still accepted `baseRuntimeProfile`, a field no dashboard control exposes, and `#runtimeGate` sat in
the claim path. Set that field and an assignment became unclaimable, while the gate told the agent
to fix it by calling `devteam_runtime_decision` and `devteam_runtime_update` — neither a registered
tool since b7f5b51. Removing it took away a way to strand work, which is a stronger reason than
hygiene.

**The ordering in the handoff had to be reversed twice.** The spend cap summed
`assignment_usage.cost_cents`, so the budget had to go first or a query against a dropped table
would stand for a commit. And the gate's largest block lived *inside* `createSessionCheckpoint`, so
checkpoints had to go before the gate.

Kept deliberately, despite sharing tables with what was removed: **`runtimeLadder`** and
**`complexity_assessments`**. The ladder is live — `devteam_join` reports one, the board names the
model a piece of work needs. Only the gate came out; `runtime/index.mjs` kept its assessment half
and lost its profile half, 234 lines to 83.

**Session rotation went too, and that was a judgement call rather than a deletion.**
`sessionRotationRecommendation` is reached by every `devteam_next`, but opened with
`if (!this.runtimeProfile(agentId)) return null` — so with zero profiles it had never once fired.
Removing it keeps behaviour byte-identical; keeping it and dropping the guard would have switched a
dormant feature on. The dashboard's session-policy setting survives with nothing acting on it for
agents, which is a loose end for a later session.

### Phase B — how the file is organised now

| File | Lines | Holds |
|---|---|---|
| `store.mjs` | 2,462 | the class, constructor, lifecycle, tokens, jobs, the reaper, projects, tasks, assignments and the **scheduler** |
| `store-views.mjs` | 647 | snapshot, task detail, `taskBrief`, replay, reliability — everything that reads |
| `store-consensus.mjs` | 564 | proposals, approvals, and the author-cannot-verify-own-work rules |
| `store-agents.mjs` | 474 | sessions, rooms, membership, presence, directed messages |
| `store-checks.mjs` | 427 | the allowlist, verified checks, baselines, regressions |
| `schema.mjs` | 396 | every table, index and migration |
| `store-knowledge.mjs` | 214 | blackboard notes, the vault, code-graph queries |
| `util.mjs` | 18 | `now`, `json`, `fromJson` |

Mixins, composed with one `Object.assign(DevTeamStore.prototype, ...)` after the class body. No call
site changed, inside the file or out. The scheduler stayed in `store.mjs` on purpose: it is what the
rest of the class exists to serve, and `claimNextAssignment` and `whyNotClaimable` must be read
against each other.

`schema.mjs` is the one piece that is **not** a mixin. `#migrate` touched exactly one thing on
`this` — the database handle — so it left as a free function, `applySchema(db)`. Nothing about it
wanted to be a method.

### The price, stated plainly

A JavaScript `#private` is lexically bound to the class body that declares it, so **a mixin can
never call `this.#event`**. Forty-six members had to become `_`-prefixed internals: privacy enforced
by the compiler became privacy by convention. That is a real loss, and it is the entire cost of the
file being separable. Twenty-five members that never crossed a boundary are still `#private` —
scheduler internals, the instance lock, the scope resolver — so the convention is the exception
rather than the rule.

Two things made this safe to do mechanically:

- **The language catches the mistake that matters.** Both errors during the agents split were
  `this.#private` calls left in moved text, and both failed at module *parse* time, before any test
  ran. Every mixin now contains zero `this.#` references, checked rather than assumed.
- **The language does not catch a missing import.** `knowledgeWrite` reaches for `path.join`; the
  first cut omitted the import and the module loaded fine, throwing only when a test actually wrote
  a note. So every mixin is now scanned against the module-level names `store.mjs` defines.

`tools/mutate-scheduler.mjs` needed one anchor repointed: M13 referenced `this.#reapStaleAgents`,
and reported SETUP ERROR — "a mutant is testing nothing" — exactly as it should. All 13 mutants are
caught again (12 caught, M9 equivalent).

### Still open after this

- `REDESIGN.md` had been **deleted outright** by e887959, a commit titled "reformat REDESIGN tables"
  that recorded 688 deletions and no insertions. Restored in `41075d2`. Worth knowing that the
  document the next session is told to start from can go missing silently.
- The session-policy setting on a task now has no consumer for agents. Either give it one or take
  the control out of the dashboard.
- Domain-neutral vocabulary (section 5) is untouched.
- Nothing here has run a real two-agent session. Section 16 item 1 is still the real test.

---

## 18. The first real two-agent session, and the one bug it found

Section 16 item 1 said the real test was a live session with two agents. It ran on 2026-08-28:
Claude and Codex, a nine-rule Markdown TOC library, planner → implementer → reviewer → tester, with
both agents told to keep a log of everything that went wrong. Claude wrote `ISSUES-claude.md`;
Codex reported into the room instead.

The team worked. Codex's review caught a rule-1 defect the passing suite missed; the rework loop
turned; a later review caught a genuine duplicate-slug collision (`## Notes` / `## Notes` /
`## Notes-1` producing two `notes-1`) that the tester had already approved past. Both defects were
real, and neither would have been found by one agent alone. That is the thing this project exists
to do, and it did it.

Then the task could not be marked done, and stayed that way until a human intervened. Twelve of the
entries in the log are consequences of a single bug.

### The bug: DevTeam graded its own wrapper as the project's result

A sandboxed project confines a `node` check with Node's permission model. Node's test runner, asked
to *discover* files (`node --test` with no paths), appends an **empty** entry to its own permission
list — it grants read access to the positional paths it was given, and there were none — then
forwards that list to the child process it spawns per test file. Every child dies on
`--allow-fs-read= requires an argument` before loading a line of the suite. It reproduces on Node
24.18 with nothing but `--permission --test`; explicit file paths, a glob, or `--test-isolation=none`
all avoid it.

The child exits non-zero having run nothing. DevTeam graded that as the suite failing, which is
where the damage came from:

- the report was refused, because a verified failure cannot be reported as done;
- a `failed` baseline was written against the task, which nothing but a passing run can clear;
- a regression was opened, and the reporter's reliability was docked (`refusedByChecks: 1`);
- with no way out, Codex blocked the whole task — correctly, on the evidence it had.

Twice-reviewed, fifteen-of-fifteen-green code sat one step short of done for the rest of the
session. Both agents diagnosed the flag independently and neither could do anything about it: there
is no verb for "the harness is broken, not my code".

### What was built

**A confinement wrapper is graded apart from the thing it wraps.** `checks.mjs` already said that
"DevTeam could not run this" and "this did not pass" are different facts — for a process that never
starts. It just did not hold for a wrapper that dies *after* spawning. Now:

| situation | verdict |
| --- | --- |
| unconfined | the command's own result, unchanged |
| wrapper rejected, workaround passes | `passed`, verified, substitution stated in the transcript |
| wrapper rejected, workaround runs and the code fails | `failed` — the workaround ran the project's own code |
| wrapper rejected, no workaround, or it is rejected too | `unavailable`, not verified, both transcripts kept |

Only the last row is new behaviour, and it is the one that unblocks everything: `unavailable`
refuses no report, sets no baseline, opens no regression, and charges nobody.

Written as a property of runners, not of Node or of tests — the detection matches the flags DevTeam
itself injects, and the single Node quirk sits in one named function so the next runner has an
obvious place to go. The direction of a misread is the safe one: it withholds a pass, it cannot
grant one.

The workaround is `--test-isolation=none`, flag name probed at runtime. That is not quite the run a
human gets, so a failure under it keeps the note explaining what was changed rather than being
handed to the agent as a plain verdict.

`NODE_TEST_CONTEXT` is now stripped from a check's environment. Inherited, it makes a project's
`node --test` announce a recursive run, skip every file, and exit 0 — a silent false pass, and the
reason the first draft of the new tests passed for the wrong reason.

**Reconnecting no longer makes an author independent.** The author set was a set of `agents.id`, and
an agent row is one *connection*. Claude wrote the implementation as `3317811b`, its session ended,
it rejoined as `6cdcc328` with no lineage link, and DevTeam handed it a "fresh specification review"
of its own code with nothing in the payload saying so. The guarantee had not been removed, only
emptied — worse, because the verdict still reads as independent. Authors now expand to every session
that participant has had, keyed on the name and provider it connects under. Two different
participants sharing one name would be treated as one; that is the right way to be wrong.

**`checks: [{ label, command: null }]` is accepted.** It used to fail validation with
`Invalid input at checks[1]` and no hint that a bare string was the shape it wanted.

`node --test` 247 → 251. The task that could not be closed now verifies: `status: passed`,
`verified: true`, 15/15.

### Deliberately not done

- **Parallel verification without cross-checking.** A tester approved the version a reviewer was
  simultaneously rejecting, and the collision the reviewer found is exactly the "edge cases covered"
  item the tester ticked. Real, but it is a scheduling decision, not a bug.
- **A reviewer who becomes the author of what it holds.** `status=blocked` on the assignment already
  queues a re-routed replacement, which is what actually unstuck the session. A `devteam_handoff`
  verb would be nicer; nothing is broken without it.
- **The historical records.** The `failed` baseline on that task and the one docked reliability
  point are left as they are. A fresh verified pass supersedes the baseline naturally.

### Still open after this

- No agent used `devteam_plan`, `devteam_stuck` or `devteam_memory` across two sessions. Three of
  nine verbs went untouched by two different models. Worth asking what they are for.
- An agent cannot see the argv DevTeam will actually run — sandbox flags included — before reporting
  against it. Both agents named this as the thing that would have saved them the most time.
- Domain-neutral vocabulary (section 5) is still untouched.
