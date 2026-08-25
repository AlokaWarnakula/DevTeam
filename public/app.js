import { escapeHtml, eventMatchesTimelineFilter, renderSafeMarkdown, unreadTimelineCount } from "/ui-utils.js";

const $ = (selector) => document.querySelector(selector);
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
const MODEL_CLASSES = ["economy", "balanced", "strong", "frontier", "specialized"];
const EFFORT_CLASSES = ["light", "medium", "high", "extra_high", "maximum"];
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

function runtimeSelectionLabel(selection) {
  if (!selection?.modelLabel || !selection?.effortLabel) return null;
  const effort = selection.effortLabel === selection.effortClass
    ? selection.effortLabel
    : `${selection.effortLabel} (${selection.effortClass})`;
  return `${selection.modelLabel} (${selection.modelClass}) · ${effort}`;
}

function runtimeProfileLabel(profile) {
  if (!profile) return null;
  const model = profile.availableModels?.find((item) => item.id === profile.currentModel);
  const effort = model?.efforts?.find((item) => item.id === profile.currentEffort);
  if (!model || !effort) return null;
  return runtimeSelectionLabel({
    modelLabel: model.label,
    modelClass: model.class,
    effortLabel: effort.label,
    effortClass: effort.class,
  });
}

function assignmentRuntimeLabel(assignment) {
  const resolution = assignment.runtimeResolution;
  const advertised = runtimeSelectionLabel(resolution?.recommendation);
  if (advertised) return `${resolution.satisfied ? "Current" : "Needs at least"} ${advertised}`;
  if (!assignment.runtimeProfileSource) return "Model gating inactive — no runtime profile registered";
  return resolution?.reason || "No advertised model/effort combination matches this assignment.";
}
let state = null;
let selectedTaskId = new URLSearchParams(location.search).get("task");
let selectedProjectId = null;
let config = null;
let eventLookup = new Map();
let replyTo = null;
let refreshGeneration = 0;
let pendingAttachments = [];
let proposalTaskId = null;
let proposalStatuses = new Map();
let renderedTaskId = null;
let messageSending = false;
let timelineFilter = "all";
let pendingSends = [];
let pendingJumpEventId = null;
let searchGeneration = 0;
let profileDraftModels = [];
let profileDraftCurrentModel = "";
let profileDraftCurrentEffort = "";
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DRAFT_LIMIT = 50_000;

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

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // Private browsing or a full storage quota must not break chat.
  }
}

const draftKey = (taskId) => `devteam:draft:${taskId}`;
const readKey = (taskId) => `devteam:last-read:${taskId}`;

function readDraft(taskId) {
  try { return JSON.parse(storageGet(draftKey(taskId)) || "null"); } catch { return null; }
}

function updateDraftStatus(message = "") {
  const status = $("#draft-status");
  if (status) status.textContent = message;
}

function saveMessageDraft(taskId = selectedTaskId) {
  if (!taskId) return;
  const form = $("#message-form");
  const message = form.elements.message.value.slice(0, DRAFT_LIMIT);
  const target = form.elements.target?.value || "all";
  if (!message) {
    storageSet(draftKey(taskId), null);
    updateDraftStatus("");
    return;
  }
  const saved = storageSet(draftKey(taskId), JSON.stringify({ message, target, savedAt: new Date().toISOString() }));
  updateDraftStatus(saved ? "Draft saved locally" : "Draft could not be saved locally");
}

function clearMessageDraft(taskId) {
  storageSet(draftKey(taskId), null);
  if (taskId === selectedTaskId) updateDraftStatus("");
}

function restoreMessageDraft(taskId) {
  const field = $("#message-form").elements.message;
  const draft = readDraft(taskId);
  field.value = draft?.message || "";
  resizeMessageField(field);
  updateDraftStatus(draft?.message ? "Draft restored" : "");
}

function lastReadEventId(taskId) {
  const value = Number(storageGet(readKey(taskId)));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function latestReadableEventId(task) {
  return Math.max(0, ...task.events.filter((event) => event.agent_id).map((event) => Number(event.id) || 0));
}

function markTimelineRead(task = state?.selectedTask) {
  if (!task || timelineFilter !== "all") return;
  const latest = latestReadableEventId(task);
  if (latest) storageSet(readKey(task.id), String(latest));
  const button = $("#jump-latest");
  if (button) button.classList.add("hidden");
}

function toast(message) {
  const element = $("#toast"); element.textContent = message; element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2300);
}

async function refresh() {
  const generation = ++refreshGeneration;
  const taskQuery = selectedTaskId
    ? `?taskId=${encodeURIComponent(selectedTaskId)}`
    : selectedProjectId ? "?taskId=" : "";
  const nextState = await api(`/api/state${taskQuery}`);
  if (generation !== refreshGeneration) return;
  state = nextState;
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
  $("#project-list").innerHTML = state.projects.map((project) => `<div class="nav-row"><button class="project-item ${selectedProjectId === project.id ? "active" : ""}" data-project="${project.id}" title="Open ${escapeHtml(project.name)}"><span>${escapeHtml(project.name)}</span></button><span class="row-actions"><button class="row-edit" data-edit-project="${project.id}" title="Edit project name or folder" aria-label="Edit ${escapeHtml(project.name)}">✎</button><button class="row-delete" data-delete-project="${project.id}" title="Remove project from DevTeam" aria-label="Remove ${escapeHtml(project.name)} from DevTeam">×</button></span></div>`).join("") || `<p class="hint">No projects</p>`;
  const visibleTasks = selectedProjectId ? state.tasks.filter((item) => item.project_id === selectedProjectId) : state.tasks;
  $("#task-count").textContent = visibleTasks.length;
  $("#task-list").innerHTML = visibleTasks.map((item) => `<div class="nav-row"><button class="task-item ${task?.id === item.id ? "active" : ""}" data-task="${item.id}" title="Open task history"><span class="dot"></span><span>${escapeHtml(item.title)}<small>${escapeHtml(item.status)} · ${item.open_assignments} open</small></span></button><button class="row-delete" data-delete-task="${item.id}" title="Delete task history" aria-label="Delete task history for ${escapeHtml(item.title)}">×</button></div>`).join("") || `<p class="hint">No tasks yet</p>`;
  $("#project-select").innerHTML = state.projects.map((project) => `<option value="${project.id}" ${project.id === selectedProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");

  $("#empty-state").classList.toggle("hidden", Boolean(task));
  $("#conversation").classList.toggle("hidden", !task);
  $("#copy-task-invite").classList.toggle("hidden", !task);
  $("#edit-task-runtime").classList.toggle("hidden", !task || task.status === "cancelled");
  $("#edit-task").classList.toggle("hidden", !task || task.status === "cancelled");
  $("#block-task").classList.toggle("hidden", !task || ["accepted", "blocked", "cancelled"].includes(task.status));
  $("#unblock-task").classList.toggle("hidden", !task || task.status !== "blocked");
  if (task) renderTask(task);
  else document.title = "DevTeam — Local AI collaboration";
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

// Authorship comes from the event's own recorded author, not from its nullable agent_id: purging an
// agent from the roster clears that foreign key, which used to reattribute every message it ever
// wrote to the human. Rows written before author_kind existed fall back to the old inference.
function eventIsHuman(event) {
  if (event.author_kind) return event.author_kind === "human";
  return !event.agent_id;
}

function eventAuthorName(event) {
  return event.agent_name || event.author_name || "Agent";
}

// A check DevTeam ran and a check an agent merely claimed must never look alike. Reports written
// before verification existed carry only strings, and stay labeled as the assertions they were.
function checkLabel(record) {
  if (record.status === "passed") return `check ✓ ${record.label} · verified (exit 0${record.durationMs != null ? `, ${Math.round(record.durationMs / 100) / 10}s` : ""})`;
  if (record.status === "failed") return `check ✕ ${record.label} · verified failure${record.exitCode != null ? ` (exit ${record.exitCode})` : ""}`;
  if (record.status === "unavailable") return `check ? ${record.label} · not run`;
  return `check: ${record.label} · agent-asserted`;
}

function checkChips(metadata) {
  const records = metadata.checkRecords;
  if (Array.isArray(records) && records.length) return records.map(checkLabel);
  return (metadata.checks || []).map((check) => `check: ${check} · agent-asserted`);
}

function renderEvent(event) {
  if (event.type === "proposal.vote") return "";
  if (SYSTEM_EVENTS.includes(event.type)) {
    const icon = event.type === "proposal.adopted" ? "✓ " : event.type === "proposal.declined" ? "✕ " : event.type.startsWith("proposal") ? "⇄ " : "";
    return `<div id="event-${event.id}" class="system-event ${event.type.replace(".", "-")}">${icon}${escapeHtml(event.message)} <span class="provider">· ${time(event.created_at)}</span></div>`;
  }
  const human = eventIsHuman(event);
  const name = human ? "You" : eventAuthorName(event);
  const kind = KIND_LABELS[event.type];
  const meta = [
    ...(event.metadata.changedFiles || []).map((file) => `changed: ${file}`),
    ...checkChips(event.metadata),
    event.metadata.role ? `role: ${event.metadata.role}` : null,
  ].filter(Boolean);
  const badge = kind ? `<span class="kind-badge ${kind}">${escapeHtml(kind)}</span>` : "";
  const parent = event.metadata.replyTo ? eventLookup.get(event.metadata.replyTo) : null;
  const quote = parent
    ? `<div class="reply-quote">↳ ${escapeHtml(eventIsHuman(parent) ? "You" : eventAuthorName(parent))}: ${escapeHtml((parent.message || "").slice(0, 100))}</div>`
    : "";
  const parsed = parseAttachmentMarkers(event.message);
  const body = parsed.message ? `<div class="event-body markdown">${renderSafeMarkdown(parsed.message)}</div>` : "";
  const attachments = parsed.attachments.length ? `<div class="message-attachments">${parsed.attachments.map(renderMessageAttachment).join("")}</div>` : "";
  return `<article id="event-${event.id}" class="event ${human ? "from-human" : ""}"><div class="avatar ${human ? "human" : ""}">${initials(name)}</div><div class="event-main"><div class="event-top"><span class="event-name">${escapeHtml(name)}</span><span class="provider">${escapeHtml(human ? "you" : event.agent_provider || event.type)}</span>${badge}<span class="event-time">${time(event.created_at)}</span><button class="reply-btn" data-reply="${event.id}" title="Reply to this message" aria-label="Reply">↩</button></div>${quote}${body}${attachments}${meta.length ? `<div class="event-meta">${meta.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div>` : ""}${human ? deliveryLine(event) : ""}</div></article>`;
}

function renderPendingSend(item) {
  const failed = item.status === "failed";
  const files = item.files.length ? `<div class="pending-file-names">${item.files.map((file) => escapeHtml(file.name)).join(" · ")}</div>` : "";
  const status = failed
    ? `<div class="delivery failed" role="status"><span class="delivery-dot failed"></span>Failed — ${escapeHtml(item.error || "message was not sent")}<button class="retry-send" type="button" data-retry-send="${item.id}">Retry</button></div>`
    : `<div class="delivery" role="status"><span class="delivery-dot pending"></span>Sending…</div>`;
  return `<article class="event from-human pending-send ${failed ? "failed" : ""}"><div class="avatar human">Y</div><div class="event-main"><div class="event-top"><span class="event-name">You</span><span class="provider">pending</span></div>${item.message ? `<div class="event-body markdown">${renderSafeMarkdown(item.message)}</div>` : ""}${files}${status}</div></article>`;
}

function renderTimeline(task, { taskChanged = false, wasNearBottom = false } = {}) {
  const eventList = $("#event-list");
  let marker = lastReadEventId(task.id);
  const latest = latestReadableEventId(task);
  if (marker === null && latest) {
    marker = latest;
    storageSet(readKey(task.id), String(latest));
  }
  const unread = unreadTimelineCount(task.events, marker);
  const visible = task.events.filter((event) => eventMatchesTimelineFilter(event, timelineFilter));
  const parts = [];
  let separatorAdded = false;
  for (const event of visible) {
    if (!separatorAdded && unread && event.agent_id && Number(event.id) > (marker || 0)) {
      parts.push(`<div id="unread-separator" class="unread-separator"><span>${unread} unread</span></div>`);
      separatorAdded = true;
    }
    const rendered = renderEvent(event);
    if (rendered) parts.push(rendered);
  }
  if (["all", "chat"].includes(timelineFilter)) {
    parts.push(...pendingSends.filter((item) => item.taskId === task.id).map(renderPendingSend));
  }
  eventList.innerHTML = parts.join("") || `<p class="timeline-empty">No ${timelineFilter === "all" ? "timeline" : timelineFilter} items yet.</p>`;
  for (const button of $("#timeline-filters").querySelectorAll("[data-timeline-filter]")) {
    const active = button.dataset.timelineFilter === timelineFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const jump = $("#jump-latest");
  jump.textContent = unread ? `${unread} unread · Jump to latest` : "Jump to latest";
  jump.classList.toggle("hidden", !unread && (taskChanged || wasNearBottom));
  requestAnimationFrame(() => {
    if (pendingJumpEventId) {
      const target = $(`#event-${pendingJumpEventId}`);
      if (target) target.scrollIntoView({ block: "center" });
      pendingJumpEventId = null;
    } else if (taskChanged && unread) {
      $("#unread-separator")?.scrollIntoView({ block: "start" });
    } else if (taskChanged || wasNearBottom) {
      eventList.scrollTo({ top: eventList.scrollHeight, behavior: taskChanged ? "auto" : "smooth" });
      markTimelineRead(task);
    }
  });
}

