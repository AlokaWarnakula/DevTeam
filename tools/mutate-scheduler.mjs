// Mutation testing for the scheduling core. Breaks one scheduler rule at a time and confirms the
// property suite catches it. A mutant that survives means the corresponding invariant is decorative
// rather than load-bearing.
//
// Run from the repo root:  node tools/mutate-scheduler.mjs
//
// It edits src/devteam/store.mjs in place and restores it afterwards, printing whether the restore
// was byte-identical. Do not run it with uncommitted changes to store.mjs you care about.
//
// Expected today: 12 caught, 1 equivalent (M9 - pending_write.id != a.id is implied by the
// creation-order rule, so removing it changes no behavior).
//
// Exit code: 0 when every behavioural mutant was caught. A surviving mutant, or an anchor that no
// longer matches the code it was written against, exits 1 — both mean this tool is no longer
// testing what it claims to. Mutants marked `equivalent` are exempt, and only those.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const STORE = "src/devteam/store.mjs";
const original = readFileSync(STORE, "utf8");
// Anchors are multi-line, so they only match a checkout whose line endings they share. This file
// previously assumed CRLF, which meant every multi-line anchor silently matched nothing on any LF
// checkout — Linux, CI, or `core.autocrlf=false` — and reported nine mutants as SETUP ERROR. That
// reads as a coverage collapse rather than an environment difference, which is the worst way for a
// safety tool to fail. Detect what this working copy actually uses and rewrite the anchors to match,
// so the tool is correct on either.
const EOL = original.includes("\r\n") ? "\r\n" : "\n";
const eol = (text) => text.replace(/\r\n/g, "\n").replace(/\n/g, EOL);

const MUTANTS = [
  {
    name: "M1  whyNotClaimable always says claimable",
    from: "      claimable: reasons.every((reason) => !reason.blocking),",
    to: "      claimable: true,",
  },
  {
    name: "M2  whyNotClaimable always says not claimable",
    from: "      claimable: reasons.every((reason) => !reason.blocking),",
    to: "      claimable: false,",
  },
  {
    name: "M3  dependency predicate removed",
    from: `        code: "dependency_pending",
        sql: \`NOT EXISTS (
            SELECT 1 FROM assignment_dependencies dependency_link
            JOIN assignments dependency ON dependency.id = dependency_link.depends_on_assignment_id
            WHERE dependency_link.assignment_id = a.id AND dependency.status != 'done'
          )\`,`,
    to: `        code: "dependency_pending",
        sql: \`1 = 1\`,`,
  },
  {
    name: "M4  review gate removed",
    from: `        code: "awaiting_writer",
        sql: \`(
            a.verifies = 0 OR NOT EXISTS (
              SELECT 1 FROM assignments pending_write WHERE \${BLOCKING_WRITER_CONDITIONS}
            )
          )\`,`,
    to: `        code: "awaiting_writer",
        sql: "1 = 1",`,
  },
  {
    name: "M5  targeting predicate removed",
    from: `        code: "targeted_elsewhere",
        sql: \`(
            a.target_agent_name IS NULL
            OR lower(a.target_agent_name) = lower(?)
            OR NOT EXISTS (
              SELECT 1 FROM agents present
              WHERE lower(present.name) = lower(a.target_agent_name) AND present.status != 'disconnected'
            )
          )\`,`,
    to: `        code: "targeted_elsewhere",
        sql: \`(? IS NOT NULL)\`,`,
  },
  {
    name: "M6  candidate window shrunk to 1 (no paging)",
    from: "const CANDIDATE_PAGE_SIZE = 20;\nconst CANDIDATE_SCAN_CEILING = 500;",
    to: "const CANDIDATE_PAGE_SIZE = 1;\nconst CANDIDATE_SCAN_CEILING = 1;",
  },
  {
    name: "M7  write-lease conflict skip removed",
    from: "          if (conflict) continue;",
    to: "          if (false) continue;",
  },
  {
    name: "M8  task version always bumps",
    from: "      if (cleanChanged.length) {",
    to: "      if (true) {",
  },
  {
    name: "M9  F8 revert (self-blocking verifier)",
    from: "                AND pending_write.id != a.id\n",
    to: "",
    // Equivalent, not a gap: an assignment cannot be a pending writer blocking *itself*, because the
    // creation-order rule already excludes it. Removing the clause changes no behaviour, so no test
    // can catch it. Recorded here so the exit code means something; see ROADMAP.md T4.5.
    equivalent: true,
  },
  {
    name: "M10 F9 revert (absent-target fallback)",
    from: `            OR NOT EXISTS (
              SELECT 1 FROM agents present
              WHERE lower(present.name) = lower(a.target_agent_name) AND present.status != 'disconnected'
            )
`,
    to: "",
  },
  {
    name: "M11 deadlock fix revert (unready writers gate again)",
    from: `                AND NOT EXISTS (
                  SELECT 1 FROM assignment_dependencies blocking_link
                  JOIN assignments blocking ON blocking.id = blocking_link.depends_on_assignment_id
                  WHERE blocking_link.assignment_id = pending_write.id AND blocking.status != 'done'
                )
`,
    to: "",
  },
  {
    name: "M12 verifier creation-order tiebreak removed",
    from: `                AND (
                  pending_write.verifies = 0
                  OR pending_write.created_at < a.created_at
                  OR (pending_write.created_at = a.created_at AND pending_write.id < a.id)
                )`,
    to: "",
  },
  {
    name: "M13 reaper skew restored (explanation skips the reaper)",
    from: `    if (agentId && refreshLiveness) {
      this._reapStaleAgents();
      this._recoverOrphanedClaims();
    }`,
    to: "",
  },
];

