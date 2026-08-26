# DevTeam — audit and roadmap to a general agentic room

**Goal being designed for:** a room where AI agents divide work among themselves, review each
other, catch and repair each other's mistakes, and behave like a team — on *any* kind of task, not
only software.

**Audit date:** 2026-08-26, against `main` @ `9ef12e6` (191 tests passing).
**Last worked:** 2026-08-26 — T0.1, T0.2 and T2.2 implemented (203 tests passing). See
*What has been done since the audit* below.

This is written to be worked from. Every item says what to change, where, why it matters for the
goal above, and rough size. Items are ordered so that earlier tiers unblock later ones — building
Tier 3 before Tier 0 will hurt.

Sizes: **S** ≈ a sitting, **M** ≈ a few days, **L** ≈ a week+, **XL** ≈ a project in its own right.

---
---

## START HERE — session handoff

*This section exists so a fresh session can pick up cold. Read it first.*

### Where this stands

**Sixteen of the twenty roadmap items are done.** DevTeam no longer merely *coordinates* a team: a
review has two honest outcomes and routes rework back to its author, the room notices when one agent
breaks another's work and routes a scoped fix to whoever caused it, an agent can divide work that
turned out too big without losing its lease, and the whole Tier 1 "any task, not one domain" tier is
complete — roles, the artifact graph, checks and git are all project-configurable now.

Each finished item has a **✅ DONE** section below recording what was built, what was deliberately
*not* built, and the design calls worth knowing before changing them. Read the one for whatever you
are about to touch.

### What is left

| Item | Size | Why it is still open |
|---|---|---|
| **T0.4** — concurrency and durability | L | Not yet needed. The roadmap's own advice: WAL is on, add a durable job table *before* considering multi-process, and **do not reach for Postgres until a measured limit forces it**. |
| **T4.1** — auth beyond localhost | M | A deliberate hold. The current credential is weak by design for single-user localhost (see *Known and accepted*). It is the blocker **only if DevTeam is ever shared or exposed**, and tightening it costs local convenience for no gain until then. |
| **T4.4** — container sandboxing for checks | M | Adds a hard Docker/Podman dependency for a protection that only matters when running checks for projects you do not fully trust. The opt-in Node permission model already narrows exfiltration. Worth doing when the trust model changes, not before. |
| **T4.5 nightly job** | S | The soak *script* exists and works; nothing runs it on a timer, because this repository has no CI. |

**None of these are blocking ordinary use.** T0.4, T4.1 and T4.4 all become worth doing at the same
moment: when DevTeam stops being one person's local tool.

### Current state

- **249 tests passing** (`node --test`).
- Working tree has substantial uncommitted work across `src/`, `test/`, `public/`, `skills/` and the
  docs. **Nothing has been committed** — review and commit before starting anything new.
- Two new source modules since the audit: `src/devteam/roles.mjs` (T1.1) and
  `src/devteam/parsers.mjs` (T1.2). Two new test files: `devteam-roles.test.mjs`,
  `devteam-parsers.test.mjs`. One new tool: `tools/scheduler-soak.mjs` (T4.5).

### How to verify you have not broken anything

```bash
node --test
```

```bash
node tools/mutate-scheduler.mjs
```

Expect **249 passing** from the suite, and **12 caught / 1 equivalent** from the mutation tool (M9 is
a documented equivalent mutant, not a coverage gap).

For anything touching the scheduler, also run a soak from a fresh offset:

```bash
node tools/scheduler-soak.mjs --seeds 240
```

`tools/mutate-scheduler.mjs` edits `src/devteam/store.mjs` in place and restores it, printing whether
the restore was byte-identical. **Do not run it with uncommitted changes to `store.mjs`.**

**If a single test fails immediately after you edited a source file, re-run before investigating** —
see the note in *Known and accepted* about the Windows write/module-load race.

### Orientation map

| File | What lives there |
|---|---|
| `src/devteam/store.mjs` (~4.6k lines) | Everything stateful. Schema, scheduling, leases, claims, approvals, knowledge wiring, checks, regressions, reliability, steering, split |
| `src/devteam/mcp.mjs` | The `devteam_*` tools agents call. This is the agent-facing API |
| `src/devteam/server.mjs` | Express + MCP transport, `/api/*` control plane, auth |
| `src/devteam/checks.mjs` | Verified-check execution. Security model documented at the top of the file |
| `src/devteam/knowledge.mjs` | Vault: agent-writable notes, backlinks, FTS5/BM25 retrieval, contradictions, decay, cross-project sharing |
| `src/devteam/roles.mjs` | Per-project role vocabulary; only `verifies`/`plans` mean anything to the scheduler |
| `src/devteam/codegraph.mjs` | Artifact graph: nodes, edges, scan, reconcile, export |
| `src/devteam/parsers.mjs` | Per-type parsers (JS/TS, Python, Markdown, opaque, reference fallback) |
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
| 1 | ~~A reviewer can only approve or block~~ | **Fixed.** `devteam_request_changes` reopens the author's own assignment with findings attached and routes it back | T2.2 ✅ |
| 2 | ~~No regression detection~~ | **Fixed.** A per-command baseline names a `passed → failed` flip, its suspects, and queues a scoped fix for whoever landed it | T2.3 ✅ |
| 3 | ~~No work decomposition~~ | **Fixed.** `devteam_split` divides work without losing the lease; overlapping sibling writers are ordered automatically | T2.1 ✅ |
| 4 | ~~Self-approval invisible~~ | **Fixed.** Independence recorded per approval; verified evidence required where verification is on; solo runs still finish, labeled | T2.4 ✅ |
| 5 | ~~No reliability signals~~ | **Fixed.** Per-agent record derived from the timeline: overclaims, rework rounds, regressions caused and caught | T2.5 ✅ |
| 6 | ~~Implicit room membership~~ | **Fixed.** Membership is explicit only; an agent in no room is told so with `room_membership_required` | T0.1 ✅ |
| 7 | ~~One claim per agent~~ | **Fixed.** One *write* claim plus N read-only ones; the lease invariant only ever concerned writers | T0.3 ✅ |
| 8 | ~~Blocking event loop~~ | **Fixed.** Checks and git probes run off-loop; a report in flight is flagged `verifying` and re-fenced before it settles | T0.2 ✅ |
| 9 | ~~Memory is derived-only~~ | **Fixed.** `devteam_knowledge_write` records a first-class note; backlinks make the vault navigable | T3.1 ✅ T3.4 ✅ |
| 10 | ~~No contradiction detection~~ | **Fixed.** Same-subject conflicts surfaced on write; disputed notes leave briefings until resolved | T3.2 ✅ |
| 11 | ~~Retrieval is keyword + recency~~ | **Fixed.** BM25 over FTS5, title-weighted, with the old ordering as tie-break and a substring fallback | T3.3 ✅ |
| 12 | ~~No human steering mid-flight~~ | **Fixed.** Priority, cooperative cancel and a wall-clock budget, delivered on the agent's next call | T2.6 ✅ |
| 13 | ~~Software assumptions welded in~~ | **Fixed.** Pluggable roles (T1.1), artifact graph (T1.2), project-declared checks (T1.3), git optional with a workspace-digest fingerprint (T1.4) | T1.1–T1.4 ✅ |
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

