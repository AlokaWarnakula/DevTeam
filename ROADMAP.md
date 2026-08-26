# DevTeam — audit and roadmap to a general agentic room

**Goal being designed for:** a room where AI agents divide work among themselves, review each
other, catch and repair each other's mistakes, and behave like a team — on *any* kind of task, not
only software.

**Audit date:** 2026-08-26, against `main` @ `9ef12e6` (191 tests passing).

This is written to be worked from. Every item says what to change, where, why it matters for the
goal above, and rough size. Items are ordered so that earlier tiers unblock later ones — building
Tier 3 before Tier 0 will hurt.

Sizes: **S** ≈ a sitting, **M** ≈ a few days, **L** ≈ a week+, **XL** ≈ a project in its own right.

---

## START HERE — session handoff

*This section exists so a fresh session can pick up cold. Read it first.*

### The one-line finding

**DevTeam today *coordinates* a team. It does not yet *behave* like one.** The hard primitives are
already built and good — write leases, claim fencing, version-invalidates-approvals, bounded
context. What is missing is the behavioural layer on top of them, plus four places where software
assumptions are welded in that block non-software work.

### Recommended first two items, and why these two

**Do T0.1 (explicit room membership) and T0.2 (get blocking work off the event loop) first.**

Not because they are the most exciting — they are not — but because they carry **cascade risk**.
T0.2 changes whether `completeAssignment` is synchronous, which ripples into `mcp.mjs`, the server
routes, and a large number of tests. Every later item that runs anything long-running assumes it.
Doing it deliberately now is far cheaper than doing it later under pressure with three other
features built on the old shape.

T0.1 is the cheapest unlock in the whole document and removes a footgun that will otherwise bite
during every later multi-task change.

After those two, **T2.2 (rework loops)** is the biggest behavioural win per unit of effort and is
the item closest to the stated goal.

### Current state as of this audit

- Branch `devteam/solid-core` is **merged into `main` and pushed** (`9ef12e6`). No feature branches
  remain except `codex/release-a-memory-safety`, which is fully merged but pinned by a Codex
  worktree at `C:/Users/aloka/.codex/worktrees/a5b8/DevTeam`.
- **191 tests passing** (`node --test`).
- The scheduling core was just hardened: it explains itself, its candidate query is decomposed into
  named predicates, and it is property-tested with mutation coverage.

### How to verify you have not broken anything

```bash
node --test
```

```bash
node tools/mutate-scheduler.mjs
```

Expect **191 passing** from the suite, and **12 caught / 1 equivalent** from the mutation tool.

`tools/mutate-scheduler.mjs` edits `src/devteam/store.mjs` in place and restores it, printing
whether the restore was byte-identical. **Do not run it with uncommitted changes to `store.mjs`.**

To sweep more property seeds than the committed 24, temporarily widen `SEEDS` in
`test/devteam-scheduler-properties.test.mjs` (48 consecutive seeds currently pass).

### Orientation map

| File | What lives there |
|---|---|
| `src/devteam/store.mjs` (~3.9k lines) | Everything stateful. Schema, scheduling, leases, claims, approvals, knowledge wiring, checks |
| `src/devteam/mcp.mjs` | The 27 `devteam_*` tools agents call. This is the agent-facing API |
| `src/devteam/server.mjs` | Express + MCP transport, `/api/*` control plane, auth |
| `src/devteam/checks.mjs` | Verified-check execution. Security model documented at the top of the file |
| `src/devteam/knowledge.mjs` | Obsidian-style vault, event-derived |
| `src/devteam/codegraph.mjs` | Import/export graph, **JS/TS only** |
| `src/devteam/brief.mjs` | Context budgeting for agent briefings |
| `src/devteam/runtime/` | Provider-neutral complexity assessment and model gating |

**Highest-risk code in the repo:** the scheduling predicates in `store.mjs` (`#claimPredicates`,
`BLOCKING_WRITER_CONDITIONS`, `DEPENDENCY_CLOSURE_CTE`). Four real deadlocks have lived there. Never
change it without running the property suite and the mutation tool.

---

## What prevents team behaviour today

*Consolidated list of everything found that stops this being a team rather than a queue.*

