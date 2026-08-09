import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const BRIDGE_DIR = "bridge";
const CONFIG_FILE = "bridge.config.json";
const RESPONSE_START = "<<<BRIDGE_RESPONSE>>>";
const RESPONSE_END = "<<<END_BRIDGE_RESPONSE>>>";

export const DEFAULT_CONFIG = {
  version: 1,
  minAgents: 2,
  maxRounds: 6,
  turnTimeoutMs: 900000,
  pollMs: 1000,
  allowRemoteActions: false,
  agents: [
    {
      name: "Codex",
      role: "implementer and reviewer",
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "-C",
        "{project}",
        "-",
      ],
      input: "stdin",
      enabled: true,
    },
    {
      name: "Claude",
      role: "critical reviewer and fixer",
      command: "claude",
      args: ["-p", "--output-format", "text", "--permission-mode", "acceptEdits"],
      input: "stdin",
      enabled: true,
    },
    {
      name: "Gemini",
      role: "independent reviewer",
      command: "gemini",
      args: ["-p", "{prompt}"],
      input: "argument",
      enabled: false,
    },
  ],
};

function pathsFor(project) {
  const root = path.resolve(project);
  const bridge = path.join(root, BRIDGE_DIR);
  return {
    root,
    bridge,
    config: path.join(root, CONFIG_FILE),
    task: path.join(bridge, "task.md"),
    connection: path.join(bridge, "connection.md"),
    final: path.join(bridge, "final.md"),
    inbox: path.join(bridge, "inbox"),
    processed: path.join(bridge, "processed"),
    archive: path.join(bridge, "archive"),
    runLock: path.join(bridge, ".run.lock"),
    watchLock: path.join(bridge, ".watch.lock"),
  };
}

const TASK_TEMPLATE = `# Task\n\ngoal: <describe the task>\n\ndone when:\n- [ ] result is implemented or decided\n- [ ] relevant checks pass\n\nconstraints: remote actions require explicit permission\nstatus: waiting\n`;
const CONNECTION_TEMPLATE = `# Agent discussion\n\n<!-- Managed by Agent Bridge. Agents must not edit this file directly. -->\n`;
const FINAL_TEMPLATE = `# Final\n\nstatus: not-started\nsummary:\nchecks:\napproved-by:\n`;

