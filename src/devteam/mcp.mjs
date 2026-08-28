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
    if (!session.agentId) throw new Error("This MCP session has not connected. Call devteam_join first.");
    if (agentId !== session.agentId) throw new Error("Identity mismatch: an MCP session may only act as the agent it connected as.");
  };

  // Reachability: piggyback any directed/broadcast messages waiting for this agent onto whatever
  // call it just made, so a *busy* agent (not sitting in devteam_next) is still reached promptly
  // instead of only when it next goes idle.
  const takeInbox = (agentId) => {
    let pendingMessages = [];
    let pendingProposals = [];
    try { pendingMessages = store.deliverDirectedMessages(agentId); } catch { pendingMessages = []; }
    // Surface open proposals the same way, so a *busy* agent (not sitting in devteam_next) is asked to
    // vote on any call it makes instead of a unanimity decision silently stalling until it next goes
    // idle. Only proposals in its rooms that it has not yet voted on are returned.
    try { pendingProposals = store.openProposalsForAgent(store.getAgent(agentId)); } catch { pendingProposals = []; }
    return { pendingMessages, pendingProposals };
  };
  const withInbox = (agentId, result) => {
    const { pendingMessages, pendingProposals } = takeInbox(agentId);
    // Human steering rides along on whatever call the agent just made, for the same reason messages
    // do: an agent deep in a long edit is not sitting in devteam_next, and "stop, this is no longer
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

  // Arriving. Four tools — connect, join, resume, roles — were four ways of saying "I am here, put
  // me in the room", and an agent had to get the order right before it could do anything at all.
  // Now one call covers a first arrival, joining a further room, and coming back after a dropped
  // session, and it answers with the project's own role vocabulary so nobody has to ask separately.
  // Arriving. Four tools — connect, join, resume, roles — were four ways of saying "I am here, put
  // me in the room", and an agent had to get the order right before it could do anything at all.
  // Now one call covers a first arrival, joining a further room, and coming back after a dropped
  // session, and it answers with the project's own role vocabulary so nobody has to ask separately.
  server.registerTool("devteam_join", {
    title: "Join the team",
    description: "Call this first. With name and provider you arrive as a new session; add taskId to enter that task's room at the same time. Membership is always explicit — until you are in a room, nothing on the board is claimable by you, and the reply lists the rooms you could join. Keep the returned agentId and resumeToken privately: if the session drops, call again with your new agentId plus that resumeToken to reclaim the work, room and missed messages of the old one rather than leaving its claim stuck. Already connected and want another room? Pass your agentId and the taskId. The reply also carries the roles this project defines — a project sets its own vocabulary in .devteam/roles.json and may use `analyst`, `fact-checker` or `domain-expert` rather than software job titles. Two behaviours matter: a role that verifies reads work rather than changing it, so it waits for pending writers and earns the right to pass a verdict; a role that plans decides what the team does next.",
    inputSchema: {
      name: z.string().min(1).max(80).optional().describe("Your display name on a first arrival, for example Codex or Claude"),
      provider: z.string().min(1).max(80).optional().describe("Your host on a first arrival, for example OpenAI Codex or Anthropic Claude Code"),
      capabilities: z.array(z.string().max(80)).max(20).default([]).describe("What you are good at — implementation, review, security, testing, research. DevTeam matches these to work; it never appoints you to a role you did not claim."),
      model: z.string().max(80).optional().describe("The model you are running as right now, in the name a human would recognise — \"Sonnet 5\", \"Opus 5\". Report what you actually are; do not guess."),
      effort: z.string().max(40).optional().describe("The effort or thinking level you are running at right now — low, medium, high, maximum — if your host exposes one."),
      ladder: z.array(z.object({
        model: z.string().min(1).max(80),
        effort: z.string().max(40).optional(),
      })).max(12).optional().describe("The model and effort combinations THIS host can run you at, ordered weakest first. Send it when the reply to a previous join asked for it, or on a first arrival. DevTeam uses it only to say which rung a piece of work needs and whether you are on it — it is never compared against another provider. Report only combinations you know your host offers."),
      taskId: z.string().uuid().optional().describe("The task room to enter"),
      role: z.enum(["contributor", "observer"]).default("contributor").describe("Observers watch and never claim work"),
      agentId: z.string().uuid().optional().describe("Your existing agentId, when joining a further room or resuming"),
      resumeToken: z.string().max(200).optional().describe("The resumeToken from the session you are reclaiming, alongside your new agentId"),
    },
  }, safe(async (args) => {
    const { name, provider, capabilities, taskId, role, agentId, resumeToken, model, effort, ladder } = args;
    // Resuming and joining act as an already-connected agent; arriving is the one call that has no
    // identity yet, and it is what establishes one for this MCP session.
    if (resumeToken) {
      if (!agentId) throw new Error("Resuming needs the agentId from your current arrival, plus the earlier session's resumeToken.");
      requireIdentity(agentId);
      return withInbox(agentId, store.resumeAgent({ agentId, resumeToken }));
    }
    if (agentId) {
      requireIdentity(agentId);
      if (!taskId) throw new Error("Pass taskId to say which room you are joining.");
      const joined = store.joinTask(agentId, taskId, role);
      const task = store.getTask(taskId);
      return withInbox(agentId, {
        ...joined,
        roles: task ? store.roleCatalogue(task.project_id) : null,
        runtime: store.runtimeLadder({ agentId, taskId, model, effort, ladder }),
      });
    }
    if (!name || !provider) throw new Error("A first arrival needs name and provider.");
    const agent = store.connectAgent({ name, provider, capabilities, freshTaskId: taskId || null, model, effort });
    session.agentId = agent.id;
    const { resumeToken: token, room, ...agentInfo } = agent;
    const roomStatus = store.roomStatusForAgent(agent.id);
    const roomRequired = roomStatus.joinedTaskIds.length === 0 && roomStatus.activeTasks.length > 0;
    const task = taskId ? store.getTask(taskId) : null;
    const runtime = taskId ? store.runtimeLadder({ agentId: agent.id, taskId, model, effort, ladder }) : null;
    return {
      connected: true,
      agent: agentInfo,
      room,
      ...(task ? { roles: store.roleCatalogue(task.project_id) } : {}),
      ...(runtime ? { runtime } : {}),
      ...(roomRequired ? { roomRequired: true, availableTasks: roomStatus.activeTasks } : {}),
      resumeToken: token,
      next: roomRequired
        ? "You are in no room, so nothing is claimable. Pick the intended task from availableTasks and call devteam_join again with your agentId and that taskId, then devteam_next. Keep resumeToken privately."
        : "Call devteam_next with this agentId. Keep resumeToken privately: if this session drops, join again and pass it to reclaim this session's work and missed messages.",
    };
  }));

  server.registerTool("devteam_next", {
    title: "Get your next piece of work, or look something up",
    description: "Your main loop. With no arguments beyond agentId it blocks locally until DevTeam has an assignment or a message for you — no model tokens are spent while blocked — and returns everything you need to start: the task, your assignment with its claim token, write scope and checklist, the relevant project memory, a map of the code around it, recent decisions and open questions. Returns 'room_required' if you are in no room yet, 'assigned' or 'message' when something arrives, or 'idle' after the timeout. The other modes are lookups, and none of them blocks: want=state reads the compact current state of a task, want=brief re-reads the full briefing for a task you are already working, want=module returns the one-hop neighbourhood of a file from the code graph (paths and symbols, never source), and want=complexity returns the deterministic score and reasons behind one assignment.",
    inputSchema: {
      agentId: z.string().uuid(),
      want: z.enum(["work", "state", "brief", "module", "complexity"]).default("work"),
      timeoutSeconds: z.number().int().min(1).max(50).default(45).describe("want=work only: how long to block before answering idle"),
      taskId: z.string().uuid().optional().describe("Required for brief and module; optional for state to narrow it to one task"),
      path: z.string().max(500).optional().describe("want=module: the project-relative file whose neighbours you want"),
      assignmentId: z.string().uuid().optional().describe("want=complexity: the assignment to score"),
    },
  }, safe(async ({ agentId, want, timeoutSeconds, taskId, path: modulePath, assignmentId }) => {
    // The lookups first: they are the same act as waiting — "tell me what I need to work" — but
    // answered from what DevTeam already knows instead of by blocking for something new.
    if (want === "state") {
      requireIdentity(agentId);
      store.heartbeat(agentId);
      if (taskId) store.assertMembership(agentId, taskId);
      return withInbox(agentId, taskId ? store.taskDetail(taskId) : store.snapshotForAgent(agentId));
    }
    if (want === "brief") {
      requireIdentity(agentId);
      store.heartbeat(agentId);
      if (!taskId) throw new Error("want=brief needs taskId.");
      const { pendingMessages, pendingProposals } = takeInbox(agentId);
      return store.taskBrief(agentId, taskId, { pendingMessages, pendingProposals });
    }
    if (want === "module") {
      requireIdentity(agentId);
      if (!taskId || !modulePath) throw new Error("want=module needs taskId and path.");
      return withInbox(agentId, store.codeGraphSearch({ agentId, taskId, path: modulePath }));
    }
    if (want === "complexity") {
      requireIdentity(agentId);
      store.heartbeat(agentId);
      if (!assignmentId) throw new Error("want=complexity needs assignmentId.");
      return withInbox(agentId, store.assignmentAssessment({ agentId, assignmentId }));
    }
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
        next: "Call devteam_join with this agentId, the intended taskId, and role contributor; then call devteam_next again.",
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
          next: "Read these messages. If a reply or acknowledgement is expected, post it with devteam_message, then call devteam_next again to stay responsive to the team.",
        };
      }
      const proposals = store.openProposalsForAgent(store.getAgent(agentId));
      if (proposals.length) {
        return {
          status: "proposal",
          proposals,
          keepWaiting: true,
          next: "The team is deciding how to organise. Review each proposal and vote with devteam_verdict (agree or object, with a short reason). A proposal is adopted only when every connected teammate agrees.",
        };
      }
      const assignment = store.claimNextAssignment(agentId);
      if (assignment) {
        return store.taskBrief(agentId, assignment.task_id, {
          currentAssignment: assignment,
          assignmentKey: "assignment",
          responseCore: {
            status: "assigned",
            keepWaiting: true,
            instructions: "Inspect the current project state before acting. Complete this bounded assignment, then call devteam_report — pass back assignment.claimToken so a stale report is fenced if your lease moved. Use devteam_plan to delegate follow-up implementation, testing, or independent review.",
          },
        });
      }
      store.heartbeat(agentId, "waiting");
      await sleep(Math.min(750, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    const activity = store.teamActivityForAgent(agentId);
    // A room the human blocked looks exactly like a finished one from here: no work, no busy
    // teammates. Say which task is stopped and that only the human can restart it, so the idle
    // answer cannot be read as "the team is done" or as licence to recreate the task elsewhere.
    const blockedRooms = store.blockedRoomsForAgent(agentId);
    if (blockedRooms.length && !activity.active) {
      return {
        status: "idle",
        keepWaiting: false,
        activity,
        blockedRooms,
        message: `Nothing is claimable because ${blockedRooms.length === 1 ? "this task is blocked" : "these tasks are blocked"}: ${blockedRooms.map((room) => `"${room.taskTitle}"${room.reason ? ` — ${room.reason}` : ""}`).join("; ")}.`,
        next: blockedRooms[0].agentAction,
      };
    }
    // Idle because the rest needs a stronger session is a completely different answer from idle
    // because the work is finished, and the two look identical from here. Say which it is: the
    // scheduler withheld those assignments rather than blocking the task, so this agent has already
    // finished everything it could, and what remains is waiting for a model, not for a decision.
    const aboveRung = store.workAboveCurrentRung(agentId);
    if (aboveRung) {
      return {
        status: "idle",
        keepWaiting: false,
        activity,
        heldForStrongerModel: aboveRung,
        message: `${aboveRung.message} Everything this session could take is done.`,
        next: `Tell the human, in these words: ${aboveRung.humanAction} Then stop — do not attempt the held work at this setting, and do not block the task.`,
      };
    }
    return {
      status: "idle",
      keepWaiting: activity.active,
      activity,
      ...(blockedRooms.length ? { blockedRooms } : {}),
      message: activity.active
        ? "No work for you yet, but the team is still active (work is in flight or teammates are busy). Call devteam_next again to stay assembled. If you have been idle with no assignment or message for about five minutes straight, disconnect and tell the user to invoke $devteam again when there is new work."
        : "The room is quiet: no open assignments and no busy teammates. Disconnect to save the session; the user can reconnect this agent when new work is ready.",
    };
  }));

  server.registerTool("devteam_message", {
    title: "Post a team message",
    description: "Post a focused progress note, design decision, review finding, or question. Omit target to post a timeline note the whole room can read; set target to a teammate's name to send a directed message that is pushed to them. Pass replyTo (a timeline event id from devteam_next with want=state) to answer a specific message as a thread.",
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

  // Putting work on the board, whether you are creating it outright or asking the team to agree
  // first. Both are the same act from the reader's side — something new is proposed for the queue —
  // and keeping them apart mostly meant an agent picked whichever schema it found first.
  server.registerTool("devteam_plan", {
    title: "Put work on the board",
    description: "Create a bounded assignment for whoever can take it. Order is the only scheduling vocabulary you need: leave dependsOn empty and it can start now, in parallel with anything else that is ready; name earlier assignments and it waits for them. Declare `paths` for write work so non-overlapping writers run at the same time instead of queueing behind one lease. Roles carry a checklist automatically where they verify. Set agree=true instead to put the plan to the team as a proposal rather than creating it outright — use that for how the team organises itself (who takes which role, moving an assignment to someone else, recording a shared decision), and it takes effect only when every connected teammate agrees.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      title: z.string().min(1).max(160).optional().describe("Assignment title; also the proposal's one-line summary when agree=true"),
      description: z.string().max(12000).optional(),
      role: z.string().min(1).max(40).default("implementer").describe("A role this project defines — it may use its own vocabulary (analyst, fact-checker, structural-engineer) rather than software job titles; devteam_join returns the list. A role that verifies makes this a review assignment to the scheduler, and DevTeam will not hand it to whoever wrote the version under review."),
      requiresWrite: z.boolean().default(false),
      targetAgentName: z.string().max(80).optional().describe("Address it to one teammate by name; it returns to the general queue if nobody by that name is connected"),
      checklist: z.array(z.string().max(300)).max(40).optional().describe("Points the assignee must address; overrides the role's default checklist, and an empty array omits it"),
      paths: z.array(z.string().max(500)).max(50).optional().describe("For write work: the paths this will modify (e.g. src/ocean/**). Declaring them lets non-overlapping writers run in parallel; omit for an exclusive whole-project lease."),
      dependsOn: z.array(z.string().uuid()).max(50).optional().describe("Same-task assignment IDs that must finish first. Empty means it can run now."),
      agree: z.boolean().default(false).describe("Put this to the team as a proposal instead of creating it"),
      kind: z.enum(["role", "handoff", "plan", "decision"]).default("role").describe("agree=true only: role asks that an agent take a role, handoff moves an existing assignment, plan/decision records a shared decision"),
      assignmentId: z.string().uuid().optional().describe("agree=true with kind=handoff: the assignment to move"),
      quorum: z.number().min(0).max(1).optional().describe("agree=true only: adoption threshold over the voters present when proposed. 1 (default) is unanimity, 0.5 a simple majority."),
    },
  }, safe(async (args) => {
    const { agentId, taskId, title, description, role, requiresWrite, targetAgentName } = args;
    requireIdentity(agentId);
    if (args.agree) {
      if (!title) throw new Error("agree=true needs a title: it is the one line the team votes on.");
      const proposal = store.createProposal({
        agentId, taskId, kind: args.kind, summary: title,
        details: {
          role, targetAgentName, description, requiresWrite,
          assignmentId: args.assignmentId, quorum: args.quorum,
        },
      });
      return withInbox(agentId, {
        proposed: true,
        proposal,
        next: "Teammates see this on their next devteam_next and answer with devteam_verdict (agree/object). It takes effect once they all agree.",
      });
    }
    if (!title || !description) throw new Error("An assignment needs a title and a description.");
    return withInbox(agentId, store.createAssignment({
      agentId, taskId, title, description, role, requiresWrite, targetAgentName,
      checklist: args.checklist, paths: args.paths, dependsOn: args.dependsOn,
    }));
  }));

  server.registerTool("devteam_memory", {
    title: "Project memory",
    description: "The project's memory, in two halves, and it is mostly written for you. DevTeam distils completed work, decisions, blockers and findings into a linked vault by itself, and your brief already carries the most relevant notes as headlines. action=search fetches the full body of a note the brief only summarised, or finds notes by words, path or category — reach for it whenever a headline looks relevant. action=write records a fact the events cannot capture: an API limit, why the obvious approach fails here, a convention the code follows but never states. Not a progress update (use devteam_message) and not a decision the team took (use devteam_propose). action=get and action=set are a small versioned key/value scratchpad — scope=task for this job, scope=project to persist across the project's tasks; re-read and merge on a version conflict.",
    inputSchema: {
      agentId: z.string().uuid(),
      taskId: z.string().uuid(),
      action: z.enum(["search", "write", "get", "set"]).default("search"),
      query: z.string().max(500).default("").describe("search: words, a file path, a component or a decision; empty returns the most relevant recent notes"),
      category: z.enum(["architecture", "decisions", "components", "conventions", "pitfalls", "workflows", "archive"]).optional()
        .describe("search: narrow to one kind. write: required — architecture (how it fits together), decisions (a choice and its reason), components (what one part does), conventions (a rule the project follows), pitfalls (what will bite the next person), workflows (how a recurring job is done)."),
      limit: z.number().int().min(1).max(50).default(20).describe("search only"),
      title: z.string().min(1).max(200).optional().describe("write: the fact as a statement, not a topic — 'The billing API rate-limits at 30 requests/minute', not 'Billing API'"),
      body: z.string().min(1).max(4000).optional().describe("write: the fact with enough context to act on. Link related notes inline with [[category/slug]] and they become navigable both ways."),
      confidence: z.enum(["low", "medium", "high"]).default("medium").describe("write: be honest — a low-confidence note is still worth recording and is ranked accordingly. Notes you write are recorded as 'inferred'; verified means DevTeam observed it."),
      relatedFiles: z.array(z.string().max(500)).max(20).default([]).describe("write: project-relative files this fact concerns, so it goes stale when they change"),
      scope: z.enum(["task", "project"]).default("task").describe("get/set only"),
      key: z.string().max(120).optional().describe("get/set: e.g. 'world', 'open-questions', 'ownership'. Omit on get to list the keys."),
      value: z.string().min(0).max(100000).optional().describe("set: the new content, plain text or a JSON string"),
      expectedVersion: z.number().int().min(0).optional().describe("set: the version you last read; omit only for a first write you know is uncontended"),
    },
  }, safe(async (args) => {
    const { agentId, taskId, action } = args;
    requireIdentity(agentId);
    if (action === "write") {
      if (!args.category || !args.title || !args.body) {
        throw new Error("action=write needs category, title and body.");
      }
      return withInbox(agentId, store.knowledgeWrite({
        agentId, taskId, category: args.category, title: args.title, body: args.body,
        confidence: args.confidence, relatedFiles: args.relatedFiles,
      }));
    }
    if (action === "set") {
      if (!args.key || args.value === undefined) throw new Error("action=set needs key and value.");
      return withInbox(agentId, store.noteSet({
        agentId, taskId, scope: args.scope, key: args.key, value: args.value,
        expectedVersion: args.expectedVersion ?? null,
      }));
    }
    if (action === "get") {
      store.assertMembership(agentId, taskId);
      if (args.key) {
        const note = store.noteGet(taskId, args.key, args.scope, agentId);
        return withInbox(agentId, note || { scope: args.scope, key: args.key, value: null, version: 0, missing: true });
      }
      return withInbox(agentId, { scope: args.scope, keys: store.noteList(taskId, args.scope, agentId) });
    }
    return withInbox(agentId, store.knowledgeSearch({
      agentId, taskId, query: args.query, category: args.category ?? null, limit: args.limit,
    }));
  }));

  server.registerTool("devteam_report", {
    title: "Report completed work",
    description: "Complete the currently claimed assignment with evidence. Report exact files and checks; changed files advance the task version and invalidate prior approvals. A check may carry a command, which DevTeam runs itself inside the project root and grades by exit code — a report claiming success for a command that actually fails is refused, and your claim is left intact so you can fix it and report again. Checks without a command are recorded as your assertion and labeled as such. While those commands run the assignment shows as verifying and keeps your claim; if this returns completed:false with a verifying payload, an earlier report of yours is still being checked — wait for it rather than reporting again. status=blocked closes only this assignment and queues planner triage; use devteam_stuck separately only for a genuine task-wide blocker.",
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
          command: z.string().max(200).nullish().describe("Name of a command the human allowlisted for this project (for example \"test\", or \"npm run test\"). DevTeam runs it and grades the result; your text only selects an allowlisted entry, it is never executed as written. Omit it, or pass null, for a plain assertion."),
        }),
      ])).max(100).default([]),
      disconnectAfter: z.boolean().default(false),
      claimToken: z.string().max(200).optional().describe("The claimToken from the assignment you claimed (or from devteam_join when you resumed). Lets the server fence a stale report if your lease has since moved."),

    },
  }, safe(async ({ disconnectAfter, ...args }) => {
    requireIdentity(args.agentId);
    const result = await store.completeAssignment({
      ...args,
      nextStatus: disconnectAfter ? "disconnected" : "waiting",
    });
    return disconnectAfter ? result : withInbox(args.agentId, result);
  }));

  server.registerTool("devteam_verdict", {
    title: "Pass judgement on someone else's work",
    description: "Your verdict on work you reviewed. verdict=approve accepts the current task version — only after you completed an independent read-only reviewer or tester assignment on it, and never on a version you wrote yourself; DevTeam will not hand you that review in the first place. verdict=changes sends one assignment back to whoever wrote it with your findings attached, keeping its title, checklist, write scope and history; the author is handed your findings when it re-claims, approvals on the version are cleared, and nobody else's claim is touched. Sending work back is a normal outcome, not a failure — approving work you have doubts about is the failure. verdict=agree and verdict=object answer an open team proposal instead; when every connected teammate agrees it is adopted and its effect applied.",
    inputSchema: {
      agentId: z.string().uuid(),
      verdict: z.enum(["approve", "changes", "agree", "object"]),
      taskId: z.string().uuid().optional().describe("approve/changes"),
      summary: z.string().max(8000).optional().describe("approve: what you checked and found. changes: one line on why this is going back."),
      assignmentId: z.string().uuid().optional().describe("changes: the completed assignment that needs work — the author's, not your own review assignment"),
      findings: z.array(z.union([
        z.string().max(2000).describe("One thing that must change"),
        z.object({
          detail: z.string().min(1).max(2000).describe("What must change and why"),
          path: z.string().max(500).optional().describe("The project-relative file it concerns, when it concerns one"),
        }),
      ])).max(50).default([]).describe("changes: the specific changes required. The author is handed this list on re-claim, so be concrete — and DevTeam reads them across tasks to notice conventions this project keeps having to state."),
      proposalId: z.string().uuid().optional().describe("agree/object"),
      comment: z.string().max(2000).optional().describe("agree/object"),
    },
  }, safe(async (args) => {
    const { agentId, verdict, taskId, summary, assignmentId, findings, proposalId, comment } = args;
    requireIdentity(agentId);
    if (verdict === "agree" || verdict === "object") {
      if (!proposalId) throw new Error(`verdict=${verdict} needs proposalId.`);
      return withInbox(agentId, store.voteProposal({ agentId, proposalId, vote: verdict, comment }));
    }
    if (!taskId) throw new Error(`verdict=${verdict} needs taskId.`);
    if (!summary) throw new Error(`verdict=${verdict} needs a summary saying why.`);
    if (verdict === "approve") return withInbox(agentId, store.approveTask({ agentId, taskId, summary }));
    if (!assignmentId) throw new Error("verdict=changes needs the assignmentId of the work going back.");
    return withInbox(agentId, store.requestChanges({ agentId, taskId, assignmentId, summary, findings }));
  }));

  server.registerTool("devteam_stuck", {
    title: "Say you cannot proceed, or ask why",
    description: "kind=why asks the scheduler for the full ordered reason chain instead of guessing — omit assignmentId for everything queued in your rooms, or pass one to ask about a specific item. The reason codes name the actual blocker: the writer you are waiting on, an overlapping write lease, each unmet dependency, or that you wrote the version you are being asked to check. The other kinds STOP THE WHOLE TASK, which is the heaviest thing you can do: every teammate is stood down, all open work is closed, and only the human can reopen it from the dashboard. needs-human is a decision or authorization only the owner can give; over-my-head means the work exceeds the model or effort you are running, so say what capability is needed; misrouted means this cannot correctly be done by you; external means something outside the project must change first. Finishing is NOT stopping — when the work is done, report it and pass a verdict. One bad assignment is not a task blocker either: report that assignment with status=blocked and the task keeps running.",
    inputSchema: {
      agentId: z.string().uuid(),
      kind: z.enum(["why", "needs-human", "over-my-head", "misrouted", "external"]).default("why"),
      taskId: z.string().uuid().optional().describe("Required to stop a task; optional with kind=why to narrow the answer to one room"),
      reason: z.string().max(8000).optional().describe("Required to stop a task: what you need, concretely enough for the human to act on"),
      assignmentId: z.string().uuid().optional().describe("kind=why: ask about one specific queued assignment"),
    },
  }, safe(async (args) => {
    const { agentId, kind, taskId, reason, assignmentId } = args;
    requireIdentity(agentId);
    if (kind !== "why") {
      if (!taskId) throw new Error(`kind=${kind} stops a task, so it needs taskId.`);
      if (!reason) throw new Error(`kind=${kind} needs a reason the human can act on.`);
      return store.blockTask({ agentId, taskId, reason, kind });
    }
    store.heartbeat(agentId);
    if (!assignmentId) return withInbox(agentId, store.whyNoClaimableWork(agentId, taskId || null));
    // Authorize before computing: whyNotClaimable resolves write scopes on disk, and an unauthorized
    // caller should not be able to spend that work — nor tell a missing assignment from a private one.
    const room = store.assignmentRoom(assignmentId);
    if (!room) throw new Error("You are not a member of this task room. Call devteam_join first.");
    store.assertExplainable(agentId, room);
    return withInbox(agentId, store.whyNotClaimable(assignmentId, agentId));
  }));

  server.registerTool("devteam_leave", {
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