| # | Gap | Effect | Item |
|---|---|---|---|
| 1 | A reviewer can only **approve or block**. Blocking closes the assignment and queues coarse planner triage | Mistakes route through a human-shaped step instead of back to their author. Biggest single blocker | T2.2 |
| 2 | **No regression detection** | Nothing notices that agent B broke what agent A delivered. Agents cannot cover for each other if nobody sees the breakage | T2.3 |
| 3 | **No work decomposition** | "Divide work" is something a planner *prompt* does, not something the system supports. An agent whose assignment is too big has no move | T2.1 |
| 4 | **Self-approval permitted as a fallback** (see the `no dead-end` test) | A single agent can complete and approve its own work. Independence is the premise of peer review | T2.4 |
| 5 | **No reliability signals** | Nothing tracks whose work gets rejected or regresses. A team learns who to trust with what; this cannot | T2.5 |
| 6 | **Implicit room membership** | An agent connecting when one task exists is silently bound to it. With >1 task, work silently becomes unclaimable | T0.1 |
| 7 | **One claim per agent** | Throughput capped at agents × tasks-per-hour regardless of queue depth. Review-heavy workflows suffer most | T0.3 |
| 8 | **Blocking event loop** | One `spawnSync` freezes MCP, dashboard, SSE and heartbeats for every agent at once | T0.2 |
| 9 | **Memory is derived-only** | An agent that *learns* something has nowhere first-class to put it. Teams accumulate knowledge; this only records events | T3.1 |
| 10 | **No contradiction detection** | Two agents can hold opposing "verified" facts with nothing noticing | T3.2 |
| 11 | **Retrieval is keyword + recency** | What an agent knows caps what it can do, and this degrades as the vault grows | T3.3 |
| 12 | **No human steering mid-flight** | Cannot re-prioritise, interrupt, or cap spend once work is running | T2.6 |
| 13 | **Software assumptions welded in** | Web-security checklists for non-web work; JS/TS-only graph; `package.json`-shaped checks; git assumed | T1.1–T1.4 |
| 14 | **Review gate is a heuristic** | Deliberately weakened for liveness (see Known and accepted). Correctness rests on version-invalidates-approvals, not on the gate | — |

---

## 0. Honest baseline

### What is genuinely good today

These are load-bearing and worth protecting as you change things:

- **Write leases with path scoping and realpath canonicalization** — a symlink cannot win two
  leases; non-overlapping writers run in parallel. (`store.mjs` `#writeScopeFor`,
  `#resolveScopesOnDisk`, `#scopesOverlap`)
- **Claim fencing** — `claim_token_hash` + `claim_generation` mean a stale report from a resumed
  session gets a structured conflict, not a silent overwrite.
- **Version-invalidates-approvals** — a completing writer that changed files bumps the task version
  and clears approvals built on the old one. This is the safety net that makes review meaningful.
- **Membership as authorization** — an agent given another room's `taskId` still cannot read it.
- **Bounded context** — `brief.mjs` budgets what an agent is told. This is the thing that usually
  kills multi-agent systems, and it is already handled.
- **The scheduler now explains itself** — `whyNotClaimable` returns the full reason chain, and the
  candidate query is decomposed into named predicates that share those reason codes.
- **Verified checks** — a reported check may carry a command DevTeam runs itself; a report claiming
  success for a command that failed is refused.

### The realistic ceiling right now

**2–5 agents, 1 active task, one human, one machine.** Two or three tasks work only if every agent
explicitly joins each room. Beyond that you are fighting the design.

### Where the bugs have concentrated

Four real deadlocks have now been found in the same ~60 lines of scheduling logic (self-blocking
verifier, work aimed at a departed agent, a waits-for cycle across the review and dependency gates,
and a candidate-window truncation). Three of them were invisible — the board simply stopped moving
with no explanation. That area is now property-tested with mutation coverage, but treat it as the
highest-risk code in the repo and never change it without running the property suite.

---

## Tier 0 — structural blockers

Nothing else matters much until these are done. Each one is currently a hard ceiling.

### T0.1 — Make room membership explicit — **S/M**

**Problem.** `#claimableTaskIds` (`store.mjs`) returns `[]` when an agent has no explicit membership
and more than one task is active. Worse, `connectAgent` pins implicit membership when *exactly one*
task exists — so an agent that connects early is silently bound to whatever room happened to be
open. This bit me while writing tests, which means it will bite real usage.

