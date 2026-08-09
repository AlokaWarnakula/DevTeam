#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(`bridge: ${error.message}`);
  if (process.env.BRIDGE_DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
