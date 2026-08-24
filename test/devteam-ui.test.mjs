import test from "node:test";
import assert from "node:assert/strict";
import { eventMatchesTimelineFilter, renderSafeMarkdown, timelineCategory, unreadTimelineCount } from "../public/ui-utils.js";

test("safe timeline Markdown preserves useful structure without allowing scriptable markup", () => {
  const rendered = renderSafeMarkdown(`# Plan\n\n- item\n- [x] done\n\n\`inline\` and **bold**\n\n[docs](https://example.com/path)\n\n\`\`\`js\nalert('text only')\n\`\`\`\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))`);
  assert.match(rendered, /<h3>Plan<\/h3>/);
  assert.match(rendered, /<ul>/);
  assert.match(rendered, /type="checkbox" disabled checked/);
  assert.match(rendered, /<code>inline<\/code>/);
  assert.match(rendered, /<strong>bold<\/strong>/);
  assert.match(rendered, /href="https:\/\/example\.com\/path"/);
  assert.match(rendered, /<pre><code class="language-js">/);
  assert.doesNotMatch(rendered, /<img|href="javascript:|<script/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/, "unsafe HTML is shown as text");
  assert.match(rendered, /\[bad\]\(javascript:alert\(1\)\)/, "unsupported links remain inert text");
});

test("timeline events map deterministically to the visible filters", () => {
  const cases = [
    [{ type: "human.message" }, "chat"],
    [{ type: "agent.progress" }, "work"],
    [{ type: "agent.decision" }, "decisions"],
    [{ type: "agent.finding" }, "findings"],
    [{ type: "task.created" }, "system"],
  ];
  for (const [event, category] of cases) {
    assert.equal(timelineCategory(event), category);
    assert.equal(eventMatchesTimelineFilter(event, category), true);
    assert.equal(eventMatchesTimelineFilter(event, "all"), true);
  }
  assert.equal(eventMatchesTimelineFilter({ type: "agent.finding" }, "chat"), false);
});

test("unread counts include only newer agent-authored events", () => {
  const events = [
    { id: 10, agent_id: "a", type: "agent.message" },
    { id: 11, agent_id: null, type: "human.message" },
    { id: 12, agent_id: "b", type: "agent.finding" },
  ];
  assert.equal(unreadTimelineCount(events, 10), 1);
  assert.equal(unreadTimelineCount(events, 0), 2);
  assert.equal(unreadTimelineCount(events, 12), 0);
});