function parseAttachmentMarkers(message) {
  const attachments = [];
  const visible = String(message || "").replace(/^\[\[devteam-attachment (.+)\]\]\s*$/gm, (line, payload) => {
    try {
      const attachment = JSON.parse(payload);
      if (attachment && typeof attachment.path === "string" && typeof attachment.name === "string") attachments.push(attachment);
    } catch { return line; }
    return "";
  }).trim();
  return { message: visible, attachments };
}

function renderMessageAttachment(attachment) {
  const previewUrl = String(attachment.previewUrl || "");
  const localPreview = /^\/api\/tasks\/[0-9a-f-]+\/attachments\/[0-9a-f-]+\.(?:png|jpg|gif|webp|pdf)$/.test(previewUrl);
  const image = String(attachment.mime || "").startsWith("image/") && localPreview
    ? `<img src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name)}" loading="lazy">`
    : `<span class="attachment-type">PDF</span>`;
  const open = localPreview ? `<a href="${escapeHtml(previewUrl)}" target="_blank" rel="noopener">Open</a>` : "";
  return `<div class="message-attachment">${image}<div><strong>${escapeHtml(attachment.name)}</strong><code title="${escapeHtml(attachment.path)}">${escapeHtml(attachment.path)}</code>${open}</div></div>`;
}

function renderTask(task) {
  const taskChanged = renderedTaskId !== task.id;
  $("#project-name").textContent = task.project_name;
  $("#task-status").textContent = `${task.status} · ${(task.session_policy || "manual").replace("_", " ")}`;
  $("#task-title").textContent = task.title;
  renderTaskDescription(task.description);
  $("#task-version").textContent = `v${task.version}`;
  const taskRuntime = runtimeProfileLabel(task.baseRuntimeProfile);
  $("#edit-task-runtime").textContent = taskRuntime ? `Task runtime: ${taskRuntime}` : "Set task runtime";
  $("#copy-task-invite").textContent = task.session_policy === "manual" ? "Invite agent" : "Fresh-session invite";
  const eventList = $("#event-list");
  const nearBottom = eventList.scrollHeight - eventList.scrollTop - eventList.clientHeight < 220;
  renderedTaskId = task.id;
  eventLookup = new Map(task.events.map((event) => [event.id, event]));
  if (replyTo && !eventLookup.has(replyTo.id)) { replyTo = null; }
  renderReplyContext();
  renderTimeline(task, { taskChanged, wasNearBottom: nearBottom });
  if (taskChanged) restoreMessageDraft(task.id);
  renderMembers(task);
  renderProposals(task);
  const openAssignments = task.assignments.filter((item) => ["queued", "claimed"].includes(item.status)).length;
  $("#assignment-count").textContent = openAssignments;
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
    const checkpoint = item.status === "claimed" && item.agent_id
      ? `<button class="mini checkpoint" data-checkpoint-assignment="${item.id}" title="Create a bounded checkpoint and fresh-session invitation without releasing this claim">Checkpoint & rotate</button>`
      : "";
    const blockedBy = item.blockedBy?.length
      ? `<div class="dependency-wait"><strong>Waiting for</strong>${item.blockedBy.map((dependency) => `<span>${escapeHtml(dependency.title)} · ${escapeHtml(dependency.status)}</span>`).join("")}</div>`
      : "";
    // A queued item nobody is picking up used to look identical to one about to be claimed. The
    // scheduler now says why, so a stall is visible on the card instead of only in a log.
    const checks = item.checks?.length
      ? `<div class="reported-checks">${item.checks.map((record) => `<span class="check-chip ${record.status}" title="${escapeHtml(record.output || "")}">${escapeHtml(checkLabel(record))}</span>`).join("")}</div>`
      : "";
    const hold = item.schedulingHold
      ? `<div class="scheduling-hold"><strong>Held back</strong><span>${escapeHtml(item.schedulingHold.detail)}</span></div>`
      : "";
    const assessment = item.assessment;
    const assessmentView = assessment
      ? `<div class="complexity"><strong>${escapeHtml(assessment.level)} · score ${Number(assessment.score)}</strong><span>${escapeHtml(assignmentRuntimeLabel(item))}</span><small>${assessment.reasons.slice(0, 2).map((reason) => escapeHtml(reason.detail)).join(" · ") || "Scoped baseline work."}</small></div>`
      : `<div class="complexity pending"><small>Complexity assessment pending</small></div>`;
    const runtimeDecision = item.runtimeDecision ? `<small class="runtime-decision">Runtime: ${escapeHtml(item.runtimeDecision.choice)} by ${escapeHtml(item.runtimeDecision.actor)}</small>` : "";
    const runtime = item.status === "queued" && assessment
      ? `<button class="mini runtime" data-runtime-assignment="${item.id}" title="Review the provider-neutral runtime recommendation">Runtime settings</button>`
      : "";
    return `<div class="assignment"><div class="assignment-top"><strong>${escapeHtml(item.title)}</strong><span class="role">${escapeHtml(item.role)}</span></div><p>${escapeHtml(item.agent_name ? `${item.agent_name} · ${item.status}` : item.status)}${item.requires_write ? " · write lease" : ""}</p>${assessmentView}${runtimeDecision}${hold}${blockedBy}${checks}${scope}${checklist}<div class="assignment-actions">${runtime}${checkpoint}${release}</div></div>`;
  }).join("") || `<p class="hint">Waiting for the plan</p>`;
  renderSessionCheckpoints(task);
  renderBlackboard(task);
  const approvals = task.approvals.length;
  $("#approval-label").textContent = `${approvals} / ${task.required_approvals}`;
  $("#approval-progress").style.width = `${Math.min(100, approvals / task.required_approvals * 100)}%`;
  const remaining = Math.max(0, task.required_approvals - approvals);
  const connectedCount = state.agents.filter((agent) => agent.status !== "disconnected").length;
  const acceptedEvent = task.status === "accepted" && task.events.slice().reverse().find((e) => e.type === "task.accepted");
  const humanOverride = acceptedEvent && acceptedEvent.metadata && acceptedEvent.metadata.humanOverride;
  let consensusCopy;
  if (task.status === "accepted") {
    consensusCopy = humanOverride
      ? "You accepted this task directly. This was not independent agent consensus."
      : "The current version has team consensus.";
  } else if (task.status === "blocked") {
    consensusCopy = "Task is blocked. Use Resume to unblock and continue work.";
  } else {
    consensusCopy = `${remaining} independent approval${remaining === 1 ? "" : "s"} still needed.`;
    if (remaining > 0 && connectedCount < remaining) {
      consensusCopy += ` Only ${connectedCount} agent${connectedCount === 1 ? "" : "s"} connected — connect ${remaining - connectedCount} more (each agent approves once) to reach consensus.`;
    }
  }
  $("#consensus-copy").textContent = consensusCopy;
  const canAccept = openAssignments === 0 && ["review"].includes(task.status);
  $("#accept-task").classList.toggle("hidden", !canAccept);
}

