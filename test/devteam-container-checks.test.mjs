import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  containerRunCommand,
  detectContainerRuntime,
  projectContainerConfig,
  runVerifiedCheck,
} from "../src/devteam/checks.mjs";
import { DevTeamStore } from "../src/devteam/store.mjs";

// T4.4 — container execution as an opt-in runner.
//
// These tests never require Docker. What must hold on every machine is that the confinement is
// constructed correctly and that a project asking for a container it cannot have is told so rather
// than quietly run on the host — which is the property the whole feature rests on.

async function projectWith(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "devteam-container-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  if (config !== undefined) {
    await mkdir(path.join(root, ".devteam"), { recursive: true });
    await writeFile(path.join(root, ".devteam", "checks.json"),
      typeof config === "string" ? config : JSON.stringify(config, null, 2), "utf8");
  }
  return root;
}

test("the confinement is the point: no network, no inherited environment, only the project mounted", () => {
  const command = containerRunCommand({
    runtime: "docker",
    argv: ["node", "--test"],
    cwd: "/home/me/project",
    container: { image: "node:24-alpine", network: "none", memory: "2g" },
  });
  assert.equal(command.executable, "docker");
  const args = command.args.join(" ");
  assert.match(args, /--network=none/, "a check that can reach the network can exfiltrate the repository it is checking");
  assert.match(args, /--memory=2g/);
  assert.match(args, /--pids-limit=512/);
  assert.match(args, /type=bind,src=\/home\/me\/project,dst=\/work/, "the project, and nothing else on the host");
  assert.match(args, /--tmpfs \/tmp:rw/, "scratch writes never touch the host");
  assert.match(args, /--workdir \/work/);
  assert.equal(command.args.includes("--rm"), true, "the container does not outlive the check");
  assert.equal(command.args.at(-3), "node:24-alpine", "the image, then the argv, in that order");
  assert.deepEqual(command.args.slice(-2), ["node", "--test"]);
  // The host's environment is the operator's; this is the one execution path that can withhold it.
  const envFlags = command.args.filter((argument, index) => command.args[index - 1] === "--env");
  assert.deepEqual(envFlags, ["CI=1"]);
});

test("inside a container, `node` means the image's node, not DevTeam's own binary", () => {
  // On the host path DevTeam substitutes process.execPath deliberately. Doing that here would mount
  // a path that does not exist in the image and fail every check with something unrelated.
  const command = containerRunCommand({
    runtime: "podman",
    argv: ["node", "--test"],
    cwd: "/srv/app",
    container: { image: "node:24", network: "none", memory: "1g" },
  });
  assert.equal(command.args.at(-2), "node");
  assert.equal(command.args.some((argument) => argument.includes(process.execPath)), false);
});

test("a project that asks for a container it cannot have is refused, never run unconfined", async (t) => {
  const root = await projectWith(t, { container: { image: "node:24-alpine" }, checks: [] });
  // Force the "no runtime" branch regardless of what this machine has installed.
  const result = await runVerifiedCheck({
    argv: ["node", "--version"], cwd: root, runner: "container", container: null,
  });
  assert.equal(result.verified, false, "nothing was verified, because nothing ran");
  assert.equal(result.status, "unavailable");
  assert.match(result.output, /container/i);
  assert.match(result.output, /was not run/, "and it says so plainly rather than reporting a pass");
});

test("a declared image is read from the project's own config, and validated as a reference", async (t) => {
  const good = await projectWith(t, { container: { image: "ghcr.io/acme/ci:2024-06", network: "bridge", memory: "512m" } });
  assert.deepEqual(projectContainerConfig(good), { image: "ghcr.io/acme/ci:2024-06", network: "bridge", memory: "512m" });

  const defaults = await projectWith(t, { container: { image: "node:24" } });
  assert.deepEqual(projectContainerConfig(defaults), { image: "node:24", network: "none", memory: "2g" },
    "no network and a bounded memory limit are what you get for saying nothing");

  // An image reference, not a sentence: anything else would become arguments to `docker run`.
  const injected = await projectWith(t, { container: { image: "node:24 --privileged -v /:/host" } });
  assert.equal(projectContainerConfig(injected), null);
  const empty = await projectWith(t, { checks: [] });
  assert.equal(projectContainerConfig(empty), null);
  const missing = await projectWith(t, undefined);
  assert.equal(projectContainerConfig(missing), null);
});