**Why it matters.** This is the single cheapest change with the biggest effect on running several
things at once. Today "many tasks" quietly degrades to "no work is claimable" with no error.

**Do.** Remove implicit membership entirely. Make `devteam_connect` take a `taskId` (or return
`roomRequired` with the list, which it already does) and make `devteam_join` the only way in. Add a
`room_membership_required` reason code so `whyNotClaimable` says so out loud instead of returning an
empty board.

### T0.2 — Get blocking work off the event loop — **M**

**Problem.** The server is one process doing synchronous work. `spawnSync` runs git probes
(`store.mjs:1247`) and verified checks (`checks.mjs` `runVerifiedCheck`). While either runs, *nothing*
responds — no MCP, no dashboard, no SSE, no heartbeats. I had to make the check timeout bound the
whole report precisely because ten checks could freeze everything for twenty minutes.

**Do.** Move check execution and git probes to `spawn` with promises, or a worker thread. Make
`completeAssignment` async, or split it: record the report as `verifying`, run checks off-loop,
then settle. The second shape is better — it also gives you a visible "checks running" state.

**Watch for.** `completeAssignment` is called synchronously from many tests and from `mcp.mjs`.
This is the change most likely to cascade; do it before anything else depends on it.

### T0.3 — Lift the one-claim-per-agent rule where it is safe — **M**

**Problem.** An agent holds at most one claimed assignment (enforced by a unique index). Correct for
write-lease safety, but it caps throughput at "agents × tasks-per-hour" regardless of how much work
is queued.

**Do.** Allow an agent to hold **one write claim plus N read-only claims**. The lease invariant only
concerns writers. This is a real throughput multiplier for review-heavy workflows, which is exactly
the workflow you are aiming at.

**Watch for.** `claimNextAssignment`'s `existingClaim` early-return, the
`idx_one_claim_per_agent` unique index, and `agent_holds_claim` in `whyNotClaimable`.

### T0.4 — Concurrency and durability model — **L**

**Problem.** One SQLite file, one process, `busy_timeout = 5000`. Fine locally; it is the reason
"many projects" is not on the table.

**Do (in order).** WAL is already on. Add a job/queue table so long work is durable across restarts.
Only then consider multi-process. Do **not** reach for Postgres until you have hit an actual limit —
the schema is well-normalized and SQLite will carry you further than you expect.

---

## Tier 1 — make it domain-neutral

This is your explicit ask: *any* task, not just web and mobile. Today the codebase has software
assumptions welded in at four points. Each needs an abstraction seam.

### T1.1 — Pluggable role and checklist templates — **S**