function renderSessionCheckpoints(task) {
  const checkpoints = Array.isArray(task.sessionCheckpoints) ? task.sessionCheckpoints : [];
  const section = $("#checkpoint-section");
  section.classList.toggle("hidden", checkpoints.length === 0);
  $("#checkpoint-count").textContent = checkpoints.length;
  $("#checkpoint-list").innerHTML = checkpoints.slice(0, 8).map((checkpoint) => {
    const bytes = checkpoint.capsuleMeta?.bytes ? `${(checkpoint.capsuleMeta.bytes / 1024).toFixed(1)} KiB` : "bounded";
    const expiry = checkpoint.status === "ready" ? `expires ${time(checkpoint.expiresAt)}` : checkpoint.status;
    const cancel = checkpoint.status === "ready"
      ? `<button class="mini" data-cancel-checkpoint="${checkpoint.id}" aria-label="Cancel checkpoint from ${escapeHtml(checkpoint.fromAgentName)}">Cancel</button>`
      : "";
    return `<div class="checkpoint-card"><div class="checkpoint-top"><strong>${escapeHtml(checkpoint.fromAgentName)}</strong><span class="checkpoint-status ${escapeHtml(checkpoint.status)}">${escapeHtml(checkpoint.status)}</span></div><p>${escapeHtml(checkpoint.nextAction || "Task state checkpointed")}</p><small>generation ${checkpoint.checkpointGeneration} · ${escapeHtml(bytes)} · ${escapeHtml(expiry)}</small>${cancel}</div>`;
  }).join("");
}

function renderTaskDescription(description) {
  const element = $("#task-description");
  const button = $("#open-task-brief");
  const text = String(description || "");
  const long = text.length > 220 || text.split("\n").length > 3;
  const preview = long ? text.replace(/\s+/g, " ").trim() : text;
  if (element.textContent !== preview) element.textContent = preview;
  element.classList.toggle("is-long", long);
  element.classList.toggle("collapsed", long);
  button.classList.toggle("hidden", !long);
  $("#task-brief-content").textContent = text;
  $("#task-brief-title").textContent = state?.selectedTask?.title || "Task brief";
}

function resizeMessageField(field) {
  field.style.height = "auto";
  const maxHeight = Number.parseFloat(getComputedStyle(field).maxHeight) || 130;
  const height = Math.min(field.scrollHeight, maxHeight);
  field.style.height = `${height}px`;
  field.style.overflowY = field.scrollHeight > maxHeight ? "auto" : "hidden";
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
    const forget = dead && member.agent_id
      ? `<button class="row-delete" data-forget-agent="${member.agent_id}" data-forget-name="${escapeHtml(member.agent_name)}" title="Remove this agent from DevTeam" aria-label="Remove ${escapeHtml(member.agent_name)}">×</button>`
      : "";
    return `<div class="member-row ${dead ? "gone" : ""}"><span class="member-name">${escapeHtml(member.agent_name)}</span><span class="member-role ${member.role === "observer" ? "observer" : ""}">${escapeHtml(member.role)}</span><span class="member-status">${escapeHtml(member.status)}</span>${forget}</div>`;
  }).join("");
}

// The team's shared working memory: versioned keys with provenance. A long value is collapsed.
function renderBlackboard(task) {
  renderMemoryScope("blackboard", task.blackboard || []);
  renderMemoryScope("project-blackboard", task.projectBlackboard || []);
  renderMemoryHealth(task);
  renderCodeGraph(task);
  renderKnowledge(task);
}

function renderMemoryHealth(task) {
  const target = $("#memory-health-summary");
  if (!target) return;
  const health = task.memoryHealth || {};
  const brief = health.brief || {};
  const limit = Number(brief.limitBytes || 32 * 1024);
  const bytes = brief.bytes == null ? null : Number(brief.bytes);
  const percentage = bytes == null || !limit ? 0 : Math.min(100, Math.round((bytes / limit) * 100));
  const formatBytes = (value) => value == null ? "Not generated yet" : `${(Number(value) / 1024).toFixed(1)} KiB`;
  $("#brief-budget-status").textContent = bytes == null ? `${Math.round(limit / 1024)} KiB limit` : `${percentage}% used`;
  const omitted = Object.entries(brief.omitted || {}).filter(([, count]) => Number(count) > 0);
  const lifecycle = health.knowledge || {};
  const errors = [health.knowledgeError?.message, health.graphError?.message].filter(Boolean);
  target.innerHTML = `
    <div class="brief-meter" role="meter" aria-label="Briefing byte use" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${bytes || 0}"><span style="width:${percentage}%"></span></div>
    <div class="memory-health-grid">
      <span><strong>${escapeHtml(formatBytes(bytes))}</strong> of ${escapeHtml(formatBytes(limit))}</span>
      <span><strong>${brief.truncated == null ? "Pending" : brief.truncated ? "Bounded" : "Complete"}</strong> context</span>
      <span><strong>${Number(lifecycle.stale || 0)}</strong> stale notes</span>
      <span><strong>${Number(lifecycle.disputed || 0)}</strong> disputed notes</span>
    </div>
    ${omitted.length ? `<p class="memory-omissions"><strong>Fetch on demand:</strong> ${omitted.map(([key, count]) => `${escapeHtml(key)} ${Number(count)}`).join(" · ")}</p>` : ""}
    ${brief.generatedAt ? `<small>Last ${escapeHtml(brief.delivery || "requested")} brief ${relativeTime(brief.generatedAt)}.</small>` : `<small>The first agent briefing will populate actual usage.</small>`}
    ${health.graphIndexedAt ? `<small>CodeGraph indexed ${relativeTime(health.graphIndexedAt)}${health.graphTruncated ? " at its safety cap" : ""}.</small>` : ""}
    ${errors.map((message) => `<p class="knowledge-error">${escapeHtml(message)}</p>`).join("")}
  `;
}

function renderCodeGraph(task) {
  const section = $("#codegraph-section");
  if (!section) return;
  const graph = task.codeGraph || {};
  section.classList.toggle("hidden", !graph.automated && !graph.moduleCount && !graph.error);
  $("#codegraph-count").textContent = graph.moduleCount || 0;
  const warning = graph.truncated ? `<p class="codegraph-warning">Showing the deterministic 3,000-module safety cap.</p>` : "";
  const error = graph.error ? `<p class="knowledge-error">Index needs attention: ${escapeHtml(graph.error.message)}</p>` : "";
  $("#codegraph-summary").innerHTML = `${error}<div class="codegraph-metrics"><span><strong>${Number(graph.moduleCount || 0)}</strong> modules</span><span><strong>${Number(graph.edgeCount || 0)}</strong> edges</span></div>${warning}<small>${graph.indexedAt ? `Indexed ${relativeTime(graph.indexedAt)}` : "Ready — indexing starts automatically."}</small>${graph.path ? `<code title="${escapeHtml(graph.path)}">${escapeHtml(graph.path)}</code>` : ""}`;
}

function renderKnowledge(task) {
  const section = $("#knowledge-section");
  if (!section) return;
  const notes = task.knowledge || [];
  const filter = $("#knowledge-filter")?.value || "current";
  const visible = notes.filter((note) => filter === "current" ? ["verified", "inferred"].includes(note.status) : note.status === filter);
  const notesById = new Map(notes.map((note) => [note.id, note]));
  section.classList.toggle("hidden", !task.knowledgeVault?.automated && notes.length === 0);
  $("#knowledge-count").textContent = visible.length;
  const error = task.knowledgeVault?.error;
  $("#knowledge-list").innerHTML = `${error ? `<p class="knowledge-error">Export needs attention: ${escapeHtml(error.message)}</p>` : ""}${visible.slice(0, 10).map((note) => `
    <div class="knowledge-note">
      <div><span class="knowledge-category">${escapeHtml(note.category)}</span><span class="knowledge-status ${escapeHtml(note.status)}">${escapeHtml(note.status)}</span></div>
      <strong>${escapeHtml(note.title)}</strong>
      <small>${escapeHtml(note.link)} · r${note.revision} · ${relativeTime(note.updated_at)}</small>
      ${note.stale_reason ? `<small class="knowledge-reason">${escapeHtml(note.stale_reason)}</small>` : ""}
      ${note.superseded_by ? `<small class="knowledge-reason">Superseded by ${escapeHtml(notesById.get(note.superseded_by)?.title || note.superseded_by)}</small>` : ""}
    </div>`).join("") || '<p class="memory-scope">Ready — notes appear as the team completes work.</p>'}`;
}

