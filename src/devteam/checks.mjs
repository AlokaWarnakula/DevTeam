import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Reported checks used to be believed. `checks: ["node --test: 142/142"]` was recorded because an
// agent typed it, and approvals were then built on top of that permanently green record. A check may
// now carry a command, which DevTeam runs itself and grades by exit code.
//
// The security shape of this file is the whole point, so it is stated once, here:
//   * Agent text NEVER becomes a command. A reported command is only ever used to *select* an entry
//     from an allowlist the human configured for the project; the argv that reaches the OS comes
//     from that stored entry and nowhere else.
//   * There is no shell. spawn runs with shell:false and an argv array, so an argument is an
//     argument — it cannot become an operator, a redirection, a substitution, or a second command.
//   * The allowlist is a pinned snapshot, not a live read of package.json. An agent with write
//     access to the repo can edit a script body; if the allowlist were derived on demand, editing
//     package.json would be arbitrary code execution. Enabling verification snapshots the scripts
//     as explicit argv, and later edits to package.json change nothing until a human re-enables it.
//   * Nothing runs unless a human enabled it. A project with an empty allowlist verifies nothing and
//     every check stays visibly agent-asserted.
//   * An allowlist entry may not itself be a way to run something else. Interpreters, package-manager
//     runners and code-loading flags are refused even when a human types them, because each of them
//     hands back exactly the shell this file exists to avoid — and because `npm run x` would resolve
//     the script body at execution time, defeating the snapshot.
//
// WHAT THIS DOES NOT PROTECT AGAINST, and no argv hygiene can:
//   Verification runs the project's own code, with cwd pinned to the project root, as the DevTeam
//   host user, OUTSIDE whatever sandbox the reporting agent itself runs under. `node --test` executes
//   the test files the agent just wrote. The pin protects *which argv* runs; it cannot protect what
//   that argv reads off disk. Enabling verification for a project therefore grants every agent
//   working in that project unsandboxed code execution on the host, at a moment of its choosing.
//   That is inherent to "run the repo's checks" and is the reason enabling it is a human decision.
//   The child's environment is scrubbed of secret-looking variables (below), which narrows the blast
//   radius but does not change the conclusion.
//
//   A project may opt into sandboxing, which confines a `node` check with Node's own permission
//   model: it can then read and write only the project root and the temp directory, so a test file
//   an agent wrote can no longer reach ~/.ssh or ~/.aws. Child processes stay allowed, because real
//   suites shell out (this project's own tests run git), so this narrows exfiltration rather than
//   closing execution. It applies to `node` only; anything else is refused rather than run
//   unconfined, so "sandboxed" never quietly means "not really".


export const CHECK_ARGV_LIMIT = 30;
export const CHECK_ARGUMENT_LIMIT = 200;
export const CHECK_ALLOWLIST_LIMIT = 40;
export const CHECK_OUTPUT_LIMIT = 4000;
export const VERIFIED_CHECKS_PER_REPORT = 10;
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
export const MAX_CHECK_TIMEOUT_MS = 600_000;
const CHECK_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

