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
  const takeInbox = (agentId) => {
    let pendingMessages = [];
    let pendingProposals = [];
    try { pendingMessages = store.deliverDirectedMessages(agentId); } catch { pendingMessages = []; }
    // Surface open proposals the same way, so a *busy* agent (not sitting in devteam_wait) is asked to
    // vote on any call it makes instead of a unanimity decision silently stalling until it next goes
    // idle. Only proposals in its rooms that it has not yet voted on are returned.
    try { pendingProposals = store.openProposalsForAgent(store.getAgent(agentId)); } catch { pendingProposals = []; }
    return { pendingMessages, pendingProposals };
  };
  const withInbox = (agentId, result) => {
    const { pendingMessages, pendingProposals } = takeInbox(agentId);
    // Human steering rides along on whatever call the agent just made, for the same reason messages
    // do: an agent deep in a long edit is not sitting in devteam_wait, and "stop, this is no longer
    // worth doing" is worthless if it only arrives when the agent next goes idle.
    let steering = null;
    try { steering = store.steeringFor(agentId); } catch { steering = null; }
    if (!pendingMessages.length && !pendingProposals.length && !steering) return result;
    return {
      ...result,
      ...(pendingMessages.length ? { pendingMessages } : {}),
      ...(pendingProposals.length ? { pendingProposals } : {}),
      ...(steering ? { steering } : {}),
    };
  };

  server.registerTool("devteam_connect", {
    title: "Connect to DevTeam",
    description: "Join the local DevTeam as a desktop agent. Call once at the start of a DevTeam session and retain the returned agentId.",
    inputSchema: {
      name: z.string().min(1).max(80).describe("Agent display name, for example Codex or Claude"),
      provider: z.string().min(1).max(80).describe("Provider or host, for example OpenAI Codex Desktop or Anthropic Claude Desktop"),
      capabilities: z.array(z.string().max(80)).max(20).default([]).describe("Useful specialties such as implementation, review, security, or testing"),
      runtimeProfile: z.any().optional().describe("Provider-neutral host/runtime profile. Report only host-, adapter-, or user-supplied model and effort options; never invent availability."),
      sessionGeneration: z.number().int().min(1).optional().describe("Host-reported fresh conversation generation when available."),
      taskId: z.string().uuid().optional().describe("Task room to join on connect. Membership is explicit: without it you join no room and can claim nothing."),
    },
  }, safe(async ({ name, provider, capabilities, runtimeProfile, sessionGeneration, taskId }) => {
    const agent = store.connectAgent({ name, provider, capabilities, runtimeProfile, sessionGeneration, freshTaskId: taskId || null });
    session.agentId = agent.id;
    const { resumeToken, room, ...agentInfo } = agent;
    const roomStatus = store.roomStatusForAgent(agent.id);
    const roomRequired = roomStatus.joinedTaskIds.length === 0 && roomStatus.activeTasks.length > 0;
    return {
      connected: true,
      agent: agentInfo,
      room,
      ...(roomRequired ? { roomRequired: true, availableTasks: roomStatus.activeTasks } : {}),
      resumeToken,
      next: roomRequired
        ? "You are in no task room, so nothing is claimable. Choose the intended task from availableTasks and call devteam_join before devteam_wait. Keep resumeToken privately: if this session drops, pass it to devteam_resume."
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
    description: "Join a specific task's room so you claim only its work, receive only its messages, and vote only on its proposals. Membership is always explicit: until you join a room (here or via devteam_connect's taskId) nothing on the board is claimable by you.",
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
    description: "Block locally (no model tokens are spent while blocked) until DevTeam has an assignment or a human message for this agent. A new runtime recommendation is surfaced once; later waits keep blocking while the same recommendation remains undecided. Returns 'room_required' immediately when a multi-task server needs an explicit devteam_join; otherwise returns early with status 'assigned' or 'message', or 'idle' after the timeout.",
    inputSchema: {
      agentId: z.string().uuid(),
      timeoutSeconds: z.number().int().min(1).max(50).default(45),
    },
  }, safe(async ({ agentId, timeoutSeconds }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId, "waiting");
    // A stop request or a blown budget outranks waiting for more work: an agent should not sit in a
    // long poll for 45 seconds after the human has asked it to stop.
    const steering = store.steeringFor(agentId);
    if (steering) {
      return { status: "steering", keepWaiting: false, steering, next: steering.next || "Act on this before waiting again." };
    }
    const initialRoomStatus = store.roomStatusForAgent(agentId);
    if (initialRoomStatus.joinedTaskIds.length === 0 && initialRoomStatus.activeTasks.length > 0) {
      return {
        status: "room_required",
        keepWaiting: false,
        availableTasks: initialRoomStatus.activeTasks,
        message: "You have joined no task room, so no work here is claimable by you. Choose the intended taskId from availableTasks and call devteam_join before waiting.",
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
      const rotation = store.sessionRotationRecommendation(agentId);
      if (rotation) return { ...rotation, keepWaiting: true };
      const assignment = store.claimNextAssignment(agentId);
      if (assignment) {
        if (assignment.runtimeActionRequired) {
          // The first recommendation needs a model turn so the agent can ask the human. Once it has
          // already been delivered, keep this local wait blocked instead of returning the same gate
          // every 750 ms and burning a model turn per retry.
          if (!assignment.alreadyRecommended) {
            return {
              ...assignment,
              keepWaiting: true,
              next: "No lease was acquired. Ask the user to switch, continue, reassign, or cancel, then record the choice with devteam_runtime_decision. If settings changed, call devteam_runtime_update first.",
            };
          }
        } else {
          return store.taskBrief(agentId, assignment.task_id, {
            currentAssignment: assignment,
            assignmentKey: "assignment",
            responseCore: {
              status: "assigned",
              keepWaiting: true,
              instructions: "Inspect the current project state before acting. Complete this bounded assignment, then call devteam_report — pass back assignment.claimToken so a stale report is fenced if your lease moved. Use devteam_assign to delegate follow-up implementation, testing, or independent review.",
            },
          });
        }
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
    description: "Read a bounded, membership-scoped briefing instead of the full task timeline: goal/version/project, your current assignment, open work and dependencies, task/project memory, relevant durable knowledge, automatic bounded code context, recent decisions/findings, and unresolved questions.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
    },
  }, safe(async ({ agentId, taskId }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId);
    const { pendingMessages, pendingProposals } = takeInbox(agentId);
    return store.taskBrief(agentId, taskId, { pendingMessages, pendingProposals });
  }));

  server.registerTool("devteam_runtime_update", {
    title: "Update this session's runtime profile",
    description: "Refresh provider-neutral current/available model and effort capabilities for this exact agent session. Use only host-, adapter-, or explicitly user-supplied facts; unknown values must remain unknown.",
    inputSchema: {
      agentId: z.string().uuid(),
      profile: z.any(),
    },
  }, safe(async ({ agentId, profile }) => {
    requireIdentity(agentId);
    return withInbox(agentId, { updated: true, runtimeProfile: store.updateRuntimeProfile({ agentId, profile }) });
  }));

  server.registerTool("devteam_session_continue", {
    title: "Continue the current session",
    description: "Record the human choice to continue this desktop session after a fresh-session recommendation. This is advisory and does not prove context quality.",
    inputSchema: { agentId: z.string().uuid(), taskId: z.string().uuid() },
  }, safe(async ({ agentId, taskId }) => {
    requireIdentity(agentId);
    return withInbox(agentId, store.continueCurrentSession({ agentId, taskId }));
  }));

  server.registerTool("devteam_assignment_assessment", {
    title: "Read an assignment complexity assessment",
    description: "Return the deterministic provider-neutral score, level, reasons, and normalized runtime requirements for an assignment in this task room.",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid(),
    },
  }, safe(async ({ agentId, assignmentId }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId);
    return withInbox(agentId, store.assignmentAssessment({ agentId, assignmentId }));
  }));

  server.registerTool("devteam_runtime_decision", {
    title: "Record a runtime gate decision",
    description: "After runtime_action_required, record switched, continue, reassign, or cancel. Exceptional settings cannot be approved by an agent; the human must approve them in the authenticated dashboard.",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid(),
      assessmentId: z.string().uuid(),
      choice: z.enum(["switched", "continue", "reassign", "cancel"]),
      reason: z.string().max(1000).optional(),
    },
  }, safe(async ({ agentId, assignmentId, assessmentId, choice, reason }) => {
    requireIdentity(agentId);
    return withInbox(agentId, store.runtimeDecision({ agentId, assignmentId, assessmentId, choice, reason, actor: "agent", humanApproved: false }));
  }));

  server.registerTool("devteam_session_checkpoint", {
    title: "Create a safe session checkpoint",
    description: "Create a redacted, bounded handoff capsule before intentionally replacing this session. If this session owns an assignment, its existing claim stays live until a fresh connected session successfully takes over. Returns a one-time handoff token; keep it private and pass it only to the intended fresh session.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      assignmentId: z.string().uuid().optional().describe("Active assignment to hand off; omitted means this session's current claim in the task, if any."),
      decisions: z.array(z.string().max(1200)).max(30).default([]),
      blockers: z.array(z.string().max(1200)).max(30).default([]),
      checks: z.array(z.string().max(1000)).max(50).default([]),
      failedApproaches: z.array(z.string().max(1200)).max(30).default([]),
      nextAction: z.string().max(2000).default(""),
      expiresInMinutes: z.number().int().min(1).max(1440).default(30),
    },
  }, safe(async ({ expiresInMinutes, ...args }) => {
    requireIdentity(args.agentId);
    const result = await store.createSessionCheckpoint({ ...args, expiresInMs: expiresInMinutes * 60_000 });
    return withInbox(args.agentId, {
      ...result,
      next: "Keep the old session and claim intact. Open a fresh session, connect and join this task, then call devteam_session_takeover with checkpoint.id and the one-time handoffToken.",
    });
  }));

  server.registerTool("devteam_session_checkpoint_get", {
    title: "Read a session checkpoint",
    description: "Read an authorized task's bounded checkpoint capsule without changing assignment ownership. This never returns a stored handoff-token hash, resume token, claim token, agent secret, or source body.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      checkpointId: z.string().uuid(),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.sessionCheckpointGet(args));
  }));

  server.registerTool("devteam_session_takeover", {
    title: "Safely take over a session checkpoint",
    description: "Use a one-time handoff token from the old session to atomically continue in this intentionally fresh session. DevTeam verifies task membership, expiry, token, checkpoint generation, and the exact claim; then it bumps the claim generation, issues a new fencing token, consumes the handoff token, and retires the old session in one transaction.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      checkpointId: z.string().uuid(),
      handoffToken: z.string().min(16).max(200),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, await store.takeoverSessionCheckpoint(args));
  }));

  server.registerTool("devteam_session_checkpoint_cancel", {
    title: "Cancel a session checkpoint",
    description: "Cancel this session's unused checkpoint without releasing its active assignment claim. The one-time handoff token is invalidated immediately.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      checkpointId: z.string().uuid(),
      reason: z.string().max(800).default("Session rotation cancelled."),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.cancelSessionCheckpoint(args));
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
      role: z.string().min(1).max(40).default("implementer").describe("A role this project defines. Call devteam_roles to see them — a project may use its own vocabulary (analyst, fact-checker, editor) rather than software job titles. A role that verifies makes this a review assignment to the scheduler."),
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
        role: z.string().min(1).max(40).optional().describe("A role this project defines; see devteam_roles"),
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

  server.registerTool("devteam_codegraph", {
    title: "Inspect the automatic code graph",
    description: "Return a bounded, task-membership-scoped one-hop neighborhood for one indexed module. Results contain paths and symbols only, never source bodies.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      path: z.string().min(1).max(500).describe("Project-relative module path"),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.codeGraphSearch({ agentId: args.agentId, taskId: args.taskId, path: args.path }));
  }));

  server.registerTool("devteam_report", {
    title: "Report completed work",
    description: "Complete the currently claimed assignment with evidence. Report exact files and checks; changed files advance the task version and invalidate prior approvals. A check may carry a command, which DevTeam runs itself inside the project root and grades by exit code — a report claiming success for a command that actually fails is refused, and your claim is left intact so you can fix it and report again. Checks without a command are recorded as your assertion and labeled as such. While those commands run the assignment shows as verifying and keeps your claim; if this returns completed:false with a verifying payload, an earlier report of yours is still being checked — wait for it rather than reporting again. status=blocked closes only this assignment and queues planner triage; use devteam_block separately only for a genuine task-wide blocker.",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid(),
      message: z.string().min(1).max(16000),
      status: z.enum(["done", "blocked"]).default("done").describe("blocked applies only to this assignment and queues planner triage; it does not stop the task"),
      changedFiles: z.array(z.string().max(500)).max(200).default([]),
      checks: z.array(z.union([
        z.string().max(500).describe("An assertion you are making, recorded and labeled as agent-asserted."),
        z.object({
          label: z.string().min(1).max(500).describe("How this check should read in the timeline"),
          command: z.string().max(200).optional().describe("Name of a command the human allowlisted for this project (for example \"test\", or \"npm run test\"). DevTeam runs it and grades the result; your text only selects an allowlisted entry, it is never executed as written."),
        }),
      ])).max(100).default([]),
      disconnectAfter: z.boolean().default(false),
      claimToken: z.string().max(200).optional().describe("The claimToken from the assignment you claimed (or from devteam_resume). Lets the server fence a stale report if your lease has since moved."),
      usage: z.object({
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        costUsd: z.number().min(0).optional(),
        model: z.string().max(120).optional(),
      }).optional().describe("What this assignment cost you, if your host tells you. Recorded and shown as agent-reported — DevTeam cannot measure it and does not pretend to. Report real figures or omit this entirely; never estimate."),
    },
  }, safe(async ({ disconnectAfter, ...args }) => {
    requireIdentity(args.agentId);
    const result = await store.completeAssignment({
      ...args,
      nextStatus: disconnectAfter ? "disconnected" : "waiting",
    });
    return disconnectAfter ? result : withInbox(args.agentId, result);
  }));

  server.registerTool("devteam_why_blocked", {
    title: "Ask why work is not claimable",
    description: "Idle with work on the board? Ask the scheduler for the full ordered reason chain instead of guessing. Omit assignmentId to get every queued item in your rooms; pass one to ask about a specific assignment. Reason codes name the actual blocker (the writer you wait for, the agent holding an overlapping write lease, each unmet dependency, the runtime gap).",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid().optional().describe("A specific queued assignment; omit to explain everything queued in your rooms."),
      taskId: z.string().uuid().optional().describe("Narrow the bulk answer to one task room."),
    },
  }, safe(async ({ agentId, assignmentId, taskId }) => {
    requireIdentity(agentId);
    store.heartbeat(agentId);
    if (!assignmentId) return withInbox(agentId, store.whyNoClaimableWork(agentId, taskId || null));
    // Authorize before computing: whyNotClaimable resolves write scopes on disk, and an unauthorized
    // caller should not be able to spend that work — nor tell a missing assignment from a private one.
    const room = store.assignmentRoom(assignmentId);
    if (!room) throw new Error("You are not a member of this task room. Call devteam_join first.");
    store.assertExplainable(agentId, room);
    return withInbox(agentId, store.whyNotClaimable(assignmentId, agentId));
  }));

  server.registerTool("devteam_split", {
    title: "Divide work that turned out too big",
    description: "Claimed something and found it is three days of work, or two unrelated jobs wearing one title? Split it into pieces instead of grinding through it or reporting blocked. You keep your claim and your write lease throughout — splitting never costs you the work you are holding. Each piece inherits the parent's write scope (unless it declares its own), its dependencies and its targeting, and is re-assessed on its own merits so a runtime gate does not treat a small piece as if it were the whole. Where two pieces declare overlapping write paths, DevTeam orders them for you rather than letting them contend for a lease. Use this when the shape of the work is wrong, not when it is merely hard.",
    inputSchema: {
      agentId: z.string().uuid(),
      assignmentId: z.string().uuid().describe("The assignment you currently hold"),
      claimToken: z.string().max(200).optional().describe("Your claimToken, so a stale session cannot reshape work whose lease has moved"),
      keepParent: z.boolean().default(false).describe("Keep holding the original — use when you are part-way through one piece and want to hand off the rest. Default closes it, since its work now lives in the pieces."),
      parts: z.array(z.object({
        title: z.string().min(1).max(160),
        description: z.string().min(1).max(12000),
        role: z.string().min(1).max(40).optional().describe("Defaults to the parent's role; see devteam_roles"),
        requiresWrite: z.boolean().optional().describe("Defaults to the parent's setting"),
        paths: z.array(z.string().max(500)).max(50).optional().describe("This piece's own write scope. Omit to inherit the parent's — never omit it expecting a narrower lease, you will get the parent's."),
        dependsOnPart: z.number().int().min(0).max(11).optional().describe("Index of an earlier part in this list that must finish first"),
      })).min(2).max(12).describe("At least two pieces. If the work is simply mis-scoped rather than too big, report it blocked instead."),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.splitAssignment(args));
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

  server.registerTool("devteam_reliability", {
    title: "What the team has learned about its members",
    description: "Rolling per-agent record: work completed, reports refused because a check DevTeam ran failed, work sent back for changes and how many rounds, regressions caused (only where a single agent is the sole suspect) and regressions caught. Use it to decide who to route work to, or to check your own record before claiming something critical. It is not a blame ledger — catching a regression counts for you, and an agent with little history is treated as trustworthy rather than punished for being new.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      agentName: z.string().max(80).optional().describe("One teammate by name; omit for the whole room"),
      windowDays: z.number().int().min(1).max(365).default(30),
    },
  }, safe(async ({ agentId, taskId, agentName, windowDays }) => {
    requireIdentity(agentId);
    store.assertMembership(agentId, taskId);
    return withInbox(agentId, agentName
      ? { agent: store.agentReliability(agentName, { windowDays }) }
      : { team: store.teamReliability({ windowDays }) });
  }));

  server.registerTool("devteam_regressions", {
    title: "What is currently broken in this task",
    description: "Checks that used to pass and now fail, with the work that landed since each was last green. Read this before assuming a failing check is your own fault: if a fix assignment is already queued for someone else, chasing it duplicates their work. Regressions close themselves when the check goes green again.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
    },
  }, safe(async ({ agentId, taskId }) => {
    requireIdentity(agentId);
    store.assertMembership(agentId, taskId);
    return withInbox(agentId, {
      regressions: store.openRegressions(taskId),
      baseline: store.checkBaseline(taskId),
    });
  }));

  server.registerTool("devteam_knowledge_write", {
    title: "Record something you learned",
    description: "Write a durable note into the project's knowledge vault. Use this the moment you learn a fact the *next* session would otherwise have to rediscover — an API rate limit, why an obvious approach does not work here, a convention the code follows but does not state, a pitfall that cost you an hour. This is not a progress update (use devteam_message) and not a decision the team voted on (use devteam_propose): it is a fact about the project. Link related notes inline with [[category/slug]] and they become navigable both ways. Notes you write are recorded as 'inferred', never 'verified' — verified means DevTeam observed it, not that you were confident.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      category: z.enum(["architecture", "decisions", "components", "conventions", "pitfalls", "workflows"])
        .describe("architecture: how the system fits together. decisions: a choice and its reason. components: what one part does. conventions: a rule the project follows. pitfalls: something that will bite the next person. workflows: how a recurring job is done."),
      title: z.string().min(1).max(200).describe("The fact as a short statement, not a topic — 'The billing API rate-limits at 30 requests/minute', not 'Billing API'"),
      body: z.string().min(1).max(4000).describe("The fact itself, with enough context to act on. Use [[category/slug]] to link related notes."),
      confidence: z.enum(["low", "medium", "high"]).default("medium").describe("How sure you are. Be honest: a low-confidence note is still worth recording and is ranked accordingly."),
      relatedFiles: z.array(z.string().max(500)).max(20).default([]).describe("Project-relative files this fact concerns, so it goes stale when they change"),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeWrite(args));
  }));

  server.registerTool("devteam_knowledge_maintain", {
    title: "Knowledge that needs attention",
    description: "Notes nobody has confirmed in a long time, and notes flagged as contradicting each other. A fact does not become false by getting old, but an unconfirmed one is a weaker basis for acting — and DevTeam ranks it lower until someone checks it. Work this queue when the room is quiet: confirm what still holds with devteam_knowledge_confirm, write over what does not.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      olderThanDays: z.number().int().min(1).max(3650).default(90),
      limit: z.number().int().min(1).max(100).default(20),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeMaintenance(args));
  }));

  server.registerTool("devteam_knowledge_confirm", {
    title: "Confirm a knowledge note still holds",
    description: "Say that a note is still true of the project as it stands now. This is the only thing that resets a note's age, so use it only after actually checking — re-reading a note is not confirmation.",
    inputSchema: { agentId: z.string().uuid(), taskId: z.string().uuid(), noteId: z.string().min(1).max(64) },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeConfirm(args));
  }));

  server.registerTool("devteam_knowledge_dispute", {
    title: "Flag two knowledge notes as contradicting each other",
    description: "When two notes about the same subject cannot both be true, say so. Both drop to 'disputed' and stop being served in briefings until resolved — better a gap than confidently serving one of two contradictory facts. devteam_knowledge_write tells you about likely conflicts when you write a note; this is how you act on that.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      noteIds: z.array(z.string().min(1).max(64)).min(2).max(10),
      reason: z.string().min(1).max(1000).describe("What the disagreement is"),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeDispute(args));
  }));

  server.registerTool("devteam_knowledge_share", {
    title: "Offer a lesson to other projects",
    description: "Mark a convention or pitfall as worth carrying to other projects on this server, or withdraw it. Only conventions and pitfalls can be shared: an architecture note or a decision is about this system in particular and cannot be true elsewhere. A note containing anything credential-shaped is refused. Read what others have shared with devteam_knowledge_borrowed.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      noteId: z.string().min(1).max(64),
      shared: z.boolean().default(true),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeShare(args));
  }));

  server.registerTool("devteam_knowledge_borrowed", {
    title: "Lessons other projects have shared",
    description: "Conventions and pitfalls other projects on this server chose to share. Each says which project it came from. Confirm a borrowed lesson applies here before acting on it — it was learned somewhere else.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      query: z.string().max(200).default(""),
      limit: z.number().int().min(1).max(50).default(10),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeShared(args));
  }));

  server.registerTool("devteam_knowledge_links", {
    title: "See what references a knowledge note",
    description: "What points at this note, and what it points at. Use it to judge whether a note is load-bearing before acting against it: a decision with six things referencing it is not one to quietly reverse. Note IDs come from devteam_knowledge results.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      noteId: z.string().min(1).max(64),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.knowledgeLinks(args));
  }));

  server.registerTool("devteam_roles", {
    title: "List the roles this project uses",
    description: "The roles this project defines, and what each one means to the scheduler. A project sets these in .devteam/roles.json and may use its own vocabulary — `analyst`, `fact-checker`, `domain-expert`, `copy-editor` — rather than software job titles. Two behaviours matter: a role that `verifies` reads the work rather than changing it, so its assignments wait for pending writers and completing one earns the right to approve or request changes; a role that `plans` decides what the team does next. Read this before devteam_assign if you are creating work in a project you have not seen.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid().describe("Any task in the project whose roles you want"),
    },
  }, safe(async ({ agentId, taskId }) => {
    requireIdentity(agentId);
    store.assertMembership(agentId, taskId);
    const task = store.getTask(taskId);
    if (!task) throw new Error("Task not found.");
    return withInbox(agentId, store.roleCatalogue(task.project_id));
  }));

  server.registerTool("devteam_request_changes", {
    title: "Send work back to its author for changes",
    description: "Found problems in work you reviewed? Send that assignment back to whoever wrote it, with your findings attached, instead of approving it anyway or blocking the task. The original assignment is reopened and addressed to its author, keeping its title, checklist, write scope and history; the author is handed your findings when it re-claims. Approvals on the current version are cleared, because the version you were reviewing is no longer settled. This does not stop the task and does not touch anyone else's claim. Requires the same standing as approving: a completed or in-progress read-only reviewer or tester assignment on the current version.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      assignmentId: z.string().uuid().describe("The completed assignment that needs changes — the author's work, not your own review assignment"),
      summary: z.string().min(1).max(4000).describe("One line on why this is going back"),
      findings: z.array(z.union([
        z.string().max(2000).describe("One thing that must change"),
        z.object({
          detail: z.string().min(1).max(2000).describe("What must change and why"),
          path: z.string().max(500).optional().describe("The project-relative file it concerns, when it concerns one"),
        }),
      ])).max(50).default([]).describe("The specific changes required. The author is handed this list on re-claim, so be concrete."),
    },
  }, safe(async (args) => {
    requireIdentity(args.agentId);
    return withInbox(args.agentId, store.requestChanges(args));
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