function renderMemoryScope(prefix, notes) {
  const section = $(`#${prefix}-section`);
  if (!section) return;
  section.classList.toggle("hidden", notes.length === 0);
  $(`#${prefix}-count`).textContent = notes.length;
  $(`#${prefix}-list`).innerHTML = notes.map((note) => {
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
  const connected = state.agents.filter((agent) => agent.status !== "disconnected");
  populateMessageTargets(connected);
  populateProposalAgents(connected);
}

// Team role negotiation: show open proposals with live vote tallies and let the human weigh in.
function renderProposals(task) {
  const section = $("#proposal-section");
  const active = !["accepted", "blocked", "cancelled"].includes(task.status);
  section.classList.toggle("hidden", !active);
  if (!active) {
    document.title = `DevTeam — ${task.title}`;
    proposalTaskId = task.id;
    proposalStatuses = new Map((task.proposals || []).map((proposal) => [proposal.id, proposal.status]));
    return;
  }
  const open = (task.proposals || []).filter((proposal) => proposal.status === "open");
  const sameTask = proposalTaskId === task.id;
  const newlyOpen = sameTask ? open.filter((proposal) => !proposalStatuses.has(proposal.id)) : [];
  const newlyAdopted = sameTask ? (task.proposals || []).filter((proposal) => proposal.status === "adopted" && proposalStatuses.get(proposal.id) === "open") : [];
  proposalTaskId = task.id;
  proposalStatuses = new Map((task.proposals || []).map((proposal) => [proposal.id, proposal.status]));
  const connectedNames = state.agents.filter((agent) => agent.status !== "disconnected").map((agent) => agent.name);
  $("#proposal-list").innerHTML = open.length
    ? open.map((proposal) => renderProposal(proposal, connectedNames)).join("")
    : `<p class="hint">No open proposals. Use ＋ to propose a role or decision.</p>`;
  document.title = open.length ? `(${open.length}) DevTeam — ${task.title}` : `DevTeam — ${task.title}`;
  if (newlyOpen.length) {
    section.classList.add("attention");
    navigator.vibrate?.([90, 45, 90]);
    toast(`${newlyOpen.length} new proposal${newlyOpen.length === 1 ? "" : "s"} needs attention`);
    setTimeout(() => section.classList.remove("attention"), 1800);
  }
  if (newlyAdopted.length) {
    navigator.vibrate?.(70);
    toast(`Accepted: ${newlyAdopted[0].summary}`);
  }
}

function renderProposal(proposal, connectedNames) {
  const agreers = proposal.votes.filter((vote) => vote.vote === "agree").map((vote) => vote.voter_name);
  const objectors = proposal.votes.filter((vote) => vote.vote === "object");
  // A dashboard-created proposal historically stored the human proposer's implicit agreement as
  // voter_id=human. That is not an explicit button vote, so keep actions available for those legacy
  // rows; agent-created proposals may still show the human's explicit pending vote.
  const humanVote = proposal.proposer_id ? proposal.votes.find((vote) => vote.voter_id === "human") : null;
  const stillNeeded = connectedNames.filter((name) => name !== proposal.proposer_name && !agreers.includes(name));
  const tally = objectors.length
    ? `<span class="vote-objection">objected: ${escapeHtml(objectors[0].voter_name)}</span>`
    : `${agreers.length} agreed${stillNeeded.length ? ` · waiting on ${escapeHtml(stillNeeded.join(", "))}` : " · ready"}`;
  const label = proposal.kind === "role" && proposal.details.role
    ? `${escapeHtml(proposal.details.role)}${proposal.details.targetAgentName ? ` → ${escapeHtml(proposal.details.targetAgentName)}` : ""}`
    : escapeHtml(proposal.kind);
  const actions = humanVote
    ? `<div class="proposal-human-vote">Your vote: ${humanVote.vote === "agree" ? "Agree" : "Object"} · waiting for resolution</div>`
    : `<div class="proposal-actions"><button class="mini agree" data-vote-proposal="${proposal.id}" data-vote="agree">Agree</button><button class="mini object" data-vote-proposal="${proposal.id}" data-vote="object">Object</button></div>`;
  return `<div class="proposal"><div class="proposal-top"><strong>${escapeHtml(proposal.summary)}</strong><span class="role">${label}</span></div><div class="proposal-meta">from ${escapeHtml(proposal.proposer_name)} · ${tally}</div>${actions}</div>`;
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
    // An unresponsive agent that has genuinely left keeps lingering as "online" (it holds its claim
    // on purpose). Offer a Remove so the human can clear the leftover session id on the spot.
    const forget = agent.status === "unresponsive"
      ? `<button class="row-delete" data-forget-agent="${agent.id}" data-forget-name="${escapeHtml(agent.name)}" title="Remove this unresponsive agent from DevTeam" aria-label="Remove ${escapeHtml(agent.name)}">×</button>`
      : "";
    const profile = agent.runtimeProfile;
    const profileLabel = runtimeProfileLabel(profile);
    const runtime = profile
      ? `<small class="runtime-profile">${escapeHtml(profileLabel || "Registered profile has no valid current selection")} · ${escapeHtml(profile.source)}${profile.stale ? " · expired" : ""}</small>`
      : `<small class="runtime-profile unknown">Model gating inactive — no runtime profile registered for this agent</small>`;
    const editRuntime = `<button class="row-runtime" data-edit-agent-runtime="${escapeHtml(agent.id)}" title="Set or correct ${escapeHtml(agent.name)}'s real model and effort options" aria-label="Edit runtime profile for ${escapeHtml(agent.name)}">⚙</button>`;
    return `<div class="agent"><div class="avatar">${initials(agent.name)}</div><div class="agent-info"><strong>${escapeHtml(agent.name)}${unread}</strong><small>${escapeHtml(agent.provider)} · ${escapeHtml(agent.status)} · session ${Number(agent.session_generation || 1)}</small>${runtime}<small class="activity">${escapeHtml(activityLine(agent))}</small></div><span class="agent-actions">${editRuntime}<span class="agent-status ${agent.status} ${freshness(agent.last_seen)}" title="${escapeHtml(agent.status)} · seen ${relativeTime(agent.last_seen)}"></span>${forget}</span></div>`;
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

function agentInvite(name = "your agent") {
  const task = state?.selectedTask;
  if (!task) return "Use $devteam to join the local DevTeam.";
  const fresh = task.session_policy === "manual" ? "" : " Open a fresh desktop conversation for this task using host-advertised runtime settings; related assignments normally stay in that session.";
  return `Use $devteam as ${name} and join task "${task.title}" with taskId ${task.id}.${fresh} If this is the same returning conversation, resume the prior DevTeam session so missed messages replay before claiming work. Use checkpoint takeover only when the invitation includes a one-time checkpoint token.`;
}

function addAttachments(files) {
  for (const file of files) {
    if (!ATTACHMENT_TYPES.has(file.type)) { toast(`${file.name}: unsupported file type`); continue; }
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) { toast(`${file.name}: file must be 10 MB or smaller`); continue; }
    if (pendingAttachments.length >= 6) { toast("Attach up to 6 files per message"); break; }
    pendingAttachments.push({ id: crypto.randomUUID(), file, objectUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
  }
  renderPendingAttachments();
}

function renderPendingAttachments() {
  const container = $("#attachment-preview");
  container.classList.toggle("hidden", pendingAttachments.length === 0);
  container.innerHTML = pendingAttachments.map((item) => `<div class="pending-attachment">${item.objectUrl ? `<img src="${escapeHtml(item.objectUrl)}" alt="">` : `<span>PDF</span>`}<strong title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</strong><button type="button" data-remove-attachment="${item.id}" aria-label="Remove ${escapeHtml(item.file.name)}">×</button></div>`).join("");
}

function clearPendingAttachments() {
  for (const item of pendingAttachments) if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
  pendingAttachments = [];
  renderPendingAttachments();
}

async function uploadAttachment(file, taskId) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Type": file.type },
    body: file,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Attachment upload failed (${response.status})`);
  return body;
}

function populateMessageTargets(connected) {
  const select = $("#message-target");
  if (select) {
    const savedTarget = selectedTaskId ? readDraft(selectedTaskId)?.target : null;
    const previous = savedTarget || select.value || "all";
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

function populateProposalAgents(connected) {
  const select = $("#proposal-agent");
  if (!select) return;
  const previous = select.value;
  const unique = [...new Map(connected.map((agent) => [agent.name, agent])).values()];
  select.innerHTML = [`<option value="">Anyone available</option>`]
    .concat(unique.map((agent) => `<option value="${escapeHtml(agent.name)}">${escapeHtml(agent.name)} · ${escapeHtml(agent.provider)}</option>`))
    .join("");
  select.value = unique.some((agent) => agent.name === previous) ? previous : "";
}

document.addEventListener("click", async (event) => {
  const retrySend = event.target.closest("[data-retry-send]");
  if (retrySend) {
    const pending = pendingSends.find((item) => item.id === retrySend.dataset.retrySend);
    if (pending) await processPendingSend(pending);
    return;
  }
  const searchResult = event.target.closest("[data-search-task]");
  if (searchResult) {
    const taskId = searchResult.dataset.searchTask || state.tasks.find((task) => task.project_id === searchResult.dataset.searchProject)?.id;
    if (!taskId) { toast("That knowledge note is not attached to a task yet"); return; }
    selectedTaskId = taskId;
    selectedProjectId = searchResult.dataset.searchProject || null;
    timelineFilter = "all";
    pendingJumpEventId = Number(searchResult.dataset.searchEvent) || null;
    $("#search-dialog").close();
    await refresh();
    return;
  }
  const removeAttachment = event.target.closest("[data-remove-attachment]");
  if (removeAttachment) {
    const index = pendingAttachments.findIndex((item) => item.id === removeAttachment.dataset.removeAttachment);
    if (index >= 0) {
      const [removed] = pendingAttachments.splice(index, 1);
      if (removed.objectUrl) URL.revokeObjectURL(removed.objectUrl);
      renderPendingAttachments();
    }
    return;
  }
  const dialogButton = event.target.closest("[data-dialog]");
  if (dialogButton) $("#" + dialogButton.dataset.dialog).showModal();
  if (event.target.closest(".close")) event.target.closest("dialog").close();
  const deleteTaskButton = event.target.closest("[data-delete-task]");
  if (deleteTaskButton) {
    const task = state.tasks.find((item) => item.id === deleteTaskButton.dataset.deleteTask);
    if (!task || !confirm(`Delete the task history “${task.title}” from DevTeam?\n\nMessages, assignments, and approvals for this task will be deleted. Project files will not be touched.`)) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: "DELETE", body: JSON.stringify({ confirmTaskId: task.id }) });
      storageSet(draftKey(task.id), null);
      storageSet(readKey(task.id), null);
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
  const forgetAgentButton = event.target.closest("[data-forget-agent]");
  if (forgetAgentButton) {
    const name = forgetAgentButton.dataset.forgetName || "this agent";
    if (!confirm(`Remove ${name} from DevTeam?\n\nThis clears the leftover session id so it stops showing here. Any work it still holds returns to the queue. It can reconnect any time with $devteam.`)) return;
    try {
      await api(`/api/agents/${forgetAgentButton.dataset.forgetAgent}`, { method: "DELETE", body: JSON.stringify({}) });
      await refresh();
      toast(`${name} removed from DevTeam`);
    } catch (error) { toast(error.message); }
    return;
  }
  const editProjectButton = event.target.closest("[data-edit-project]");
  if (editProjectButton) {
    const project = state.projects.find((item) => item.id === editProjectButton.dataset.editProject);
    if (!project) return;
    const form = $("#project-edit-form");
    form.dataset.projectId = project.id;
    form.elements.name.value = project.name;
    form.elements.root.value = project.root;
    $("#project-edit-dialog").showModal();
    return;
  }
  if (event.target.closest(".reply-cancel")) { replyTo = null; renderReplyContext(); return; }
  const replyButton = event.target.closest("[data-reply]");
  if (replyButton) {
    const parent = eventLookup.get(Number(replyButton.dataset.reply));
    if (parent) {
      replyTo = { id: parent.id, name: eventIsHuman(parent) ? "You" : eventAuthorName(parent), snippet: (parent.message || "").slice(0, 80) };
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
  const checkpointButton = event.target.closest("[data-checkpoint-assignment]");
  if (checkpointButton) {
    const task = state?.selectedTask;
    const assignment = task?.assignments.find((item) => item.id === checkpointButton.dataset.checkpointAssignment);
    if (!task || !assignment || assignment.status !== "claimed") return;
    const form = $("#checkpoint-form");
    form.reset();
    form.dataset.taskId = task.id;
    form.elements.assignmentId.value = assignment.id;
    $("#checkpoint-assignment-summary").textContent = `${assignment.agent_name} will hand off “${assignment.title}” at claim generation ${assignment.claim_generation}.`;
    $("#checkpoint-result").classList.add("hidden");
    $("#checkpoint-invitation").value = "";
    $("#create-checkpoint").classList.remove("hidden");
    $("#checkpoint-dialog").showModal();
    form.elements.nextAction.focus();
    return;
  }
  const editAgentRuntimeButton = event.target.closest("[data-edit-agent-runtime]");
  if (editAgentRuntimeButton) {
    const agent = state.agents.find((item) => item.id === editAgentRuntimeButton.dataset.editAgentRuntime);
    if (!agent || agent.status === "disconnected") return;
    openRuntimeProfileEditor({
      scopeType: "agent",
      scopeId: agent.id,
      scopeLabel: `${agent.name} · ${agent.provider}`,
      profile: agent.runtimeProfile,
    });
    return;
  }
  const runtimeButton = event.target.closest("[data-runtime-assignment]");
  if (runtimeButton) {
    const assignment = state?.selectedTask?.assignments.find((item) => item.id === runtimeButton.dataset.runtimeAssignment);
    if (!assignment?.assessment) return;
    const form = $("#runtime-form");
    form.reset();
    form.elements.assignmentId.value = assignment.id;
    form.elements.assessmentId.value = assignment.assessment.id;
    form.dataset.exceptional = String(Boolean(assignment.assessment.requirements.humanApprovalRequired));
    $("#runtime-assignment-summary").textContent = `${assignment.title}: ${assignment.assessment.level} (${assignment.assessment.score}). ${assignmentRuntimeLabel(assignment)}.`;
    $("#runtime-reasons").innerHTML = assignment.assessment.reasons.map((reason) => {
      const source = reason.source === "task" ? "from the task description" : "from the assignment";
      return `<p><strong>+${Number(reason.points)}</strong> ${escapeHtml(reason.detail)} <small>· ${escapeHtml(source)}</small></p>`;
    }).join("") || "<p>Baseline scoped work.</p>";
    $("#runtime-exceptional-confirm").classList.toggle("hidden", !assignment.assessment.requirements.humanApprovalRequired);
    const agents = state.agents.filter((agent) => agent.status !== "disconnected");
    $("#runtime-agent").innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)} · ${escapeHtml(runtimeProfileLabel(agent.runtimeProfile || state.selectedTask.baseRuntimeProfile) || "no runtime profile")}</option>`).join("") || '<option value="">No connected agents</option>';
    populateRuntimeOptions();
    $("#runtime-dialog").showModal();
    return;
  }
  const cancelCheckpointButton = event.target.closest("[data-cancel-checkpoint]");
  if (cancelCheckpointButton) {
    if (!selectedTaskId || !confirm("Cancel this unused session handoff?\n\nThe old session keeps its assignment claim, and the one-time handoff token will stop working immediately.")) return;
    try {
      await api(`/api/tasks/${selectedTaskId}/checkpoints/${cancelCheckpointButton.dataset.cancelCheckpoint}/cancel`, { method: "POST", body: JSON.stringify({}) });
      await refresh();
      toast("Checkpoint cancelled; the old claim was kept");
    } catch (error) { toast(error.message); }
    return;
  }
  const voteButton = event.target.closest("[data-vote-proposal]");
  if (voteButton) {
    const actions = voteButton.closest(".proposal-actions");
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    try { await api(`/api/proposals/${voteButton.dataset.voteProposal}/vote`, { method: "POST", body: JSON.stringify({ vote: voteButton.dataset.vote }) }); await refresh(); }
    catch (error) { for (const button of actions.querySelectorAll("button")) button.disabled = false; toast(error.message); }
    return;
  }
  const reconnectButton = event.target.closest("[data-reconnect]");
  if (reconnectButton) {
    const name = reconnectButton.dataset.reconnect;
    const promptText = agentInvite(name);
    try { await navigator.clipboard.writeText(promptText); toast(`Copied — paste into ${name}'s desktop to reconnect`); }
    catch { toast(`Paste into ${name}'s desktop: ${promptText}`); }
    return;
  }
  const taskButton = event.target.closest("[data-task]");
  if (taskButton) { clearPendingAttachments(); selectedTaskId = taskButton.dataset.task; syncTaskUrl(); await refresh(); }
  const projectButton = event.target.closest("[data-project]");
  if (projectButton) { clearPendingAttachments(); selectedProjectId = projectButton.dataset.project; const first = state.tasks.find((task) => task.project_id === selectedProjectId); selectedTaskId = first?.id || null; syncTaskUrl(); await refresh(); }
});

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const values = Object.fromEntries(new FormData(event.target)); values.requiredApprovals = Number(values.requiredApprovals);
    const task = await api("/api/tasks", { method: "POST", body: JSON.stringify(values) });
    selectedTaskId = task.id; selectedProjectId = task.project_id; event.target.reset(); event.target.closest("dialog").close(); await refresh(); toast("Task created — use Invite agent to start its room");
  } catch (error) { toast(error.message); }
});

