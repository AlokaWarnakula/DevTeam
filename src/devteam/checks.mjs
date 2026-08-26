import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

// Reported checks used to be believed. `checks: ["node --test: 142/142"]` was recorded because an
// agent typed it, and approvals were then built on top of that permanently green record. A check may
// now carry a command, which DevTeam runs itself and grades by exit code.
//
// The security shape of this file is the whole point, so it is stated once, here:
//   * Agent text NEVER becomes a command. A reported command is only ever used to *select* an entry
//     from an allowlist the human configured for the project; the argv that reaches the OS comes
//     from that stored entry and nowhere else.
//   * There is no shell. spawnSync runs with shell:false and an argv array, so an argument is an
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

// The environment the check runs in: the operator's, minus anything that looks like a credential.
function scrubbedEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET_ENV_PATTERN.test(name)));
}

// Run one allowlisted check inside the project root and grade it by exit code.
//
// This is deliberately synchronous, like the git probe the store already uses: DevTeam is a local
// single-user coordination server, and a report that returned before its own evidence had been
// gathered would be a smaller lie than the one this feature exists to stop. The pause is bounded —
// and the caller bounds the *whole report*, not just each command, so one report can never hold the
// event loop for longer than the configured timeout however many checks it carries.
export function runVerifiedCheck({ argv, cwd, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS }) {
  const [program, ...args] = argv;
  // Run the same Node that runs DevTeam rather than whatever "node" happens to resolve to on PATH.
  const executable = program === "node" ? process.execPath : program;
  const timeout = Math.min(Math.max(1000, Number(timeoutMs) || DEFAULT_CHECK_TIMEOUT_MS), MAX_CHECK_TIMEOUT_MS);
  const startedAt = Date.now();
  const result = spawnSync(executable, args, {
    cwd,
    shell: false, // never: the argv reaches the OS verbatim, so an argument can never become syntax
    windowsHide: true,
    encoding: "utf8",
    timeout,
    maxBuffer: CHECK_MAX_BUFFER_BYTES,
    killSignal: "SIGKILL",
    env: scrubbedEnvironment(),
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (result.error && !timedOut) {
    if (result.error.code === "ENOBUFS") {
      // The command *ran* and drowned the capture buffer, so its exit status could not be read. An
      // unreadable status is not a pass: grading this "unavailable" would let any real failure
      // through simply by printing two megabytes first.
      return {
        verified: true, status: "failed", exitCode: null, durationMs, timedOut: false,
        output: boundCheckOutput(`[DevTeam] the command produced more than ${CHECK_MAX_BUFFER_BYTES} bytes and was stopped before its exit status could be read. An unreadable result cannot count as a pass.`),
      };
    }
    // It never started at all. Nothing was verified, so nothing is recorded as verified — and an
    // unavailable check grants no pass either.
    return {
      verified: false, status: "unavailable", exitCode: null, durationMs, timedOut: false,
      output: boundCheckOutput(`${result.error.code || "spawn failed"}: ${result.error.message || ""}`),
    };
  }
  const killed = timedOut || (result.status == null && Boolean(result.signal));
  const exitCode = killed ? null : (result.status ?? null);
  const transcript = `${result.stdout || ""}${result.stderr || ""}`;
  return {
    verified: true,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs,
    timedOut: Boolean(timedOut),
    output: boundCheckOutput(killed
      ? `${transcript}\n[DevTeam] killed after ${durationMs}ms${timedOut ? ` (timeout ${timeout}ms)` : ` (signal ${result.signal})`}`
      : transcript),
  };
}
