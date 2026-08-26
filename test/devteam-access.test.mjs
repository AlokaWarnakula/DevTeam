import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkExposureRequirements,
  decideApiAccess,
  exposureMode,
  hostnameOf,
  mintToken,
  normalizeTokenLabel,
  shouldIssueDashboardCookie,
  tokensMatch,
} from "../src/devteam/access.mjs";
import { DevTeamStore } from "../src/devteam/store.mjs";
import { startDevTeamServer } from "../src/devteam/server.mjs";

// T4.1 — the rules, tested without a socket, and then the server actually applying them.

test("a loopback bind behaves exactly as it always has", async () => {
  assert.equal(exposureMode("127.0.0.1"), "loopback");
  assert.equal(exposureMode("localhost"), "loopback");
  assert.equal(exposureMode("::1"), "loopback");
  assert.equal(checkExposureRequirements({ host: "127.0.0.1" }).ok, true, "and needs no operator secret");

  // Reads stay open to the local dashboard: this is what makes the local tool zero-friction.
  assert.equal(decideApiAccess({ mode: "loopback", method: "GET", hostHeader: "127.0.0.1:7331" }).allow, true);
  // Writes still need a credential.
  const write = decideApiAccess({ mode: "loopback", method: "POST", hostHeader: "127.0.0.1:7331" });
  assert.equal(write.allow, false);
  assert.equal(write.status, 401);
  assert.equal(decideApiAccess({
    mode: "loopback", method: "POST", hostHeader: "127.0.0.1:7331", credential: { kind: "dashboard" },
  }).allow, true);
});

test("a loopback server refuses a foreign Host or Origin", () => {
  // The Host check is what blunts DNS rebinding: a name that resolves to 127.0.0.1 still arrives
  // carrying its own Host header.
  const rebind = decideApiAccess({ mode: "loopback", method: "GET", hostHeader: "devteam.attacker.example:7331" });
  assert.equal(rebind.allow, false);
  assert.equal(rebind.status, 403);
  const cross = decideApiAccess({
    mode: "loopback", method: "GET", hostHeader: "127.0.0.1:7331", origin: "https://evil.example",
  });
  assert.equal(cross.allow, false);
  assert.equal(cross.status, 403);
  assert.equal(decideApiAccess({
    mode: "loopback", method: "GET", hostHeader: "127.0.0.1:7331", origin: "http://localhost:7331",
  }).allow, true, "the dashboard's own origin is fine");
});

test("an exposed server treats reads as privileged too", () => {
  assert.equal(exposureMode("0.0.0.0"), "exposed");
  const read = decideApiAccess({ mode: "exposed", method: "GET", hostHeader: "devteam.example:7331" });
  assert.equal(read.allow, false, "there is no such thing as a trusted read once the socket is not loopback");
  assert.equal(read.status, 401);
  assert.equal(decideApiAccess({
    mode: "exposed", method: "GET", hostHeader: "devteam.example:7331", credential: { kind: "agent" },
  }).allow, true);
  // The Host check is dropped on purpose: being reachable by another name is the whole point.
  assert.equal(decideApiAccess({
    mode: "exposed", method: "POST", hostHeader: "whatever.example", credential: { kind: "shared" },
  }).allow, true);
});