**Problem.** `DevTeamStore.CHECKLIST_TEMPLATES` (`store.mjs:818`) hardcodes software roles, and the
`security-reviewer` checklist is specifically *web* security ("session fixation", "secure/httponly
cookies"). A research task, a legal review, a data-analysis task, or a writing project gets a
checklist about cookies.

**Do.** Move templates to a per-project config file (`.devteam/roles.yaml` or a DB table), seeded
from the current defaults. Let a project define its own roles: `analyst`, `fact-checker`,
`editor`, `domain-expert`. Keep `reviewer`/`tester` as *behavioural* roles the scheduler understands
(the review gate keys off `VERIFIER_ROLES`) but decouple them from the checklist content.

**Important.** `VERIFIER_ROLES` is scheduling semantics, not domain vocabulary. Keep that list
small and behavioural; let projects map their own role names onto it.

### T1.2 — Generalize the code graph into an artifact graph — **L**

**Problem.** `codegraph.mjs` handles `.js .jsx .mjs .cjs .ts .tsx .json` only (`SOURCE_EXTENSIONS`).
Every other ecosystem — Python, Go, Rust, SQL, notebooks, prose, CAD, spreadsheets — gets nothing.

**Do.** Define a parser interface (`{ extensions, parse(file) -> { symbols, links } }`) and register
implementations. Ship JS/TS (existing) plus at minimum Python and Markdown. For unknown types, fall
back to a **link graph** built from filename references and Markdown/wikilink mentions — that alone
makes the graph useful for non-code projects.

**Why it matters most.** The graph is what lets an agent answer "what else does this touch?" Without
it, non-software tasks lose the main mechanism that stops agents from breaking each other's work.

### T1.3 — Domain-neutral checks — **M**

**Problem.** Verified checks default to `package.json` scripts and can only run programs resolvable
on PATH without a shell. On Windows, `npm`/`npx`/`eslint` are `.cmd` shims that return `ENOENT`
under `shell:false`, so only parsed script bodies like `node --test` actually run.

**Do.** Add a project-level `.devteam/checks.yaml` declaring named checks with explicit argv,
independent of `package.json`. Keep the same security rules (`isSafeCheckArgv`). Solve the Windows
`.cmd` problem by resolving shims to their real target at snapshot time rather than shelling out.

### T1.4 — Separate "work product" from "code" — **M**

**Problem.** `changedFiles`, `requiresWrite`, and write leases are file-path shaped. That actually
generalizes fine (any artifact is a file), but the *vocabulary* and the git integration assume a
repository.

**Do.** Make git optional per project. Where `#unverifiedChangedFiles` and the git HEAD probe run,
degrade gracefully for non-repo projects instead of silently producing empty evidence.

---

## Tier 2 — the team behaviours you actually want

This is the heart of the goal: agents that divide work, review each other, and repair mistakes.
Today DevTeam **coordinates** a team; it does not yet **behave** like one.

### T2.1 — Real work decomposition — **L**

**Missing today.** A planner agent creates assignments by hand via `devteam_assign`. There is no
decomposition loop, no splitting when work turns out larger than assessed, no dependency inference.
"Divide work" is currently a thing the human or a planner prompt does, not something the system
supports.

**Do.**
- A `devteam_split` tool: an agent holding a claim that turns out too big can split it into
  children, inheriting scope and dependencies, without losing its lease.
- Re-assessment on split (`assignmentAssessment` already exists and is evidence-hashed).
- Dependency *inference* from declared write scopes: if B writes paths A also writes, propose an
  ordering rather than letting them serialize by lease contention alone.

### T2.2 — Rework loops instead of blunt blocking — **M**

**Problem.** When a review finds problems, the reviewer's only options are "approve" or
`status=blocked`, which closes the assignment and queues a coarse planner triage item.

**Do.** Add a `changes_requested` outcome that reopens the *original* assignment (new
`claim_generation`, preserved history, linked findings) and routes it back to its author. This is
the single most important missing behaviour for "cover up each other's mistakes" — right now the
loop goes through a human-shaped triage step every time.

### T2.3 — Regression awareness — **M**

**Missing today.** Nothing detects that agent B broke what agent A delivered. Verified checks give
you the raw material (exit codes over time) but nothing compares runs.

**Do.** Store a per-task **check baseline**. When a check that previously passed now fails, mark the
report as a regression, name the assignment that last changed the overlapping paths, and
auto-create a linked fix assignment targeted at that author. This is the mechanism that turns a
group of agents into a team that covers for each other.

### T2.4 — Cross-agent verification quality — **M**

**Problem.** `no dead-end: a solo agent can complete a task that nominally needs two approvals`
exists as a test — meaning self-approval is permitted as a fallback. Combined with unverified
checks, a single agent can currently mark its own work done and approved.

**Do.** Make independence a first-class, visible property: record for each approval whether it was
independent, and surface `selfReviewed` prominently in the dashboard (it exists in the payload
already). Consider requiring at least one verified check before an approval counts when the project
has verification enabled.

### T2.5 — Agent reliability signals — **M**

**Missing today.** Nothing tracks which agent's work gets rejected, which produces regressions, or
which reports checks that fail verification.

**Do.** Per-agent rolling stats: assignments completed, reports refused by check verification,
reviews that later regressed, average rework count. Feed this into `claimNextAssignment` ordering
and into the runtime gate — an agent with a poor record on `critical` work gets gated harder. You
already have the gating machinery (`#runtimeGate`, `assignmentAssessment`); this is new *input* to
it, not new machinery.

### T2.6 — Human steering mid-flight — **S/M**

**Missing today.** A human can block, force-release, and message, but cannot re-prioritize the
queue, interrupt a running agent, or cap spend.

**Do.** Assignment priority column feeding the `ORDER BY`; a cooperative cancel flag agents check on
heartbeat; per-task budget caps (wall clock, and token counts once T4.2 exists).

---

## Tier 3 — the memory system

You asked specifically about this. Today you have two halves that do not yet compose.

### Current state

- `knowledge.mjs` — an **event-derived, one-way** Obsidian-style vault. Categories:
  `architecture, decisions, components, conventions, pitfalls, workflows` plus `sessions`/`archive`.
  Writes `[[wikilinks]]`, redacts secrets, has status (`verified`/`disputed`/`superseded`) and
  confidence. Genuinely good bones.
- `codegraph.mjs` — JS/TS import/export graph.
- `brief.mjs` — budgeted retrieval into an agent's briefing.
- Retrieval is **keyword + path-relevance + recency**. No embeddings (deliberate, per project notes).

### T3.1 — Agent-writable structured memory — **M**

**Problem.** The vault is derived from events. `devteam_note_set` exists but writes flat key/value
notes, separate from the vault's category/status/confidence model.

**Do.** Let an agent write a *first-class* knowledge note directly — with category, confidence,
related files, and links — subject to the same redaction. An agent that learns "this API rate-limits
at 30/min" has nowhere good to put that today.

### T3.2 — Contradiction detection — **M**

**Problem.** Notes have `status: verified | disputed | superseded`, but nothing *detects* that a new
note contradicts an old one. Superseding is triggered by file changes, not by meaning.

**Do.** On note write, retrieve near-duplicates by key/path overlap and flag conflicts for
resolution — either by a reviewer agent or by the existing proposal/consensus mechanism, which is
already the right tool for "the team disagrees about a fact."

### T3.3 — Better retrieval — **M/L**

**Problem.** Keyword + recency retrieval degrades badly as the vault grows. This is the mechanism
that decides what an agent knows, so its quality caps the whole system's quality.

**Do.** Two options, in order of cost:
1. **BM25 over SQLite FTS5** — cheap, no new dependency, a large improvement over substring
   matching. Do this first.
2. **Local embeddings** — only if BM25 proves insufficient. Your notes say "no vector store" as a
   deliberate choice; FTS5 lets you honour that a while longer.

### T3.4 — Backlinks and graph queries — **S/M**

**Problem.** You emit `[[wikilinks]]` but maintain no backlink index, so "what references this
decision?" is unanswerable without scanning.

**Do.** A `knowledge_links` table maintained on write; expose backlinks in `devteam_knowledge` and
on the dashboard. Cheap, and it makes the Obsidian vault genuinely navigable.

### T3.5 — Memory decay and review — **S**

**Problem.** Nothing ages. A `verified` note from six months and forty versions ago reads exactly
like one written today.

**Do.** Age-weight confidence in retrieval; surface a "stale knowledge" queue a maintainer agent can
work through. You already have `verifiedAt` — this is mostly scoring, not schema.

### T3.6 — Cross-project memory — **M**

**Problem.** Knowledge is project-scoped. A lesson learned in one project cannot inform another.

**Do.** A `global` scope for conventions and pitfalls, explicitly opt-in per note, with strict
redaction (this is the most likely place to leak one client's details into another's context).

---

## Tier 4 — trust, operations, scale

### T4.1 — Auth that survives leaving localhost — **M**

**Problem.** Any unauthenticated loopback `GET` is issued a `devteam_dash` cookie, which
`GET /api/setup` will trade for the MCP bearer token. Acceptable for single-user localhost — you
have accepted this — but it is the blocker if DevTeam is ever shared.

**Do.** Issue the dashboard cookie only on the HTML page load, never on `/api/*`; bind it to a nonce
printed at startup. Per-agent tokens rather than one shared bearer, so a compromised agent is
revocable and the audit trail is real.

### T4.2 — Cost and token accounting — **M**

**Missing today.** No record of what work cost. For a "go-to tool", the human needs to see which
agent burned what on which assignment.

**Do.** Let agents report token/cost figures on `devteam_report`; aggregate per task and per agent.
Pairs naturally with the budget caps in T2.6.

### T4.3 — Full task replay — **S/M**

**Problem.** Events exist and are rich, but there is no way to replay a task's history as a
narrative — which is what you need when a task went wrong and you want to know where.

**Do.** A read-only timeline export (Markdown) reconstructing the whole task: assignments, claims,
reports, checks, reviews, decisions.

### T4.4 — Sandboxing agents' checks properly — **M**

**Current.** Opt-in Node permission-model confinement exists (`sandboxFlagsFor`), limited to `node`
and still allowing child processes. It narrows exfiltration; it does not close execution.

**Do.** Container-based execution (Docker/Podman) as an optional per-project runner. This is the
only real answer, and it becomes important the moment DevTeam runs checks for projects you do not
fully trust.

### T4.5 — Scheduler regression safety — **S** *(do this permanently)*

The property suite (`test/devteam-scheduler-properties.test.mjs`) is what caught the waits-for
cycle. Keep it honest:
- Seeds must stay **enumerated**, never hand-picked. Six chosen seeds passed while four of the next
  eight deadlocked.
- Run a nightly job with randomized seeds and a much larger board.
- Re-run the mutation script whenever the scheduler changes. 12 of 13 mutants are currently caught;
  one is a verified equivalent.

---

## Suggested order of work

```
T0.1  explicit membership          ← start here, cheapest unlock
T0.2  off the event loop           ← everything long-running depends on this
T2.2  rework loops                 ← biggest behavioural win per unit effort
T1.1  pluggable roles              ← unlocks non-software domains cheaply
T3.4  backlinks     + T3.1 agent-writable notes
T2.3  regression awareness         ← needs T0.2
T1.2  artifact graph               ← the big one for "any task"
T3.3  FTS5 retrieval
T0.3  multi-claim
T2.5  reliability signals
T4.*  as the tool leaves your machine
```

**If you only do three things:** T0.1, T0.2, T2.2. Those three move it from "a coordination server
for one task" to "a room that can actually run several pieces of work and repair its own mistakes."

---

## Known and accepted — not bugs to re-find

*Recorded so a future session does not spend time rediscovering decisions that were made
deliberately. Two independent reviews (correctness and security) produced these.*

- **The `/api` credential is weak.** Any unauthenticated loopback `GET` is issued a `devteam_dash`
  cookie, which `GET /api/setup` trades for the MCP bearer token. Accepted by the owner as fine for
  single-user localhost. After the argv hardening it no longer buys arbitrary code execution, only
  "enable verification". See T4.1 if this ever leaves the machine.
- **Verification runs the project's own code.** `node --test` executes test files an agent just
  wrote, as the host user, outside whatever sandbox the agent itself runs in. The allowlist pin
  protects *which argv* runs, not what that argv reads off disk — the project root is the real
  boundary. Documented at the top of `checks.mjs`. Optional Node permission-model confinement exists
  (`sandboxFlagsFor`) and narrows exfiltration; T4.4 is the real answer.
- **Enabling verification snapshots *all* derivable `package.json` scripts**, including `start` and
  `dev`. The dashboard shows exactly what would be allowed before enabling, which is the mitigation.
  Trim per project if that matters.
- **On Windows, `npm`/`npx`/`eslint` are `.cmd` shims** and return `ENOENT` under `shell:false`, so
  those checks grade `unavailable` forever. Only parsed script bodies like `node --test` run. See T1.3.
- **A timed-out check leaks its process tree.** `killSignal: SIGKILL` kills only the direct child;
  grandchildren survive. Needs Job Objects on Windows / process-group kill on POSIX.
- **The review gate was deliberately weakened.** A verifier no longer waits for writers with unmet
  dependencies, and write-declaring verifiers are ordered by creation time. This was required to
  break a waits-for cycle that deadlocked the board permanently. The cost — a verifier may start
  just before a distant queued writer runs — is absorbed by version-invalidates-approvals. Do not
  "restore" the stricter gate without re-reading that reasoning.
- **`pending_write.id != a.id` is now redundant** (implied by the creation-order rule) and kept only
  to state intent. Mutation M9 surviving is correct, not a coverage gap.

---

## Things to deliberately *not* do

- **Don't add a vector store yet.** FTS5 first. You will get most of the benefit without the
  operational weight, and your existing design note on this is sound.
- **Don't move off SQLite** until a measured limit forces it.
- **Don't loosen the write-lease model** for throughput. It is the one thing preventing agents from
  silently overwriting each other, and it is correct today.
- **Don't make the review gate smarter without the property tests.** Four deadlocks have lived in
  that logic. It is the highest-risk code in the repo.
- **Don't hand-pick property seeds.** Six chosen seeds passed while four of the next eight
  deadlocked. Enumerate them, always.
- **Don't remove the one-write-lease-per-path rule** to buy throughput. It is the only thing
  stopping agents from silently overwriting each other.
