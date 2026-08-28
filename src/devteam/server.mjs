import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DevTeamStore } from "./store.mjs";
import { createDevTeamMcpServer } from "./mcp.mjs";
import { ManagedRuntimeSupervisor } from "./runtime/managed.mjs";
import { normalizeRuntimeProfile, resolveRuntimeRequirement } from "./runtime/index.mjs";
import {
  checkExposureRequirements,
  decideApiAccess,
  exposureMode,
  hostnameOf,
  shouldIssueDashboardCookie,
  tokensMatch,
} from "./access.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(moduleDir, "../../public");
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TYPES = new Map([
  ["image/png", { extension: ".png", matches: (body) => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ["image/jpeg", { extension: ".jpg", matches: (body) => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff }],
  ["image/gif", { extension: ".gif", matches: (body) => ["GIF87a", "GIF89a"].includes(body.subarray(0, 6).toString("ascii")) }],
  ["image/webp", { extension: ".webp", matches: (body) => body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP" }],
  ["application/pdf", { extension: ".pdf", matches: (body) => body.subarray(0, 5).toString("ascii") === "%PDF-" }],
]);

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function requireFields(body, fields) {
  for (const field of fields) {
    if (typeof body?.[field] !== "string" || !body[field].trim()) throw new Error(`${field} is required.`);
  }
}

function requireDirectory(root) {
  const resolved = path.resolve(root);
  if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) throw new Error("Project root must be an existing directory.");
  return resolved;
}

function userRuntimeProfile(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime profile must be an object or null.");
  return normalizeRuntimeProfile({
    ...value,
    source: "user",
    switchMode: value.switchMode || "user_required",
    observedAt: value.observedAt || new Date().toISOString(),
  });
}

function taskRuntimeProfile(task) {
  if (!task?.base_runtime_profile) return null;
  try {
    const stored = typeof task.base_runtime_profile === "string" ? JSON.parse(task.base_runtime_profile) : task.base_runtime_profile;
    return userRuntimeProfile(stored);
  } catch {
    return null;
  }
}

export async function startDevTeamServer({
  host = "127.0.0.1",
  port = 7331,
  dataDir,
  workspaceRoot = process.cwd(),
  liveness = {},
  knowledge = { enabled: true },
  codegraph = { enabled: true },
  checkpoint = {},
  managed = {},
} = {}) {
  if (!dataDir) throw new Error("dataDir is required.");
  // T4.1 — the one place DevTeam declines to start. A server reachable from the network whose
  // credential is the one auto-generated for a single-user localhost tool is a worse outcome than
  // no server, and an operator who means to expose it can say so with a real secret.
  const exposure = checkExposureRequirements({ host, token: process.env.DEVTEAM_TOKEN });
  if (!exposure.ok) throw new Error(exposure.error);
  const store = new DevTeamStore(dataDir, { liveness, knowledge, codegraph, checkpoint });
  // An operator-supplied token replaces the generated one, so what authenticates is the secret they
  // chose rather than a string sitting in the data directory.
  if (process.env.DEVTEAM_TOKEN) store.setSharedToken(process.env.DEVTEAM_TOKEN);
  const supervisor = new ManagedRuntimeSupervisor(managed);
  const attachmentRoot = path.resolve(dataDir, "attachments");
  const root = requireDirectory(workspaceRoot);
  store.ensureProject(path.basename(root), root);

  const app = createMcpExpressApp({ host });
  const transports = new Map();
  // A per-run secret for the browser dashboard's own session, so control-plane mutations require a
  // real credential (this cookie, issued only to a loopback page load) or the MCP bearer token —
  // not merely a same-origin request. Kept out of every routine API response.
  const dashSecret = randomBytes(24).toString("base64url");
  const parseCookies = (req) => Object.fromEntries(
    String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const eq = part.indexOf("=");
      return eq === -1 ? [part, ""] : [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
    }),
  );
  const hasDashSession = (req) => parseCookies(req).devteam_dash === dashSecret;
  // T4.1 — a bearer is now resolved to *which* credential it is: the shared server token, or a
  // named token that can be revoked on its own. `null` means no credential, and nothing below
  // distinguishes "wrong token" from "no token" in what it says back.
  const bearerOf = (req) => {
    const header = req.get("authorization") || "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    return presented ? store.resolveAccessToken(presented) : null;
  };
  const credentialOf = (req) => bearerOf(req) || (hasDashSession(req) ? { kind: "dashboard", id: null, label: "Dashboard session" } : null);
  const mcpAuth = (req, res, next) => {
    const credential = bearerOf(req);
    if (!credential) {
      return res.status(401).json({ error: "Invalid DevTeam token." });
    }
    req.devteamCredential = credential;
    next();
  };

  // T4.1 — the access rules live in access.mjs, stated once and unit-tested without a socket.
  //
  // Loopback (the default, and what every existing install runs): unchanged. Reads are open to the
  // local dashboard, writes need the session cookie or a bearer, a foreign Origin is refused, and a
  // non-loopback Host is refused outright, which is what blunts DNS rebinding.
  //
  // Exposed (any other bind address): there is no trusted read. Everything needs a credential, the
  // cookie is never handed out for free, and the server refuses to start at all behind a weak token.
  const mode = exposureMode(host);
  const apiGuard = (req, res, next) => {
    const decision = decideApiAccess({
      mode,
      method: req.method,
      hostHeader: req.headers.host,
      origin: req.get("origin") || null,
      credential: credentialOf(req),
      allowedOrigins: [hostnameOf(host)],
    });
    if (!decision.allow) return res.status(decision.status).json({ error: decision.error });
    next();
  };
  // Hand the browser a dashboard session cookie on its page load, so its later control-plane calls
  // carry a credential without ever exposing the MCP bearer token in the page. Only on a document
  // load, never on /api: issuing it on any GET is what let one unauthenticated request collect a
  // cookie and the next one trade it at /api/setup for the bearer token.
  app.use((req, res, next) => {
    if (shouldIssueDashboardCookie({ mode, method: req.method, path: req.path, accept: req.get("accept") || "", hasSession: hasDashSession(req) })) {
      res.setHeader("Set-Cookie", `devteam_dash=${dashSecret}; HttpOnly; SameSite=Strict; Path=/`);
    }
    next();
  });
  // Exchanging the token for a dashboard session. This is the only /api route that must be reachable
  // without a credential — it is where a credential is presented — so it is mounted ahead of the
  // guard and does its own checking. Attempts are counted and slowed, because an endpoint that says
  // yes or no to a secret is a guessing oracle if it will answer forever.
  const loginAttempts = new Map();
  app.post("/api/session", express.json({ limit: "4kb" }), (req, res) => {
    const from = req.ip || "unknown";
    const attempts = loginAttempts.get(from) || { count: 0, until: 0 };
    if (attempts.until > Date.now()) {
      return res.status(429).json({ error: "Too many attempts. Wait a minute and try again." });
    }
    const presented = String(req.body?.token || "").trim();
    const credential = presented && (tokensMatch(presented, store.token) ? { kind: "shared" } : store.resolveAccessToken(presented));
    if (!credential) {
      const count = attempts.count + 1;
      loginAttempts.set(from, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      return res.status(401).json({ error: "That token is not valid for this server." });
    }
    loginAttempts.delete(from);
    res.setHeader("Set-Cookie", `devteam_dash=${dashSecret}; HttpOnly; SameSite=Strict; Path=/`);
    res.json({ ok: true, credential: credential.label || "Shared server token" });
  });
  app.use("/api", apiGuard);
  const requireControlAuth = (req, res, next) => {
    if (credentialOf(req)) return next();
    return res.status(401).json({ error: "This action requires the DevTeam dashboard session or bearer token." });
  };

  const checkpointInvitation = (task, result) => [
    `Continue DevTeam task “${result.checkpoint.capsule?.task?.title || task.id}” in a fresh session.`,
    "",
    "Use the DevTeam skill and connect as a new agent session. Join the task room below, then call devteam_session_takeover exactly once with:",
    "",
    `taskId: ${task.id}`,
    `checkpointId: ${result.checkpoint.id}`,
    `handoffToken: ${result.handoffToken}`,
    "",
    "After takeover, read the bounded capsule, inspect the repository and current task state, and continue only under the newly issued claim token. Do not use devteam_resume: this is an intentional fresh-session takeover. The handoff token is single-use and expires at " + result.checkpoint.expiresAt + ".",
  ].join("\n");

  const mcpPost = asyncRoute(async (req, res) => {
    const sessionId = req.get("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : null;
    if (!transport && !sessionId && isInitializeRequest(req.body)) {
      // One identity scope per MCP session, so a tool call can only act as the agent that
      // connected on this session (prevents cross-session impersonation).
      const session = { agentId: null };
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
        // A confirmed transport close is strong evidence the client is gone: release its work.
        if (session.agentId) {
          try { store.handleTransportClose(session.agentId); } catch { /* best effort */ }
        }
      };
      await createDevTeamMcpServer(store, session).connect(transport);
    }
    if (!transport) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid or missing MCP session." }, id: null });
    await transport.handleRequest(req, res, req.body);
  });

  const mcpExisting = asyncRoute(async (req, res) => {
    const transport = transports.get(req.get("mcp-session-id"));
    if (!transport) return res.status(400).send("Invalid or missing MCP session.");
    await transport.handleRequest(req, res);
  });

  app.post("/mcp", mcpAuth, mcpPost);
  app.get("/mcp", mcpAuth, mcpExisting);
  app.delete("/mcp", mcpAuth, mcpExisting);

  app.get("/api/config", (req, res) => res.json({
    name: "DevTeam",
    version: "0.2.0",
    localOnly: mode === "loopback",
    // The dashboard needs to know which world it is in: on an exposed server nothing is readable
    // without a credential, so it must ask for one rather than rendering an empty board.
    accessMode: mode,
    mcpUrl: `${req.protocol}://${req.get("host")}/mcp`,
    idleWaitSeconds: 45,
    liveness: store.liveness,
  }));
  // The bearer token lives behind the dashboard session (or the token itself), never in the routine
  // config that drives polling — so a stray GET can't harvest it.
  app.get("/api/setup", requireControlAuth, (req, res) => res.json({
    mcpUrl: `${req.protocol}://${req.get("host")}/mcp`,
    token: store.token,
  }));
  // T4.1 — named credentials. One shared token is right for one person on one machine; the moment
  // more than one party is involved, a credential you cannot revoke without re-keying everybody is
  // the problem. The plaintext is returned once here and never again — the server keeps only a hash.
  app.get("/api/tokens", requireControlAuth, (req, res) => res.json({
    mode,
    sharedTokenInUse: true,
    tokens: store.accessTokens(),
  }));
  app.post("/api/tokens", requireControlAuth, (req, res) => {
    requireFields(req.body, ["label"]);
    const minted = store.mintAccessToken({ label: req.body.label });
    res.json({
      ...minted,
      note: "Copy this now: DevTeam stores only a hash of it and cannot show it again.",
    });
  });
  app.delete("/api/tokens/:id", requireControlAuth, (req, res) => res.json(store.revokeAccessToken(req.params.id)));
  app.get("/api/state", (req, res) => {
    const taskId = Object.hasOwn(req.query, "taskId") ? req.query.taskId || null : undefined;
    const snapshot = store.snapshot(taskId);
    const task = snapshot.selectedTask;
    if (task) {
      const baseProfile = taskRuntimeProfile(task);
      task.baseRuntimeProfile = baseProfile;
      for (const assignment of task.assignments || []) {
        if (!assignment.assessment?.requirements) continue;
        const assigned = snapshot.agents.find((agent) => agent.id === assignment.agent_id);
        const targeted = !assigned && assignment.target_agent_name
          ? snapshot.agents.find((agent) => agent.status !== "disconnected" && agent.name.toLowerCase() === assignment.target_agent_name.toLowerCase())
          : null;
        const agentProfile = assigned?.runtimeProfile || targeted?.runtimeProfile || null;
        const profile = agentProfile || baseProfile;
        assignment.runtimeProfileSource = agentProfile ? "agent" : (baseProfile ? "task" : null);
        assignment.runtimeResolution = resolveRuntimeRequirement(assignment.assessment.requirements, profile);
      }
    }
    res.json(snapshot);
  });
  app.get("/api/search", (req, res) => {
    res.json({
      query: String(req.query.q || "").trim().slice(0, 120),
      results: store.workspaceSearch(req.query.q, {
        projectId: typeof req.query.projectId === "string" && req.query.projectId ? req.query.projectId : null,
        limit: Number(req.query.limit) || 40,
      }),
    });
  });
  app.get("/api/tasks/:taskId", (req, res) => {
    const detail = store.taskDetail(req.params.taskId);
    if (!detail) return res.status(404).json({ error: "Task not found." });
    res.json(detail);
  });
  app.post("/api/projects", (req, res) => {
    requireFields(req.body, ["name", "root"]);
    res.status(201).json(store.ensureProject(req.body.name, requireDirectory(req.body.root)));
  });
  app.patch("/api/projects/:projectId", (req, res) => {
    const patch = {};
    if (typeof req.body?.name === "string") patch.name = req.body.name;
    if (typeof req.body?.root === "string" && req.body.root.trim()) patch.root = requireDirectory(req.body.root);
    if (!Object.keys(patch).length) throw new Error("Provide a new name or folder path to update.");
    res.json(store.updateProject(req.params.projectId, patch));
  });
  app.delete("/api/projects/:projectId", (req, res) => {
    requireFields(req.body, ["confirmName"]);
    res.json(store.deleteProject(req.params.projectId, req.body.confirmName));
  });
  app.post("/api/tasks", (req, res) => {
    requireFields(req.body, ["projectId", "title", "description"]);
    res.status(201).json(store.createTask(req.body));
  });
  app.patch("/api/tasks/:taskId", (req, res) => {
    const patch = {};
    if (typeof req.body?.title === "string") patch.title = req.body.title;
    if (typeof req.body?.description === "string") patch.description = req.body.description;
    if (req.body?.requiredApprovals !== undefined) patch.requiredApprovals = Number(req.body.requiredApprovals);
    if (typeof req.body?.sessionPolicy === "string") patch.sessionPolicy = req.body.sessionPolicy;
    if (Object.hasOwn(req.body || {}, "baseRuntimeProfile")) patch.baseRuntimeProfile = userRuntimeProfile(req.body.baseRuntimeProfile);
    if (!Object.keys(patch).length) throw new Error("Provide task details or a session policy to update.");
    res.json(store.updateTask(req.params.taskId, patch));
  });
  app.patch("/api/tasks/:taskId/session-policy", (req, res) => {
    requireFields(req.body, ["sessionPolicy"]);
    res.json(store.updateTask(req.params.taskId, {
      sessionPolicy: req.body.sessionPolicy,
      baseRuntimeProfile: Object.hasOwn(req.body || {}, "baseRuntimeProfile") ? userRuntimeProfile(req.body.baseRuntimeProfile) : undefined,
    }));
  });
  app.delete("/api/tasks/:taskId", (req, res) => {
    requireFields(req.body, ["confirmTaskId"]);
    res.json(store.deleteTask(req.params.taskId, req.body.confirmTaskId));
  });
  app.post("/api/tasks/:taskId/assignments", (req, res) => {
    requireFields(req.body, ["title", "description"]);
    res.status(201).json(store.createAssignment({ ...req.body, taskId: req.params.taskId }));
  });
  app.get("/api/agents/:agentId/runtime", requireControlAuth, (req, res) => {
    res.json({ agentId: req.params.agentId, runtimeProfile: store.runtimeProfile(req.params.agentId) });
  });
  app.put("/api/agents/:agentId/runtime", (req, res) => {
    res.json({ updated: true, runtimeProfile: store.updateRuntimeProfile({
      agentId: req.params.agentId,
      profile: userRuntimeProfile(req.body?.profile || req.body),
      force: true,
    }) });
  });
  app.get("/api/assignments/:assignmentId/assessment", requireControlAuth, (req, res) => {
    res.json(store.assignmentAssessment({ assignmentId: req.params.assignmentId }));
  });
  // Reading the allowlist executes nothing, but it does disclose what a host is willing to run, so
  // it stays behind the control credential like the other configuration surfaces.
  app.get("/api/projects/:projectId/check-commands", requireControlAuth, (req, res) => {
    const commands = store.projectCheckCommands(req.params.projectId);
    res.json({
      projectId: req.params.projectId,
      verificationEnabled: commands.length > 0,
      sandbox: store.projectCheckSandbox(req.params.projectId),
      commands,
      available: store.availableCheckCommands(req.params.projectId),
    });
  });
  app.put("/api/projects/:projectId/check-commands", (req, res) => {
    // Omitting commands snapshots the project's own package.json scripts; sending [] turns
    // verification back off. Either way this is a human decision, never an agent's.
    res.json(store.setProjectCheckCommands({
      projectId: req.params.projectId,
      commands: Array.isArray(req.body?.commands) ? req.body.commands : null,
      sandbox: typeof req.body?.sandbox === "boolean" ? req.body.sandbox : null,
    }));
  });
  app.get("/api/assignments/:assignmentId/why-not-claimable", (req, res) => {
    // The dashboard asks agent-agnostically ("why is this queued item stuck?"); passing agentId
    // answers the sharper question of why one particular teammate cannot take it. Naming an agent
    // makes this the same question devteam_why_blocked answers, so it enforces the same membership
    // boundary rather than being a way around it.
    const agentId = typeof req.query.agentId === "string" && req.query.agentId ? req.query.agentId : null;
    if (agentId) {
      const room = store.assignmentRoom(req.params.assignmentId);
      if (!room) return res.status(404).json({ error: "Assignment not found." });
      store.assertExplainable(agentId, room);
    }
    return res.json(store.whyNotClaimable(req.params.assignmentId, agentId));
  });
  app.patch("/api/assignments/:assignmentId/complexity", (req, res) => {
    res.json(store.setAssignmentComplexityOverride({ assignmentId: req.params.assignmentId, override: req.body?.override ?? req.body ?? null }));
  });
  app.post("/api/assignments/:assignmentId/runtime-decisions", (req, res) => {
    requireFields(req.body, ["choice"]);
    res.status(201).json(store.runtimeDecision({
      agentId: typeof req.body?.agentId === "string" ? req.body.agentId : null,
      assignmentId: req.params.assignmentId,
      assessmentId: typeof req.body?.assessmentId === "string" ? req.body.assessmentId : null,
      choice: req.body.choice,
      actor: "human",
      reason: req.body?.reason || "Human runtime decision from the dashboard.",
      humanApproved: req.body?.humanApproved === true,
    }));
  });
  app.post("/api/tasks/:taskId/managed-launch", asyncRoute(async (req, res) => {
    requireFields(req.body, ["agentId", "assignmentId", "adapterId", "modelId", "effortId"]);
    const task = store.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found." });
    const assignment = store.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(req.body.assignmentId, task.id);
    if (!assignment) throw new Error("Assignment does not belong to this task.");
    const profile = store.runtimeProfile(req.body.agentId);
    if (profile?.switchMode !== "automatic") throw new Error("This session did not advertise an automatic managed switch mode.");
    const assessment = store.assignmentAssessment({ assignmentId: assignment.id });
    if (assessment.requirements.humanApprovalRequired && req.body?.humanApproved !== true) throw new Error("Exceptional managed settings require explicit human approval.");
    const advertisedModel = profile.availableModels.find((model) => model.id === req.body.modelId);
    const advertisedEffort = advertisedModel?.efforts.find((effort) => effort.id === req.body.effortId);
    if (!advertisedModel || !advertisedEffort) throw new Error("Managed selection must exactly match the host-advertised profile.");
    const selectedProfile = { ...profile, currentModel: advertisedModel.id, currentEffort: advertisedEffort.id, currentModelClass: advertisedModel.class, currentEffortClass: advertisedEffort.class };
    if (!resolveRuntimeRequirement(assessment.requirements, selectedProfile).satisfied) throw new Error("The selected managed runtime does not satisfy the current assessment.");
    const checkpointResult = await store.createSessionCheckpoint({ agentId: req.body.agentId, taskId: task.id, assignmentId: assignment.id, nextAction: "Managed runner should connect and take over this checkpoint." });
    const invitation = checkpointInvitation(task, checkpointResult);
    try {
      const launched = await supervisor.launch({
        adapterId: req.body.adapterId,
        selection: { modelId: advertisedModel.id, effortId: advertisedEffort.id },
        taskInvite: invitation,
        projectRoot: task.project_root,
        env: { DEVTEAM_MCP_URL: `${req.protocol}://${req.get("host")}/mcp`, DEVTEAM_TOKEN: store.token },
      });
      store.recordManagedLaunch({ taskId: task.id, agentId: req.body.agentId, adapterId: req.body.adapterId, pid: launched.pid, status: "launched", message: "An opt-in managed runner launched; the old claim remains until checkpoint takeover succeeds." });
      res.status(201).json({ launched: true, pid: launched.pid, adapterId: launched.adapterId, checkpoint: checkpointResult.checkpoint, invitation });
    } catch (error) {
      store.cancelSessionCheckpoint({ agentId: req.body.agentId, taskId: task.id, checkpointId: checkpointResult.checkpoint.id, reason: "Managed launch failed; the old claim was kept." });
      store.recordManagedLaunch({ taskId: task.id, agentId: req.body.agentId, adapterId: req.body.adapterId, status: "failed", message: `Managed launch failed: ${error.message}. The old claim was kept.` });
      throw error;
    }
  }));
  app.post("/api/tasks/:taskId/checkpoints", asyncRoute(async (req, res) => {
    const task = store.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found." });
    const assignmentId = typeof req.body?.assignmentId === "string" ? req.body.assignmentId : null;
    const assignment = assignmentId
      ? store.db.prepare("SELECT * FROM assignments WHERE id = ? AND task_id = ?").get(assignmentId, task.id)
      : null;
    if (assignmentId && !assignment) throw new Error("The assignment does not belong to this task.");
    const fromAgentId = assignment?.agent_id || (typeof req.body?.fromAgentId === "string" ? req.body.fromAgentId : null);
    if (!fromAgentId) throw new Error("Choose an active agent or claimed assignment to checkpoint.");
    const expiresInMinutes = Math.max(1, Math.min(1440, Number(req.body?.expiresInMinutes) || 30));
    const result = await store.createSessionCheckpoint({
      agentId: fromAgentId,
      taskId: task.id,
      assignmentId,
      decisions: req.body?.decisions,
      blockers: req.body?.blockers,
      checks: req.body?.checks,
      failedApproaches: req.body?.failedApproaches,
      nextAction: req.body?.nextAction,
      expiresInMs: expiresInMinutes * 60_000,
    });
    res.status(201).json({ ...result, invitation: checkpointInvitation(task, result) });
  }));
  app.get("/api/tasks/:taskId/checkpoints/:checkpointId", requireControlAuth, (req, res) => {
    res.json(store.sessionCheckpointGet({ taskId: req.params.taskId, checkpointId: req.params.checkpointId }));
  });
  app.post("/api/tasks/:taskId/checkpoints/:checkpointId/cancel", (req, res) => {
    res.json(store.cancelSessionCheckpoint({
      taskId: req.params.taskId,
      checkpointId: req.params.checkpointId,
      reason: req.body?.reason || "Human cancelled session rotation from the dashboard.",
    }));
  });
  app.post("/api/tasks/:taskId/messages", (req, res) => {
    requireFields(req.body, ["message"]);
    const input = { taskId: req.params.taskId, message: req.body.message, target: req.body.target || "all", replyTo: req.body.replyTo || null };
    res.status(201).json(req.body.continueTask === true
      ? store.continueTask(input)
      : store.humanMessage(input.taskId, input.message, input.target, input.replyTo));
  });
  app.post("/api/tasks/:taskId/attachments", express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES }), asyncRoute(async (req, res) => {
    const task = store.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found." });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) throw new Error("Attachment is empty.");
    const declaredType = String(req.get("x-file-type") || "").toLowerCase();
    const type = ATTACHMENT_TYPES.get(declaredType);
    if (!type || !type.matches(body)) throw new Error("Only valid PNG, JPEG, GIF, WebP, and PDF files are accepted.");
    let originalName = "attachment";
    try { originalName = decodeURIComponent(req.get("x-file-name") || originalName); } catch { throw new Error("Attachment filename is invalid."); }
    originalName = path.basename(originalName).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) || `attachment${type.extension}`;
    const fileName = `${randomUUID()}${type.extension}`;
    const taskDir = path.resolve(attachmentRoot, task.id);
    if (path.dirname(taskDir) !== attachmentRoot) throw new Error("Attachment path is invalid.");
    await mkdir(taskDir, { recursive: true });
    const filePath = path.resolve(taskDir, fileName);
    if (path.dirname(filePath) !== taskDir) throw new Error("Attachment path is invalid.");
    await writeFile(filePath, body, { flag: "wx" });
    res.status(201).json({
      name: originalName,
      mime: declaredType,
      size: body.length,
      path: filePath,
      previewUrl: `/api/tasks/${task.id}/attachments/${fileName}`,
    });
  }));
  app.get("/api/tasks/:taskId/attachments/:fileName", (req, res) => {
    const task = store.getTask(req.params.taskId);
    if (!task) return res.status(404).json({ error: "Task not found." });
    const fileName = String(req.params.fileName || "");
    if (!/^[0-9a-f-]+\.(?:png|jpg|gif|webp|pdf)$/.test(fileName)) return res.status(404).json({ error: "Attachment not found." });
    const filePath = path.resolve(attachmentRoot, task.id, fileName);
    const taskDir = path.resolve(attachmentRoot, task.id);
    if (path.dirname(filePath) !== taskDir) return res.status(404).json({ error: "Attachment not found." });
    res.set({ "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'" });
    res.sendFile(filePath, { dotfiles: "deny" }, (error) => {
      if (error && !res.headersSent) res.status(error.statusCode || 404).json({ error: "Attachment not found." });
    });
  });
  // The human can send work back for changes too, from the dashboard, without needing a review
  // assignment of its own — the control plane is trusted, exactly as it is for block and accept.
  app.post("/api/tasks/:taskId/assignments/:assignmentId/request-changes", (req, res) => {
    requireFields(req.body, ["summary"]);
    res.json(store.requestChanges({
      taskId: req.params.taskId,
      assignmentId: req.params.assignmentId,
      summary: req.body.summary,
      findings: Array.isArray(req.body.findings) ? req.body.findings : [],
    }));
  });
  // T2.6 — mid-flight steering. All three are control-plane only: an agent re-prioritising its own
  // queue, cancelling a teammate, or lifting a budget would defeat the point of the human having them.
  app.post("/api/tasks/:taskId/assignments/:assignmentId/priority", (req, res) => {
    requireFields(req.body, ["priority"]);
    res.json(store.prioritizeAssignment({ taskId: req.params.taskId, assignmentId: req.params.assignmentId, priority: req.body.priority }));
  });
  app.post("/api/tasks/:taskId/assignments/:assignmentId/cancel", (req, res) => {
    res.json(store.requestCancel({ taskId: req.params.taskId, assignmentId: req.params.assignmentId, reason: req.body?.reason }));
  });
  app.post("/api/tasks/:taskId/budget", (req, res) => {
    res.json(store.setTaskBudget({
      taskId: req.params.taskId,
      wallClockMinutes: req.body?.wallClockMinutes ?? null,
      spendUsd: req.body?.spendUsd ?? null,
    }));
  });
  // T4.3 — the whole task as a narrative, for when something went wrong and the question is where.
  app.get("/api/tasks/:taskId/replay", (req, res) => {
    const replay = store.taskReplay(req.params.taskId, { limit: Number(req.query.limit) || 1000 });
    if (String(req.query.format || "markdown") === "json") return res.json(replay);
    res.type("text/markdown; charset=utf-8").send(replay.markdown);
  });
  app.post("/api/tasks/:taskId/block", (req, res) => {
    requireFields(req.body, ["reason"]);
    res.json(store.blockTask({ taskId: req.params.taskId, reason: req.body.reason }));
  });
  app.post("/api/tasks/:taskId/unblock", (req, res) => {
    requireFields(req.body, ["reason"]);
    res.json(store.unblockTask({
      taskId: req.params.taskId,
      reason: req.body.reason,
      targetAgentName: req.body.targetAgentName || null,
    }));
  });
  app.post("/api/tasks/:taskId/accept", (req, res) => {
    requireFields(req.body, ["summary"]);
    res.json(store.acceptTaskByHuman({
      taskId: req.params.taskId, summary: req.body.summary, acceptStranded: req.body.acceptStranded === true,
    }));
  });
  app.delete("/api/agents/:agentId", (req, res) => {
    res.json(store.forgetAgent(req.params.agentId, { force: req.body?.force === true }));
  });
  app.post("/api/assignments/:assignmentId/force-release", (req, res) => {
    requireFields(req.body, ["confirmTitle"]);
    res.json(store.forceReleaseAssignment({ assignmentId: req.params.assignmentId, confirmTitle: req.body.confirmTitle }));
  });
  app.post("/api/tasks/:taskId/proposals", (req, res) => {
    requireFields(req.body, ["summary"]);
    res.status(201).json(store.createProposal({
      agentId: null,
      taskId: req.params.taskId,
      kind: req.body.kind || "decision",
      summary: req.body.summary,
      details: req.body.details || {},
    }));
  });
  app.post("/api/proposals/:proposalId/vote", (req, res) => {
    requireFields(req.body, ["vote"]);
    res.json(store.voteProposal({ agentId: null, proposalId: req.params.proposalId, vote: req.body.vote, comment: req.body.comment }));
  });

  app.get("/api/stream", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    store.on("change", send);
    send({ type: "connected", at: new Date().toISOString() });
    req.on("close", () => {
      clearInterval(keepAlive);
      store.off("change", send);
    });
  });

  app.use(express.static(publicDir, { extensions: ["html"] }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(400).json({ error: error?.message || "Unexpected DevTeam error." });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.once("error", reject);
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  // Sweep crashed or silently-closed agents on a timer so the dashboard reflects
  // reality even when no request is arriving to trigger the lazy reaper.
  const reaper = setInterval(() => {
    try { store.reapAndRecover(); } catch { /* keep the server alive across sweeps */ }
  }, 30_000);
  reaper.unref?.();

  return {
    app,
    server: httpServer,
    store,
    url,
    accessMode: mode,
    mcpUrl: `${url}/mcp`,
    async close() {
      clearInterval(reaper);
      supervisor.stopAll();
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