### The realistic ceiling

*(At audit time: **2–5 agents, 1 active task**, and two or three tasks only if every agent explicitly
joined each room.)*

**Now: 2–5 agents across several active tasks, one human, one machine.** Explicit membership (T0.1)
made multi-task use safe rather than silently broken, off-loop verification (T0.2) means one agent's
long suite no longer freezes everyone, and one-write-plus-N-read claims (T0.3) lift the throughput
cap — the multi-claim win is *cross-room*, since the review gate still holds a verifier behind
writers in its own task. The remaining ceiling is the single process and the single SQLite file
(T0.4), which is where "many projects at once" would start to hurt.

### Where the bugs have concentrated

Four real deadlocks have now been found in the same ~60 lines of scheduling logic (self-blocking
verifier, work aimed at a departed agent, a waits-for cycle across the review and dependency gates,
and a candidate-window truncation). Three of them were invisible — the board simply stopped moving
with no explanation. That area is now property-tested with mutation coverage, but treat it as the
highest-risk code in the repo and never change it without running the property suite.

---

## Tier 0 — structural blockers

Nothing else matters much until these are done. Each one is currently a hard ceiling.

### T0.1 — Make room membership explicit — **S/M** — ✅ DONE

**Was.** `#claimableTaskIds` returned `[]` when an agent had no explicit membership and more than
one task was active, and `connectAgent` pinned implicit membership when *exactly one* task existed —
so an agent that connected early was silently bound to whatever room happened to be open.

**Now.** Implicit membership is gone from `#memberTaskIds` and `#claimableTaskIds`; both read
`task_members` and nothing else. `connectAgent({ freshTaskId })` performs a real `joinTask` (real
membership row, real `agent.joined` event) and returns the `room` it joined, so `devteam_connect`
with a `taskId` and `devteam_join` are the only two ways in. A claim by an invited-by-name agent
still records its membership on claim, as before.

**New reason code.** `room_membership_required` — distinct from `room_not_claimable`, because being
in *no* room is a different situation from being in the wrong one, and only the first is what a
fresh session lands in. It carries `availableTasks`. `whyNoClaimableWork` gained a matching
`membershipRequired` / `availableTasks` / `next` triple, so an idle agent is never handed an empty
board with no explanation. Both are covered by the branch-coverage contract in
`test/devteam-scheduler-explain.test.mjs` (`SKIP_BRANCHES`).

**Test churn, for the record.** Roughly 150 `store.connectAgent(...)` call sites across the suite
relied on the implicit room and now pass `freshTaskId`. Tests that deliberately exercise an outsider,
an observer, or a roomless agent were rewritten by hand rather than mechanically. Verified: 191
passing, and `node tools/mutate-scheduler.mjs` still reports 12 caught / 1 equivalent (M9).

### T0.2 — Get blocking work off the event loop — **M** — ✅ DONE

**Was.** One process doing synchronous work. `spawnSync` ran git probes and verified checks, and
while either ran *nothing* responded — no MCP, no dashboard, no SSE, no heartbeats. The check
timeout had to bound the whole report precisely because ten checks could freeze everything for
twenty minutes.

**Now.** `runVerifiedCheck` (`checks.mjs`) and `#repositoryHead` (`store.mjs`) both use `spawn` and
return promises. `#gradeReportedChecks`, `completeAssignment`, `createSessionCheckpoint` and
`takeoverSessionCheckpoint` are async. The *caller* still waits for its own verdict — a report that
returned before its own evidence was gathered would be a smaller lie than the one verified checks
exist to stop — but nobody else does.

**The verifying window.** `assignments.verifying_at` is set for the duration of a report that
actually executes something, and carries three jobs:

1. **A visible state.** The timeline gets an `assignment.verifying` event and the dashboard card
   shows "Checks running", so a report in flight never reads as a stalled claim.
2. **No duplicate runs.** A second report on an assignment already verifying is refused with a
   `verifying` payload rather than spawning the suite a second time over one working tree.
3. **Crash recovery.** Startup clears any flag left behind. The claim, lease and fencing token were
   never released while verification ran, so clearing it returns the assignment to what it still is.

**The new invariant this created.** Verification is no longer instantaneous, so the claim can move
*underneath a report in flight* — force-release, resume and checkpoint takeover all reassign it
without waiting. `completeAssignment` therefore re-reads the assignment after the await and re-fences
against the current row (including `claim_generation`) before writing anything. Without that, a
report would settle against a lease its session no longer held. Covered by
`a claim that moves while its checks run cannot be settled by the session that lost it`.

