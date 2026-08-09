import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DevTeamStore } from "./store.mjs";
import { createDevTeamMcpServer } from "./mcp.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(moduleDir, "../../public");

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

export async function startDevTeamServer({
  host = "127.0.0.1",
  port = 7331,
  dataDir,
  workspaceRoot = process.cwd(),
  liveness = {},
} = {}) {
  if (!dataDir) throw new Error("dataDir is required.");
  const store = new DevTeamStore(dataDir, { liveness });
  const root = requireDirectory(workspaceRoot);
  store.ensureProject(path.basename(root), root);

  const app = createMcpExpressApp({ host });
  const transports = new Map();
  const mcpAuth = (req, res, next) => {
    if (req.get("authorization") !== `Bearer ${store.token}`) {
      return res.status(401).json({ error: "Invalid DevTeam token." });
    }
    next();
  };

  // DevTeam is a local-only control plane. Reject requests whose Host is not loopback
  // (blunts DNS-rebinding) and mutating requests carrying a foreign Origin (blocks a random
  // web page from POSTing tasks, messages, or votes into the room). Native clients and the
  // same-origin dashboard send either no Origin or a loopback Origin and are allowed.
  const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
  const hostnameOf = (value = "") => {
    const raw = String(value).trim();
    if (raw.startsWith("[")) return raw.slice(1, raw.indexOf("]")); // [::1]:port
    return raw.split(":")[0];
  };
  const apiGuard = (req, res, next) => {
    if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) {
      return res.status(403).json({ error: "DevTeam only accepts local (loopback) connections." });
    }
    const origin = req.get("origin");
    if (origin) {
      let originHost;
      try { originHost = new URL(origin).hostname; } catch { return res.status(403).json({ error: "Invalid Origin header." }); }
      if (!LOCAL_HOSTS.has(originHost)) {
        return res.status(403).json({ error: "Cross-origin requests are not allowed." });
      }
    }
    next();
  };
  app.use("/api", apiGuard);

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
    localOnly: host === "127.0.0.1" || host === "localhost",
    mcpUrl: `${req.protocol}://${req.get("host")}/mcp`,
    token: store.token,
    idleWaitSeconds: 45,
    liveness: store.liveness,
  }));
  app.get("/api/state", (req, res) => {
    const taskId = Object.hasOwn(req.query, "taskId") ? req.query.taskId || null : undefined;
    res.json(store.snapshot(taskId));
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
  app.delete("/api/projects/:projectId", (req, res) => {
    requireFields(req.body, ["confirmName"]);
    res.json(store.deleteProject(req.params.projectId, req.body.confirmName));
  });
  app.post("/api/tasks", (req, res) => {
    requireFields(req.body, ["projectId", "title", "description"]);
    res.status(201).json(store.createTask(req.body));
  });
  app.delete("/api/tasks/:taskId", (req, res) => {
    requireFields(req.body, ["confirmTaskId"]);
    res.json(store.deleteTask(req.params.taskId, req.body.confirmTaskId));
  });
  app.post("/api/tasks/:taskId/assignments", (req, res) => {
    requireFields(req.body, ["title", "description"]);
    res.status(201).json(store.createAssignment({ ...req.body, taskId: req.params.taskId }));
  });
  app.post("/api/tasks/:taskId/messages", (req, res) => {
    requireFields(req.body, ["message"]);
    res.status(201).json(store.humanMessage(req.params.taskId, req.body.message, req.body.target || "all", req.body.replyTo || null));
  });
  app.post("/api/tasks/:taskId/block", (req, res) => {
    requireFields(req.body, ["reason"]);
    res.json(store.blockTask({ taskId: req.params.taskId, reason: req.body.reason }));
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
    mcpUrl: `${url}/mcp`,
    async close() {
      clearInterval(reaper);
      await Promise.allSettled([...transports.values()].map((transport) => transport.close()));
      await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
