# DevTeam session issues log — claude

Session start: 2026-08-28

Running log of everything that goes wrong or reads badly during this DevTeam session.

## 1. devteam_report rejected `command: null` inside a checks[] entry
- when: 2026-08-28T16:38:00Z
- doing: reporting the implementer assignment with one verified check (`node --test`) plus three plain assertion checks
- called: `devteam_report` with `checks: [{label, command:"test"}, {label, command:null}, {label, command:null}, {label, command:null}]`
- got: `"MCP error -32602: Input validation error: Invalid arguments for tool devteam_report: Invalid input at checks[1]\nInvalid input at checks[2]\nInvalid input at checks[3]"`
- expected: `command: null` to be accepted as "this is an assertion, not a command" — the schema anyOf allows a bare string OR an object, but an object with an explicit `command: null` fails validation with no hint that the fix is to omit the key or pass a bare string
- severity: friction
- worked around by: resending with those three entries as bare strings instead of objects

## 2. DevTeam's verified-check runner invokes `node --test` with a malformed permission-model flag, so every check fails
- when: 2026-08-28T16:38:15Z
- doing: reporting the implementer assignment; `node --test` passes cleanly when I run it myself (pass 13, fail 0)
- called: `devteam_report` ... `checks: [{label:"node --test passes", command:"test"}]`
- got: `"C:\\Program Files\\nodejs\\node.exe: --allow-fs-read= requires an argument"` and `"✖ test\\toc.test.mjs"`, `"ℹ tests 1 ... fail 1"`, then `"DevTeam ran the commands you reported and they did not pass, so this cannot be recorded as done."` — full output also shows `SecurityWarning: The flag --allow-child-process must be used with extreme caution` and `--allow-worker`
- expected: DevTeam to run the allowlisted `test` command the same way a human would (`node --test`), and see it pass. Instead it injects `--allow-fs-read=` with an empty argument (plus `--allow-child-process` / `--allow-worker`), which makes node itself exit before running any test. The sandbox flag construction is broken: `--allow-fs-read=` needs a path.
- severity: blocker — a correct, passing implementation cannot be reported as done through a verified check
- worked around by: re-reporting with the `node --test` result as a plain agent-asserted check (no `command`), noting the harness bug in the report message; the check is recorded as "asserted" not "verified"

## 3. The broken check result is now a persistent "checkBaseline" regression marker
- when: 2026-08-28T16:41:00Z
- doing: reading want=state after my report was accepted (as asserted) and the reviewer sent it back
- called: `devteam_next` want=state
- got: `"checkBaseline":[{"label":"node --test passes (13 tests, 0 fail)","command":["node","--test"],"status":"failed","taskVersion":1,"lastPassedAt":null,...}]` and `"reliability":[{"agentName":"Claude",...,"refusedByChecks":1,...,"cleanReportRate":0.94}]`
- expected: a check that failed only because DevTeam's own runner is misconfigured should not be recorded against the task as a failed baseline, nor counted against my reliability stats. There is no way for an agent to clear this without the runner being fixed.
- severity: friction
- worked around by: nothing — recorded, carrying on

## 4. Reviewer (Codex) returned a valid finding; rework loop worked as intended
- when: 2026-08-28T16:41:30Z
- doing: after reporting done, `devteam_next` re-handed me assignment 6202333f (claim_generation 2) with a finding attached
- got: finding `"Require at least one space or tab after the opening # sequence. The current regex treats a bare ##  ... as a heading, but TASK.md rule 1 requires ... Remove the empty-heading exception and add a rule-named regression test showing extractHeadings('##') returns []."`
- expected: this is correct — my original regex had an empty-heading exception that rule 1 does not allow. Not a DevTeam bug. Noting only because it is the one place a review caught a real defect the passing test suite missed, which is the point of the review step.
- severity: cosmetic (working as designed)
- worked around by: removed the exception, added a rule-1 regression test (`extractHeadings("##")` -> []), 14 tests pass locally

## 5. Codex blocked the whole task (kind=external) over the same check-runner bug
- when: 2026-08-28T16:42:00Z
- doing: calling devteam_next after reporting rework round 1 done
- called: `devteam_next` (work mode)
- got: `"status":"idle"` ... `"reason":"DevTeam's mandatory verified-check runner injects a malformed Node permission option (--allow-fs-read without an argument), causing node --test to fail before test code loads. The direct project-root test passes 14/14, but no approval can be recorded until the runner configuration is fixed or its verified-check requirement is changed."`, `"kind":"external"`, `"blockedBy":"Codex"`, and `"agentAction":"Only the human can resume a blocked task; no MCP tool can. Say which task needs resuming and why, then stop and wait."`
- expected: to be able to complete an independent review of Codex's... wait, of the implementation (I wrote it, so I could not review it anyway) — or for the tester assignment to run. Instead the task is fully stopped for everyone.
- severity: blocker
- worked around by: nothing — the implementation and tests are complete and pass 14/14 locally, but DevTeam cannot record any approval. Human must resume from the dashboard after fixing the check runner. Stopping here.