let survived = 0;
let setupErrors = 0;
let unexpectedlyCaught = 0;
for (const mutant of MUTANTS) {
  const anchor = eol(mutant.from);
  const hits = original.split(anchor).length - 1;
  if (hits !== 1) {
    console.log(`${mutant.name.padEnd(52)} SETUP ERROR (anchor matched ${hits})`);
    setupErrors += 1;
    continue;
  }
  writeFileSync(STORE, original.replace(anchor, eol(mutant.to)));
  const run = spawnSync(process.execPath, ["--test", "test/devteam-scheduler-properties.test.mjs", "test/devteam-scheduler-explain.test.mjs"], {
    encoding: "utf8", maxBuffer: 40 * 1024 * 1024,
  });
  writeFileSync(STORE, original);
  const output = `${run.stdout}${run.stderr}`;
  const fail = Number(/ℹ fail (\d+)/.exec(output)?.[1] ?? -1);
  const caught = fail > 0;
  // An equivalent mutant changes no behaviour, so no test can catch it and its survival is not a
  // coverage gap. Naming it here rather than in prose is what lets this tool have a meaningful exit
  // code: a survivor is a real finding again, and a scheduled run can fail on one. If an equivalent
  // mutant is ever *caught*, the suite has learned to tell two identical behaviours apart — worth
  // printing, never worth failing on.
  if (!caught && !mutant.equivalent) survived += 1;
  if (caught && mutant.equivalent) unexpectedlyCaught += 1;
  const verdict = caught
    ? `CAUGHT (${fail} seeds)`
    : (mutant.equivalent ? "EQUIVALENT (expected, no behaviour to catch)" : "SURVIVED");
  const why = /AssertionError[^\n]*: ([^\n]{0,90})/.exec(output.replace(/\[scheduler property failure[^\]]*\]\n?/g, ""))?.[1] || "";
  console.log(`${mutant.name.padEnd(52)} ${verdict}  ${caught ? why.trim().slice(0, 70) : ""}`);
}

console.log(`\nline endings: ${EOL === "\r\n" ? "CRLF" : "LF"} (anchors matched to this working copy)`);
console.log(`restored byte-identical: ${readFileSync(STORE, "utf8") === original}`);
if (unexpectedlyCaught) console.log(`${unexpectedlyCaught} mutant(s) marked equivalent were caught — the suite got stronger.`);
if (setupErrors) console.log(`\n${setupErrors} ANCHOR(S) NO LONGER MATCH — a mutant is testing nothing. Repoint it at the current code.`);
console.log(survived ? `\n${survived} MUTANT(S) SURVIVED` : "\nevery behavioural mutant was caught");
process.exit(survived || setupErrors ? 1 : 0);
