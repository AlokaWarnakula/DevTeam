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

// The program must be a bare name resolved on PATH. A path separator, a drive letter, or a relative
// walk would let a check point at an executable dropped anywhere on the machine.
function isSafeProgram(program) {
  return Boolean(program) && !/[\\/:]/.test(program) && program !== "." && program !== "..";
}

// A package.json script body is usable only when it is one plain command: no operators, no
// redirection, no substitution, no globbing, and no quoting to reassemble arguments from.
export function parseScriptCommand(body) {
  const text = String(body ?? "").trim();
  if (!text || text.length > 400) return null;
  if (SHELL_SYNTAX.test(text)) return null;
  const argv = text.split(/\s+/).filter(Boolean);
  if (!argv.length || argv.length > CHECK_ARGV_LIMIT) return null;
  if (argv.some((item) => item.length > CHECK_ARGUMENT_LIMIT)) return null;
  return isSafeProgram(argv[0]) ? argv : null;
}

// Validate one allowlist entry, whether it came from a package.json snapshot or from a human typing
// argv into the dashboard. A human-configured entry is still argv, never a command line.
export function normalizeCheckCommand(entry) {
  const name = String(entry?.name ?? "").trim().slice(0, 80);
  const supplied = Array.isArray(entry?.argv) ? entry.argv : parseScriptCommand(entry?.command);
  if (!name || !Array.isArray(supplied) || !supplied.length || supplied.length > CHECK_ARGV_LIMIT) return null;
  const argv = supplied.map((item) => String(item ?? "").trim());
  if (argv.some((item) => !item || item.length > CHECK_ARGUMENT_LIMIT)) return null;
  if (!isSafeProgram(argv[0])) return null;
  return { name, argv };
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

// Run one allowlisted check inside the project root and grade it by exit code.
//
// This is deliberately synchronous, like the git probe the store already uses: DevTeam is a local
// single-user coordination server, and a report that returns before its own evidence has been
// gathered would be a smaller lie than the one this feature exists to stop. The pause is bounded by
// timeoutMs, which is why the ceiling matters.
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
  });
  const durationMs = Date.now() - startedAt;
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (result.error && !timedOut) {
    // It never started, or its output blew past the capture limit. Either way nothing was verified,
    // so nothing may be *recorded* as verified — an unavailable check grants no pass.
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
