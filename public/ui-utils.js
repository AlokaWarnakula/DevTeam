export function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function renderInline(value = "") {
  const source = String(value);
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gi;
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    result += escapeHtml(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      result += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith("**")) {
      result += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i);
      try {
        const url = new URL(link[2]);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error("unsupported link");
        result += `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link[1])}</a>`;
      } catch {
        result += escapeHtml(token);
      }
    }
    cursor = match.index + token.length;
  }
  return result + escapeHtml(source.slice(cursor));
}

// A deliberately small, allow-listed Markdown renderer. Every text fragment is escaped before
// markup is introduced, and links are limited to parsed HTTP(S) URLs.
export function renderSafeMarkdown(value = "") {
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let list = null;
  let code = null;
  let codeLanguage = "";
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };
  const openList = (type) => {
    if (list === type) return;
    closeList();
    list = type;
    output.push(`<${type}>`);
  };
  const closeCode = () => {
    if (code === null) return;
    const className = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
    output.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
    code = null;
    codeLanguage = "";
  };

  for (const line of lines) {
    const fence = line.match(/^```([a-z0-9_-]{0,30})\s*$/i);
    if (fence) {
      closeList();
      if (code === null) {
        code = [];
        codeLanguage = fence[1] || "";
      } else {
        closeCode();
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 2;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const checkbox = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) {
      openList("ul");
      output.push(`<li class="task-list-line"><input type="checkbox" disabled ${checkbox[1].toLowerCase() === "x" ? "checked " : ""}aria-hidden="true">${renderInline(checkbox[2])}</li>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      openList("ul");
      output.push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numbered) {
      openList("ol");
      output.push(`<li>${renderInline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
    } else if (!line) {
      output.push(`<div class="message-blank" aria-hidden="true"></div>`);
    } else {
      output.push(`<div class="message-line">${renderInline(line)}</div>`);
    }
  }
  closeList();
  closeCode();
  return output.join("");
}

export function timelineCategory(event = {}) {
  const type = String(event.type || "");
  if (type === "human.message" || type === "agent.message" || type === "agent.question") return "chat";
  if (type === "agent.finding" || type.includes("blocked") || type.includes("failed")) return "findings";
  if (type === "agent.decision" || type.startsWith("proposal.")) return "decisions";
  if (type === "agent.progress" || type === "agent.report" || type.startsWith("assignment.")) return "work";
  return "system";
}

export function eventMatchesTimelineFilter(event, filter = "all") {
  return filter === "all" || timelineCategory(event) === filter;
}

export function unreadTimelineCount(events = [], lastReadId = 0) {
  const marker = Number(lastReadId) || 0;
  return events.filter((event) => event.agent_id && Number(event.id) > marker).length;
}

// The banner copy for a blocked task. Kept out of the DOM code so the one sentence a stuck human
// reads is testable: this is the wording that replaces a Resume button buried ~4,800px down the
// team panel, where it went unfound for a whole session.
export function blockedBannerCopy(recovery = null) {
  if (!recovery) return null;
  const reason = String(recovery.reason || "").trim();
  const who = recovery.blockedBy ? `Blocked by ${recovery.blockedBy}` : "Blocked";
  const stranded = Number(recovery.strandedAssignments) || 0;
  const parts = [who];
  if (stranded) parts.push(`${stranded} assignment${stranded === 1 ? "" : "s"} stopped mid-flight`);
  parts.push(`v${recovery.version}`);
  return {
    reason: reason || "No reason was recorded.",
    meta: `${parts.join(" · ")} — agents cannot lift this; resuming reopens the task at v${Number(recovery.version) + 1} and clears its approvals.`,
    targets: Array.isArray(recovery.resumableBy) ? recovery.resumableBy : [],
  };
}