**Deliberately NOT done:** the status column is untouched. Making `verifying` an assignment *status*
would have taken the row out of `status = 'claimed'`, which is what `#heldWriteLeases`,
`idx_one_claim_per_agent`, `agent_holds_claim` and orphan recovery all key off — a verifying
assignment would have silently dropped its write lease. A separate nullable column keeps every
existing invariant intact.

**Test churn, for the record.** 142 call sites gained `await`; nine `assert.throws` on
`takeoverSessionCheckpoint` became `await assert.rejects`; `drainPlanner` and the property suite's
`report` helper became async (an unawaited `report` made the property seeds take 30–75s each instead
of failing loudly — worth remembering). Verified: 197 passing, mutation tool still 12 caught / 1
equivalent.

### T0.3 — Lift the one-claim-per-agent rule where it is safe — **M** — ✅ DONE

**Now.** One **write** claim per agent, plus up to `MAX_CONCURRENT_READ_CLAIMS` (3) read-only claims.
The unique index is narrowed from "any claim" to "write claim"
(`idx_one_write_claim_per_agent`), with legacy double-*write* claims healed first exactly as the old
migration healed double claims.

**Why the old rule was wrong, precisely.** The invariant that matters is about *write leases*: two
agents must never hold overlapping write scopes, and one agent holding two leases is how it hoards
them. Read-only work — review, testing, research — takes no lease at all, so capping it bought
nothing and throttled exactly the review-heavy workflows this server exists for.

**New reason code** `agent_holds_write_claim`, distinct from `agent_holds_claim` (which now means
"you are at the total cap"), and a matching `#claimPredicates` entry so the scan and the explanation
stay in step.

**The read cap is a fairness guard, not a correctness rule** — it stops one agent draining the review
queue and starving its teammates. Correctness needs only the write cap.

**What the tests taught, and it is worth knowing before using this:** the review gate holds a
verifier behind pending writers *in its own task*, so an agent holding a write claim generally cannot
also review **in that same room** — which is correct, and means the throughput this unlocks is
**cross-room**. A writer in task A reviewing in task B is the real win. There is a test for exactly
that, and a separate one asserting the guarantee that must not weaken: two agents still cannot hold
overlapping write scopes.

**Verified:** 246 passing, mutation 12/1, and a 240-board randomised soak from a fresh offset.

### T0.3 (original plan, for reference) — **M**

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

### T1.1 — Pluggable role and checklist templates — **S** — ✅ DONE

**Now.** `src/devteam/roles.mjs` + `.devteam/roles.json` per project, seeded from the old defaults by
`devteam roles --init`. A project with no config behaves exactly as before.

**The important part is what did *not* become configurable.** Role *names* are domain vocabulary and
never reach any SQL. Exactly two *behaviours* are scheduling semantics — `verifies` and `plans` — and
they are now columns on `assignments`, resolved from the project's config when the assignment is
created. So `fact-checker` schedules identically to `reviewer`, and the review gate, task-status
derivation, approval standing and `requestChanges` standing all key off the column rather than a list
of job titles. Resolving at creation rather than at scan time means editing a project's roles never
silently re-classifies work already queued or in flight.

**Scheduler impact, and how it was checked.** `VERIFIER_ROLES`/`VERIFIER_ROLE_LIST` are gone from
`#claimPredicates` and `BLOCKING_WRITER_CONDITIONS`, replaced by `a.verifies = 0` /
`pending_write.verifies = 0`. Existing databases are backfilled once from the old hardcoded names
(guarded by a `role_behaviour_backfilled` metadata key, so a later config edit never rewrites the
snapshot an assignment was created under). `tools/mutate-scheduler.mjs` anchors M4 and M12 were
repointed at the new SQL — they had silently degraded to "anchor matched 0", which is worse than a
failure. Verified: 211 passing, mutation still 12 caught / 1 equivalent.

**JSON, not YAML,** deliberately: DevTeam has three runtime dependencies and a YAML parser would be a
fourth, bought for one config file read once per project. T1.3 should use JSON for the same reason.

**Refused on read:** a config with no verifying role (nothing could ever be approved) or no planning
role (no role to open a task with). Both are silent dead ends later. A malformed config surfaces as
`source: "invalid"` with the parse error and falls back to the defaults, rather than pretending the
defaults were chosen.

**Not done here:** role *names* still appear in `ROLE_VERB` in the dashboard for a nicer label, which
falls back to the raw name for unknown roles. That is cosmetic, not behavioural.

### T1.1 (original plan, for reference) — **S**

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

### T1.2 — Generalize the code graph into an artifact graph — **L** — ✅ DONE

**Now.** `src/devteam/parsers.mjs` holds a registry of
`{ id, language, extensions, parse, external, resolve }`. Shipped: **JavaScript/TypeScript** (the
existing one, moved), **Python**, **Markdown**, an **opaque** parser for data/config formats (nodes
but nothing parsed out of them), and a **reference fallback** for every other text type.

**The fallback is what makes this work for a project DevTeam has never seen.** A filename mentioned
inside a file is a real relationship whatever the file is, so a `.txt` spec naming three files is a
node with three edges. It only ever produces an edge when the mentioned path actually exists, so a
false positive costs nothing and a stray word can never invent a module. Go, Rust, Ruby, Java, shell
and friends get this today rather than nothing.

**Resolution moved onto the parser**, which is where it belongs: `./util` means `util.ts` in
JavaScript, `from .util import x` means `util/__init__.py` in Python, `[[decisions/x]]` in prose
means a Markdown file. Each parser proposes candidates in preference order and the first that exists
wins — so a parser may guess freely, because a wrong guess costs an edge, never a wrong edge.

**Two JS assumptions were welded in deeper than the extension list, and both were real bugs:**

1. **`is_bare` was computed as "does not start with `./`"**, so Python's `from .clean import clean`
   was classified as an external package and never resolved. Externality is now the parser's call
   (`external()`), and Python answers "a leading dot is intra-package".
2. **Edge rebuilding only considered non-bare imports.** Python's `from mypkg.core import x` is
   external by that rule and still names a file in this repo. Every import is now offered for
   resolution, and resolution — which only ever answers with a file that exists — decides.

