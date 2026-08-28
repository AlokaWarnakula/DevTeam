import test from "node:test";
import assert from "node:assert/strict";
import { blockedBannerCopy, eventMatchesTimelineFilter, renderSafeMarkdown, timelineCategory, unreadTimelineCount } from "../public/ui-utils.js";

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

test("the blocked banner states the reason, the cost of resuming, and who can take the replan", () => {
  const copy = blockedBannerCopy({
    version: 2,
    reason: "Review was misrouted to its own author.",
    blockedBy: "Codex",
    strandedAssignments: 3,
    resumableBy: ["Codex", "Claude"],
  });
  assert.match(copy.reason, /misrouted/);
  assert.match(copy.meta, /Blocked by Codex/);
  assert.match(copy.meta, /3 assignments stopped mid-flight/);
  assert.match(copy.meta, /agents cannot lift this/);
  assert.match(copy.meta, /reopens the task at v3 and clears its approvals/);
  assert.deepEqual(copy.targets, ["Codex", "Claude"]);

  const sparse = blockedBannerCopy({ version: 1, strandedAssignments: 1 });
  assert.equal(sparse.reason, "No reason was recorded.");
  assert.match(sparse.meta, /^Blocked · 1 assignment stopped mid-flight · v1/);
  assert.deepEqual(sparse.targets, []);

  assert.equal(blockedBannerCopy(null), null, "an unblocked task renders no banner");
});

test("the blocked banner says which kind of blocker it was, in the human's words", () => {
  const overHead = blockedBannerCopy({
    version: 2,
    reason: "This needs a frontier model to do safely.",
    blockedBy: "Claude",
    kind: "over-my-head",
    strandedAssignments: 1,
  });
  assert.match(overHead.meta, /Blocked by Claude — beyond the model or effort the agent had/);

  const needsHuman = blockedBannerCopy({ version: 1, blockedBy: "Codex", kind: "needs-human" });
  assert.match(needsHuman.meta, /needs a decision only you can make/);

  // Blocks recorded before kinds existed carry none. The banner reads exactly as it always did
  // rather than inventing a kind for them.
  const legacy = blockedBannerCopy({ version: 1, blockedBy: "Codex", strandedAssignments: 2 });
  assert.match(legacy.meta, /^Blocked by Codex · 2 assignments stopped mid-flight/);

  const unknown = blockedBannerCopy({ version: 1, blockedBy: "Codex", kind: "something-new" });
  assert.match(unknown.meta, /^Blocked by Codex ·/, "an unrecognised kind is ignored, not printed raw");
});