$("#project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const project = await api("/api/projects", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    selectedProjectId = project.id; event.target.reset(); event.target.closest("dialog").close(); await refresh(); toast("Project added");
  } catch (error) { toast(error.message); }
});

function runtimeClassOptions(values, selected) {
  return values.map((value) => `<option value="${value}" ${value === selected ? "selected" : ""}>${escapeHtml(value.replace("_", " "))}</option>`).join("");
}

function renderProfileModelRows() {
  $("#profile-model-list").innerHTML = profileDraftModels.map((model, modelIndex) => `
    <section class="profile-model-card">
      <div class="profile-model-head"><strong>Model ${modelIndex + 1}</strong><button type="button" class="row-delete visible" data-profile-remove-model="${modelIndex}" aria-label="Remove model ${modelIndex + 1}">×</button></div>
      <div class="profile-grid">
        <label>Model ID<input data-profile-model-field="id" data-model-index="${modelIndex}" value="${escapeHtml(model.id || "")}" placeholder="desktop-model-id" required></label>
        <label>Display name<input data-profile-model-field="label" data-model-index="${modelIndex}" value="${escapeHtml(model.label || "")}" placeholder="Clear model name" required></label>
        <label>Capability class<select data-profile-model-field="class" data-model-index="${modelIndex}">${runtimeClassOptions(MODEL_CLASSES, model.class)}</select></label>
      </div>
      <div class="profile-effort-list">${(model.efforts || []).map((effort, effortIndex) => `
        <div class="profile-effort-row">
          <input data-profile-effort-field="id" data-model-index="${modelIndex}" data-effort-index="${effortIndex}" value="${escapeHtml(effort.id || "")}" placeholder="effort-id" aria-label="Effort ID" required>
          <input data-profile-effort-field="label" data-model-index="${modelIndex}" data-effort-index="${effortIndex}" value="${escapeHtml(effort.label || "")}" placeholder="Display label" aria-label="Effort display label" required>
          <select data-profile-effort-field="class" data-model-index="${modelIndex}" data-effort-index="${effortIndex}" aria-label="Effort class">${runtimeClassOptions(EFFORT_CLASSES, effort.class)}</select>
          <button type="button" class="row-delete visible" data-profile-remove-effort="${modelIndex}:${effortIndex}" aria-label="Remove effort">×</button>
        </div>`).join("")}</div>
      <button type="button" class="secondary profile-add-effort" data-profile-add-effort="${modelIndex}">Add effort</button>
    </section>`).join("");
  populateProfileCurrentOptions(profileDraftCurrentModel, profileDraftCurrentEffort);
}