**The graph payload gained `language` and `dependencies`,** because with one language they carried no
information and with six they tell an agent how to read a file before opening it.

**Deliberately not done:** no real parser per language. That is a dependency per language, and this
graph's job is orientation ("what else should I look at?"), not compilation. Bounded regex, zero
dependencies, and import-like text in a comment may be mis-detected — which was already true.

### T1.2 (original plan, for reference) — **L**

**Problem.** `codegraph.mjs` handles `.js .jsx .mjs .cjs .ts .tsx .json` only (`SOURCE_EXTENSIONS`).
Every other ecosystem — Python, Go, Rust, SQL, notebooks, prose, CAD, spreadsheets — gets nothing.

**Do.** Define a parser interface (`{ extensions, parse(file) -> { symbols, links } }`) and register
implementations. Ship JS/TS (existing) plus at minimum Python and Markdown. For unknown types, fall
back to a **link graph** built from filename references and Markdown/wikilink mentions — that alone
makes the graph useful for non-code projects.

**Why it matters most.** The graph is what lets an agent answer "what else does this touch?" Without
it, non-software tasks lose the main mechanism that stops agents from breaking each other's work.

### T1.3 — Domain-neutral checks — **M** — ✅ DONE

**Now.** A project declares its own checks in **`.devteam/checks.json`** with explicit argv, entirely
independent of `package.json`. A research project, a data pipeline or a book could previously report
checks but never have any verified, so every claim stayed agent-asserted forever.

**The security rules are untouched, deliberately.** Declared entries go through the same
`normalizeCheckCommand`: the program must be a bare executable name, interpreters and package runners
are still refused, there is still no shell, and a human still has to enable it. This widens *what can
be declared*, not what DevTeam is willing to run. (A declared `bash -c …` is refused exactly as a
derived one is; there is a test.)

**Declared entries beat derived ones** on a name collision — a human writing the file is a stronger
statement of intent than a script body DevTeam parsed. `availableCheckCommands` now reports `source`
so the pre-enable dashboard says where each entry came from.

**The Windows `.cmd` problem is fixed.** A locally installed tool is a `.cmd` shim; `spawn` with
`shell:false` cannot run one, so those checks graded `unavailable` forever — indistinguishable from
having no verification while looking like it works. `resolveLocalBinary` reads the shim **at snapshot
time** and rewrites the argv to run its real entry point under `node` directly. Shelling out to run
the shim would have handed back the very shell `checks.mjs` exists to avoid. Resolution happens once,
when a human enables verification, and the resolved argv is what gets pinned, so this is no more a
live re-read of `node_modules` than the `package.json` snapshot is. A shim pointing outside the
project root is refused rather than run on its say-so.

**`npm`/`npx` stay refused** and that is correct, not an oversight: `npm run x` resolves the script
body at execution time, which defeats the snapshot that makes the allowlist safe.

### T1.3 (original plan, for reference) — **M**

**Problem.** Verified checks default to `package.json` scripts and can only run programs resolvable
on PATH without a shell. On Windows, `npm`/`npx`/`eslint` are `.cmd` shims that return `ENOENT`
under `shell:false`, so only parsed script bodies like `node --test` actually run.

**Do.** Add a project-level `.devteam/checks.yaml` declaring named checks with explicit argv,
independent of `package.json`. Keep the same security rules (`isSafeCheckArgv`). Solve the Windows
`.cmd` problem by resolving shims to their real target at snapshot time rather than shelling out.

### T1.4 — Separate "work product" from "code" — **M** — ✅ DONE

**What was already fine.** `changedFiles`, `requiresWrite` and write leases are file-path shaped, and
that generalizes as-is — any artifact is a file. `#unverifiedChangedFiles` is a filesystem check, not
a git one, and `#repositoryHead` already answered `null` for a non-repo project without throwing.

**What was actually broken.** A checkpoint's drift fingerprint was git HEAD plus the task version, so
for a project that is not a repository it collapsed to the task version alone — a manuscript,
research folder or data directory got **no** signal that files had moved while a session was away.
That is precisely the non-software case this tier exists for.

**Now.** The fingerprint carries `isRepository` and a **`workspaceDigest`**: a bounded hash of the
assignment's own write scope (project-relative path, size, mtime). A takeover compares it and warns
that files in scope changed, with git not involved at all. It walks the *declared scope* rather than
the project, so the cost stays flat on a large tree, and it is explicitly not a content hash — it
answers "did this move while I was away", which is all a fingerprint is for.

**`isRepository` is surfaced rather than inferred,** so a non-repo project reads as "git is not in
play here" instead of "git said nothing", which are different facts.

### T1.4 (original plan, for reference) — **M**

**Problem.** `changedFiles`, `requiresWrite`, and write leases are file-path shaped. That actually
generalizes fine (any artifact is a file), but the *vocabulary* and the git integration assume a
repository.

**Do.** Make git optional per project. Where `#unverifiedChangedFiles` and the git HEAD probe run,
degrade gracefully for non-repo projects instead of silently producing empty evidence.

---

## Tier 2 — the team behaviours you actually want

This is the heart of the goal: agents that divide work, review each other, and repair mistakes.
Today DevTeam **coordinates** a team; it does not yet **behave** like one.

### T2.1 — Real work decomposition — **L** — ✅ DONE

**Now.** `devteam_split` / `splitAssignment`. An agent that claims something and finds it is three
days of work, or two unrelated jobs wearing one title, divides it into 2–12 pieces instead of
grinding through it or reporting blocked and waiting for a human-shaped triage step.

**The constraint that shapes the whole design: splitting must not cost the splitter its lease.** An
agent that has to release its claim to reorganise will not do it — it will grind on instead — and in
the gap another agent can take the paths it was midway through editing. So the parent stays claimed,
by the same agent, at the same `claim_generation`, throughout; the claim token keeps working.

**Inheritance, all of it deliberate:**

