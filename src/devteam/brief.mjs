export const DEFAULT_BRIEF_BUDGET = Object.freeze({
  totalBytes: 32_768,
  reservedCoreBytes: 4_096,
  assignmentBytes: 6_144,
  taskMemoryBytes: 5_120,
  projectMemoryBytes: 4_096,
  knowledgeBytes: 6_144,
  codeContextBytes: 7_168,
  activityBytes: 4_096,
});

export const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

// Clip text without leaving a dangling UTF-16 surrogate or exceeding the requested UTF-8 byte
// count. JSON escaping may add more bytes later, so BriefBudget still verifies the final object.
export function clipUtf8(value, maxBytes, suffix = "…") {
  const text = String(value ?? "");
  const limit = Math.max(0, Number(maxBytes) || 0);
  if (Buffer.byteLength(text, "utf8") <= limit) return { value: text, truncated: false };
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (limit <= suffixBytes) return { value: "", truncated: true };
  const contentLimit = limit - suffixBytes;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let end = middle;
    if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    if (Buffer.byteLength(text.slice(0, end), "utf8") <= contentLimit) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > contentLimit) end -= 1;
  return { value: `${text.slice(0, end)}${suffix}`, truncated: true };
}

function stableBytes(payload) {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = jsonBytes(payload);
    payload.briefMeta.bytes = bytes;
    if (bytes === previous) return bytes;
    previous = bytes;
  }
  const bytes = jsonBytes(payload);
  payload.briefMeta.bytes = bytes;
  return jsonBytes(payload);
}

function groupBytes(payload, keys) {
  return jsonBytes(Object.fromEntries(keys.map((key) => [key, payload[key]])));
}

/**
 * Assemble optional briefing sections under both their group ceilings and one hard final limit.
 * The caller supplies an already-bounded mandatory core; every optional item is admitted only
 * after measuring the complete serialized response with its updated metadata.
 */
export function buildBudgetedBrief({ core, sections, budget = {}, clipped = {}, omitted = {} }) {
  const limits = { ...DEFAULT_BRIEF_BUDGET, ...budget };
  const descriptors = sections.map((section) => ({
    ...section,
    items: Array.isArray(section.items) ? section.items : [],
    totalCount: Math.max(Array.isArray(section.items) ? section.items.length : 0, Number(section.totalCount) || 0),
    maxItems: section.maxItems == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Number(section.maxItems) || 0),
  }));
  const payload = { ...core };
  for (const section of descriptors) {
    payload[section.key] = section.items.length || !Object.hasOwn(section, "emptyValue") ? [] : section.emptyValue;
  }
  const included = Object.fromEntries(descriptors.map((section) => [section.key, 0]));
  const omittedCounts = {
    ...Object.fromEntries(descriptors.map((section) => [section.key, section.totalCount])),
    ...omitted,
  };
  payload.briefMeta = {
    version: 1,
    bytes: 0,
    limitBytes: limits.totalBytes,
    truncated: false,
    included,
    omitted: omittedCounts,
    clipped: Object.fromEntries(Object.entries(clipped).filter(([, count]) => Number(count) > 0)),
    fetchMore: {
      taskMemory: "Use devteam_note_get or devteam_note_list.",
      projectMemory: "Use devteam_note_get or devteam_note_list with scope=project.",
      projectKnowledge: "Use devteam_knowledge.",
      codeContext: "Use devteam_codegraph.",
      activity: "Use devteam_state for the full authorized task view.",
    },
  };
  payload.briefMeta.truncated = Object.values(omittedCounts).some((count) => Number(count) > 0)
    || Object.keys(payload.briefMeta.clipped).length > 0;

  if (stableBytes(payload) > limits.totalBytes) {
    throw new RangeError("Mandatory DevTeam briefing context exceeds the configured total byte limit.");
  }

  const groupKeys = new Map();
  for (const section of descriptors) {
    if (!groupKeys.has(section.group)) groupKeys.set(section.group, []);
    groupKeys.get(section.group).push(section.key);
  }
  const admitted = [];
  for (const section of descriptors) {
    const candidates = section.items.slice(0, section.maxItems);
    for (const item of candidates) {
      payload[section.key].push(item);
      included[section.key] += 1;
      omittedCounts[section.key] = Math.max(0, omittedCounts[section.key] - 1);
      payload.briefMeta.truncated = Object.values(omittedCounts).some((count) => Number(count) > 0)
        || Object.keys(payload.briefMeta.clipped).length > 0;
      const withinGroup = groupBytes(payload, groupKeys.get(section.group)) <= section.maxBytes;
      const withinTotal = stableBytes(payload) <= limits.totalBytes;
      if (withinGroup && withinTotal) {
        admitted.push(section.key);
        continue;
      }
      payload[section.key].pop();
      included[section.key] -= 1;
      omittedCounts[section.key] += 1;
      stableBytes(payload);
    }
  }

  // Metadata digit-width changes are normally stabilized above. Keep this defensive removal path
  // so a future metadata field can never weaken the hard final limit.
  while (stableBytes(payload) > limits.totalBytes && admitted.length) {
    const key = admitted.pop();
    payload[key].pop();
    included[key] -= 1;
    omittedCounts[key] += 1;
  }
  payload.briefMeta.truncated = Object.values(omittedCounts).some((count) => Number(count) > 0)
    || Object.keys(payload.briefMeta.clipped).length > 0;
  stableBytes(payload);
  return payload;
}