test("a non-loopback bind is refused unless the operator supplies a real secret", () => {
  const refused = checkExposureRequirements({ host: "0.0.0.0" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /DEVTEAM_TOKEN/);
  assert.match(refused.error, /tunnel/, "and it names the arrangement this tool was actually built for");
  assert.equal(checkExposureRequirements({ host: "0.0.0.0", token: "short" }).ok, false);
  assert.equal(checkExposureRequirements({ host: "0.0.0.0", token: mintToken() }).ok, true);
});

test("the dashboard cookie is issued on a page load and nowhere else", () => {
  // This is the hole T4.1 exists to close: any unauthenticated GET used to be handed a cookie, and
  // GET /api/setup would then trade that cookie for the bearer token.
  assert.equal(shouldIssueDashboardCookie({
    mode: "loopback", method: "GET", path: "/", accept: "text/html,application/xhtml+xml", hasSession: false,
  }), true);
  assert.equal(shouldIssueDashboardCookie({
    mode: "loopback", method: "GET", path: "/api/setup", accept: "*/*", hasSession: false,
  }), false, "an API request never collects a credential by asking");
  assert.equal(shouldIssueDashboardCookie({
    mode: "loopback", method: "GET", path: "/app.js", accept: "*/*", hasSession: false,
  }), false, "and neither does an asset fetch");
  assert.equal(shouldIssueDashboardCookie({
    mode: "exposed", method: "GET", path: "/", accept: "text/html", hasSession: false,
  }), false, "on an exposed server a page load proves nothing, so the token must be presented");
});

test("tokens are compared in constant time, over hashes", () => {
  const token = mintToken();
  assert.equal(tokensMatch(token, token), true);
  assert.equal(tokensMatch(token, mintToken()), false);
  assert.equal(tokensMatch("", ""), false, "an empty credential is never a match");
  assert.equal(tokensMatch(null, token), false);
  // Different lengths must not throw — timingSafeEqual does, on unequal buffers.
  assert.equal(tokensMatch("a", token), false);
});

test("hostnames are read the way a browser sends them", () => {
  assert.equal(hostnameOf("127.0.0.1:7331"), "127.0.0.1");
  assert.equal(hostnameOf("[::1]:7331"), "::1");
  assert.equal(hostnameOf("::1"), "::1", "a bare IPv6 address has no port to strip");
  assert.equal(hostnameOf("devteam.example"), "devteam.example");
});

test("a token label has to say who holds it", () => {
  assert.equal(normalizeTokenLabel("  Codex desktop  "), "Codex desktop");
  assert.throws(() => normalizeTokenLabel(""), /label/);
  assert.equal(normalizeTokenLabel("x".repeat(200)).length, 80);
});

test("a named token can be revoked without re-keying everyone else", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-tokens-"));
  const store = new DevTeamStore(dataDir, { knowledge: { enabled: false }, codegraph: { enabled: false } });
  t.after(async () => { try { store.close(); } catch { /* closed */ } await rm(dataDir, { recursive: true, force: true }); });

  const codex = store.mintAccessToken({ label: "Codex desktop" });
  const claude = store.mintAccessToken({ label: "Claude Code" });
  assert.equal(store.resolveAccessToken(codex.token).label, "Codex desktop");
  assert.equal(store.resolveAccessToken(store.token).kind, "shared", "the shared token still works");

  store.revokeAccessToken(codex.id);
  assert.equal(store.resolveAccessToken(codex.token), null, "a revoked token is not a credential");
  assert.equal(store.resolveAccessToken(claude.token).label, "Claude Code", "and nobody else is disturbed");

  const listed = store.accessTokens();
  assert.equal(listed.length, 2);
  assert.equal(Object.hasOwn(listed[0], "token"), false, "listing tokens never re-issues one");
  assert.ok(listed.find((row) => row.id === claude.id).last_used_at, "use is stamped, so the record says who is actually connecting");
});

test("a live loopback server no longer hands the bearer token to an unauthenticated request", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-access-server-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "devteam-access-workspace-"));
  const server = await startDevTeamServer({
    port: 0, dataDir, workspaceRoot: workspace, knowledge: { enabled: false }, codegraph: { enabled: false },
  });
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  assert.equal(server.accessMode, "loopback");

  // The old chain: GET anything, collect a cookie, spend it at /api/setup.
  const cold = await fetch(`${server.url}/api/setup`);
  assert.equal(cold.headers.get("set-cookie"), null, "an API request is not handed a session");
  assert.equal(cold.status, 401);

  // A page load still is, so the dashboard keeps working with no configuration at all.
  const page = await fetch(`${server.url}/`, { headers: { accept: "text/html" } });
  const cookie = page.headers.get("set-cookie");
  assert.ok(cookie?.includes("devteam_dash="), "the browser that loads the dashboard gets its session");
  const withSession = await fetch(`${server.url}/api/setup`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(withSession.status, 200);
  assert.equal((await withSession.json()).token, server.store.token);

  // And the bearer works on its own, which is how every agent connects.
  const withBearer = await fetch(`${server.url}/api/setup`, { headers: { authorization: `Bearer ${server.store.token}` } });
  assert.equal(withBearer.status, 200);
  const wrong = await fetch(`${server.url}/api/setup`, { headers: { authorization: "Bearer not-the-token" } });
  assert.equal(wrong.status, 401);
});

test("a token can be exchanged for a dashboard session, and guessing is slowed down", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-session-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "devteam-session-workspace-"));
  const server = await startDevTeamServer({
    port: 0, dataDir, workspaceRoot: workspace, knowledge: { enabled: false }, codegraph: { enabled: false },
  });
  t.after(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const named = server.store.mintAccessToken({ label: "Phone" });
  const login = await fetch(`${server.url}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: named.token }),
  });
  assert.equal(login.status, 200);
  assert.ok(login.headers.get("set-cookie")?.includes("devteam_dash="));
  assert.equal((await login.json()).credential, "Phone", "the session says which credential opened it");

  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await fetch(`${server.url}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: `guess-${attempt}` }),
    });
  }
  assert.equal(last.status, 429, "an endpoint that answers yes or no about a secret cannot answer forever");
});

test("the server refuses to open a non-loopback socket without an operator secret", async (t) => {
  // The refusal happens before anything binds, so this never actually opens a public port.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "devteam-exposed-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "devteam-exposed-workspace-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });
  const previous = process.env.DEVTEAM_TOKEN;
  delete process.env.DEVTEAM_TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.DEVTEAM_TOKEN; else process.env.DEVTEAM_TOKEN = previous; });

  await assert.rejects(
    () => startDevTeamServer({ host: "0.0.0.0", port: 0, dataDir, workspaceRoot: workspace, knowledge: { enabled: false }, codegraph: { enabled: false } }),
    /DEVTEAM_TOKEN/,
    "a server reachable from the network behind a generated single-user token should not start at all",
  );
});
