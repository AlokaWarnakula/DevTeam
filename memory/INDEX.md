# Next Session Handoff
> **Next session:** DevTeam is fully built and cleaned — read `memory/memory_2026-08-09.md` first (its later "Update —" sections). Tests **51/51 green**, doctor healthy, root md is just README. We also agreed a model strategy: Claude Opus 5 for planning/review, Codex for the heavy coding, Sonnet 5/Haiku 4.5 for tests — reviewer must differ from coder. The ONLY open action is human-approved deployment: run `node bin/devteam.mjs sync-skill --dest ...` for each installed agent. Nothing is committed yet. Do NOT sync the live skill or touch the running server/data without asking.

---
# Session Index
Most recent first.

| Date | File | Summary |
|------|------|---------|
| 2026-08-09 | [memory_2026-08-09.md](./memory_2026-08-09.md) | Shipped the entire hive-mind roadmap + all loose ends (auth, symlink scopes, dashboard membership), cleaned root docs, and agreed a per-role model strategy. 36 → 51 tests green. |

---
## How this works
- `/shorekeeper check` → reads INDEX + latest session.
- `/shorekeeper` → saves/updates today's session + updates INDEX.
- One file per day. Conversational. Under 100 lines. Cross-account friendly.
