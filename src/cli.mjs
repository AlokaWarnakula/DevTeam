import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  bridgeStatus,
  doctor,
  initProject,
  readState,
  runBridge,
  setTask,
  submitTask,
  watchBridge,
} from "./core.mjs";

const HELP = `Agent Bridge — local multi-agent development loop

Usage:
  bridge init [--project PATH]
  bridge doctor [--project PATH]
  bridge task "goal" [--file task.md] [--project PATH]
  bridge run ["goal"] [--file task.md] [--max-rounds N] [--allow-remote]
  bridge submit "goal" [--file task.md] [--project PATH]
  bridge watch [--project PATH] [--max-rounds N] [--allow-remote]
  bridge status [--project PATH]
  bridge read [--project PATH]

Typical use:
  bridge init
  bridge doctor
  bridge run "Implement the feature and review it"

Always-on use (terminal 1 / terminal 2):
  bridge watch
  bridge submit "Fix the failing authentication test"
`;

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [key, inline] = value.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--") && !["allow-remote", "help"].includes(key)) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return { positionals, flags };
}

async function getTaskText(positionals, flags) {
  if (flags.file) return readFile(path.resolve(String(flags.file)), "utf8");
  return positionals.join(" ").trim();
}

function printTurn({ round, agent, status, message }) {
  const firstLine = message.split(/\r?\n/).find(Boolean) || "";
  console.log(`[round ${round}] ${agent}: ${status} — ${firstLine.slice(0, 180)}`);
}

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals.shift() || "help";
  if (flags.help || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  const project = path.resolve(flags.project ? String(flags.project) : process.cwd());
  if (command === "init") {
    const result = await initProject(project);
    console.log(result.created.length ? `Initialized Agent Bridge. Created: ${result.created.join(", ")}` : "Agent Bridge is already initialized; nothing overwritten.");
    return;
  }
  if (command === "doctor") {
    const result = await doctor(project);
    console.log(`Project: ${result.project}\nNode: ${result.node}\nBridge writable: ${result.writable ? "yes" : "no"}`);
    for (const agent of result.agents) {
      const location = agent.resolved || `NOT FOUND (${agent.command})`;
      const probe = agent.probe ? (agent.probe.ok ? ` — runnable${agent.probe.detail ? ` (${agent.probe.detail})` : ""}` : ` — NOT RUNNABLE (${agent.probe.detail})`) : "";
      console.log(`${agent.enabled ? "[enabled]" : "[disabled]"} ${agent.name}: ${location}${probe}`);
    }
    return;
  }
  if (command === "task") {
    const text = await getTaskText(positionals, flags);
    const result = await setTask(project, text);
    console.log(`Task ready.${result.archived ? ` Previous run archived at ${result.archived}` : ""}`);
    return;
  }
  if (command === "run") {
    const text = await getTaskText(positionals, flags);
    if (text) await setTask(project, text);
    const result = await runBridge(project, {
      maxRounds: flags["max-rounds"],
      allowRemote: flags["allow-remote"] === true,
      onTurn: printTurn,
    });
    console.log(`Bridge finished: ${result.status}. Approvals: ${result.approvals.join(", ") || "none"}.`);
    if (result.status !== "accepted") process.exitCode = 2;
    return;
  }
  if (command === "submit") {
    const text = await getTaskText(positionals, flags);
    const file = await submitTask(project, text);
    console.log(`Queued: ${file}`);
    return;
  }
  if (command === "watch") {
    await watchBridge(project, {
      maxRounds: flags["max-rounds"],
      allowRemote: flags["allow-remote"] === true,
      onReady: (inbox) => console.log(`Watching ${inbox}. Press Ctrl+C to stop.`),
      onTask: (name, task) => console.log(`Starting ${name}: ${task}`),
      onTurn: printTurn,
      onResult: (name, result) => console.log(`Finished ${name}: ${result.status}`),
    });
    console.log("Watcher stopped.");
    return;
  }
  if (command === "status") {
    const result = await bridgeStatus(project);
    console.log(`Project: ${result.project}\nQueued: ${result.queued}\nWatcher: ${result.watcher?.alive ? `running (PID ${result.watcher.pid})` : "stopped"}\nRun: ${result.run?.alive ? `running (PID ${result.run.pid})` : "idle"}\n\n${result.final}`);
    return;
  }
  if (command === "read") {
    const state = await readState(project);
    console.log(`${state.task}\n--- DISCUSSION ---\n${state.connection}\n--- FINAL ---\n${state.final}`);
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