function populateProfileCurrentOptions(requestedModel = "", requestedEffort = "") {
  const models = profileDraftModels.filter((model) => String(model.id || "").trim());
  const modelId = models.some((model) => model.id === requestedModel) ? requestedModel : (models[0]?.id || "");
  profileDraftCurrentModel = modelId;
  $("#profile-current-model").innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === modelId ? "selected" : ""}>${escapeHtml(model.label || model.id)} · ${escapeHtml(model.class)}</option>`).join("") || '<option value="">Add a model first</option>';
  const model = models.find((item) => item.id === modelId);
  const efforts = (model?.efforts || []).filter((effort) => String(effort.id || "").trim());
  const effortId = efforts.some((effort) => effort.id === requestedEffort) ? requestedEffort : (efforts[0]?.id || "");
  profileDraftCurrentEffort = effortId;
  $("#profile-current-effort").innerHTML = efforts.map((effort) => `<option value="${escapeHtml(effort.id)}" ${effort.id === effortId ? "selected" : ""}>${escapeHtml(effort.label || effort.id)} · ${escapeHtml(effort.class)}</option>`).join("") || '<option value="">Add an effort first</option>';
}

function openRuntimeProfileEditor({ scopeType, scopeId, scopeLabel, profile = null }) {
  const form = $("#runtime-profile-form");
  form.reset();
  form.dataset.scopeType = scopeType;
  form.dataset.scopeId = scopeId;
  form.elements.providerId.value = profile?.providerId || "";
  form.elements.switchMode.value = profile?.switchMode || "user_required";
  profileDraftModels = (profile?.availableModels || []).map((model) => ({
    id: model.id,
    label: model.label,
    class: model.class,
    efforts: (model.efforts || []).map((effort) => ({ id: effort.id, label: effort.label, class: effort.class })),
  }));
  if (!profileDraftModels.length) profileDraftModels = [{ id: "", label: "", class: "balanced", efforts: [{ id: "", label: "", class: "medium" }] }];
  for (const model of profileDraftModels) {
    if (!model.efforts.length) model.efforts.push({ id: "", label: "", class: "medium" });
  }
  profileDraftCurrentModel = profile?.currentModel || "";
  profileDraftCurrentEffort = profile?.currentEffort || "";
  $("#runtime-profile-title").textContent = scopeType === "task" ? "Set task base runtime" : "Set agent runtime";
  $("#runtime-profile-scope").textContent = scopeLabel;
  $("#profile-clear-task").classList.toggle("hidden", scopeType !== "task" || !profile);
  renderProfileModelRows();
  $("#runtime-profile-dialog").showModal();
}

$("#profile-add-model").addEventListener("click", () => {
  profileDraftModels.push({ id: "", label: "", class: "balanced", efforts: [{ id: "", label: "", class: "medium" }] });
  renderProfileModelRows();
});

$("#profile-model-list").addEventListener("input", (event) => {
  const modelField = event.target.dataset.profileModelField;
  const effortField = event.target.dataset.profileEffortField;
  const modelIndex = Number(event.target.dataset.modelIndex);
  if (modelField && profileDraftModels[modelIndex]) profileDraftModels[modelIndex][modelField] = event.target.value;
  if (effortField) {
    const effortIndex = Number(event.target.dataset.effortIndex);
    if (profileDraftModels[modelIndex]?.efforts[effortIndex]) profileDraftModels[modelIndex].efforts[effortIndex][effortField] = event.target.value;
  }
  populateProfileCurrentOptions(profileDraftCurrentModel, profileDraftCurrentEffort);
});

$("#profile-model-list").addEventListener("change", (event) => {
  event.target.dispatchEvent(new Event("input", { bubbles: true }));
});

$("#profile-model-list").addEventListener("click", (event) => {
  const addEffort = event.target.closest("[data-profile-add-effort]");
  if (addEffort) {
    profileDraftModels[Number(addEffort.dataset.profileAddEffort)].efforts.push({ id: "", label: "", class: "medium" });
    renderProfileModelRows();
    return;
  }
  const removeEffort = event.target.closest("[data-profile-remove-effort]");
  if (removeEffort) {
    const [modelIndex, effortIndex] = removeEffort.dataset.profileRemoveEffort.split(":").map(Number);
    profileDraftModels[modelIndex].efforts.splice(effortIndex, 1);
    renderProfileModelRows();
    return;
  }
  const removeModel = event.target.closest("[data-profile-remove-model]");
  if (removeModel) {
    profileDraftModels.splice(Number(removeModel.dataset.profileRemoveModel), 1);
    renderProfileModelRows();
  }
});

$("#profile-current-model").addEventListener("change", (event) => populateProfileCurrentOptions(event.target.value, ""));
$("#profile-current-effort").addEventListener("change", (event) => { profileDraftCurrentEffort = event.target.value; });

$("#runtime-profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const models = profileDraftModels.map((model) => ({
    id: String(model.id || "").trim(),
    label: String(model.label || "").trim(),
    class: model.class,
    efforts: (model.efforts || []).map((effort) => ({ id: String(effort.id || "").trim(), label: String(effort.label || "").trim(), class: effort.class })),
  }));
  if (!models.length || models.some((model) => !model.id || !model.label || !model.efforts.length || model.efforts.some((effort) => !effort.id || !effort.label))) {
    toast("Every model and effort needs an ID and a clear display name");
    return;
  }
  if (new Set(models.map((model) => model.id)).size !== models.length || models.some((model) => new Set(model.efforts.map((effort) => effort.id)).size !== model.efforts.length)) {
    toast("Model and effort IDs must be unique within the profile");
    return;
  }
  const values = Object.fromEntries(new FormData(form));
  const currentModel = models.find((model) => model.id === values.currentModel);
  if (!currentModel?.efforts.some((effort) => effort.id === values.currentEffort)) { toast("Choose a valid current model and effort"); return; }
  const profile = {
    providerId: values.providerId,
    currentModel: values.currentModel,
    currentEffort: values.currentEffort,
    availableModels: models,
    switchMode: values.switchMode,
    source: "user",
    observedAt: new Date().toISOString(),
  };
  try {
    if (form.dataset.scopeType === "task") {
      await api(`/api/tasks/${form.dataset.scopeId}`, { method: "PATCH", body: JSON.stringify({ baseRuntimeProfile: profile }) });
    } else {
      await api(`/api/agents/${form.dataset.scopeId}/runtime`, { method: "PUT", body: JSON.stringify({ profile }) });
    }
    form.closest("dialog").close();
    await refresh();
    if ($("#runtime-dialog").open) populateRuntimeOptions();
    toast("Runtime profile saved with real model names");
  } catch (error) { toast(error.message); }
});

$("#profile-clear-task").addEventListener("click", async () => {
  const form = $("#runtime-profile-form");
  if (form.dataset.scopeType !== "task" || !confirm("Clear this task's base runtime profile? Model gating stays inactive for agents that do not advertise their own profile.")) return;
  try {
    await api(`/api/tasks/${form.dataset.scopeId}`, { method: "PATCH", body: JSON.stringify({ baseRuntimeProfile: null }) });
    $("#runtime-profile-dialog").close();
    await refresh();
    toast("Task runtime profile cleared");
  } catch (error) { toast(error.message); }
});

const checkpointLines = (value) => String(value || "").split("\n").map((line) => line.trim()).filter(Boolean);

function selectedRuntimeAgent() {
  return state?.agents.find((agent) => agent.id === $("#runtime-agent").value) || null;
}

function selectedRuntimeProfile() {
  return selectedRuntimeAgent()?.runtimeProfile || state?.selectedTask?.baseRuntimeProfile || null;
}

function populateRuntimeOptions(requestedModel = null) {
  const agent = selectedRuntimeAgent();
  const profile = selectedRuntimeProfile();
  const models = profile?.availableModels || [];
  const selectedModel = models.some((model) => model.id === requestedModel) ? requestedModel : profile?.currentModel;
  $("#runtime-model").innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === selectedModel ? "selected" : ""}>${escapeHtml(model.label)} · ${escapeHtml(model.class)}</option>`).join("") || '<option value="">No advertised models</option>';
  const model = models.find((item) => item.id === selectedModel) || models[0];
  $("#runtime-effort").innerHTML = (model?.efforts || []).map((effort) => `<option value="${escapeHtml(effort.id)}" ${effort.id === profile?.currentEffort ? "selected" : ""}>${escapeHtml(effort.label)} · ${escapeHtml(effort.class)}</option>`).join("") || '<option value="">No advertised efforts</option>';
  $("#runtime-profile-state").textContent = profile
    ? `${agent?.runtimeProfile ? "Agent profile" : "Task base profile"}: ${runtimeProfileLabel(profile) || "no valid current selection"}`
    : "Model gating inactive — no runtime profile registered for this agent";
}

