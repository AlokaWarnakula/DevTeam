import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDevTeamCli, skillStatus, packagedSkillDir } from "../src/devteam/cli.mjs";

test("sync-skill copies the packaged skill into a destination folder", async (t) => {
  const dest = await mkdtemp(path.join(os.tmpdir(), "devteam-skill-"));
  t.after(async () => { await rm(dest, { recursive: true, force: true }); });

  await runDevTeamCli(["sync-skill", "--dest", dest]);

  const copied = await readFile(path.join(dest, "SKILL.md"), "utf8");
  const source = await readFile(path.join(packagedSkillDir(), "SKILL.md"), "utf8");
  assert.equal(copied, source, "the destination skill matches the packaged source");
  assert.match(copied, /## The nine verbs/, "the current nine-verb skill was copied, not a stale one");
});

test("skillStatus reports whether a source skill exists", () => {
  const status = skillStatus();
  assert.equal(status.source, true, "the packaged skill is present in this repo");
});
