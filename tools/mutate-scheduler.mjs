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
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const STORE = "src/devteam/store.mjs";
const crlf = (text) => text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
const original = readFileSync(STORE, "utf8");

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
            lower(a.role) NOT IN (\${VERIFIER_ROLES.map(() => "?").join(", ")}) OR NOT EXISTS (
              SELECT 1 FROM assignments pending_write WHERE \${BLOCKING_WRITER_CONDITIONS}
            )
          )\`,`,
    to: `        code: "awaiting_writer",
        sql: \`(\${VERIFIER_ROLES.map(() => "? IS NOT NULL").join(" AND ")})\`,`,
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
                  lower(pending_write.role) NOT IN (\${VERIFIER_ROLE_LIST})
                  OR pending_write.created_at < a.created_at
                  OR (pending_write.created_at = a.created_at AND pending_write.id < a.id)
                )`,
    to: "",
  },
  {
    name: "M13 reaper skew restored (explanation skips the reaper)",
    from: `    if (agentId && refreshLiveness) {
      this.#reapStaleAgents();
      this.#recoverOrphanedClaims();
    }`,
    to: "",
  },
];

let survived = 0;
for (const mutant of MUTANTS) {
  const anchor = crlf(mutant.from);
  const hits = original.split(anchor).length - 1;
  if (hits !== 1) {
    console.log(`${mutant.name.padEnd(52)} SETUP ERROR (anchor matched ${hits})`);
    survived += 1;
    continue;
  }
  writeFileSync(STORE, original.replace(anchor, crlf(mutant.to)));
  const run = spawnSync(process.execPath, ["--test", "test/devteam-scheduler-properties.test.mjs", "test/devteam-scheduler-explain.test.mjs"], {
    encoding: "utf8", maxBuffer: 40 * 1024 * 1024,
  });
  writeFileSync(STORE, original);
  const output = `${run.stdout}${run.stderr}`;
  const fail = Number(/ℹ fail (\d+)/.exec(output)?.[1] ?? -1);
  const caught = fail > 0;
  if (!caught) survived += 1;
  const why = /AssertionError[^\n]*: ([^\n]{0,90})/.exec(output.replace(/\[scheduler property failure[^\]]*\]\n?/g, ""))?.[1] || "";
  console.log(`${mutant.name.padEnd(52)} ${caught ? `CAUGHT (${fail} seeds)` : "SURVIVED"}  ${caught ? why.trim().slice(0, 70) : ""}`);
}

console.log(`\nrestored byte-identical: ${readFileSync(STORE, "utf8") === original}`);
console.log(survived ? `\n${survived} MUTANT(S) SURVIVED` : "\nall mutants caught");
process.exit(survived ? 1 : 0);
