import { blockedBannerCopy, escapeHtml, eventMatchesTimelineFilter, renderSafeMarkdown, unreadTimelineCount } from "/ui-utils.js";

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
// Only the software defaults get a nicer present-participle label; a project that defines its own
// vocabulary falls back to the role name itself, which reads fine ("Ana · fact-checker").
const ROLE_VERB = { planner: "planning", implementer: "implementing", reviewer: "reviewing", "security-reviewer": "security review", tester: "testing", researcher: "researching" };

// The roles the selected task's project defines. Populated from the task payload so the dropdown
// offers this project's vocabulary rather than a list of job titles baked into the HTML.
// Checks that used to pass and now do not, with who is suspected. Shown above the assignment list
// because a broken shared check is the team's problem, not one assignment's.
function renderRegressions(task) {
  const container = $("#regressions");
  if (!container) return;
  const open = task.regressions || [];
  container.classList.toggle("hidden", open.length === 0);
  if (!open.length) { container.innerHTML = ""; return; }
  container.innerHTML = `<div class="section-label">Broken checks</div>` + open.map((regression) => {
    const suspects = (regression.suspects || []).map((suspect) => `${escapeHtml(suspect.title)}${suspect.author ? ` · ${escapeHtml(suspect.author)}` : ""}`).join("; ");
    const blame = regression.suspects?.length === 1
      ? `Last green before ${suspects}`
      : (regression.suspects?.length ? `${regression.suspects.length} changes landed since it was green: ${suspects}` : "Nothing changed files since it was green");
    return `<div class="regression"><strong>${escapeHtml(regression.label)} regressed</strong><span>${blame}</span>${regression.fixAssignmentId ? `<small>A fix is queued.</small>` : ""}</div>`;
  }).join("");
}

function renderRoleOptions(select, catalogue, selected) {
  if (!select) return;
  const roles = catalogue?.roles?.length ? catalogue.roles : [{ name: "implementer" }];
  const keep = selected || select.value;
  select.innerHTML = roles.map((role) => {
    const marks = [role.plans ? "plans" : null, role.verifies ? "verifies" : null, role.writes ? "writes" : null].filter(Boolean);
    return `<option value="${escapeHtml(role.name)}" title="${escapeHtml(role.description || "")}">${escapeHtml(role.name)}${marks.length ? ` · ${marks.join(", ")}` : ""}</option>`;
  }).join("");
  if (keep && roles.some((role) => role.name === keep)) select.value = keep;
}
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
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DRAFT_LIMIT = 50_000;

function syncTaskUrl() {
  const url = new URL(location.href);
  if (selectedTaskId) url.searchParams.set("task", selectedTaskId);
  else url.searchParams.delete("task");
  history.replaceState({}, "", `${url.pathname}${url.search}`);
}

// On a loopback server the browser is handed a session cookie when it loads the page, so nothing
// here ever sees a 401. On a server bound to anything else there is no free cookie — the token has
// to be presented once, exchanged for a session, and the original request retried. Asking only when
// the server actually refuses keeps the local case exactly as friction-free as it was.
let authenticating = null;
async function api(url, options = {}, { retry = true } = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  if (response.status === 401 && retry) {
    const authenticated = await authenticate();
    if (authenticated) return api(url, options, { retry: false });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function authenticate() {
  // One prompt at a time, however many polls discover the 401 together.
  if (authenticating) return authenticating;
  authenticating = (async () => {
    const token = prompt("This DevTeam server requires its token.\n\nPaste the value of DEVTEAM_TOKEN (or a named token issued from the dashboard):");
    if (!token || !token.trim()) return false;
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token.trim() }),
    });
    return response.ok;
  })();
  try { return await authenticating; }
  finally { authenticating = null; }
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
  // What a collapsed section still shows. Kept in step with the lists so the sidebar never hides
  // which project and task you are looking at — that is the one thing it exists to tell you.
  const currentProject = state.projects.find((project) => project.id === selectedProjectId);
  $("#project-current").textContent = currentProject ? currentProject.name : "";
  $("#task-current").innerHTML = task
    ? `${escapeHtml(task.title)}<small>${escapeHtml(task.status)}</small>`
    : "";
  $("#project-select").innerHTML = state.projects.map((project) => `<option value="${project.id}" ${project.id === selectedProjectId ? "selected" : ""}>${escapeHtml(project.name)}</option>`).join("");

  $("#empty-state").classList.toggle("hidden", Boolean(task));
  $("#conversation").classList.toggle("hidden", !task);
  $("#copy-task-invite").classList.toggle("hidden", !task);
  $("#edit-task").classList.toggle("hidden", !task || task.status === "cancelled");
  $("#block-task").classList.toggle("hidden", !task || ["accepted", "blocked", "cancelled"].includes(task.status));
  $("#unblock-task").classList.toggle("hidden", !task || task.status !== "blocked");
  renderBlockedBanner(task);
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