async function writeIfMissing(file, content) {
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function initProject(project) {
  const p = pathsFor(project);
  await mkdir(p.bridge, { recursive: true });
  await mkdir(p.inbox, { recursive: true });
  await mkdir(p.processed, { recursive: true });
  await mkdir(p.archive, { recursive: true });
  const created = [];
  if (await writeIfMissing(p.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)) created.push(CONFIG_FILE);
  if (await writeIfMissing(p.task, TASK_TEMPLATE)) created.push("bridge/task.md");
  if (await writeIfMissing(p.connection, CONNECTION_TEMPLATE)) created.push("bridge/connection.md");
  if (await writeIfMissing(p.final, FINAL_TEMPLATE)) created.push("bridge/final.md");
  return { paths: p, created };
}

export async function loadConfig(project) {
  const p = pathsFor(project);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(p.config, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Missing ${CONFIG_FILE}; run bridge init first.`);
    throw new Error(`Invalid ${CONFIG_FILE}: ${error.message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
    throw new Error(`${CONFIG_FILE} must have version 1 and an agents array.`);
  }
  return { ...DEFAULT_CONFIG, ...parsed, agents: parsed.agents };
}

export async function readState(project) {
  const p = pathsFor(project);
  const [task, connection, final] = await Promise.all([
    readFile(p.task, "utf8"),
    readFile(p.connection, "utf8"),
    readFile(p.final, "utf8"),
  ]);
  return { task, connection, final, paths: p };
}

function timestampForPath() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function archiveCurrent(p) {
  const current = await readState(p.root);
  const hasWork = !current.task.includes("<describe the task>") || current.connection.includes("### ");
  if (!hasWork) return null;
  const destination = path.join(p.archive, timestampForPath());
  await mkdir(destination, { recursive: true });
  await Promise.all([
    copyFile(p.task, path.join(destination, "task.md")),
    copyFile(p.connection, path.join(destination, "connection.md")),
    copyFile(p.final, path.join(destination, "final.md")),
  ]);
  return destination;
}

export async function setTask(project, goal) {
  const clean = goal.trim();
  if (!clean) throw new Error("Task text cannot be empty.");
  const { paths: p } = await initProject(project);
  const archived = await archiveCurrent(p);
  const task = `# Task\n\ngoal: ${clean}\n\ndone when:\n- [ ] requested outcome is complete\n- [ ] relevant checks have been run\n- [ ] every active agent agrees, or a blocker is recorded\n\nconstraints: no push, PR, deploy, or destructive action unless explicitly authorized\nstatus: active\n`;
  await Promise.all([
    writeFile(p.task, task, "utf8"),
    writeFile(p.connection, `# ${clean}\n\n<!-- Managed by Agent Bridge. Agents must not edit this file directly. -->\n`, "utf8"),
    writeFile(p.final, FINAL_TEMPLATE, "utf8"),
  ]);
  return { archived, paths: p };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function acquireLock(file, label) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(file, "wx");
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number.parseInt((await readFile(file, "utf8").catch(() => "")).split(/\r?\n/)[0], 10);
    if (isPidAlive(pid)) throw new Error(`Another ${label} is active (PID ${pid}).`);
    await rm(file, { force: true });
    return acquireLock(file, label);
  }
  return async () => rm(file, { force: true });
}

function executableCandidates(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return [command];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const hasExtension = path.extname(command) !== "";
  return dirs.flatMap((dir) => (hasExtension ? [path.join(dir, command)] : extensions.map((ext) => path.join(dir, `${command}${ext.toLowerCase()}`))));
}

export async function resolveCommand(command) {
  for (const candidate of executableCandidates(command)) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function applyTemplate(value, replacements) {
  return value.replace(/\{(project|prompt|agent)\}/g, (_, key) => replacements[key]);
}

function quoteForCmd(value) {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

async function spawnCaptured(command, args, options) {
  const isCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const actualCommand = isCmdShim ? (process.env.ComSpec || "cmd.exe") : command;
  const actualArgs = isCmdShim ? ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(actualCommand, actualArgs, {
      cwd: options.cwd,
      env: { ...process.env, BRIDGE_AGENT_NAME: options.agentName },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const limit = 4 * 1024 * 1024;
    const collect = (target, chunk) => (target + chunk.toString("utf8")).slice(-limit);
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(options.stdin || "");
  });
}

export function buildPrompt({ agent, task, connection, project, allowRemoteActions }) {
  return `You are ${agent.name}, acting as the ${agent.role || "collaborating engineer"} in a local multi-agent development team.\n\n` +
    `Project: ${project}\n\nTASK\n${task}\n\nDISCUSSION SO FAR\n${connection}\n\n` +
    `Work on the actual project now. Inspect current files because another agent may have changed them. You may implement, test, review, or assign a clearly bounded next action to another named agent. ` +
    `Do not edit anything inside the bridge/ directory or bridge.config.json; the orchestrator owns those files. ` +
    `${allowRemoteActions ? "The user has authorized remote git actions for this run, but still avoid destructive operations." : "Do not push, open a PR, deploy, publish, or perform destructive/irreversible actions."}\n\n` +
    `Return exactly one response envelope and no text outside it:\n${RESPONSE_START}\n` +
    `{"status":"continue|done|blocked","message":"Concise Markdown: work performed, files/checks, findings, and the next action or reason it is done/blocked."}\n${RESPONSE_END}\n\n` +
    `Use status=continue when more implementation or review is needed. Use status=done only after inspecting the current result and believing the task and checks are complete. Use status=blocked only when human input or authorization is genuinely required.`;
}

export function parseAgentResponse(output) {
  const start = output.lastIndexOf(RESPONSE_START);
  const end = output.indexOf(RESPONSE_END, start + RESPONSE_START.length);
  if (start >= 0 && end > start) {
    const raw = output.slice(start + RESPONSE_START.length, end).trim();
    try {
      const parsed = JSON.parse(raw);
      if (["continue", "done", "blocked"].includes(parsed.status) && typeof parsed.message === "string") return parsed;
    } catch {
      // Fall through to a safe unstructured response.
    }
  }
  return {
    status: "continue",
    message: `Agent returned an unstructured response; treating it as work in progress.\n\n${output.trim() || "(no output)"}`,
  };
}

async function appendMessage(file, agent, response) {
  const block = `\n### ${agent.name} · ${new Date().toISOString()} · ${response.status}\n${response.message.trim()}\n`;
  await writeFile(file, block, { encoding: "utf8", flag: "a" });
}

async function invokeAgent({ agent, prompt, project, timeoutMs }) {
  const executable = await resolveCommand(agent.command);
  if (!executable) throw new Error(`Command not found: ${agent.command}`);
  const replacements = { project, prompt, agent: agent.name };
  const args = (agent.args || []).map((arg) => applyTemplate(arg, replacements));
  const stdin = agent.input === "stdin" ? prompt : "";
  const result = await spawnCaptured(executable, args, { cwd: project, stdin, timeoutMs, agentName: agent.name });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-4000);
    throw new Error(`${agent.name} exited with ${result.code ?? result.signal}: ${detail || "no diagnostic output"}`);
  }
  return parseAgentResponse(result.stdout);
}

async function preserveManagedFiles(p, snapshots) {
  const restored = [];
  for (const [file, before] of snapshots) {
    const after = await readFile(file, "utf8").catch(() => null);
    if (after !== before) {
      await writeFile(file, before, "utf8");
      restored.push(path.relative(p.root, file));
    }
  }
  return restored;
}

async function workspaceFingerprint(project) {
  const hash = createHash("sha256");
  const ignoredDirectories = new Set([".git", ".agent-bridge", "bridge", "node_modules"]);
  async function walk(directory, relative = "") {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(path.join(directory, entry.name), rel);
        continue;
      }
      if (!entry.isFile() || rel === CONFIG_FILE) continue;
      try {
        const info = await stat(path.join(directory, entry.name));
        hash.update(`${rel}\0${info.size}\0${info.mtimeMs}\n`);
      } catch {
        hash.update(`${rel}\0missing\n`);
      }
    }
  }
  await walk(project);
  return hash.digest("hex");
}

