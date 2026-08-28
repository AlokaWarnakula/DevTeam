// The three helpers every part of the store reaches for. They lived at the top of store.mjs and had
// to move out when the clusters did: a mixin importing them back from store.mjs — which imports the
// mixin — would be a cycle, and a cycle that happens to work today is not a thing to build on.

export const now = () => new Date().toISOString();

export const json = (value) => JSON.stringify(value ?? null);

// A column that should hold JSON may hold anything at all: a value written before a shape changed,
// or one a human edited by hand. Answer the fallback rather than throwing, because none of these
// callers can do anything useful with a parse error except lose the row.
export const fromJson = (value, fallback = null) => {
  try {
    return value == null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
};