## Session summary
- verbs I actually used: devteam_join, devteam_next (work, state), devteam_report, devteam_message, devteam_leave. Not used: devteam_plan, devteam_verdict, devteam_stuck, devteam_memory.
- anything I expected to exist and did not find: no tool/flag to mark a verified check as "runner is broken, not my code" or to re-run a failed baseline check; no way to see the exact command line DevTeam uses for an allowlisted check before reporting against it. `checks[]` schema silently rejects `{label, command: null}` — a bare string is the only way to assert.
- did a review of my own work ever get handed to me? no. DevTeam correctly kept the reviewer (7246dbe0) and tester (13606952) assignments away from me as the implementer; both went to / were reserved for Codex and the queue.
- did I ask for changes on someone else's work, or only approve? neither — I was never handed a verify assignment (I was the sole implementer). Codex asked me for changes once (valid rule-1 finding) and I addressed it.
- did DevTeam ever run a check for me, or did it only record what I claimed? it tried to run `node --test` and the run failed due to its own malformed permission flag (`--allow-fs-read=` with no argument). Every substantive check ended up recorded as an agent assertion, never verified. So in practice: it only recorded what I claimed.
- the one thing that would have saved me the most time: a working verified-check runner (or a documented way to see/override the command it runs). The entire task is now blocked on that single bug despite a complete, passing implementation.

---

# Session 2 (2026-08-28T16:43Z) — human resumed the task

## 6. I was handed a review of code I wrote myself
- when: 2026-08-28T16:43:46Z
- doing: called devteam_next after the human resumed the task; expected a planner assignment
- called: `devteam_next` (work mode), new agentId 6cdcc328 (fresh session, same human/provider)
- got: assignment `f238cdcd` "Fresh specification review of current TOC implementation", role `reviewer`, over src/toc.mjs + test/toc.test.mjs — which I (agentId 3317811b, session 1) authored in events 2805/2810.
- expected: per the skill, "You will never be handed a review of your own work" — DevTeam should refuse or at least label it. There was no `selfReviewed` flag or warning in the assignment payload. The only other agent (Codex) is disconnected, so the fallback ("nobody independent available") applies, but nothing in the tool response said so.
- severity: friction — the safeguard silently degraded; a human reading the eventual verdict has no signal it was a self-review unless they notice the agentId/author match themselves
- worked around by: proceeding with a genuinely adversarial read and calling out a real bug (below); stating plainly in the verdict + room message that I am the author

## 7. Rule-8 duplicate-slug suffixing collides with a literal heading of the suffixed name
- when: 2026-08-28T16:45:00Z
- doing: reviewing src/toc.mjs against TASK.md rule 8 ("Duplicate slugs get a numeric suffix ... links break without it")
- called: `node -e` probe: `extractHeadings("## Notes\n## Notes\n## Notes-1").map(h=>h.slug)`
- got: `["notes","notes-1","notes-1"]`
- expected: three distinct slugs (GitHub yields `notes`, `notes-1`, `notes-1-1`). The current impl only checks the *base* slug against the seen-map, not the generated suffixed slug, so `## Notes` (2nd) and `## Notes-1` (literal) both resolve to `notes-1` — a duplicate slug, the exact failure rule 8 exists to prevent.
- severity: friction (real correctness gap in the code under review, not a DevTeam bug) — logging because it is what the review step caught
- worked around by: submitting verdict=changes against implementer assignment 6202333f with a concrete finding + suggested fix (loop the suffix until the candidate slug is unused, and register every emitted slug)

## 8. Two verification assignments (planner, tester) ran and completed against a version I then sent back
- when: 2026-08-28T16:45:30Z
- doing: reclaiming the implementer assignment after my changes verdict; read the brief
- got: projectKnowledge shows `work-2832-plan-resumed-task` ("local node --test passes 14/14") and `work-2836-fresh-test-verification-of-current-toc-implementation` ("Direct project-root npm test passes 14/14 ... Recording the direct execution as an asserted check") both already `verified` — i.e. Codex (or a runner) completed the planner and tester assignments and the tester *approved* the code at the same moment I was reviewing it and finding a real duplicate-slug bug.
- expected: some ordering so a tester isn't approving a version a reviewer is simultaneously rejecting. The tester's checklist includes "Edge cases and invalid input covered" — the `## Notes / ## Notes / ## Notes-1` collision is exactly that, and it passed tester review. Parallel verification without cross-checking findings means "2 approvals" can include one that missed a defect the other caught.
- severity: friction
- worked around by: nothing to work around — my changes verdict re-queued the implementer assignment regardless; noting the coordination gap.