function finalText(status, summary, approvals, checks = "See agent discussion.") {
  return `# Final\n\nstatus: ${status}\nsummary: ${summary}\nchecks: ${checks}\napproved-by: ${approvals.join(", ") || "none"}\n`;
}

export async function runBridge(project, options = {}) {
  const { paths: p } = await initProject(project);
  const release = await acquireLock(p.runLock, "bridge run");
  try {
    const config = await loadConfig(project);
    const agents = [];
    const missing = [];
    for (const agent of config.agents.filter((item) => item.enabled !== false)) {
      if (await resolveCommand(agent.command)) agents.push(agent);
      else missing.push(agent.name);
    }
    const minAgents = Number(config.minAgents) || 2;
    if (agents.length < minAgents) {
      throw new Error(`Need at least ${minAgents} available agents; found ${agents.length}. Missing: ${missing.join(", ") || "none"}. Run bridge doctor.`);
    }
    const initial = await readState(project);
    if (initial.task.includes("<describe the task>")) throw new Error("No active task. Use bridge task \"...\" or bridge run \"...\".");
    const approvals = new Set();
    const failures = new Map();
    const maxRounds = Number(options.maxRounds || config.maxRounds) || 6;
    const allowRemoteActions = options.allowRemote === true || config.allowRemoteActions === true;
    for (let round = 1; round <= maxRounds; round += 1) {
      for (const agent of agents) {
        const state = await readState(project);
        const prompt = buildPrompt({ agent, task: state.task, connection: state.connection, project: p.root, allowRemoteActions });
        const snapshots = new Map([
          [p.task, state.task],
          [p.connection, state.connection],
          [p.final, state.final],
          [p.config, await readFile(p.config, "utf8")],
        ]);
        const workspaceBefore = await workspaceFingerprint(p.root);
        let response;
        try {
          response = await invokeAgent({ agent, prompt, project: p.root, timeoutMs: Number(config.turnTimeoutMs) || 900000 });
          failures.delete(agent.name);
        } catch (error) {
          const count = (failures.get(agent.name) || 0) + 1;
          failures.set(agent.name, count);
          approvals.clear();
          response = { status: count >= 2 ? "blocked" : "continue", message: `Agent invocation failed (${count}): ${error.message}` };
        }
        const restored = await preserveManagedFiles(p, snapshots);
        const workspaceChanged = (await workspaceFingerprint(p.root)) !== workspaceBefore;
        if (restored.length) response.message += `\n\nSafety note: restored orchestrator-managed files changed by the agent: ${restored.join(", ")}.`;
        await appendMessage(p.connection, agent, response);
        options.onTurn?.({ round, agent: agent.name, status: response.status, message: response.message });
        if (response.status === "blocked") {
          await writeFile(p.final, finalText("blocked", response.message.replaceAll("\n", " "), [...approvals]), "utf8");
          return { status: "blocked", rounds: round, approvals: [...approvals], missing };
        }
        if (workspaceChanged) approvals.clear();
        if (response.status === "done") approvals.add(agent.name);
        else approvals.clear();
        if (approvals.size === agents.length) {
          const summary = `All active agents agreed the task is complete after ${round} round(s).`;
          await writeFile(p.final, finalText("accepted", summary, [...approvals]), "utf8");
          return { status: "accepted", rounds: round, approvals: [...approvals], missing };
        }
      }
    }
    const summary = `No consensus after ${maxRounds} rounds; human review is required.`;
    await writeFile(p.final, finalText("needs-human", summary, [...approvals]), "utf8");
    return { status: "needs-human", rounds: maxRounds, approvals: [...approvals], missing };
  } finally {
    await release();
  }
}

