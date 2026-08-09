const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const time = (stamp) => new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(stamp));
const relativeTime = (stamp) => {
  if (!stamp) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(stamp).getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
// The server reaps agents after 120s without a heartbeat; colour the pulse as it ages.
const freshness = (stamp) => {
  const seconds = (Date.now() - new Date(stamp).getTime()) / 1000;
  if (seconds < 60) return "fresh";
  if (seconds < 120) return "stale";
  return "cold";
};
const initials = (name = "AI") => name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
const ROLE_VERB = { planner: "planning", implementer: "implementing", reviewer: "reviewing", "security-reviewer": "security review", tester: "testing", researcher: "researching" };
// A live "doing X" line for an agent: what it is working on right now, or how long it has waited.
function activityLine(agent) {
  if (agent.status === "busy" && agent.current_assignment_title) {
    const verb = ROLE_VERB[agent.current_assignment_role] || agent.current_assignment_role || "working on";
    const version = agent.current_task_version ? ` · v${agent.current_task_version}` : "";
    return `${verb}: ${agent.current_assignment_title}${version}`;
  }
  if (agent.status === "unresponsive") return `unresponsive · silent ${relativeTime(agent.last_seen)} (keeps its claim)`;
  if (agent.status === "waiting") return `waiting · ${relativeTime(agent.last_seen)}`;
  return relativeTime(agent.last_seen);
}
let state = null;
let selectedTaskId = new URLSearchParams(location.search).get("task");
let selectedProjectId = null;
let config = null;
let eventLookup = new Map();
let replyTo = null;

function syncTaskUrl() {
  const url = new URL(location.href);
  if (selectedTaskId) url.searchParams.set("task", selectedTaskId);
  else url.searchParams.delete("task");
  history.replaceState({}, "", `${url.pathname}${url.search}`);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function toast(message) {
  const element = $("#toast"); element.textContent = message; element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2300);
}

async function refresh() {
  const taskQuery = selectedTaskId
    ? `?taskId=${encodeURIComponent(selectedTaskId)}`
    : selectedProjectId ? "?taskId=" : "";
  state = await api(`/api/state${taskQuery}`);
  if (state.selectedTask) {
    selectedTaskId = state.selectedTask.id;
    selectedProjectId = state.selectedTask.project_id;
  } else {
    selectedTaskId = null;
    if (!state.projects.some((project) => project.id === selectedProjectId)) selectedProjectId = state.projects[0]?.id || null;
  }
  syncTaskUrl();
  render();
}

function render() {
  const task = state.selectedTask;
  $("#project-list").innerHTML = state.projects.map((project) => `<div class="nav-row"><button class="project-item ${selectedProjectId === project.id ? "active" : ""}" data-project="${project.id}" title="Open ${escapeHtml(project.name)}"><span>${escapeHtml(project.name)}</span></button><button class="row-delete" data-delete-project="${project.id}" title="Remove project from DevTeam" aria-label="Remove ${escapeHtml(project.name)} from DevTeam">×</button></div>`).join("") || `<p class="hint">No projects</p>`;
  const visibleTasks = selectedProjectId ? state.tasks.filter((item) => item.project_id === selectedProjectId) : state.tasks;
  $("#task-count").textContent = visibleTasks.length;
  $("#task-list").innerHTML = visibleTasks.map((item) => `<div class="nav-row"><button class="task-item ${task?.id === item.id ? "active" : ""}" data-task="${item.id}" title="Open task history"><span class="dot"></span><span>${escapeHtml(item.title)}<small>${escapeHtml(item.status)} · ${item.open_assignments} open</small></span></button><button class="row-delete" data-delete-task="${item.id}" title="Delete task history" aria-label="Delete task history for ${escapeHtml(item.title)}">×</button></div>`).join("") || `<p class="hint">No tasks yet</p>`;
  $("#project-select").innerHTML = state.projects.map((project) => `<option value="${project.id}" ${project.id === selectedProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");

  $("#empty-state").classList.toggle("hidden", Boolean(task));
  $("#conversation").classList.toggle("hidden", !task);
  $("#block-task").classList.toggle("hidden", !task || ["accepted", "blocked", "cancelled"].includes(task.status));
  if (task) renderTask(task);
  renderAgents();
}

const KIND_LABELS = { "agent.question": "question", "agent.finding": "finding", "agent.decision": "decision", "agent.progress": "note" };

function deliveryLine(event) {
  const target = event.metadata.targetLabel || "all agents";
  const receipts = event.receipts || [];
  const names = (list) => list.map((receipt) => escapeHtml(receipt.agent_name)).join(", ");
  if (!receipts.length) return `<div class="delivery"><span class="delivery-dot pending"></span>To ${escapeHtml(target)} · not delivered yet</div>`;
  const seen = receipts.filter((receipt) => receipt.seen_at);
  if (seen.length) return `<div class="delivery"><span class="delivery-dot seen"></span>To ${escapeHtml(target)} · seen by ${names(seen)}</div>`;
  return `<div class="delivery"><span class="delivery-dot delivered"></span>To ${escapeHtml(target)} · delivered to ${names(receipts)}</div>`;
}

const SYSTEM_EVENTS = ["task.created", "assignment.created", "task.accepted", "assignment.reassigned", "proposal.created", "proposal.adopted", "proposal.declined"];

function renderEvent(event) {
  if (SYSTEM_EVENTS.includes(event.type)) {
    const icon = event.type === "proposal.adopted" ? "✓ " : event.type === "proposal.declined" ? "✕ " : event.type.startsWith("proposal") ? "⇄ " : "";
    return `<div class="system-event ${event.type.replace(".", "-")}">${icon}${escapeHtml(event.message)} <span class="provider">· ${time(event.created_at)}</span></div>`;
  }
  const human = !event.agent_id;
  const name = human ? "You" : event.agent_name || "Agent";
  const kind = KIND_LABELS[event.type];
  const meta = [
    ...(event.metadata.changedFiles || []).map((file) => `changed: ${file}`),
    ...(event.metadata.checks || []).map((check) => `check: ${check}`),
    event.metadata.role ? `role: ${event.metadata.role}` : null,
  ].filter(Boolean);
  const badge = kind ? `<span class="kind-badge ${kind}">${escapeHtml(kind)}</span>` : "";
  const parent = event.metadata.replyTo ? eventLookup.get(event.metadata.replyTo) : null;
  const quote = parent
    ? `<div class="reply-quote">↳ ${escapeHtml(parent.agent_id ? (parent.agent_name || "Agent") : "You")}: ${escapeHtml((parent.message || "").slice(0, 100))}</div>`
    : "";
  return `<article class="event ${human ? "from-human" : ""}"><div class="avatar ${human ? "human" : ""}">${initials(name)}</div><div class="event-main"><div class="event-top"><span class="event-name">${escapeHtml(name)}</span><span class="provider">${escapeHtml(human ? "you" : event.agent_provider || event.type)}</span>${badge}<span class="event-time">${time(event.created_at)}</span><button class="reply-btn" data-reply="${event.id}" title="Reply to this message" aria-label="Reply">↩</button></div>${quote}<div class="event-body">${escapeHtml(event.message)}</div>${meta.length ? `<div class="event-meta">${meta.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>` : ""}${human ? deliveryLine(event) : ""}</div></article>`;
}

function renderTask(task) {
  $("#project-name").textContent = task.project_name;
  $("#task-status").textContent = task.status;
  $("#task-title").textContent = task.title;
  $("#task-description").textContent = task.description;
  $("#task-version").textContent = `v${task.version}`;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 220;
  eventLookup = new Map(task.events.map((event) => [event.id, event]));
  if (replyTo && !eventLookup.has(replyTo.id)) { replyTo = null; }
  renderReplyContext();
  $("#event-list").innerHTML = task.events.map(renderEvent).join("");
  renderMembers(task);
  renderProposals(task);
  $("#assignment-count").textContent = task.assignments.filter((item) => ["queued", "claimed"].includes(item.status)).length;
  $("#assignment-list").innerHTML = task.assignments.slice().reverse().slice(0, 8).map((item) => {
    const checklist = item.checklist && item.checklist.length
      ? `<details class="checklist"><summary>${item.checklist.length}-point checklist</summary><ul>${item.checklist.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul></details>`
      : "";
    const scope = item.requires_write && item.writeScope && item.writeScope.length
      ? `<span class="scope" title="Write lease scope">${item.writeScope.map((p) => escapeHtml(p === "" ? "whole project" : p)).join(", ")}</span>`
      : (item.requires_write ? `<span class="scope">whole project</span>` : "");
    const release = item.status === "claimed" && item.requires_write
      ? `<button class="mini release" data-release="${item.id}" data-release-title="${escapeHtml(item.title)}" title="Force-release this stuck write lease (asks you to confirm the title)">Release lease</button>`
      : "";
    return `<div class="assignment"><div class="assignment-top"><strong>${escapeHtml(item.title)}</strong><span class="role">${escapeHtml(item.role)}</span></div><p>${escapeHtml(item.agent_name ? `${item.agent_name} · ${item.status}` : item.status)}${item.requires_write ? " · write lease" : ""}</p>${scope}${checklist}${release}</div>`;
  }).join("") || `<p class="hint">Waiting for the plan</p>`;
  renderBlackboard(task);
  const approvals = task.approvals.length;
  $("#approval-label").textContent = `${approvals} / ${task.required_approvals}`;
  $("#approval-progress").style.width = `${Math.min(100, approvals / task.required_approvals * 100)}%`;
  const remaining = Math.max(0, task.required_approvals - approvals);
  const connectedCount = state.agents.filter((agent) => agent.status !== "disconnected").length;
  let consensusCopy = task.status === "accepted"
    ? "The current version has team consensus."
    : `${remaining} independent approval${remaining === 1 ? "" : "s"} still needed.`;
  if (task.status !== "accepted" && remaining > 0 && connectedCount < remaining) {
    consensusCopy += ` Only ${connectedCount} agent${connectedCount === 1 ? "" : "s"} connected — connect ${remaining - connectedCount} more (each agent approves once) to reach consensus.`;
  }
  $("#consensus-copy").textContent = consensusCopy;
  if (nearBottom) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

// Who belongs to this task room and in what role — so the human can see the room's membership,
// not just who is globally online. Contributors claim work; observers watch and review.
function renderMembers(task) {
  const container = $("#room-members");
  if (!container) return;
  const members = task.members || [];
  container.classList.toggle("hidden", members.length === 0);
  if (!members.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="members-head">In this room</div>` + members.map((member) => {
    const dead = member.status === "disconnected";
    return `<div class="member-row ${dead ? "gone" : ""}"><span class="member-name">${escapeHtml(member.agent_name)}</span><span class="member-role ${member.role === "observer" ? "observer" : ""}">${escapeHtml(member.role)}</span><span class="member-status">${escapeHtml(member.status)}</span></div>`;
  }).join("");
}

// The team's shared working memory: versioned keys with provenance. A long value is collapsed.
function renderBlackboard(task) {
  const section = $("#blackboard-section");
  if (!section) return;
  const notes = task.blackboard || [];
  section.classList.toggle("hidden", notes.length === 0);
  $("#blackboard-count").textContent = notes.length;
  $("#blackboard-list").innerHTML = notes.map((note) => {
    const value = String(note.value ?? "");
    const preview = value.length > 240 ? `${value.slice(0, 240)}…` : value;
    return `<details class="note"><summary><span class="note-key">${escapeHtml(note.key)}</span><span class="note-meta">v${note.version} · ${escapeHtml(note.updatedBy || "?")} · ${relativeTime(note.updatedAt)}</span></summary><pre class="note-body">${escapeHtml(preview)}</pre></details>`;
  }).join("");
}

function renderReplyContext() {
  const element = $("#reply-context");
  if (!element) return;
  if (!replyTo) { element.classList.add("hidden"); element.innerHTML = ""; return; }
  element.classList.remove("hidden");
  element.innerHTML = `<span class="reply-quote">↳ Replying to ${escapeHtml(replyTo.name)}: ${escapeHtml(replyTo.snippet)}</span><button type="button" class="reply-cancel" title="Cancel reply" aria-label="Cancel reply">×</button>`;
}

function renderAgents() {
  renderAgentList();
  populateMessageTargets(state.agents.filter((agent) => agent.status !== "disconnected"));
}

// Team role negotiation: show open proposals with live vote tallies and let the human weigh in.
function renderProposals(task) {
  const section = $("#proposal-section");
  const active = !["accepted", "blocked", "cancelled"].includes(task.status);
  section.classList.toggle("hidden", !active);
  if (!active) return;
  const open = (task.proposals || []).filter((proposal) => proposal.status === "open");
  const connectedNames = state.agents.filter((agent) => agent.status !== "disconnected").map((agent) => agent.name);
  $("#proposal-list").innerHTML = open.length
    ? open.map((proposal) => renderProposal(proposal, connectedNames)).join("")
    : `<p class="hint">No open proposals. Use ＋ to propose a role or decision.</p>`;
}

function renderProposal(proposal, connectedNames) {
  const agreers = proposal.votes.filter((vote) => vote.vote === "agree").map((vote) => vote.voter_name);
  const objectors = proposal.votes.filter((vote) => vote.vote === "object");
  const stillNeeded = connectedNames.filter((name) => name !== proposal.proposer_name && !agreers.includes(name));
  const tally = objectors.length
    ? `<span class="vote-objection">objected: ${escapeHtml(objectors[0].voter_name)}</span>`
    : `${agreers.length} agreed${stillNeeded.length ? ` · waiting on ${escapeHtml(stillNeeded.join(", "))}` : " · ready"}`;
  const label = proposal.kind === "role" && proposal.details.role
    ? `${escapeHtml(proposal.details.role)}${proposal.details.targetAgentName ? ` → ${escapeHtml(proposal.details.targetAgentName)}` : ""}`
    : escapeHtml(proposal.kind);
  return `<div class="proposal"><div class="proposal-top"><strong>${escapeHtml(proposal.summary)}</strong><span class="role">${label}</span></div><div class="proposal-meta">from ${escapeHtml(proposal.proposer_name)} · ${tally}</div><div class="proposal-actions"><button class="mini agree" data-vote-proposal="${proposal.id}" data-vote="agree">Agree</button><button class="mini object" data-vote-proposal="${proposal.id}" data-vote="object">Object</button></div></div>`;
}

// Presence + unread badges + re-ping list. Split out so a lightweight timer can
// refresh relative "last seen" times without disturbing the message composer.
function renderAgentList() {
  if (!state) return;
  const connected = state.agents.filter((agent) => agent.status !== "disconnected");
  $("#online-count").textContent = `${connected.length} online`;
  $("#agent-list").innerHTML = connected.map((agent) => {
    const unread = agent.pending_messages > 0
      ? `<span class="unread-badge" title="${agent.pending_messages} message${agent.pending_messages === 1 ? "" : "s"} not delivered yet">${agent.pending_messages}</span>`
      : "";
    return `<div class="agent"><div class="avatar">${initials(agent.name)}</div><div class="agent-info"><strong>${escapeHtml(agent.name)}${unread}</strong><small>${escapeHtml(agent.provider)} · ${escapeHtml(agent.status)}</small><small class="activity">${escapeHtml(activityLine(agent))}</small></div><span class="agent-status ${agent.status} ${freshness(agent.last_seen)}" title="${escapeHtml(agent.status)} · seen ${relativeTime(agent.last_seen)}"></span></div>`;
  }).join("") || `<p class="hint">No agents connected. Copy the MCP setup, then invoke <code>$devteam</code> in an AI desktop.</p>`;
  renderReconnectList();
}

function renderReconnectList() {
  const container = $("#reconnect-list");
  if (!container) return;
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recent = state.agents
    .filter((agent) => agent.status === "disconnected" && agent.disconnected_at && new Date(agent.disconnected_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.disconnected_at) - new Date(a.disconnected_at))
    .slice(0, 3);
  container.innerHTML = recent.length
    ? `<div class="reconnect-head">Recently left</div>` + recent.map((agent) => `<div class="reconnect-row"><div class="agent-info"><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.provider)} · left ${relativeTime(agent.disconnected_at)}</small></div><button class="reconnect-btn" data-reconnect="${escapeHtml(agent.name)}" title="Copy a reconnect prompt to paste into ${escapeHtml(agent.name)}'s desktop">Re-ping</button></div>`).join("")
    : "";
}

function populateMessageTargets(connected) {
  const select = $("#message-target");
  if (select) {
    const previous = select.value || "all";
    const options = [`<option value="all">All agents${connected.length ? ` (${connected.length})` : ""}</option>`]
      .concat(connected.map((agent) => `<option value="${escapeHtml(agent.name)}">${escapeHtml(agent.name)} · ${escapeHtml(agent.provider)}</option>`));
    select.innerHTML = options.join("");
    select.value = previous === "all" || connected.some((agent) => agent.name === previous) ? previous : "all";
  }
  const hint = $("#composer-hint");
  if (hint) hint.textContent = connected.length
    ? "Delivered live to connected agents on their next check (about a minute)."
    : "No agents connected yet — they will read this in the timeline when they join.";
}

document.addEventListener("click", async (event) => {
  const dialogButton = event.target.closest("[data-dialog]");
  if (dialogButton) $("#" + dialogButton.dataset.dialog).showModal();
  if (event.target.closest(".close")) event.target.closest("dialog").close();
  const deleteTaskButton = event.target.closest("[data-delete-task]");
  if (deleteTaskButton) {
    const task = state.tasks.find((item) => item.id === deleteTaskButton.dataset.deleteTask);
    if (!task || !confirm(`Delete the task history “${task.title}” from DevTeam?\n\nMessages, assignments, and approvals for this task will be deleted. Project files will not be touched.`)) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: "DELETE", body: JSON.stringify({ confirmTaskId: task.id }) });
      const currentTask = state.tasks.find((item) => item.id === selectedTaskId && item.id !== task.id);
      const nextTask = state.tasks.find((item) => item.project_id === task.project_id && item.id !== task.id);
      selectedTaskId = currentTask?.id || nextTask?.id || null;
      selectedProjectId = task.project_id;
      syncTaskUrl();
      await refresh();
      toast("Task history deleted; project files were untouched");
    } catch (error) { toast(error.message); }
    return;
  }
  const deleteProjectButton = event.target.closest("[data-delete-project]");
  if (deleteProjectButton) {
    const project = state.projects.find((item) => item.id === deleteProjectButton.dataset.deleteProject);
    if (!project || !confirm(`Remove “${project.name}” from DevTeam?\n\nThis deletes ${project.task_count} task ${project.task_count === 1 ? "history" : "histories"} from DevTeam. Files in ${project.root} will not be touched.`)) return;
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE", body: JSON.stringify({ confirmName: project.name }) });
      const currentProject = state.projects.find((item) => item.id === selectedProjectId && item.id !== project.id);
      const nextProject = currentProject || state.projects.find((item) => item.id !== project.id);
      selectedProjectId = nextProject?.id || null;
      const currentTask = state.tasks.find((item) => item.id === selectedTaskId && item.project_id === selectedProjectId);
      selectedTaskId = currentTask?.id || state.tasks.find((item) => item.project_id === selectedProjectId)?.id || null;
      syncTaskUrl();
      await refresh();
      toast("Project removed from DevTeam; files were untouched");
    } catch (error) { toast(error.message); }
    return;
  }
  if (event.target.closest(".reply-cancel")) { replyTo = null; renderReplyContext(); return; }
  const replyButton = event.target.closest("[data-reply]");
  if (replyButton) {
    const parent = eventLookup.get(Number(replyButton.dataset.reply));
    if (parent) {
      replyTo = { id: parent.id, name: parent.agent_id ? (parent.agent_name || "Agent") : "You", snippet: (parent.message || "").slice(0, 80) };
      renderReplyContext();
      $("#message-form").elements.message.focus();
    }
    return;
  }
  const releaseButton = event.target.closest("[data-release]");
  if (releaseButton) {
    const title = releaseButton.dataset.releaseTitle;
    if (!confirm(`Force-release the write lease for “${title}”?\n\nOnly do this if the agent has genuinely crashed or is stuck — a still-running writer would lose its lease. Type nothing; this confirms the exact title for you.`)) return;
    try { await api(`/api/assignments/${releaseButton.dataset.release}/force-release`, { method: "POST", body: JSON.stringify({ confirmTitle: title }) }); await refresh(); toast("Write lease released back to the queue"); }
    catch (error) { toast(error.message); }
    return;
  }
  const voteButton = event.target.closest("[data-vote-proposal]");
  if (voteButton) {
    try { await api(`/api/proposals/${voteButton.dataset.voteProposal}/vote`, { method: "POST", body: JSON.stringify({ vote: voteButton.dataset.vote }) }); await refresh(); }
    catch (error) { toast(error.message); }
    return;
  }
  const reconnectButton = event.target.closest("[data-reconnect]");
  if (reconnectButton) {
    const name = reconnectButton.dataset.reconnect;
    const promptText = `Use $devteam and rejoin as ${name}.`;
    try { await navigator.clipboard.writeText(promptText); toast(`Copied — paste into ${name}'s desktop to reconnect`); }
    catch { toast(`Paste into ${name}'s desktop: ${promptText}`); }
    return;
  }
  const taskButton = event.target.closest("[data-task]");
  if (taskButton) { selectedTaskId = taskButton.dataset.task; syncTaskUrl(); await refresh(); }
  const projectButton = event.target.closest("[data-project]");
  if (projectButton) { selectedProjectId = projectButton.dataset.project; const first = state.tasks.find((task) => task.project_id === selectedProjectId); selectedTaskId = first?.id || null; syncTaskUrl(); await refresh(); }
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.target)); values.requiredApprovals = Number(values.requiredApprovals);
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(values) });
    selectedTaskId = task.id; selectedProjectId = task.project_id; event.target.reset(); event.target.closest("dialog").close(); await refresh(); toast("Task sent to the team");
  } catch (error) { toast(error.message); }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    selectedProjectId = project.id; event.target.reset(); event.target.closest("dialog").close(); await refresh(); toast("Project added");
  } catch (error) { toast(error.message); }
});

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedTaskId) return;
  const field = event.target.elements.message;
  const target = event.target.elements.target?.value || "all";
  const body = { message: field.value, target };
  if (replyTo) body.replyTo = replyTo.id;
  try { await api(`/api/tasks/${selectedTaskId}/messages`, { method: "POST", body: JSON.stringify(body) }); field.value = ""; replyTo = null; renderReplyContext(); await refresh(); } catch (error) { toast(error.message); }
});

