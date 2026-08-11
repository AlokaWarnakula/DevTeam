import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const textResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const errorResult = (error) => ({
  isError: true,
  content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
});

const safe = (handler) => async (args) => {
  try {
    return textResult(await handler(args));
  } catch (error) {
    return errorResult(error);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDevTeamMcpServer(store, session = { agentId: null }) {
  const server = new McpServer({ name: "devteam", version: "0.2.0" }, {
    instructions: "DevTeam coordinates local AI development agents. Connect once, claim only assigned work, inspect the real project, report concrete changes and checks, request independent review, approve only the current version, and disconnect after acceptance or a blocker. Never push, deploy, publish, or perform destructive actions without explicit human approval in DevTeam.",
    capabilities: { logging: {} },
  });

  // Identity is bound to the MCP session that connected, not to the caller-supplied agentId.
  // Without this, any client sharing the bearer token could pass another agent's id and speak,
  // vote, approve, or disconnect as them — making the timeline's provenance untrustworthy.
  const requireIdentity = (agentId) => {
    if (!session.agentId) throw new Error("This MCP session has not connected. Call devteam_connect first.");
    if (agentId !== session.agentId) throw new Error("Identity mismatch: an MCP session may only act as the agent it connected as.");
  };

  // Reachability: piggyback any directed/broadcast messages waiting for this agent onto whatever
  // call it just made, so a *busy* agent (not sitting in devteam_wait) is still reached promptly
  // instead of only when it next goes idle.
  const withInbox = (agentId, result) => {
    let pendingMessages = [];
    let pendingProposals = [];
    try { pendingMessages = store.deliverDirectedMessages(agentId); } catch { pendingMessages = []; }
    // Surface open proposals the same way, so a *busy* agent (not sitting in devteam_wait) is asked to
    // vote on any call it makes instead of a unanimity decision silently stalling until it next goes
    // idle. Only proposals in its rooms that it has not yet voted on are returned.
    try { pendingProposals = store.openProposalsForAgent(store.getAgent(agentId)); } catch { pendingProposals = []; }
    if (!pendingMessages.length && !pendingProposals.length) return result;
    return {
      ...result,
      ...(pendingMessages.length ? { pendingMessages } : {}),
      ...(pendingProposals.length ? { pendingProposals } : {}),
    };
  };

  server.registerTool("devteam_connect", {
    title: "Connect to DevTeam",
    description: "Join the local DevTeam as a desktop agent. Call once at the start of a DevTeam session and retain the returned agentId.",
    inputSchema: {
      name: z.string().min(1).max(80).describe("Agent display name, for example Codex or Claude"),
      provider: z.string().min(1).max(80).describe("Provider or host, for example OpenAI Codex Desktop or Anthropic Claude Desktop"),
      capabilities: z.array(z.string().max(80)).max(20).default([]).describe("Useful specialties such as implementation, review, security, or testing"),
      taskId: z.string().uuid().optional().describe("Task room to join on connect. Required to disambiguate a server hosting more than one task."),
    },
  }, safe(async ({ name, provider, capabilities, taskId }) => {
    const agent = store.connectAgent({ name, provider, capabilities });
    session.agentId = agent.id;
    let room = null;
    if (taskId) {
      try { room = store.joinTask(agent.id, taskId); } catch (error) { room = { joined: false, error: error.message }; }
    }
    const { resumeToken, ...agentInfo } = agent;
    const roomStatus = store.roomStatusForAgent(agent.id);
    const roomRequired = roomStatus.joinedTaskIds.length === 0 && roomStatus.activeTasks.length > 0;
    return {
      connected: true,
      agent: agentInfo,
      room,
      ...(roomRequired ? { roomRequired: true, availableTasks: roomStatus.activeTasks } : {}),
      resumeToken,
      next: roomRequired
        ? "Choose the intended task from availableTasks and call devteam_join before devteam_wait. Keep resumeToken privately: if this session drops, pass it to devteam_resume."
        : "Call devteam_wait with this agentId. Keep resumeToken privately: if this session drops and you reconnect, pass it to devteam_resume to reclaim this session's work and missed messages.",
    };
  }));

  server.registerTool("devteam_resume", {
    title: "Resume a previous DevTeam session",
    description: "After reconnecting, reclaim the work, task room, and missed messages of an earlier session using the resumeToken it returned. Use this when the same agent (e.g. the same desktop chat) comes back, instead of leaving its claimed assignment stuck.",
    inputSchema: {
      agentId: z.string().uuid().describe("The agentId from your *current* devteam_connect"),
      resumeToken: z.string().min(1).max(200).describe("The resumeToken returned by the earlier session's devteam_connect"),
    },
  }, safe(async ({ agentId, resumeToken }) => {
    requireIdentity(agentId);
    return withInbox(agentId, store.resumeAgent({ agentId, resumeToken }));
  }));

  server.registerTool("devteam_join", {
    title: "Join a task room",
    description: "Join a specific task's room so you claim only its work, receive only its messages, and vote only on its proposals. In a single-task server you are placed in that room automatically; join explicitly when the server hosts more than one task, or to observe a specific one.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      role: z.enum(["contributor", "observer"]).default("contributor"),
    },
  }, safe(async ({ agentId, taskId, role }) => {
    requireIdentity(agentId);
    return withInbox(agentId, store.joinTask(agentId, taskId, role));
  }));

  server.registerTool("devteam_wait", {
    title: "Wait for DevTeam work or messages",
    description: "Block locally (no model tokens are spent while blocked) until DevTeam has an assignment or a human message for this agent. Returns 'room_required' immediately when a multi-task server needs an explicit devteam_join; otherwise returns early with status 'assigned' or 'message', or 'idle' after the timeout.",
    inputSchema: {
      agentId: z.string().uuid(),
      timeoutSeconds: z.number().int().min(1).max(50).default(45),
    },
  }, safe(async ({ agentId, timeoutSeconds }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId, "waiting");
    const initialRoomStatus = store.roomStatusForAgent(agentId);
    if (initialRoomStatus.joinedTaskIds.length === 0 && initialRoomStatus.activeTasks.length > 0) {
      return {
        status: "room_required",
        keepWaiting: false,
        availableTasks: initialRoomStatus.activeTasks,
        message: "This server has active work in multiple task rooms. Choose the intended taskId from availableTasks and call devteam_join before waiting.",
        next: "Call devteam_join with this agentId, the intended taskId, and role contributor; then call devteam_wait again.",
      };
    }
    const deadline = Date.now() + timeoutSeconds * 1000;
    do {
      // Live human messages take priority: the user is actively trying to reach this agent.
      const messages = store.deliverDirectedMessages(agentId);
      if (messages.length) {
        return {
          status: "message",
          messages,
          keepWaiting: true,
          next: "Read these messages. If a reply or acknowledgement is expected, post it with devteam_message, then call devteam_wait again to stay responsive to the team.",
        };
      }
      const proposals = store.openProposalsForAgent(store.getAgent(agentId));
      if (proposals.length) {
        return {
          status: "proposal",
          proposals,
          keepWaiting: true,
          next: "The team is deciding how to organise. Review each proposal and vote with devteam_vote (agree or object, with a short reason). A proposal is adopted only when every connected teammate agrees.",
        };
      }
      const assignment = store.claimNextAssignment(agentId);
      if (assignment) {
        return {
          status: "assigned",
          assignment,
          keepWaiting: true,
          instructions: "Inspect the current project state before acting. Complete this bounded assignment, then call devteam_report — pass back assignment.claimToken so a stale report is fenced if your lease moved. Use devteam_assign to delegate follow-up implementation, testing, or independent review.",
        };
      }
      store.heartbeat(agentId, "waiting");
      await sleep(Math.min(750, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    const activity = store.teamActivityForAgent(agentId);
    return {
      status: "idle",
      keepWaiting: activity.active,
      activity,
      message: activity.active
        ? "No work for you yet, but the team is still active (work is in flight or teammates are busy). Call devteam_wait again to stay assembled. If you have been idle with no assignment or message for about five minutes straight, disconnect and tell the user to invoke $devteam again when there is new work."
        : "The room is quiet: no open assignments and no busy teammates. Disconnect to save the session; the user can reconnect this agent when new work is ready.",
    };
  }));

  server.registerTool("devteam_state", {
    title: "Read DevTeam state",
    description: "Read the compact current state of a task before planning, implementing, or reviewing.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid().optional(),
    },
  }, safe(async ({ agentId, taskId }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId);
    if (taskId) store.assertMembership(agentId, taskId);
    return withInbox(agentId, taskId ? store.taskDetail(taskId) : store.snapshotForAgent(agentId));
  }));

  server.registerTool("devteam_brief", {
    title: "Read a compact task briefing",
    description: "Read a bounded, membership-scoped briefing instead of the full task timeline: goal/version/project, your current assignment, open work and dependencies, task/project memory, open proposals, recent decisions/findings, and unresolved questions.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
    },
  }, safe(async ({ agentId, taskId }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId);
    return withInbox(agentId, store.taskBrief(agentId, taskId));
  }));

  server.registerTool("devteam_message", {
    title: "Post a team message",
    description: "Post a focused progress note, design decision, review finding, or question. Omit target to post a timeline note the whole room can read; set target to a teammate's name to send a directed message that is pushed to them. Pass replyTo (a timeline event id from devteam_state) to answer a specific message as a thread.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      message: z.string().min(1).max(12000),
      kind: z.enum(["progress", "decision", "finding", "question"]).default("progress"),
      target: z.string().max(80).optional().describe("Direct this message to one teammate by name; omit to broadcast it to the room's timeline."),
      replyTo: z.number().int().positive().optional().describe("Timeline event id this message replies to"),
    },
  }, safe(async ({ agentId, taskId, message, kind, target, replyTo }) => {
    requireIdentity(agentId);
    const metadata = { ...(replyTo ? { replyTo } : {}), ...(target ? { target } : {}) };
    return withInbox(agentId, store.postMessage({ agentId, taskId, message, type: `agent.${kind}`, metadata }));
  }));

  server.registerTool("devteam_assign", {
    title: "Assign team work",
    description: "Create a bounded implementation, review, testing, research, or planning assignment for another available agent. Reviewer, security-reviewer, and tester assignments automatically carry a checklist so the team covers the usual blind spots; pass your own `checklist` to override it, or an empty array to omit it.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      title: z.string().min(1).max(160),
      description: z.string().min(1).max(12000),
      role: z.enum(["planner", "implementer", "reviewer", "security-reviewer", "tester", "researcher"]).default("implementer"),
      requiresWrite: z.boolean().default(false),
      targetAgentName: z.string().max(80).optional(),
      checklist: z.array(z.string().max(300)).max(40).optional().describe("Points the assignee must address; overrides the default checklist for the role"),
      paths: z.array(z.string().max(500)).max(50).optional().describe("For write work: the file paths/prefixes this assignment will modify (e.g. src/ocean/**). Declaring them lets non-overlapping writers run in parallel; omit for an exclusive whole-project lease."),
      dependsOn: z.array(z.string().uuid()).max(50).optional().describe("Existing same-task assignment IDs that must be done before this assignment can be claimed"),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.createAssignment(args));
  }));

  server.registerTool("devteam_propose", {
    title: "Propose a team decision",
    description: "Ask the team to agree on how to organise. Use kind 'role' to request that an agent take a role (creates that assignment on adoption), 'handoff' to move an existing assignment to another agent, or 'plan'/'decision' to record a shared decision. Adopted only when every connected teammate agrees.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      kind: z.enum(["role", "handoff", "plan", "decision"]).default("role"),
      summary: z.string().min(1).max(2000).describe("One line the team votes on, e.g. 'I take the security-reviewer role'"),
      details: z.object({
        role: z.enum(["planner", "implementer", "reviewer", "security-reviewer", "tester", "researcher"]).optional(),
        targetAgentName: z.string().max(80).optional().describe("Agent the role or handoff is for; defaults to the proposer"),
        title: z.string().max(160).optional(),
        description: z.string().max(4000).optional(),
        requiresWrite: z.boolean().optional(),
        assignmentId: z.string().uuid().optional().describe("For kind 'handoff': the assignment to move"),
        quorum: z.number().min(0).max(1).optional().describe("Adoption threshold over the voters present when proposed: 1 (default) = unanimity, 0.5 = simple majority, e.g. 0.67 = two-thirds"),
      }).default({}),
    },
  }, safe(async ({ agentId, taskId, kind, summary, details }) => {
    requireIdentity(agentId);
    const proposal = store.createProposal({ agentId, taskId, kind, summary, details });
    return withInbox(agentId, { proposed: true, proposal, next: "Teammates will see this on their next devteam_wait and vote. It is adopted when all connected teammates agree." });
  }));

  server.registerTool("devteam_vote", {
    title: "Vote on a team proposal",
    description: "Agree or object to an open team proposal. When every connected teammate agrees, the proposal is adopted and its effect (new role assignment or handoff) is applied automatically.",
    inputSchema: {
      agentId: z.string().uuid(),
      proposalId: z.string().uuid(),
      vote: z.enum(["agree", "object"]).default("agree"),
      comment: z.string().max(2000).optional(),
    },
  }, safe(async ({ agentId, proposalId, vote, comment }) => {
    requireIdentity(agentId);
    return withInbox(agentId, store.voteProposal({ agentId, proposalId, vote, comment }));
  }));

  server.registerTool("devteam_note_set", {
    title: "Write shared team memory",
    description: "Write versioned shared memory. scope=task (default) belongs to this job; scope=project persists across every task in the same project. Project scope is inferred from the authorized taskId, never an arbitrary projectId. Re-read and merge on a version conflict.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      scope: z.enum(["task", "project"]).default("task").describe("task for this job, project for durable memory shared by every task in the project"),
      key: z.string().min(1).max(120).describe("e.g. 'world', 'decisions', 'open-questions', 'ownership'"),
      value: z.string().min(0).max(100000).describe("The new content (plain text or a JSON string)"),
      expectedVersion: z.number().int().min(0).optional().describe("The version you last read; omit only for a first write you know is uncontended"),
    },
  }, safe(async ({ agentId, taskId, scope, key, value, expectedVersion }) => {
    requireIdentity(agentId);
    return withInbox(agentId, store.noteSet({ agentId, taskId, scope, key, value, expectedVersion: expectedVersion ?? null }));
  }));

  server.registerTool("devteam_note_get", {
    title: "Read shared team memory",
    description: "Read versioned task or project memory. scope=task (default) is job-specific; scope=project persists across every task in the same project. Omit key to list keys; pass key for its full value and version.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      scope: z.enum(["task", "project"]).default("task"),
      key: z.string().max(120).optional(),
    },
  }, safe(async ({ agentId, taskId, scope, key }) => {
    requireIdentity(agentId);
    store.assertMembership(agentId, taskId);
    if (key) {
      const note = store.noteGet(taskId, key, scope, agentId);
      return withInbox(agentId, note || { scope, key, value: null, version: 0, missing: true });
    }
    return withInbox(agentId, { scope, keys: store.noteList(taskId, scope, agentId) });
  }));

  server.registerTool("devteam_knowledge", {
    title: "Search durable project knowledge",
    description: "Search the automatic Obsidian-compatible project vault. DevTeam creates and refreshes it from completed assignments, adopted decisions, blockers, findings, and project memory; agents do not need to maintain it manually.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      query: z.string().max(500).default("").describe("Words, file path, component, or decision to find; empty returns the most relevant recent notes"),
      category: z.enum(["architecture", "decisions", "components", "conventions", "pitfalls", "workflows", "archive"]).optional(),
      status: z.enum(["verified", "inferred", "disputed", "stale", "archived"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeSearch(args));
  }));

  server.registerTool("devteam_report", {
    title: "Report completed work",
    description: "Complete the currently claimed assignment with evidence. Report exact files and checks; changed files advance the task version and invalidate prior approvals. status=blocked closes only this assignment and queues planner triage; use devteam_block separately only for a genuine task-wide blocker.",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid(),
      message: z.string().min(1).max(16000),
      status: z.enum(["done", "blocked"]).default("done").describe("blocked applies only to this assignment and queues planner triage; it does not stop the task"),
      changedFiles: z.array(z.string().max(500)).max(200).default([]),
      checks: z.array(z.string().max(500)).max(100).default([]),
      disconnectAfter: z.boolean().default(false),
      claimToken: z.string().max(200).optional().describe("The claimToken from the assignment you claimed (or from devteam_resume). Lets the server fence a stale report if your lease has since moved."),
    },
  }, safe(async ({ disconnectAfter, ...args }) => {
    requireIdentity(args.agentId);
    const result = store.completeAssignment({
      ...args,
      nextStatus: disconnectAfter ? "disconnected" : "waiting",
    });
    return disconnectAfter ? result : withInbox(args.agentId, result);
  }));

  server.registerTool("devteam_approve", {
    title: "Approve current task version",
    description: "Approve only after completing an independent read-only reviewer or tester assignment on the current version. Consensus accepts the task and keeps its agents assembled briefly for a same-conversation follow-up instead of disconnecting them.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      summary: z.string().min(1).max(8000),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.approveTask(args));
  }));

  server.registerTool("devteam_block", {
    title: "Block a task",
    description: "Stop the task when human input, authorization, or an external state change is genuinely required. Blocking disconnects assigned agents.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      reason: z.string().min(1).max(8000),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return store.blockTask(args);
  }));

  server.registerTool("devteam_disconnect", {
    title: "Disconnect from DevTeam",
    description: "End this desktop agent session after work is finished, blocked, or no longer needed.",
    inputSchema: {
      agentId: z.string().uuid(),
      summary: z.string().max(4000).default(""),
    },
  }, safe(async ({ agentId, summary }) => {
    requireIdentity(agentId);
    const result = store.disconnectAgent(agentId, summary);
    session.agentId = null;
    return result;
  }));

  return server;
}
