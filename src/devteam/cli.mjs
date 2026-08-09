import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DevTeamStore } from "./store.mjs";
import { startDevTeamServer } from "./server.mjs";

export const defaultDataDir = () => process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "DevTeam")
  : path.join(os.homedir(), ".devteam");

// The canonical skill shipped with this package. Any MCP-capable agent loads its own
// copy of a skill from its own skills folder, so after you change the skill you re-copy
// it wherever that agent reads skills from. `sync-skill --dest <path>` does that copy for
// ANY agent — DevTeam does not assume which agents you use or where they live.
export const packagedSkillDir = () => path.resolve(import.meta.dirname, "../../skills/devteam");

const readIfExists = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

export function skillStatus() {
  const dir = packagedSkillDir();
  return { source: Boolean(readIfExists(path.join(dir, "SKILL.md"))), skillDir: dir };
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

const help = `DevTeam — local AI development team portal

Usage:
  devteam start [--port 7331] [--workspace PATH] [--data-dir PATH] [--open]
  devteam doctor [--data-dir PATH]
  devteam token [--data-dir PATH]
  devteam sync-skill --dest PATH     Copy the current skill into a folder your AI agent
                                     reads skills from. Works for any agent. Re-run after
                                     you change the skill so it does not run a stale copy.
`;

export async function runDevTeamCli(args = process.argv.slice(2)) {
  const command = args[0] || "start";
  const dataDir = path.resolve(option(args, "--data-dir", defaultDataDir()));
  if (["help", "--help", "-h"].includes(command)) return console.log(help);

  if (command === "doctor") {
    const packagePath = path.resolve(import.meta.dirname, "../../package.json");
    const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
    const report = {
      node: process.version,
      nodeSupported: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13),
      package: existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")).version : "unknown",
      dataDir,
      workspace: process.cwd(),
      skillDir: packagedSkillDir(),
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.nodeSupported) process.exitCode = 1;
    return;
  }

  if (command === "sync-skill") {
    const source = packagedSkillDir();
    if (!existsSync(path.join(source, "SKILL.md"))) throw new Error(`Cannot find the packaged skill at ${source}.`);
    const destArg = option(args, "--dest", null);
    if (!destArg) throw new Error("sync-skill needs --dest <path>: the folder your AI agent reads skills from (e.g. a 'devteam' folder inside its skills directory).");
    const dest = path.resolve(destArg);
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, { recursive: true });
    console.log(`Copied the DevTeam skill:\n  from ${source}\n  to   ${dest}`);
    console.log("Start a new session in that agent so it reloads the skill.");
    return;
  }

  if (command === "token") {
    const store = new DevTeamStore(dataDir);
    console.log(store.token);
    store.close();
    return;
  }

  if (command !== "start") throw new Error(`Unknown command: ${command}\n\n${help}`);
  const host = option(args, "--host", "127.0.0.1");
  const port = Number(option(args, "--port", "7331"));
  const workspaceRoot = path.resolve(option(args, "--workspace", process.cwd()));
  const instance = await startDevTeamServer({ host, port, dataDir, workspaceRoot });
  console.log(`\n  DevTeam is ready: ${instance.url}`);
  console.log(`  MCP endpoint:     ${instance.mcpUrl}`);
  console.log(`  Bearer token:     ${instance.store.token}`);
  console.log("\n  Keep this window open while agents are connected. Press Ctrl+C to stop.\n");
  if (args.includes("--open")) openBrowser(instance.url);

  const shutdown = async () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
