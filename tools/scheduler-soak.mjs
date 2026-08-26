#!/usr/bin/env node
// T4.5 — the nightly soak the roadmap asks for, as a script rather than a promise.
//
// The committed property suite runs 24 enumerated seeds because it has to finish in a normal test
// run. That is enough to catch a reproducible deadlock and not enough to find a rare one: six
// hand-picked seeds once passed while four of the next eight deadlocked, which is exactly why the
// committed seeds are enumerated rather than chosen.
//
// This runs a much larger, *randomised* span on a bigger board. It is deliberately not part of
// `node --test`: a nightly job that occasionally takes ten minutes is useful, and a test suite that
// occasionally takes ten minutes gets skipped.
//
//   node tools/scheduler-soak.mjs                 # 200 seeds from a random offset
//   node tools/scheduler-soak.mjs --seeds 1000    # longer
//   node tools/scheduler-soak.mjs --from 5000     # reproduce a reported failure exactly
//
// A failure prints the offending seed. Put that seed in SEEDS in the property suite and it becomes a
// permanent regression test — that is the whole workflow this script exists to feed.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
};

const total = Math.max(1, argument("--seeds", 200));
const from = argument("--from", Math.floor(Math.random() * 100_000) + 1);
const batch = Math.max(1, argument("--batch", 24));

console.log(`Scheduler soak: seeds ${from}..${from + total - 1} (${total} boards), batches of ${batch}.`);
console.log("A failure names the seed. Add it to SEEDS in test/devteam-scheduler-properties.test.mjs.\n");

const startedAt = Date.now();
let failures = 0;
for (let offset = 0; offset < total; offset += batch) {
  const first = from + offset;
  const count = Math.min(batch, total - offset);
  const result = spawnSync(process.execPath, ["--test", "test/devteam-scheduler-properties.test.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEVTEAM_SOAK_FROM: String(first), DEVTEAM_SOAK_COUNT: String(count) },
    timeout: 30 * 60_000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const failed = result.status !== 0;
  if (failed) {
    failures += 1;
    console.error(`FAIL seeds ${first}..${first + count - 1}`);
    // Only the part that names what broke; the full run is thousands of lines.
    for (const line of output.split("\n")) {
      if (/seed=|AssertionError|never drained|deadlock|Still open/.test(line)) console.error(`  ${line.trim()}`);
    }
  } else {
    process.stdout.write(`ok ${first}..${first + count - 1}\n`);
  }
}

const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
console.log(`\n${failures ? `${failures} batch(es) FAILED` : "All batches passed"} — ${total} boards in ${minutes} min.`);
process.exitCode = failures ? 1 : 0;
