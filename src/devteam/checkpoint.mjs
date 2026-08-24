import { clipUtf8, jsonBytes } from "./brief.mjs";

export const DEFAULT_CHECKPOINT_BUDGET_BYTES = 16_384;

const TOKEN_PATTERNS = [
  /-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/gi,
  /\b(?:sk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g,
  /\b(token|secret|password|passphrase|api[_ -]?key|authorization)(\s*[:=]\s*)(["']?)[^\s,;"']{4,}\3/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*\b/gi,
];

export function redactCheckpointText(value) {
  let text = String(value ?? "");
  let redacted = 0;
  for (const pattern of TOKEN_PATTERNS) {
    text = text.replace(pattern, (...match) => {
      redacted += 1;
      if (pattern === TOKEN_PATTERNS[2]) return `${match[1]}${match[2]}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return { value: text, redacted };
}

export function boundedCheckpointText(value, maxBytes, counters = null, key = "text") {
  const safe = redactCheckpointText(value);
  const clipped = clipUtf8(safe.value, maxBytes);
  if (counters) {
    if (safe.redacted) counters.redacted = (counters.redacted || 0) + safe.redacted;
    if (clipped.truncated) counters.clipped[key] = (counters.clipped[key] || 0) + 1;
  }
  return clipped.value;
}

function stableBytes(payload) {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bytes = jsonBytes(payload);
    payload.capsuleMeta.bytes = bytes;
    if (bytes === previous) return bytes;
    previous = bytes;
  }
  payload.capsuleMeta.bytes = jsonBytes(payload);
  return jsonBytes(payload);
}

/**
 * Assemble a redacted checkpoint capsule under one exact serialized UTF-8 byte ceiling. The
 * mandatory core is supplied already clipped; optional sections are admitted item-by-item in
 * deterministic priority order and every omission is reported.
 */
export function buildCheckpointCapsule({ core, sections, limitBytes = DEFAULT_CHECKPOINT_BUDGET_BYTES, counters = {} }) {
  const limit = Math.max(4_096, Number(limitBytes) || DEFAULT_CHECKPOINT_BUDGET_BYTES);
  const descriptors = sections.map((section) => ({
    key: section.key,
    items: Array.isArray(section.items) ? section.items : [],
    maxItems: Math.max(0, Number(section.maxItems) || 0),
  }));
  const payload = { ...core };
  for (const section of descriptors) payload[section.key] = [];
  const included = Object.fromEntries(descriptors.map((section) => [section.key, 0]));
  const omitted = Object.fromEntries(descriptors.map((section) => [section.key, section.items.length]));
  payload.capsuleMeta = {
    version: 1,
    bytes: 0,
    limitBytes: limit,
    truncated: false,
    included,
    omitted,
    clipped: { ...(counters.clipped || {}) },
    redacted: Number(counters.redacted) || 0,
    sourceBodiesIncluded: false,
  };
  payload.capsuleMeta.truncated = Object.values(omitted).some(Boolean)
    || Object.keys(payload.capsuleMeta.clipped).length > 0;
  if (stableBytes(payload) > limit) {
    throw new RangeError("Mandatory session checkpoint context exceeds the configured capsule byte limit.");
  }

  const admitted = [];
  for (const section of descriptors) {
    for (const item of section.items.slice(0, section.maxItems)) {
      payload[section.key].push(item);
      included[section.key] += 1;
      omitted[section.key] -= 1;
      payload.capsuleMeta.truncated = Object.values(omitted).some(Boolean)
        || Object.keys(payload.capsuleMeta.clipped).length > 0;
      if (stableBytes(payload) <= limit) {
        admitted.push(section.key);
        continue;
      }
      payload[section.key].pop();
      included[section.key] -= 1;
      omitted[section.key] += 1;
      stableBytes(payload);
    }
  }
  while (stableBytes(payload) > limit && admitted.length) {
    const key = admitted.pop();
    payload[key].pop();
    included[key] -= 1;
    omitted[key] += 1;
  }
  payload.capsuleMeta.truncated = Object.values(omitted).some(Boolean)
    || Object.keys(payload.capsuleMeta.clipped).length > 0;
  stableBytes(payload);
  return payload;
}