## 9. Rule-8 fix applied (rework round 2)
- when: 2026-08-28T16:46:30Z
- doing: fixing the duplicate-slug collision I found in review
- called: edited src/toc.mjs (replaced base-only `slugCounts` Map with a `usedSlugs` Set + while-loop that bumps the suffix until unused), added test `rule 8: a generated suffix never collides with a literal heading of that name` asserting `["notes","notes-1","notes-1-1"]` and all-distinct
- got: `node --test` -> tests 15, pass 15, fail 0
- severity: cosmetic (working as designed)
- worked around by: n/a — about to report

## 10. Routing deadlock: I held a review assignment for code I had become the author of, with no self-service handoff
- when: 2026-08-28T16:50:30Z
- doing: after reporting rework round 2 (v5), trying to get v5 approved. I still held reviewer assignment `f238cdcd`; Codex held the older reviewer assignment `7246dbe0` in status `blocked`.
- called: `devteam_next` repeatedly — got `"status":"idle" ... "No work for you yet, but the team is still active"` while `openWork:1, workingAgents:1`. Both agents visibly sat in devteam_next (the human noticed and asked "why are you guys now doing anything i can see you both are in like devteam next state?").
- expected: when a reviewer becomes the author of the version under review, DevTeam should re-route the review to the other connected agent automatically, or offer a handoff verb. Instead the review just sat claimed by me, unapprovable, and there was no `devteam_handoff` — the only lever was `devteam_report status=blocked`.
- severity: friction — needed a human to notice the stall
- worked around by: `devteam_report` on `f238cdcd` with `status=blocked`, reason "author cannot self-approve v5". Response: `"taskBlocked":false, "followUpAssignmentId":"40857f17-..."` — it queued a fresh review for re-routing. That worked, but only because I knew status=blocked on an assignment != blocking the task.

## 11. `devteam_next` never hands over a review of a peer's work while I sit idle, even with one open and unclaimed
- when: 2026-08-28T16:48-16:50Z
- doing: waiting for the reviewer/tester work on v5 to be handed to me or Codex
- got: repeated `idle` / `message` responses; the queued tester assignment `0149e4b9` and (after my block) the fresh review `40857f17` never came to me via `devteam_next` during the ~4 min I stayed assembled
- expected: `devteam_next` to hand me a claimable verification assignment for a version I did not write (v5 — I wrote the impl, but a tester role I could still do). It's possible DevTeam correctly excluded me from all v5 verification because I touched the code; if so, that's right, but then with Codex idle too nothing advances and the human is left watching two stalled agents.
- severity: friction
- worked around by: messaging the room + Codex directly to claim the v5 review; leaving the session so the human can drive Codex.

## 12. Work is complete and independently verified but the task cannot reach "done" — approval is gated on the broken check runner
- when: 2026-08-28T16:52:00Z
- doing: checking whether v5 got its 2 approvals after Codex ran the fresh reviewer + tester assignments
- got: task status `review`, version 5, `approvals: []`. Codex event 2865: `"v5 passed independent review and testing locally (15/15) ... DevTeam's formal approval still refuses only because its internal Node runner fails before loading tests with malformed --allow-fs-read=; run npm test from the project root to verify the actual project."` checkBaseline still `{'label':'npm test passes','command':['node','--test'],'status':'failed'}`.
- expected: after an independent reviewer and an independent tester both complete and report the version good, `verdict=approve` should be recordable. It is not — the mandatory verified check (`node --test`) can never pass while DevTeam's runner injects `--allow-fs-read=` with no argument, so the task is permanently stuck one step short of done despite correct, twice-reviewed code.
- severity: blocker
- worked around by: nothing. The deliverable is finished and correct (src/toc.mjs + test/toc.test.mjs, 15/15 local, both review-round bugs fixed, Codex independently confirmed). The DevTeam task will not close until a human fixes the check-runner flag. Left the session.

## Session 2 summary
- verbs I actually used this session: devteam_join, devteam_next (work + state), devteam_message, devteam_verdict (changes), devteam_report (done + blocked), devteam_leave. Added over session 1: devteam_verdict. Still never used: devteam_plan, devteam_stuck, devteam_memory.
- did a review of my own work ever get handed to me? YES — twice. Session 1: no. Session 2: assignment `f238cdcd` "Fresh specification review" was handed to me (new agentId) for code my previous session wrote, with no selfReviewed flag in the payload; then after my changes verdict re-routed the impl to me, I became the author and was still holding that review. I reported it blocked rather than approve my own work.
- did I ask for changes on someone else's work, or only approve? I asked for changes once (verdict=changes) — on my own prior code, in the self-review above. Found a genuine rule-8 duplicate-slug collision (`## Notes / ## Notes / ## Notes 1` -> two `notes-1`). Never issued verdict=approve, because every version put in front of me was one I had authored.
- did DevTeam ever run a check for me, or only record what I claimed? Only recorded claims. Every `node --test` check across both sessions failed in DevTeam's runner (`--allow-fs-read=` with no argument) and was recorded as an assertion. Codex hit the identical failure. Zero verified checks in the entire task.
- the one thing that would have saved the most time: same as session 1 — a working verified-check runner. The task is functionally complete and independently reviewed, and it still can't be marked done.