// Anything a shell would interpret. Nothing here is passed to a shell, so these characters could
// only ever arrive as literal argv — which is never what a script author meant by writing them.
// Refusing the script outright is honest: DevTeam cannot run it faithfully, so it does not pretend.
const SHELL_SYNTAX = /[&|;<>$`\\!*?()[\]{}'"~\n\r]/;

// Programs that exist to run something else. Allowing one as argv[0] gives back the shell, the
// network, or a live re-read of package.json — undoing shell:false and the snapshot in one step.
const INDIRECTION_PROGRAMS = new Set([
  "cmd", "command", "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh",
  "powershell", "pwsh", "wsl", "wsl.exe", "env", "xargs", "start", "nohup", "time", "sudo", "doas",
  "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "bunx", "corepack", "deno",
]);

// Flags that make a runtime load and execute code named on the command line rather than the
// project's own entry point. A reviewer skims past these; they are as powerful as a shell.
const CODE_LOADING_FLAGS = new Set([
  "-e", "--eval", "-p", "--print", "-r", "--require", "--import",
  "--loader", "--experimental-loader", "--experimental-network-imports",
]);

// Environment variables that look like credentials. The child is the project's own code, which may
// legitimately need most of the environment, but it has no business inheriting the operator's API
// keys just because DevTeam happens to hold them.
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i;

// The program must be a bare name resolved on PATH, and must not be an indirection. A path
// separator, a drive letter, or a relative walk would let a check point at an executable dropped
// anywhere on the machine.
function isSafeProgram(program) {
  if (!program || /[\\/:]/.test(program)) return false;
  if (program === "." || program === "..") return false;
  const base = program.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
  return !INDIRECTION_PROGRAMS.has(base);
}

// Every argument is held to the same standard as a script body, plus: no code-loading flags, and no
// ".." segment, so an argument cannot reach outside the pinned working directory.
function isSafeArgument(argument) {
  if (!argument || argument.length > CHECK_ARGUMENT_LIMIT) return false;
  if (SHELL_SYNTAX.test(argument)) return false;
  if (CODE_LOADING_FLAGS.has(argument.split("=")[0].toLowerCase())) return false;
  return !argument.split(/[\\/]/).includes("..");
}

export function isSafeCheckArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > CHECK_ARGV_LIMIT) return false;
  return isSafeProgram(argv[0]) && argv.slice(1).every(isSafeArgument);
}

// A package.json script body is usable only when it is one plain command: no operators, no
// redirection, no substitution, no globbing, and no quoting to reassemble arguments from.
export function parseScriptCommand(body) {
  const text = String(body ?? "").trim();
  if (!text || text.length > 400) return null;
  if (SHELL_SYNTAX.test(text)) return null;
  const argv = text.split(/\s+/).filter(Boolean);
  return isSafeCheckArgv(argv) ? argv : null;
}

// Validate one allowlist entry, whether it came from a package.json snapshot or from a human typing
// argv into the dashboard. A human-configured entry is still argv, never a command line — and it is
// held to the same rules, because the credential that reaches this endpoint is not strong enough to
// treat "a human sent it" as proof that a human considered it.
export function normalizeCheckCommand(entry) {
  const name = String(entry?.name ?? "").trim().slice(0, 80);
  const supplied = Array.isArray(entry?.argv) ? entry.argv : parseScriptCommand(entry?.command);
  if (!name || !Array.isArray(supplied)) return null;
  const argv = supplied.map((item) => String(item ?? "").trim());
  return isSafeCheckArgv(argv) ? { name, argv } : null;
}

// What the project's own package.json offers, for a human to review before enabling verification.
// Scripts DevTeam cannot run faithfully are simply absent rather than silently mangled.
export const CHECKS_CONFIG_PATH = path.join(".devteam", "checks.json");

// T1.3 — a project declares its own checks, with explicit argv, independent of package.json.
//
// Deriving the allowlist from package.json scripts assumes the project is a Node package. A research
// project, a data pipeline, a book, an infrastructure repo — none of them have one, so verification
// was simply unavailable and every check they reported stayed agent-asserted forever.
//
// The security rules are unchanged and deliberately so: each entry still goes through
// normalizeCheckCommand, so the program must be a bare executable name, interpreters and package
// runners are still refused, there is still no shell, and the human still has to enable it. This
// widens *what can be declared*, not what DevTeam is willing to run.
export function projectDeclaredCommands(projectRoot) {
  if (!projectRoot) return [];
  let parsed;
  try { parsed = JSON.parse(readFileSync(path.join(projectRoot, CHECKS_CONFIG_PATH), "utf8")); }
  catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.checks) ? parsed.checks : []);
  const commands = [];
  for (const candidate of list.slice(0, CHECK_ALLOWLIST_LIMIT)) {
    const entry = normalizeCheckCommand(candidate);
    if (entry) commands.push({ ...entry, source: "project" });
  }
  return commands;
}

// On Windows a locally installed tool is a `.cmd` shim, and spawn with shell:false cannot run it —
// every such check graded `unavailable` forever, which is the same as having no verification while
// looking like it works. Shelling out to run the shim would hand back the shell this whole file
// exists to avoid, so instead the shim is read *at snapshot time* and rewritten to run its real
// entry point under node directly.
//
// Resolution happens once, when a human enables verification, and the resolved argv is what gets
// pinned — so this cannot become a live re-read of node_modules any more than the package.json
// snapshot can.
export function resolveLocalBinary(projectRoot, argv) {
  if (!projectRoot || !Array.isArray(argv) || !argv.length) return argv;
  const [program, ...args] = argv;
  if (program === "node" || program.includes("/") || program.includes("\\")) return argv;
  const binDirectory = path.join(projectRoot, "node_modules", ".bin");
  for (const candidate of [`${program}.cmd`, `${program}.CMD`, program]) {
    const shim = path.join(binDirectory, candidate);
    let contents;
    try { contents = readFileSync(shim, "utf8"); } catch { continue; }
    if (contents.length > 64 * 1024) continue;
    // The entry point a Node shim points at, in either the .cmd or the shebang-script form: a
    // path-like token ending in a script extension. Bounded and anchored on a real extension, so
    // arbitrary text inside the shim cannot become a target. The leading `%dp0%` / `$basedir` the
    // shim uses to mean its own directory is stripped, because that directory is where we resolve
    // from — leaving it in would turn the path absolute and escape the project.
    const target = contents.match(/[^"'\s]*\.(?:c|m)?js\b/);
    if (!target) continue;
    const relativeTarget = target[0]
      .replace(/^%[^%]*%/, "")
      .replace(/^\$\{?[A-Za-z_]\w*\}?/, "")
      .split("\\").join("/")
      .replace(/^\/+/, "");
    if (!relativeTarget) continue;
    const resolved = path.resolve(binDirectory, relativeTarget);
    const relative = path.relative(projectRoot, resolved);
    // Never outside the project. A shim pointing elsewhere is not something to run on its say-so.
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try { if (!statSync(resolved).isFile()) continue; } catch { continue; }
    return ["node", relative.split(path.sep).join("/"), ...args];
  }
  return argv;
}

export function packageScriptCommands(projectRoot) {
  if (!projectRoot) return [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")); }
  catch { return []; }
  const scripts = manifest?.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const commands = [];
  for (const [name, body] of Object.entries(scripts)) {
    const entry = normalizeCheckCommand({ name, argv: parseScriptCommand(body) });
    if (entry) commands.push(entry);
  }
  return commands.slice(0, CHECK_ALLOWLIST_LIMIT);
}

// The ways an agent might reasonably name an allowlisted check. Matching is by *name*, never by
// interpreting the text: whatever the agent writes only ever selects one of these stored entries.
export function checkCommandAliases(entry) {
  return [
    entry.name,
    entry.argv.join(" "),
    `npm run ${entry.name}`,
    `npm run -s ${entry.name}`,
    ...(entry.name === "test" ? ["npm test"] : []),
    ...(entry.name === "start" ? ["npm start"] : []),
  ];
}

export function matchCheckCommand(allowlist, requested) {
  const wanted = String(requested ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return allowlist.find((entry) => checkCommandAliases(entry).some((alias) => alias.toLowerCase() === wanted)) || null;
}

// Keep the head (what ran, what it printed first) and the tail (where it failed) and say plainly how
// much was dropped, rather than storing an unbounded transcript in the database.
export function boundCheckOutput(text, limit = CHECK_OUTPUT_LIMIT) {
  const clean = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, Math.floor(limit * 0.6));
  const tail = clean.slice(clean.length - Math.floor(limit * 0.3));
  return `${head}\n… ${clean.length - head.length - tail.length} characters omitted …\n${tail}`;
}

// Confine a node check to the project root and the temp directory using Node's own permission
// model. Both the directory and its subtree are granted, since the flag does not imply recursion.
export function sandboxFlagsFor(program, cwd) {
  if (program !== "node") return null;
  const scopes = [cwd, os.tmpdir()];
  const flags = ["--permission"];
  for (const scope of scopes) {
    const normalized = scope.replace(/[\\/]+$/, "");
    flags.push(`--allow-fs-read=${normalized}`, `--allow-fs-read=${normalized}/*`);
    flags.push(`--allow-fs-write=${normalized}`, `--allow-fs-write=${normalized}/*`);
  }
  // Real suites spawn processes (this project's own tests run git), so blocking that would make the
  // sandbox unusable rather than safe. Exfiltration to disk is what this closes.
  flags.push("--allow-child-process", "--allow-worker");
  return flags;
}

// The environment the check runs in: the operator's, minus anything that looks like a credential.
function scrubbedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET_ENV_PATTERN.test(name)));
}

// Run one allowlisted check inside the project root and grade it by exit code.
//
// This is asynchronous, and that is the whole point. DevTeam is one process serving every agent,
// the dashboard, SSE and the heartbeats that decide who still holds a write lease, so a check that
// blocked here froze all of them at once for as long as it ran. The *caller* still waits for its
// own verdict — a report that returned before its own evidence had been gathered would be a smaller
// lie than the one this feature exists to stop — but nobody else does. The caller also bounds the
// whole report rather than each command, so one report can never occupy verification for longer
// than the configured timeout however many checks it carries.
//
// Every verdict below is the one the synchronous version produced for the same situation. The four
// states spawnSync gave for free (clean exit, timeout kill, output flood, never started) are each
// tracked explicitly here, because spawn hands back a stream instead of a result.
export function runVerifiedCheck({ argv, cwd, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS, sandbox = false, runner = null }) {
  const [program, ...args] = argv;
  // `sandbox: true` and `runner: "node-permission"` are the same thing; the second spelling exists
  // so a caller can be explicit about which confinement it is asking for.
  const mode = runner || (sandbox ? "node-permission" : "host");
  const confinement = mode === "node-permission" ? sandboxFlagsFor(program, cwd) : null;
  if (mode === "node-permission" && !confinement) {
    return Promise.resolve({
      verified: false, status: "unavailable", exitCode: null, durationMs: 0, timedOut: false,
      output: boundCheckOutput(`This project runs checks sandboxed, and DevTeam can only confine "node". "${program}" was not run.`),
    });
  }
  // Run the same Node that runs DevTeam rather than whatever "node" happens to resolve to on PATH.
  const executable = program === "node" ? process.execPath : program;
  return spawnCheck({
    executable,
    args: confinement ? [...confinement, ...args] : args,
    cwd,
    timeoutMs,
    env: scrubbedEnvironment(),
  });
}

// Spawning and grading, shared by every runner. Which process to start is the runner's decision;
// how its result becomes a verdict must not be, or a second runner would quietly grade differently
// from the first — and the four states here (clean exit, timeout kill, output flood, never started)
// are exactly the distinctions that make a verified check worth more than an assertion.
function spawnCheck({ executable, args, cwd, timeoutMs, env }) {
  const timeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_CHECK_TIMEOUT_MS), MAX_CHECK_TIMEOUT_MS);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false, // never: the argv reaches the OS verbatim, so an argument can never become syntax
        windowsHide: true,
        env,
      });
    } catch (error) {
      resolve(spawnFailure(error, Date.now() - startedAt));
      return;
    }
    let transcript = "";
    let captured = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const capture = (chunk) => {
      if (overflowed) return;
      captured += chunk.length;
      if (captured > CHECK_MAX_BUFFER_BYTES) {
        // The command *ran* and drowned the capture buffer, so its exit status can no longer be
        // trusted to arrive. An unreadable status is not a pass: grading this "unavailable" would
        // let any real failure through simply by printing two megabytes first.
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      transcript += chunk.toString("utf8");
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    // An 'error' with no 'close' behind it means the program never started at all. Nothing was
    // verified, so nothing is recorded as verified — and an unavailable check grants no pass either.
    child.on("error", (error) => settle(spawnFailure(error, Date.now() - startedAt)));
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (overflowed) {
        settle({
          verified: true, status: "failed", exitCode: null, durationMs, timedOut: false,
          output: boundCheckOutput(`[DevTeam] the command produced more than ${CHECK_MAX_BUFFER_BYTES} bytes and was stopped before its exit status could be read. An unreadable result cannot count as a pass.`),
        });
        return;
      }
      const killed = timedOut || (code == null && Boolean(signal));
      const exitCode = killed ? null : (code ?? null);
      settle({
        verified: true,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        durationMs,
        timedOut,
        output: boundCheckOutput(killed
          ? `${transcript}\n[DevTeam] killed after ${durationMs}ms${timedOut ? ` (timeout ${timeout}ms)` : ` (signal ${signal})`}`
          : transcript),
      });
    });
  });
}

// A program that never started. Reported unavailable rather than failed, because "DevTeam could not
// run this" and "this did not pass" are different facts, and only the second one is evidence.
function spawnFailure(error, durationMs) {
  return {
    verified: false, status: "unavailable", exitCode: null, durationMs, timedOut: false,
    output: boundCheckOutput(`${error?.code || "spawn failed"}: ${error?.message || ""}`),
  };
}