$("#message-form").addEventListener("keydown", (event) => {
  if (event.target.tagName === "TEXTAREA" && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

$("#proposal-kind").addEventListener("change", (event) => {
  $("#role-fields").classList.toggle("hidden", event.target.value !== "role");
});

$("#proposal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedTaskId) return;
  const values = Object.fromEntries(new FormData(event.target));
  const body = { kind: values.kind, summary: values.summary };
  if (values.kind === "role") {
    body.details = { role: values.role };
    if (values.targetAgentName) body.details.targetAgentName = values.targetAgentName;
    if (values.description) body.details.description = values.description;
  }
  try {
    await api(`/api/tasks/${selectedTaskId}/proposals`, { method: "POST", body: JSON.stringify(body) });
    event.target.reset(); $("#role-fields").classList.remove("hidden"); event.target.closest("dialog").close(); await refresh(); toast("Proposal sent to the team");
  } catch (error) { toast(error.message); }
});

$("#block-task").addEventListener("click", async () => {
  const reason = prompt("Why should the team stop this task?"); if (!reason) return;
  try { await api(`/api/tasks/${selectedTaskId}/block`, { method: "POST", body: JSON.stringify({ reason }) }); await refresh(); } catch (error) { toast(error.message); }
});

$("#copy-setup").addEventListener("click", async () => {
  try {
    const { mcpUrl, token } = await api("/api/setup");
    const setup = `DevTeam MCP\nURL: ${mcpUrl}\nAuthorization: Bearer ${token}\n\nCodex config.toml:\n[mcp_servers.devteam]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${token}" }\ntool_timeout_sec = 60\n\nClaude JSON:\n{"mcpServers":{"devteam":{"type":"http","url":"${mcpUrl}","headers":{"Authorization":"Bearer ${token}"}}}}`;
    await navigator.clipboard.writeText(setup); toast("Desktop MCP setup copied");
  } catch (error) { toast(error.message); }
});

async function boot() {
  try {
    config = await api("/api/config"); $("#server-address").textContent = new URL(config.mcpUrl).host;
    await refresh();
    const stream = new EventSource("/api/stream"); stream.onmessage = () => refresh().catch(() => {});
    // Keep presence ("3s ago", pulse colour) live between server events.
    setInterval(() => { if (state) renderAgentList(); }, 5000);
  } catch (error) { toast(error.message); }
}
boot();