$("#runtime-agent").addEventListener("change", populateRuntimeOptions);
$("#runtime-model").addEventListener("change", (event) => populateRuntimeOptions(event.target.value));
$("#runtime-edit-profile").addEventListener("click", () => {
  const agent = selectedRuntimeAgent();
  if (!agent) { toast("Choose a connected agent first"); return; }
  openRuntimeProfileEditor({ scopeType: "agent", scopeId: agent.id, scopeLabel: `${agent.name} · ${agent.provider}`, profile: agent.runtimeProfile });
});
$("#runtime-form").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-runtime-choice]");
  if (!button) return;
  const form = event.currentTarget;
  const choice = button.dataset.runtimeChoice;
  const values = Object.fromEntries(new FormData(form));
  if (!values.agentId) { toast("Choose an agent with an advertised runtime profile"); return; }
  const exceptional = form.dataset.exceptional === "true";
  if (exceptional && ["switched", "continue"].includes(choice) && values.humanApproved !== "on") { toast("Exceptional settings require explicit approval"); return; }
  button.disabled = true;
  try {
    if (choice === "switched") {
      const profile = selectedRuntimeProfile();
      const advertised = profile?.availableModels.find((model) => model.id === values.modelId);
      const effort = advertised?.efforts.find((item) => item.id === values.effortId);
      if (!advertised || !effort) throw new Error("Choose a host-advertised model and effort before confirming the switch.");
      await api(`/api/agents/${values.agentId}/runtime`, { method: "PUT", body: JSON.stringify({ profile: {
        ...profile,
        currentModel: advertised.id,
        currentEffort: effort.id,
        currentModelClass: advertised.class,
        currentEffortClass: effort.class,
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      } }) });
    }
    await api(`/api/assignments/${values.assignmentId}/runtime-decisions`, { method: "POST", body: JSON.stringify({
      agentId: values.agentId,
      assessmentId: values.assessmentId,
      choice,
      reason: values.reason,
      humanApproved: values.humanApproved === "on",
    }) });
    $("#runtime-dialog").close();
    await refresh();
    toast(`Runtime decision recorded: ${choice}`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$("#checkpoint-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const taskId = form.dataset.taskId;
  if (!taskId || !form.elements.assignmentId.value) return;
  const submit = $("#create-checkpoint");
  submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const result = await api(`/api/tasks/${taskId}/checkpoints`, {
      method: "POST",
      body: JSON.stringify({
        assignmentId: values.assignmentId,
        nextAction: values.nextAction,
        decisions: checkpointLines(values.decisions),
        blockers: checkpointLines(values.blockers),
        checks: checkpointLines(values.checks),
        failedApproaches: checkpointLines(values.failedApproaches),
        expiresInMinutes: Number(values.expiresInMinutes),
      }),
    });
    $("#checkpoint-invitation").value = result.invitation;
    $("#checkpoint-result").classList.remove("hidden");
    submit.classList.add("hidden");
    await refresh();
    try { await navigator.clipboard.writeText(result.invitation); toast("Checkpoint created and invitation copied"); }
    catch { toast("Checkpoint created — copy the one-time invitation now"); }
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
});

$("#copy-checkpoint-invitation").addEventListener("click", async () => {
  const invitation = $("#checkpoint-invitation").value;
  if (!invitation) return;
  try { await navigator.clipboard.writeText(invitation); toast("Fresh-session invitation copied"); }
  catch { $("#checkpoint-invitation").select(); toast("Invitation selected — copy it now"); }
});

$("#checkpoint-dialog").addEventListener("close", () => {
  $("#checkpoint-invitation").value = "";
  $("#checkpoint-result").classList.add("hidden");
  $("#create-checkpoint").classList.remove("hidden");
});

function openTaskEditor() {
  const task = state?.selectedTask;
  if (!task) return;
  const form = $("#task-edit-form");
  form.dataset.taskId = task.id;
  form.elements.title.value = task.title;
  form.elements.description.value = task.description;
  form.elements.requiredApprovals.value = String(task.required_approvals);
  form.elements.sessionPolicy.value = task.session_policy || "manual";
  $("#task-edit-dialog").showModal();
}

$("#edit-task").addEventListener("click", openTaskEditor);
$("#edit-task-runtime").addEventListener("click", () => {
  const task = state?.selectedTask;
  if (!task) return;
  openRuntimeProfileEditor({ scopeType: "task", scopeId: task.id, scopeLabel: `Default runtime for “${task.title}”`, profile: task.baseRuntimeProfile });
});
$("#edit-task-from-brief").addEventListener("click", () => {
  $("#task-brief-dialog").close();
  openTaskEditor();
});

$("#task-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const taskId = form.dataset.taskId;
  if (!taskId) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ title: values.title, description: values.description, requiredApprovals: Number(values.requiredApprovals), sessionPolicy: values.sessionPolicy }) });
    form.closest("dialog").close(); await refresh(); toast("Task updated");
  } catch (error) { toast(error.message); }
});

$("#project-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const projectId = form.dataset.projectId;
  if (!projectId) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name: values.name, root: values.root }) });
    form.closest("dialog").close(); await refresh(); toast("Project updated");
  } catch (error) { toast(error.message); }
});

async function processPendingSend(item) {
  if (messageSending) { toast("Wait for the current message to finish sending"); return; }
  const sendButton = $("#message-form .send");
  messageSending = true;
  item.status = "sending";
  item.error = "";
  sendButton.disabled = true;
  if (state?.selectedTask?.id === item.taskId) renderTimeline(state.selectedTask, { wasNearBottom: true });
  try {
    item.uploaded ||= await Promise.all(item.files.map((file) => uploadAttachment(file, item.taskId)));
    const markers = item.uploaded.map((attachment) => `[[devteam-attachment ${JSON.stringify(attachment)}]]`);
    const body = { message: [item.message, ...markers].filter(Boolean).join("\n"), target: item.target };
    if (item.replyTo) body.replyTo = item.replyTo;
    await api(`/api/tasks/${item.taskId}/messages`, { method: "POST", body: JSON.stringify(body) });
    pendingSends = pendingSends.filter((pending) => pending.id !== item.id);
    const stored = readDraft(item.taskId);
    if (!stored || stored.message === item.message) clearMessageDraft(item.taskId);
    try { await refresh(); }
    catch (error) { toast(`Message sent, but the timeline refresh failed: ${error.message}`); }
  } catch (error) {
    item.status = "failed";
    item.error = error.message;
    if (!readDraft(item.taskId)) storageSet(draftKey(item.taskId), JSON.stringify({ message: item.message, target: item.target, savedAt: new Date().toISOString() }));
    if (state?.selectedTask?.id === item.taskId) {
      updateDraftStatus("Failed message kept for retry");
      renderTimeline(state.selectedTask, { wasNearBottom: true });
    }
    toast(`Message failed: ${error.message}`);
  } finally {
    messageSending = false;
    sendButton.disabled = false;
  }
}

$("#message-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!selectedTaskId || messageSending) return;
  const field = event.target.elements.message;
  const message = field.value.trim();
  if (!message && pendingAttachments.length === 0) { toast("Write a message or attach a file"); return; }
  const item = {
    id: crypto.randomUUID(),
    taskId: selectedTaskId,
    message,
    target: event.target.elements.target?.value || "all",
    replyTo: replyTo?.id || null,
    files: pendingAttachments.map((attachment) => attachment.file),
    uploaded: null,
    status: "sending",
    error: "",
  };
  pendingSends.push(item);
  field.value = "";
  resizeMessageField(field);
  clearPendingAttachments();
  updateDraftStatus("Sending…");
  replyTo = null;
  renderReplyContext();
  await processPendingSend(item);
});

$("#message-form").addEventListener("keydown", (event) => {
  if (event.target.tagName === "TEXTAREA" && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

$("#message-form").elements.message.addEventListener("input", (event) => {
  resizeMessageField(event.target);
  saveMessageDraft();
});
$("#message-target").addEventListener("change", () => saveMessageDraft());

$("#attachment-input").addEventListener("change", (event) => {
  addAttachments(event.target.files || []);
  event.target.value = "";
});

$("#message-form").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); addAttachments(files); }
});

