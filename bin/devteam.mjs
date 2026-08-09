#!/usr/bin/env node
import { runDevTeamCli } from "../src/devteam/cli.mjs";

runDevTeamCli().catch((error) => {
  console.error(`DevTeam: ${error.message}`);
  process.exitCode = 1;
});