// The Resume control used to live only at the foot of the team panel, below the roster, the whole
// work queue, the knowledge vault and consensus — on a busy task roughly 4,800px down a scrolling
// panel. A human looking for it found more assignment cards and concluded DevTeam could not reopen
// the task at all. The banner puts the same action where the eye already is.
function renderBlockedBanner(task) {
  const banner = $("#blocked-banner");
  const copy = task ? blockedBannerCopy(task.blockedRecovery) : null;
  banner.classList.toggle("hidden", !copy);
  if (!copy) return;
  $("#blocked-reason").textContent = copy.reason;
  $("#blocked-meta").textContent = copy.meta;
}

function renderTask(task) {
  const taskChanged = renderedTaskId !== task.id;
  $("#project-name").textContent = task.project_name;
  $("#task-status").textContent = `${task.status} · ${(task.session_policy || "manual").replace("_", " ")}`;
  $("#task-title").textContent = task.title;
  renderTaskDescription(task.description);
  $("#task-version").textContent = `v${task.version}`;
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
    // Only while the lease is live. A finished assignment's write scope is history, and printing it
    // on every completed card was a line of text that answered a question nobody was asking.
    const leaseIsLive = item.status === "queued" || item.status === "claimed";
    const scope = item.requires_write && leaseIsLive
      ? `<span class="scope" title="Write lease scope">${(item.writeScope?.length ? item.writeScope : [""]).map((p) => escapeHtml(p === "" ? "whole project" : p)).join(", ")}</span>`
      : "";
    const release = item.status === "claimed" && item.requires_write
      ? `<button class="mini release" data-release="${item.id}" data-release-title="${escapeHtml(item.title)}" title="Force-release this stuck write lease (asks you to confirm the title)">Release lease</button>`
      : "";
    // Completed work can go back to its author without stopping the task. This is the human's half
    // of the same loop reviewers drive with devteam_request_changes.
    const sendBack = item.status === "done"
      ? `<button class="mini send-back" data-send-back="${item.id}" data-send-back-title="${escapeHtml(item.title)}" title="Send this work back to its author for changes, with your reasons attached">Request changes</button>`
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
    // Verification runs off the event loop, so a report can be in flight for minutes while the
    // assignment still reads "claimed". Say what it is actually doing rather than looking idle.
    const verifying = item.verifying_at
      ? `<div class="verifying"><strong>Checks running</strong><span>DevTeam is running this report's checks — started ${escapeHtml(relativeTime(item.verifying_at))}</span></div>`
      : "";
    // Work sent back for changes reads as an ordinary queued item unless the card says otherwise,
    // which is exactly how rework used to get silently lost.
    const findings = item.findings?.length
      ? `<ul class="finding-list">${item.findings.map((finding) => `<li>${finding.path ? `<code>${escapeHtml(finding.path)}</code> ` : ""}${escapeHtml(finding.detail)}<small>${escapeHtml(finding.requested_by_name)}</small></li>`).join("")}</ul>`
      : "";
    const rework = item.rework_requested_at
      ? `<div class="rework"><strong>Changes requested${Number(item.rework_count) > 1 ? ` · ${Number(item.rework_count)} times` : ""}</strong><span>${escapeHtml(item.rework_summary || "Sent back to its author.")}</span>${findings}</div>`
      : (item.findings?.length ? `<div class="rework"><strong>Open findings</strong>${findings}</div>` : "");
    // Complexity answers "is this the right agent and model for the job", which is a question about
    // work not yet finished. On a done card it is history, and it was the single most repeated block
    // on the board. The "assessment pending" placeholder is gone outright: an absent assessment now
    // says nothing rather than taking a line to announce its own absence on every card.
    const assessment = item.assessment;
    const assessmentView = assessment && leaseIsLive
      // Lead with the model this needs, in the names the ladder reported. The level and score are
      // DevTeam's own vocabulary and stay as the small print — useful when you want to know why, and
      // meaningless as a headline. With no ladder reported yet, the level leads instead.
      ? `<div class="complexity"><strong>${item.needsRung ? `Needs ${escapeHtml(item.needsRung)}` : escapeHtml(assessment.level)}</strong>${item.needsRung ? `<span>${escapeHtml(assessment.level)} · score ${Number(assessment.score)}</span>` : ""}<small>${assessment.reasons.slice(0, 2).map((reason) => escapeHtml(reason.detail)).join(" · ") || "Ordinary scoped work."}</small></div>`
      : "";
    const runtimeDecision = item.runtimeDecision && leaseIsLive
      ? `<small class="runtime-decision">Runtime: ${escapeHtml(item.runtimeDecision.choice)} by ${escapeHtml(item.runtimeDecision.actor)}</small>`
      : "";
    return `<div class="assignment"><div class="assignment-top"><strong>${escapeHtml(item.title)}</strong><span class="role">${escapeHtml(item.role)}</span></div><p>${escapeHtml(item.agent_name ? `${item.agent_name} · ${item.status}` : item.status)}${item.requires_write && leaseIsLive ? " · write lease" : ""}</p>${assessmentView}${runtimeDecision}${verifying}${rework}${hold}${blockedBy}${checks}${scope}${checklist}<div class="assignment-actions">${sendBack}${release}</div></div>`;
  }).join("") || `<p class="hint">Waiting for the plan</p>`;
  renderRegressions(task);
  renderRoleOptions($("#proposal-role"), task.roleCatalogue);
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
    // What this session says it is running, in the words it reported at join.
    const running = [agent.current_model, agent.current_effort].filter(Boolean).join(" · ");
    const runtime = running ? `<small class="runtime-profile">${escapeHtml(running)}</small>` : "";
    return `<div class="agent"><div class="avatar">${initials(agent.name)}</div><div class="agent-info"><strong>${escapeHtml(agent.name)}${unread}</strong><small>${escapeHtml(agent.provider)} · ${escapeHtml(agent.status)} · session ${Number(agent.session_generation || 1)}</small>${runtime}<small class="activity">${escapeHtml(activityLine(agent))}</small></div><span class="agent-actions"><span class="agent-status ${agent.status} ${freshness(agent.last_seen)}" title="${escapeHtml(agent.status)} · seen ${relativeTime(agent.last_seen)}"></span>${forget}</span></div>`;
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
  return `Use $devteam as ${name} and join task "${task.title}" with taskId ${task.id}.${fresh} If this is the same returning conversation, resume the prior DevTeam session so missed messages replay before claiming work.`;
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
    loadProjectCheckCommands(project.id, form);
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
  const sendBackButton = event.target.closest("[data-send-back]");
  if (sendBackButton) {
    const title = sendBackButton.dataset.sendBackTitle;
    const summary = prompt(`Send “${title}” back to its author for changes.\n\nWhat needs to change? (one line)`);
    if (summary === null || !summary.trim()) return;
    const detail = prompt("Specific findings, one per line (optional). The author is handed these when it picks the work back up.") || "";
    const findings = detail.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 50);
    try {
      const result = await api(`/api/tasks/${state.selectedTask.id}/assignments/${sendBackButton.dataset.sendBack}/request-changes`, {
        method: "POST", body: JSON.stringify({ summary: summary.trim(), findings }),
      });
      await refresh();
      toast(result.routedTo ? `Sent back to ${result.routedTo}` : "Sent back to the queue");
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

// The check allowlist is a human decision and nothing else can make it: show what enabling would
// permit *before* it is enabled, so "yes" is an informed answer rather than a shrug.
async function loadProjectCheckCommands(projectId, form) {
  const list = $("#project-check-commands");
  list.innerHTML = `<p class="hint">Loading…</p>`;
  form.elements.verificationEnabled.checked = false;
  form.elements.checkSandbox.checked = false;
  try {
    const config = await api(`/api/projects/${projectId}/check-commands`);
    form.elements.verificationEnabled.checked = config.verificationEnabled;
    form.elements.checkSandbox.checked = Boolean(config.sandbox);
    // Commands already approved, plus what this project's package.json would add. Scripts DevTeam
    // cannot run without a shell are simply absent — it never guesses at what a script body meant.
    const approved = new Map(config.commands.map((entry) => [entry.name, entry]));
    const offered = config.available.filter((entry) => !approved.has(entry.name));
    const row = (entry, live) => `<div class="check-command ${live ? "approved" : ""}"><code>${escapeHtml(entry.name)}</code><span>${escapeHtml(entry.argv.join(" "))}</span></div>`;
    list.innerHTML = [
      config.commands.length ? `<p class="hint">Currently allowed:</p>${config.commands.map((entry) => row(entry, true)).join("")}` : "",
      offered.length ? `<p class="hint">${config.verificationEnabled ? "Also available in package.json (saving re-snapshots all of them):" : "Would be allowed from package.json:"}</p>${offered.map((entry) => row(entry, false)).join("")}` : "",
      config.commands.length || offered.length ? "" : `<p class="hint">This project's package.json offers no script DevTeam can run without a shell.</p>`,
    ].filter(Boolean).join("");
  } catch (error) {
    list.innerHTML = `<p class="hint">Could not read the allowlist: ${escapeHtml(error.message)}</p>`;
  }
}

$("#project-edit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const projectId = form.dataset.projectId;
  if (!projectId) return;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name: values.name, root: values.root }) });
    // Saved after the folder, because re-pointing the folder clears the allowlist by design: the
    // commands were approved against the tree the human was looking at.
    await api(`/api/projects/${projectId}/check-commands`, {
      method: "PUT",
      body: JSON.stringify({
        ...(values.verificationEnabled ? {} : { commands: [] }),
        sandbox: Boolean(values.checkSandbox),
      }),
    });
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