export async function submitTask(project, task) {
  const { paths: p } = await initProject(project);
  const clean = task.trim();
  if (!clean) throw new Error("Task text cannot be empty.");
  const name = `${timestampForPath()}-${Math.random().toString(36).slice(2, 8)}.md`;
  const file = path.join(p.inbox, name);
  await writeFile(file, `${clean}\n`, { encoding: "utf8", flag: "wx" });
  return file;
}

export async function queuedTasks(project) {
  const p = pathsFor(project);
  await mkdir(p.inbox, { recursive: true });
  return (await readdir(p.inbox)).filter((name) => name.endsWith(".md")).sort();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function watchBridge(project, options = {}) {
  const { paths: p } = await initProject(project);
  const config = await loadConfig(project);
  const release = await acquireLock(p.watchLock, "bridge watcher");
  let stopped = false;
  const stop = () => { stopped = true; };
  const abort = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (options.signal?.aborted) stopped = true;
  options.signal?.addEventListener("abort", abort, { once: true });
  options.onReady?.(p.inbox);
  try {
    while (!stopped) {
      const queue = await queuedTasks(project);
      if (!queue.length) {
        await delay(Number(config.pollMs) || 1000);
        continue;
      }
      for (const name of queue) {
        if (stopped) break;
        const source = path.join(p.inbox, name);
        const task = await readFile(source, "utf8");
        await setTask(project, task);
        options.onTask?.(name, task.trim());
        let result;
        try {
          result = await runBridge(project, options);
        } catch (error) {
          result = { status: "failed", error: error.message };
          await writeFile(p.final, finalText("failed", error.message, []), "utf8");
        }
        const destination = path.join(p.processed, `${path.basename(name, ".md")}.${result.status}.md`);
        await rename(source, destination);
        options.onResult?.(name, result);
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", abort);
    await release();
  }
}

export async function doctor(project) {
  const { paths: p } = await initProject(project);
  const config = await loadConfig(project);
  const agents = [];
  for (const agent of config.agents) {
    const resolved = await resolveCommand(agent.command);
    let probe = null;
    if (resolved) {
      try {
        const result = await spawnCaptured(resolved, agent.probeArgs || ["--version"], {
          cwd: p.root,
          stdin: "",
          timeoutMs: 10000,
          agentName: agent.name,
        });
        probe = result.code === 0
          ? { ok: true, detail: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] }
          : { ok: false, detail: (result.stderr || result.stdout).trim().slice(-500) || `exit ${result.code}` };
      } catch (error) {
        probe = { ok: false, detail: error.message };
      }
    }
    agents.push({ name: agent.name, enabled: agent.enabled !== false, command: agent.command, resolved, probe });
  }
  let writable = true;
  const probe = path.join(p.bridge, `.write-probe-${process.pid}`);
  try {
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });
  } catch {
    writable = false;
  }
  return { project: p.root, node: process.version, writable, agents };
}

export async function bridgeStatus(project) {
  const { paths: p } = await initProject(project);
  const state = await readState(project);
  const queue = await queuedTasks(project);
  const lockInfo = async (file) => {
    try {
      const value = await readFile(file, "utf8");
      const pid = Number.parseInt(value.split(/\r?\n/)[0], 10);
      return { pid, alive: isPidAlive(pid) };
    } catch {
      return null;
    }
  };
  return {
    project: p.root,
    task: state.task,
    final: state.final,
    queued: queue.length,
    run: await lockInfo(p.runLock),
    watcher: await lockInfo(p.watchLock),
  };
}

export { pathsFor };