test("the runner is a project setting, and the old sandbox boolean still means what it meant", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-runner-data-"));
  const root = await projectWith(t, { container: { image: "node:24-alpine" } });
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { try { store.close(); } catch { /* closed */ } await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Container project", root);

  assert.equal(store.projectCheckRunner(project.id), "host", "a project that has said nothing runs checks as it always did");
  store.setProjectCheckCommands({ projectId: project.id, commands: [{ name: "test", argv: ["node", "--test"] }], sandbox: true });
  assert.equal(store.projectCheckRunner(project.id), "node-permission", "the boolean that came before still selects the node sandbox");

  const updated = store.setProjectCheckCommands({ projectId: project.id, commands: [{ name: "test", argv: ["node", "--test"] }], runner: "container" });
  assert.equal(updated.runner, "container");
  assert.equal(store.projectCheckSandbox(project.id), false, "and the two settings never disagree about which runner is live");
  assert.deepEqual(updated.container, { image: "node:24-alpine", network: "none", memory: "2g" });

  assert.throws(() => store.setProjectCheckCommands({ projectId: project.id, runner: "chroot" }), /Unknown check runner/);
});

test("a container check on a host without a runtime grades unavailable, and the claim survives", async (t) => {
  // The end-to-end shape of the honesty rule: an agent reports a check, DevTeam cannot confine it,
  // so the check is recorded as unavailable — which grants no pass — and the work stays claimed.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-container-e2e-"));
  const root = await projectWith(t, { container: { image: "devteam-does-not-exist:latest" } });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "c", scripts: { test: "node --version" } }), "utf8");
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { try { store.close(); } catch { /* closed */ } await rm(dataDir, { recursive: true, force: true }); });
  const project = store.ensureProject("Container e2e", root);
  store.setProjectCheckCommands({ projectId: project.id, runner: "container" });
  const task = store.createTask({ projectId: project.id, title: "Container work", description: "Run it confined." });
  const agent = store.connectAgent({ name: "Reporter", provider: "fixture", freshTaskId: task.id });
  const plan = store.claimNextAssignment(agent.id);
  await store.completeAssignment({ agentId: agent.id, assignmentId: plan.id, claimToken: plan.claimToken, message: "Planned." });
  store.createAssignment({ taskId: task.id, title: "Do it", description: "Work.", role: "implementer" });
  const claim = store.claimNextAssignment(agent.id);

  const result = await store.completeAssignment({
    agentId: agent.id, assignmentId: claim.id, claimToken: claim.claimToken,
    message: "Ran the suite.", checks: [{ label: "suite", command: "test" }],
  });

  const record = result.checks?.find((check) => check.label === "suite");
  if (detectContainerRuntime()) {
    // This host has Docker or Podman: the image is bogus, so the runtime itself refuses. Either way
    // the outcome that matters is identical — nothing was verified on the host.
    assert.notEqual(record.status, "passed", "a check that never produced a clean exit is never a pass");
  } else {
    assert.equal(record.verified, false);
    assert.equal(record.status, "unavailable");
    assert.match(record.output, /unconfined/, "and it says why, rather than looking like a missing check");
  }
});

test("a container that never started is unavailable, not a failed check", async () => {
  // Docker Desktop stopped is the ordinary case on a laptop, and the CLI answers `--version` happily
  // while every `docker run` fails. Grading that as a failure tells an agent its work is broken for
  // a reason it cannot see or fix — the exact inversion of what verified checks are for.
  const { gradeContainerResult } = await import("../src/devteam/checks.mjs");
  for (const exitCode of [125, 126, 127]) {
    const graded = gradeContainerResult(
      { verified: true, status: "failed", exitCode, durationMs: 12, timedOut: false, output: "docker: daemon not running" },
      { runtime: "docker", program: "node" },
    );
    assert.equal(graded.verified, false, `exit ${exitCode} means the runtime refused, not that the suite failed`);
    assert.equal(graded.status, "unavailable");
    assert.match(graded.output, /could not start the container/);
  }
  // A real failing suite is still a real failure.
  const failure = gradeContainerResult(
    { verified: true, status: "failed", exitCode: 1, durationMs: 900, timedOut: false, output: "3 tests failed" },
    { runtime: "docker", program: "node" },
  );
  assert.equal(failure.verified, true);
  assert.equal(failure.status, "failed");
});