// Both the banner button and the old team-panel link open the same dialog. A plain prompt() could
// not offer the target list, and routing the replan to one agent by name is the whole reason the
// dialog exists: dropping it back into the open queue is how the work reached the wrong agent.
function openResumeDialog() {
  const task = state.selectedTask;
  const copy = task ? blockedBannerCopy(task.blockedRecovery) : null;
  if (!copy) { toast("This task is not blocked"); return; }
  $("#resume-context").textContent = `"${task.title}" was blocked: ${copy.reason}`;
  $("#resume-target").innerHTML = `<option value="">Whoever is available</option>`
    + copy.targets.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  $("#resume-dialog").showModal();
}

$("#unblock-task").addEventListener("click", openResumeDialog);
$("#resume-task").addEventListener("click", openResumeDialog);

// The other way out of a block. Resume is right for work that genuinely stopped; it is the wrong
// shape for a task an agent blocked to mean "finished", which then needed a whole replan cycle just
// to close. The server refuses this if work was still in flight, and says how much.
$("#close-blocked-task").addEventListener("click", async () => {
  const summary = prompt("Close this task as finished. What was delivered?");
  if (summary === null) return;
  const body = { summary: summary.trim() || "Human closed a stopped task as finished." };
  try {
    await api(`/api/tasks/${selectedTaskId}/accept`, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    // The only refusal worth a second question is "work was still in flight"; anything else stands.
    if (!/still in flight/.test(error.message)) { toast(error.message); return; }
    if (!confirm(`${error.message}

Close it anyway, leaving that work unfinished?`)) return;
    try {
      await api(`/api/tasks/${selectedTaskId}/accept`, {
        method: "POST", body: JSON.stringify({ ...body, acceptStranded: true }),
      });
    } catch (retryError) { toast(retryError.message); return; }
  }
  await refresh();
  toast("Task closed as finished");
});

$("#resume-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  try {
    const result = await api(`/api/tasks/${selectedTaskId}/unblock`, {
      method: "POST",
      body: JSON.stringify({ reason: values.reason, targetAgentName: values.targetAgentName || null }),
    });
    event.target.reset(); event.target.closest("dialog").close(); await refresh();
    toast(result.targetAgentName
      ? `Resumed at v${result.version} — replan addressed to ${result.targetAgentName}`
      : `Resumed at v${result.version} — the team can plan again`);
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

// Collapsing a nav section. The state is remembered per browser, and a collapsed section keeps
// showing the selected project or task above the fold — see #project-current / #task-current.
function applyNavCollapse(section, collapsed) {
  const nav = document.querySelector(".sidebar nav");
  if (!nav) return;
  nav.classList.toggle(`${section}-collapsed`, collapsed);
  const toggle = document.querySelector(`[data-collapse="${section}"]`);
  if (toggle) {
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.title = collapsed
      ? `Expand ${section === "projects" ? "projects" : "task history"}`
      : `Collapse ${section === "projects" ? "projects" : "task history"}`;
  }
  // A private convenience, so it is fine for this to be unavailable or to throw.
  try { localStorage.setItem(`devteam.nav.${section}`, collapsed ? "collapsed" : "open"); } catch { /* ignore */ }
}

for (const section of ["projects", "tasks"]) {
  let collapsed = false;
  try { collapsed = localStorage.getItem(`devteam.nav.${section}`) === "collapsed"; } catch { collapsed = false; }
  applyNavCollapse(section, collapsed);
}

document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-collapse]");
  if (!toggle) return;
  const section = toggle.dataset.collapse;
  applyNavCollapse(section, toggle.getAttribute("aria-expanded") === "true");
});