for (const type of ["dragenter", "dragover"]) {
  $("#message-form").addEventListener(type, (event) => { event.preventDefault(); event.currentTarget.classList.add("dragging"); });
}
for (const type of ["dragleave", "drop"]) {
  $("#message-form").addEventListener(type, (event) => {
    event.preventDefault(); event.currentTarget.classList.remove("dragging");
    if (type === "drop") addAttachments(event.dataTransfer?.files || []);
  });
}

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

$("#accept-task").addEventListener("click", async () => {
  if (!confirm("Accept this task without full agent consensus?\n\nThis overrides the normal independent-review requirement. The task will be marked as human-accepted.")) return;
  const summary = prompt("Optional: add a short acceptance note (or press OK to skip).");
  try { await api(`/api/tasks/${selectedTaskId}/accept`, { method: "POST", body: JSON.stringify({ summary: summary || "Human accepted from dashboard" }) }); await refresh(); toast("Task accepted"); } catch (error) { toast(error.message); }
});

$("#unblock-task").addEventListener("click", async () => {
  const reason = prompt("Why is the task ready to resume?"); if (!reason) return;
  try { await api(`/api/tasks/${selectedTaskId}/unblock`, { method: "POST", body: JSON.stringify({ reason }) }); await refresh(); toast("Task unblocked — agents can resume"); } catch (error) { toast(error.message); }
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

$("#copy-task-invite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(agentInvite()); toast("Task-specific agent invite copied"); }
  catch { toast(agentInvite()); }
});

$("#knowledge-filter")?.addEventListener("change", () => {
  if (state?.selectedTask) renderKnowledge(state.selectedTask);
});

$("#timeline-filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-timeline-filter]");
  if (!button || !state?.selectedTask) return;
  timelineFilter = button.dataset.timelineFilter;
  renderTimeline(state.selectedTask, { wasNearBottom: false });
});

$("#jump-latest").addEventListener("click", () => {
  if (!state?.selectedTask) return;
  timelineFilter = "all";
  renderTimeline(state.selectedTask, { wasNearBottom: true });
});

let timelineScrollFrame = 0;
$("#event-list").addEventListener("scroll", () => {
  cancelAnimationFrame(timelineScrollFrame);
  timelineScrollFrame = requestAnimationFrame(() => {
    const list = $("#event-list");
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
    if (nearBottom) markTimelineRead();
    else $("#jump-latest").classList.remove("hidden");
  });
});

function searchResultMarkup(result) {
  const occurred = result.occurred_at ? relativeTime(result.occurred_at) : "";
  return `<button class="search-result" type="button" data-search-task="${escapeHtml(result.task_id || "")}" data-search-project="${escapeHtml(result.project_id || "")}" data-search-event="${Number(result.event_id) || ""}"><span class="search-kind">${escapeHtml(result.kind)}</span><span class="search-copy"><strong>${escapeHtml(result.title)}</strong><span>${escapeHtml(result.snippet || "No preview")}</span><small>${escapeHtml(result.project_name)} · ${escapeHtml(result.subtype || result.kind)}</small></span><time>${escapeHtml(occurred)}</time></button>`;
}

async function performWorkspaceSearch() {
  const input = $("#workspace-search");
  const results = $("#search-results");
  const query = input.value.trim();
  const generation = ++searchGeneration;
  if (query.length < 2) {
    results.innerHTML = `<p class="search-empty">Type at least two characters to search the workspace.</p>`;
    return;
  }
  results.innerHTML = `<p class="search-empty">Searching…</p>`;
  const project = $("#search-current-project").checked ? selectedProjectId : null;
  try {
    const params = new URLSearchParams({ q: query, limit: "50" });
    if (project) params.set("projectId", project);
    const response = await api(`/api/search?${params}`);
    if (generation !== searchGeneration) return;
    results.innerHTML = response.results.length
      ? response.results.map(searchResultMarkup).join("")
      : `<p class="search-empty">No workspace results for “${escapeHtml(query)}”.</p>`;
  } catch (error) {
    if (generation === searchGeneration) results.innerHTML = `<p class="search-empty">Search failed: ${escapeHtml(error.message)}</p>`;
  }
}

let searchTimer = 0;
$("#workspace-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(performWorkspaceSearch, 180);
});
$("#search-current-project").addEventListener("change", performWorkspaceSearch);
$("#open-search").addEventListener("click", () => setTimeout(() => $("#workspace-search").focus(), 0));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("#search-dialog").open) $("#search-dialog").showModal();
    $("#workspace-search").focus();
  }
});

function initPanelResizers() {
  const shell = $(".app-shell");
  const widths = {
    sidebar: Math.max(190, Math.min(420, Number(storageGet("dt-sidebar-width")) || 260)),
    team: Math.max(240, Math.min(520, Number(storageGet("dt-panel-width")) || 300)),
  };
  const applyWidth = (panel, width) => {
    const minimum = panel === "sidebar" ? 190 : 240;
    const hardMaximum = panel === "sidebar" ? 420 : 520;
    const peerWidth = widths[panel === "sidebar" ? "team" : "sidebar"];
    const layoutMaximum = window.innerWidth > 1050 ? Math.max(minimum, window.innerWidth - peerWidth - 460) : hardMaximum;
    widths[panel] = Math.round(Math.max(minimum, Math.min(hardMaximum, layoutMaximum, width)));
    shell.style.setProperty(panel === "sidebar" ? "--sidebar-open-w" : "--panel-open-w", `${widths[panel]}px`);
    storageSet(panel === "sidebar" ? "dt-sidebar-width" : "dt-panel-width", String(widths[panel]));
  };
  applyWidth("sidebar", widths.sidebar);
  applyWidth("team", widths.team);
  window.addEventListener("resize", () => {
    applyWidth("sidebar", widths.sidebar);
    applyWidth("team", widths.team);
  });
  for (const handle of document.querySelectorAll("[data-resize-panel]")) {
    const panel = handle.dataset.resizePanel;
    handle.setAttribute("aria-valuemin", panel === "sidebar" ? "190" : "240");
    handle.setAttribute("aria-valuemax", panel === "sidebar" ? "420" : "520");
    const syncValue = () => handle.setAttribute("aria-valuenow", String(widths[panel]));
    syncValue();
    handle.addEventListener("pointerdown", (event) => {
      if (window.innerWidth <= 1050) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("resizing-panel");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const raw = panel === "sidebar" ? event.clientX : window.innerWidth - event.clientX;
      applyWidth(panel, Math.max(panel === "sidebar" ? 190 : 240, Math.min(panel === "sidebar" ? 420 : 520, raw)));
      syncValue();
    });
    const stop = (event) => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.classList.remove("resizing-panel");
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const delta = panel === "sidebar" ? direction * 12 : direction * -12;
      applyWidth(panel, Math.max(panel === "sidebar" ? 190 : 240, Math.min(panel === "sidebar" ? 420 : 520, widths[panel] + delta)));
      syncValue();
    });
  }
}

function initPanelToggles() {
  const shell = $(".app-shell");
  const sidebarBtn = $("#toggle-sidebar");
  const teamBtn = $("#toggle-team");
  const narrow = window.innerWidth <= 1050;
  if (narrow) {
    shell.classList.add("sidebar-collapsed", "panel-collapsed");
  } else {
    if (storageGet("dt-sidebar") === "collapsed") shell.classList.add("sidebar-collapsed");
    if (storageGet("dt-panel") === "collapsed") shell.classList.add("panel-collapsed");
  }
  const sync = (persist = true) => {
    const sidebarOpen = !shell.classList.contains("sidebar-collapsed");
    const panelOpen = !shell.classList.contains("panel-collapsed");
    sidebarBtn.setAttribute("aria-expanded", String(sidebarOpen));
    teamBtn.setAttribute("aria-expanded", String(panelOpen));
    if (persist) {
      storageSet("dt-sidebar", sidebarOpen ? "open" : "collapsed");
      storageSet("dt-panel", panelOpen ? "open" : "collapsed");
    }
  };
  const togglePanel = (panel) => {
    const className = panel === "sidebar" ? "sidebar-collapsed" : "panel-collapsed";
    const opening = shell.classList.contains(className);
    shell.classList.toggle(className);
    if (opening && window.matchMedia("(max-width: 1050px)").matches) {
      shell.classList.add(panel === "sidebar" ? "panel-collapsed" : "sidebar-collapsed");
    }
    sync();
  };
  sidebarBtn.addEventListener("click", () => togglePanel("sidebar"));
  teamBtn.addEventListener("click", () => togglePanel("team"));
  for (const button of document.querySelectorAll("[data-close-panel]")) {
    button.addEventListener("click", () => {
      shell.classList.add(button.dataset.closePanel === "sidebar" ? "sidebar-collapsed" : "panel-collapsed");
      sync();
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !window.matchMedia("(max-width: 1050px)").matches) return;
    shell.classList.add("sidebar-collapsed", "panel-collapsed");
    sync();
  });
  sync(false);
}

async function boot() {
  initPanelToggles();
  initPanelResizers();
  try {
    config = await api("/api/config"); $("#server-address").textContent = new URL(config.mcpUrl).host;
    await refresh();
    const stream = new EventSource("/api/stream"); stream.onmessage = () => refresh().catch(() => {});
    // Keep presence ("3s ago", pulse colour) live between server events.
    setInterval(() => { if (state) renderAgentList(); }, 5000);
  } catch (error) { toast(error.message); }
}
boot();
