import { spawn } from "node:child_process";

const safeValue = (value, label, { multiline = false } = {}) => {
  const text = String(value ?? "");
  if (!text || /\u0000/.test(text) || (!multiline && /[\r\n]/.test(text))) throw new Error(`${label} is invalid.`);
  return text;
};

export class GenericCommandRuntimeAdapter {
  constructor({ id = "generic-command", command, args = [], env = {} } = {}) {
    this.id = safeValue(id, "Adapter id");
    this.command = safeValue(command, "Managed command");
    if (!Array.isArray(args)) throw new Error("Managed command arguments must be an array.");
    this.args = args.map((value) => safeValue(value, "Managed argument"));
    this.env = Object.fromEntries(Object.entries(env).map(([key, value]) => [safeValue(key, "Environment key"), safeValue(value, "Environment value")]));
  }
  probe() { return { adapterId: this.id, command: this.command }; }
  normalizeCapabilities(raw) { return raw; }
  resolveProfile(requirement, capabilities) { return { requirement, capabilities }; }
  buildLaunchArgs(selection, taskInvite, context = {}) {
    const values = {
      "{model}": safeValue(selection.modelId, "Model id"),
      "{effort}": safeValue(selection.effortId, "Effort id"),
      "{invite}": safeValue(taskInvite, "Task invitation", { multiline: true }),
      "{project}": safeValue(context.projectRoot, "Project root"),
      "{mcpUrl}": safeValue(context.mcpUrl || "unknown", "MCP URL"),
    };
    return this.args.map((arg) => Object.entries(values).reduce((result, [token, value]) => result.replaceAll(token, value), arg));
  }
  verifyCurrent(selection, profile) { return profile?.currentModel === selection.modelId && profile?.currentEffort === selection.effortId; }
}

export class CodexCliRuntimeAdapter extends GenericCommandRuntimeAdapter {
  constructor({ command = "codex" } = {}) {
    super({ id: "codex-cli", command, args: ["exec", "--ephemeral", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", "{project}", "--model", "{model}", "--config", "model_reasoning_effort=\"{effort}\"", "{invite}"] });
  }
}

export class ClaudeCliRuntimeAdapter extends GenericCommandRuntimeAdapter {
  constructor({ command = "claude", effortArgs = ["--effort", "{effort}"] } = {}) {
    if (!Array.isArray(effortArgs)) throw new Error("Claude effort arguments must be an array supplied by the host configuration.");
    super({ id: "claude-cli", command, args: ["-p", "--output-format", "text", "--permission-mode", "acceptEdits", "--model", "{model}", ...effortArgs, "{invite}"] });
  }
}

export class ManagedRuntimeSupervisor {
  constructor({ enabled = false, adapters = [], spawnProcess = spawn } = {}) {
    this.enabled = Boolean(enabled);
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    this.spawnProcess = spawnProcess;
    this.children = new Map();
  }
  adapter(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error("The requested managed runtime adapter is not configured.");
    return adapter;
  }
  async launch({ adapterId, selection, taskInvite, projectRoot, env = {} }) {
    if (!this.enabled) throw new Error("Managed runtime automation is disabled. Desktop mode remains available.");
    const adapter = this.adapter(adapterId);
    const args = adapter.buildLaunchArgs(selection, taskInvite, { projectRoot });
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new Error("Managed adapters must return an argument array.");
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(adapter.command, args, {
        cwd: projectRoot, env: { ...process.env, ...adapter.env, ...env }, shell: false, windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      child.once("error", (error) => { if (!settled) { settled = true; reject(error); } });
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        this.children.set(child.pid, child);
        child.once("exit", () => this.children.delete(child.pid));
        resolve({ launched: true, pid: child.pid, adapterId, command: adapter.command, args });
      });
    });
  }
  stopAll() {
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }
}