- **Write scope** — a piece that declares no paths inherits the parent's. Giving it *no* scope would
  hand it a whole-project lease, which is the opposite of what splitting is for.
- **Dependencies** — a prerequisite of the whole is a prerequisite of every piece.
- **Targeting** — work addressed to a teammate by name stays addressed to them when subdivided,
  rather than quietly returning to the pool.
- **Priority** — a piece of urgent work is urgent.

**Dependency inference (the roadmap's third bullet).** Two sibling writers whose declared scopes
overlap cannot run at once, and would otherwise discover that by contending for a lease — one sitting
blocked with no stated reason. Overlaps become explicit dependency edges, ordered deterministically
(earlier part first). Note this is transitive-looking in practice: a piece that inherits the parent's
broad scope overlaps every narrower sibling, so it is ordered after all of them. There is a test
asserting exactly that shape.

**Each piece is re-assessed on its own merits** (`assignmentAssessment`, which is evidence-hashed, so
this is not a second opinion). The point of splitting is that the pieces are smaller than the whole;
a runtime gate treating each child as if it were the original would defeat it.

**`keepParent`** is offered because an agent part-way through real work often wants to finish the
piece it is holding and hand off the rest. Default closes the parent, since its work now lives in the
children and leaving it open would double-count.

**Fenced like a report:** only the live claim holder, with a matching claim token, can reshape the
work — and not while its checks are running.

### T2.1 (original plan, for reference) — **L**

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

### T2.2 — Rework loops instead of blunt blocking — **M** — ✅ DONE

**Was.** When a review found problems the reviewer had two moves and both were wrong. Approving
anyway is dishonest; `status=blocked` closes the *reviewer's own* assignment and queues a coarse
planner triage item, so every real defect routed through a human-shaped step instead of back to the
person who wrote the code.

**Now.** `devteam_request_changes` (store: `requestChanges`) is the third move. The author's
completed assignment is **reopened** — not replaced — so its title, description, checklist, write
scope, dependencies and whole event history stay attached to the work instead of being scattered
across a chain of near-duplicate follow-ups. It goes back to `queued`, addressed to its author by
name, with the reviewer's findings attached as rows in a new `assignment_findings` table.

**How the loop closes.** `claimNextAssignment` returns a `rework` block — count, summary, and the
open findings — on any assignment queued as rework, so the author is handed exactly what to fix
rather than re-reading an assignment whose description still describes the *original* task.
Reporting again marks those findings resolved (kept, not deleted, so the next reviewer can see what
this went back for) and clears the queued-as-rework flag. `rework_count` deliberately survives: how
many rounds a piece of work has taken is a fact about the work.

**Design calls worth knowing about:**

- **Standing is the same as approving.** Sending work back needs a completed *or in-progress*
  read-only verifier assignment on the current version. In-progress matters: the reviewer that finds
  the problem mid-review should not have to file its own report before it can say so.
- **Approvals on that version are cleared.** A version a reviewer just judged not good enough is not
  a settled state. If the rework changes files the version bumps and they would have gone anyway; if
  it changes none they would otherwise have survived a reviewer saying "not yet".
- **Targeting is a preference, not a lock.** The existing absent-target rule returns the item to the
  room once nobody by that name is connected, so rework never becomes unclaimable because its author
  went home.
- **No generation bump on reopen.** It clears the claim and its fencing token, exactly as
  `forceReleaseAssignment` does, and lets the re-claim advance the generation. A late report from the
  author's previous session is refused because the row is no longer `claimed`, not because of a
  second bump — matching the convention already in the file rather than inventing another.
- **The human has the same move.** `POST /api/tasks/:taskId/assignments/:assignmentId/request-changes`
  and a **Request changes** button on every completed assignment card. Findings show on the card,
  with the reopened assignment marked so rework never reads as an ordinary queued item.

**Still open for T2.5:** `rework_count` is now recorded per assignment but nothing aggregates it per
*agent* yet. That is the reliability signal, and this is the input it was waiting for.

### T2.3 — Regression awareness — **M** — ✅ DONE

**Now.** A per-task `check_baselines` row per *verified command* records what it last did and when it
was last green. On every report — including a refused one, which is where a regression is usually
first seen — the new results are compared against it. `passed → failed` opens a `check_regressions`
row, emits `check.regressed`, and queues a fix assignment scoped to the suspects' changed files.
`failed → passed` closes it, so ordinary work quietly repairing something does not leave it open.

**Keyed by command, not label.** A label is prose an agent chose; the argv is the allowlist entry
DevTeam actually ran. Two agents describing the same suite differently must compare against the same
baseline — and an *asserted* check must be able to neither establish a baseline nor quietly repair
one, which falls out of only recording `verified` results.

**Attribution is a set, not a name.** Suspects are the assignments that changed files between the
last green run and the failure. With exactly one, the fix is addressed to its author. With several,
the fix is untargeted and its description says the attribution is a starting point rather than a
verdict — naming one of three writers would be a guess dressed up as a finding.

**Two bugs found while building it, both worth remembering:**

1. **Timestamps cannot order events here.** Attribution originally walked forward from the baseline's
   ISO `updated_at`. Several events routinely land in the same millisecond, so a suspect was
   sometimes dropped — turning an ambiguous attribution into a confident *wrong* one, which is the
   worst possible failure for this feature. It now walks forward by monotonic **event id**
   (`last_passed_event_id`).
2. **The mark is taken before the report writes its own completion event**, so the assignment that
   made a check green became a suspect for breaking it. Both the reporting assignment and the
   baseline-setting assignment are excluded.

**The fix assignment is path-scoped** to the suspects' changed files. Unscoped it would take a
whole-project lease and block every unrelated writer — a regression fix that stops the team is worse
than the regression.

**What this does not do.** It cannot tell *which* file broke a check, only which changes landed in
the window. Real per-check file coverage would need the check to report it, which no runner does
uniformly. The window is the honest answer.

### T2.3 (original plan, for reference) — **M**

**Missing today.** Nothing detects that agent B broke what agent A delivered. Verified checks give
you the raw material (exit codes over time) but nothing compares runs.

**Do.** Store a per-task **check baseline**. When a check that previously passed now fails, mark the
report as a regression, name the assignment that last changed the overlapping paths, and
auto-create a linked fix assignment targeted at that author. This is the mechanism that turns a
group of agents into a team that covers for each other.

### T2.4 — Cross-agent verification quality — **M** — ✅ DONE

**Now.** Independence is recorded *on the approval row* (`approvals.independent`, `verified_evidence`)
at the moment of approving, not recomputed later — whether the approver was the author is a fact
about that moment, and recomputing lets the record change as agents connect and disconnect, which is
exactly when it must not. The `task.approved` event says so in words when a self-review happens.

**And where a project runs verified checks, an approval must rest on one.** Without this, "DevTeam
ran it and it passed" and "an agent said so" carried identical weight at the one moment that decides
whether work ships. Projects with no allowlist are unaffected — nothing to verify means nothing to
require — so this cannot strand a project that never opted in.

**A solo run still finishes.** The no-dead-end property is deliberately preserved; it is just
labeled honestly rather than silently.

### T2.4 (original plan, for reference) — **M**

**Problem.** `no dead-end: a solo agent can complete a task that nominally needs two approvals`
exists as a test — meaning self-approval is permitted as a fallback. Combined with unverified
checks, a single agent can currently mark its own work done and approved.

**Do.** Make independence a first-class, visible property: record for each approval whether it was
independent, and surface `selfReviewed` prominently in the dashboard (it exists in the payload
already). Consider requiring at least one verified check before an approval counts when the project
has verification enabled.

### T2.5 — Agent reliability signals — **M** — ✅ DONE

**Now.** `agentReliability(name)` / `teamReliability()` and a `devteam_reliability` tool: work
completed, reports refused because a check failed, assignments sent back and how many rounds,
regressions caused, regressions caught, approvals and how many were independent.

**Derived on read, never counted.** A counter can drift from the timeline and then quietly libel an
agent, with no way to notice. Deriving from the event log is slower and always agrees with the
record. Keyed by agent **name**, not session id — a reliability record that resets whenever a desktop
chat reconnects is worthless.

**Three deliberate choices that keep it honest:**

- **Ambiguous regressions are charged to nobody.** Only a sole suspect counts. Attributing a shared
  window to one name is a guess, and a guess that follows someone around as a number is worse than
  no number.
- **Catching a regression counts *for* you.** A record that only ever counts faults teaches agents
  not to run checks, which is the opposite of what it is for.
- **An agent with no history is treated as trustworthy.** A score that suppresses newcomers starves
  the very work that would give it data.

**Not wired into the runtime gate.** The roadmap suggested feeding it into `#runtimeGate` and claim
ordering. It is deliberately left as an input a human and a planner can read: gating on a derived
score would let one bad afternoon quietly lock an agent out of critical work, and the gate already
has the assessment machinery for that decision.

### T2.5 (original plan, for reference) — **M**

**Missing today.** Nothing tracks which agent's work gets rejected, which produces regressions, or
which reports checks that fail verification.

**Do.** Per-agent rolling stats: assignments completed, reports refused by check verification,
reviews that later regressed, average rework count. Feed this into `claimNextAssignment` ordering
and into the runtime gate — an agent with a poor record on `critical` work gets gated harder. You
already have the gating machinery (`#runtimeGate`, `assignmentAssessment`); this is new *input* to
it, not new machinery.

### T2.6 — Human steering mid-flight — **S/M** — ✅ DONE

**Now.** Three controls, all control-plane only (an agent re-prioritising its own queue or lifting a
budget would defeat the point):

- **Priority** (`assignments.priority`, `POST …/priority`) sits *inside* the candidate ordering,
  after targeting and before creation time. It reorders what is already claimable and can never make
  unclaimable work claimable — wanting something sooner is not a reason to skip a dependency, a write
  lease or the review gate. There is a test for exactly that.
- **Cooperative cancel** (`POST …/cancel`) sets a flag the holder is handed on its next call. It does
  **not** release the claim: killing a writer mid-edit is precisely how a working tree gets left
  half-written, and DevTeam cannot know where in its work an agent is. If the agent never comes back,
  the existing liveness machinery handles it exactly as before.
- **Wall-clock budget** (`tasks.budget_minutes`, `POST …/budget`), advisory for the same reason.

**Delivery matters as much as the controls.** Steering rides along on `withInbox`, so it reaches an
agent deep in a long edit rather than only when it next goes idle, and `devteam_wait` returns
`status: "steering"` immediately rather than making a stopped agent sit in a 45-second poll.

**Token/spend caps are not here** — they need T4.2 first.

### T2.6 (original plan, for reference) — **S/M**

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

### T3.1 — Agent-writable structured memory — **M** — ✅ DONE

**Now.** `devteam_knowledge_write` (store `knowledgeWrite`, vault `write`) writes a first-class vault
note with category, confidence, related files and inline `[[links]]`, through the same upsert,
redaction, slugging and link indexing as a derived note. An `agent.finding` event records who claimed
it, so the note and the timeline agree.

**Two deliberate limits.** An agent-written note is always `inferred`, never `verified` — `verified`
means DevTeam observed it happen, and letting an agent assert it would destroy the distinction
exactly where it matters most, in deciding what the next session's briefing should believe. And
`sessions`/`archive` are not writable: they are DevTeam's own bookkeeping.

### T3.4 — Backlinks and graph queries — **S/M** — ✅ DONE

**Now.** A `knowledge_links` table maintained on every note write, plus `backlinks()` /
`outboundLinks()` and a `devteam_knowledge_links` tool. Backlinks travel with `devteam_knowledge`
results, so a note is read together with what depends on it.

**The one non-obvious design call.** `to_note_id` is *computed* from the link target rather than
looked up, because a note's id is a pure function of `(project, category, slug)`. A link written
before its target exists already points at the right id and simply starts resolving the moment that
note is written — so a forward reference is an ordinary link rather than a dangling one needing a
repair pass. Rewriting a note replaces its edges rather than accumulating them, self-links are not
backlinks, and `[[x|label]]` is the same edge as `[[x]]`.

### T3.1 / T3.4 (original plan, for reference)

**Problem.** The vault is derived from events. `devteam_note_set` exists but writes flat key/value
notes, separate from the vault's category/status/confidence model.

**Do.** Let an agent write a *first-class* knowledge note directly — with category, confidence,
related files, and links — subject to the same redaction. An agent that learns "this API rate-limits
at 30/min" has nowhere good to put that today.

### T3.2 — Contradiction detection — **M** — ✅ DONE

**Now.** On every note write, `#conflictCandidates` looks for notes in the same category that are
about the same subject — by title-term overlap **or** by shared related files, either alone being
enough, since notes about one file often have unlike titles and notes about one idea often touch no
files. Matches come back as `possibleConflicts` on the write result, while the agent that wrote it is
still there and can say which is right. `devteam_knowledge_dispute` then drops both to `disputed`,
which briefs and searches already exclude — better a gap than confidently serving one of two
contradictory facts.

**It does not try to understand the claims,** and says so: it detects "these are about one subject and
say different things". Resolution is the team's job, which is what the proposal mechanism is for.

### T3.5 — Memory decay and review — **S** — ✅ DONE

**Now.** `ageWeight` decays on a 120-day half-life **from the last confirmation**, not from creation —
so re-confirming an old note makes it current again, which is the honest rule. Applied in
`rankKnowledgeNotes` as a bounded penalty rather than a multiplier: scaling the whole score would let
age erase a direct path match, and "old but exactly about this file" is still the right note.

`devteam_knowledge_maintain` is the stale queue plus anything disputed; `devteam_knowledge_confirm`
is the only thing that resets age. Deliberately a *queue*, not an automatic downgrade — a fact does
not become false by getting old, it becomes unconfirmed, and those are different claims.

### T3.6 — Cross-project memory — **M** — ✅ DONE

**Now.** `shared_scope` per note, opt-in and never inherited, with `devteam_knowledge_share` /
`devteam_knowledge_borrowed`.

**Two guards, because this is the one place one client's details could reach another's context:**

- **Only `conventions` and `pitfalls` may be shared.** An architecture note, a component description
  or a decision is *about* a particular system and cannot be true elsewhere; offering it would be
  shipping a claim that does not apply.
- **Re-redacted at share time, not trusted from write time.** Sharing changes who can read a note, so
  a rule that only ran when it was written would carry whatever it missed then. Anything
  credential-shaped is refused outright rather than scrubbed.

Borrowed notes are a separate, asked-for surface — never mixed silently into a project's own
knowledge — and each says which project it came from and that it needs confirming here.

### T3.2 (original plan, for reference) — **M**

**Problem.** Notes have `status: verified | disputed | superseded`, but nothing *detects* that a new
note contradicts an old one. Superseding is triggered by file changes, not by meaning.

**Do.** On note write, retrieve near-duplicates by key/path overlap and flag conflicts for
resolution — either by a reviewer agent or by the existing proposal/consensus mechanism, which is
already the right tool for "the team disagrees about a fact."

### T3.3 — Better retrieval — **M/L** — ✅ DONE (option 1; no vector store)

**Now.** A `knowledge_fts` FTS5 table (porter/unicode61) maintained on every note write, searched with
**bm25** weighted `title 6.0 / body 1.0 / related 2.0` — a note *about* a thing beats one mentioning
it in passing. The previous ordering (this task's notes first, then verified, then recent) survives
as the tie-break within relevance rather than being the ranking itself.

**No new dependency, and the no-vector-store decision stands.** Node's built-in SQLite ships FTS5 and
bm25; this is exactly the "do this first" option the roadmap called for.

**Three things worth knowing:**

- **Queries are sanitized into literal phrases.** FTS5 MATCH is a small language (`AND OR NOT NEAR *
  " ^ -`) and agent queries are prose. Every term is quoted and joined with `OR`, so nothing in the
  text can be read as an operator — a stray `-` silently inverting a search is the kind of bug nobody
  would ever find. Covered by a test that fires malformed queries at it.
- **The LIKE path is kept as a fallback, deliberately.** FTS matches whole tokens, so a fragment
  inside a word ("illing" in "billing") finds nothing until substring matching answers it. Ranked
  search runs first; the fallback runs when it is empty.
- **A SQLite build without FTS5 degrades to exactly the old behaviour** rather than leaving the vault
  unsearchable (`ftsEnabled` is false and every path falls through).

### T3.3 (original plan, for reference) — **M/L**

**Problem.** Keyword + recency retrieval degrades badly as the vault grows. This is the mechanism
that decides what an agent knows, so its quality caps the whole system's quality.

**Do.** Two options, in order of cost:
1. **BM25 over SQLite FTS5** — cheap, no new dependency, a large improvement over substring
   matching. Do this first.
2. **Local embeddings** — only if BM25 proves insufficient. Your notes say "no vector store" as a
   deliberate choice; FTS5 lets you honour that a while longer.

### T3.4 (original plan, for reference) — Backlinks and graph queries — **S/M**

**Problem.** You emit `[[wikilinks]]` but maintain no backlink index, so "what references this
decision?" is unanswerable without scanning.

**Do.** A `knowledge_links` table maintained on write; expose backlinks in `devteam_knowledge` and
on the dashboard. Cheap, and it makes the Obsidian vault genuinely navigable.

### T3.5 (original plan, for reference) — Memory decay and review — **S**

**Problem.** Nothing ages. A `verified` note from six months and forty versions ago reads exactly
like one written today.

**Do.** Age-weight confidence in retrieval; surface a "stale knowledge" queue a maintainer agent can
work through. You already have `verifiedAt` — this is mostly scoring, not schema.

### T3.6 (original plan, for reference) — Cross-project memory — **M**

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

### T4.2 — Cost and token accounting — **M** — ✅ DONE

**Now.** `devteam_report` takes an optional `usage` block (input/output tokens, cost, model), stored
in `assignment_usage` and aggregated by `taskUsage(taskId)` per agent and per model. A **spend cap**
joins the wall-clock cap from T2.6, and trips the same steering signal.

**Labeled agent-reported everywhere it appears, because it is.** DevTeam cannot measure another
process's token use and does not pretend to — these are the agent's own figures, exactly like an
unverified check, and `agentAsserted: true` plus a plain-English note travel with every aggregate. A
number that looks measured but is asserted is worse than an obviously asserted one. The spend cap
says `spendIsAgentReported` for the same reason: a cap on a self-reported figure is only as good as
the reporting, and a task whose agents never report simply never trips it.

**One bug worth remembering:** `costUsd: null` was coerced to `0` by `Number(null)`, so an omitted
figure recorded a zero-cost row and a task where nobody reported anything read as *free*. Null now
means "not reported" and is dropped.

### T4.2 (original plan, for reference) — **M**

**Missing today.** No record of what work cost. For a "go-to tool", the human needs to see which
agent burned what on which assignment.

**Do.** Let agents report token/cost figures on `devteam_report`; aggregate per task and per agent.
Pairs naturally with the budget caps in T2.6.

### T4.3 — Full task replay — **S/M** — ✅ DONE

**Now.** `taskReplay(taskId)` renders the whole task as ordered Markdown — assignments, claims,
reports with their own prose, what DevTeam actually ran, reviews, changes requested, regressions —
with version bumps as section breaks, since everything after one is review of different work. Served
at `GET /api/tasks/:taskId/replay` (`?format=json` for the structured form).

**It reports; it does not re-grade.** A check that was agent-asserted at the time still reads as
asserted in the replay, and reported cost still says it was reported. A retrospective that silently
upgrades old evidence is worse than no retrospective.

### T4.3 (original plan, for reference) — **S/M**

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

### T4.5 — Scheduler regression safety — **S** — ✅ DONE *(and permanent)*

**Now.** `tools/scheduler-soak.mjs` runs the property suite over a large **randomised** seed span in
batches, well beyond what a normal test run can afford:

```bash
node tools/scheduler-soak.mjs                 # 200 boards from a random offset
node tools/scheduler-soak.mjs --seeds 1000    # longer
node tools/scheduler-soak.mjs --from 5000     # reproduce a reported failure exactly
```

A failure names the seed; **put that seed in `SEEDS` and it becomes a permanent regression test.**
That is the workflow this exists to feed, and it is why the committed seeds stay enumerated rather
than chosen — six hand-picked seeds once passed while four of the next eight deadlocked.

**Deliberately not part of `node --test`.** A nightly job that sometimes takes ten minutes is useful;
a test suite that sometimes takes ten minutes gets skipped.

**One thing the soak immediately taught us:** the property file's vacuity guards (`largestBoard > 20`
and friends) are calibrated for the committed 24-seed span, and a short soak batch legitimately may
not generate a board big enough to page. They now apply only to the committed span — a soak failing
on coverage rather than on a deadlock is a false alarm, and false alarms train people to ignore soaks.

**Still open:** wiring the soak into an actual scheduled job. It is a script and a documented command;
nothing runs it on a timer, because this repository has no CI.

### T4.5 (original plan, for reference) — **S**

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
T0.1  explicit membership          ✅ done
T0.2  off the event loop           ✅ done
T2.2  rework loops                 ✅ done
T1.1  pluggable roles              ✅ done
T3.4  backlinks     + T3.1 agent-writable notes   ✅ done
T2.3  regression awareness         ✅ done
T1.2  artifact graph               ✅ done
T3.3  FTS5 retrieval               ✅ done
T0.3  multi-claim                  ✅ done
T2.5  reliability signals          ✅ done
T4.2 cost accounting ✅  T4.3 replay ✅  T4.5 soak ✅   (T4.1 auth / T4.4 containers: as the tool leaves your machine)
```

**If you only do three things:** T0.1, T0.2, T2.2. Those three move it from "a coordination server
for one task" to "a room that can actually run several pieces of work and repair its own mistakes."
**All three are now done.** The next three, on the same reasoning, are **T2.3** (nothing yet notices
that one agent broke another's work), **T1.1** (the cheapest unlock for non-software domains), and
**T2.5** (which T2.2 just produced the first real input for).

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
- ~~**On Windows, `npm`/`npx`/`eslint` are `.cmd` shims** and return `ENOENT` under `shell:false`.~~
  **Fixed in T1.3** for locally installed tools: the shim is resolved to its real entry point at
  snapshot time and pinned as `node <entry>`. `npm`/`npx` remain refused on purpose — `npm run x`
  resolves the script body at execution time, defeating the snapshot.
- **A timed-out check leaks its process tree.** `killSignal: SIGKILL` kills only the direct child;
  grandchildren survive. Needs Job Objects on Windows / process-group kill on POSIX.
- **The review gate was deliberately weakened.** A verifier no longer waits for writers with unmet
  dependencies, and write-declaring verifiers are ordered by creation time. This was required to
  break a waits-for cycle that deadlocked the board permanently. The cost — a verifier may start
  just before a distant queued writer runs — is absorbed by version-invalidates-approvals. Do not
  "restore" the stricter gate without re-reading that reasoning.
- **Running `node --test` in the same command that just wrote a source file can fail spuriously on
  Windows.** Seen repeatedly as `a solo acceptance is labeled selfReviewed` failing on the run
  immediately after an edit to `store.mjs`, then passing on every re-run (verified 5/5 and 3/3 on the
  full suite each time), and not reproducible when the same scenario is driven directly. It is a
  write/module-load race between the editor and the test process, not a defect in the code under
  test. **If a single test fails right after you edited a source file, re-run before investigating.**
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
