# Prompt: have each agent record what went wrong

Paste the block below into **each** agent (Claude and Codex) at the start of the session,
after it has loaded the DevTeam skill but before it calls `devteam_join`.

Replace `<YOUR-NAME>` with `claude` or `codex`. **Each agent writes its own file** — two
agents appending to one file will silently clobber each other's writes, and a lost-update
race is exactly the kind of thing that would make this log untrustworthy.

---

While you work this DevTeam session, keep a running log of everything that goes wrong or
reads badly, and write it to:

`C:\Users\aloka\Mine\Projects\DevTeam\ISSUES-<YOUR-NAME>.md`

That file is outside your DevTeam write scope on purpose — it is a note to the human, not
part of the work under review. Create it if it does not exist, and append to it as you go
rather than saving it all up for the end; if the session drops, whatever you have already
written is the part that survives.

Record an entry every time any of these happens:

- A tool call fails, or returns something you did not expect.
- You look for a tool that does not exist, or cannot tell which of the nine verbs to use.
- An instruction in the skill, a tool description, or a `next:` hint points at something
  that is not there, or tells you to do something that then gets refused.
- You are blocked and it is not obvious why, or the reason given does not match what you
  observe on the board.
- You are about to give up on something and work around it.
- Anything takes more calls than it should have.

Use exactly this shape, one block per entry, newest at the bottom:

```
## <n>. <one line, what happened>
- when: <ISO timestamp>
- doing: <what you were trying to accomplish>
- called: <the exact tool name and the arguments that matter>
- got: <the exact message or result, quoted, not paraphrased>
- expected: <what you thought would happen>
- severity: blocker | friction | cosmetic
- worked around by: <what you did instead, or "nothing, still stuck">
```

Two rules about the content:

1. **Quote exact text.** Error strings, refusal messages and `next:` hints verbatim. A
   paraphrase cannot be grepped for and cannot be matched against the source.
2. **Do not fix DevTeam.** Do not edit anything under `C:\Users\aloka\Mine\Projects\DevTeam`
   except your own `ISSUES-<YOUR-NAME>.md`. Report the problem and carry on with the task
   you were given.

At the very end of the session, append a short section:

```
## Session summary
- verbs I actually used:
- anything I expected to exist and did not find:
- did a review of my own work ever get handed to me? (yes/no — this matters)
- did I ask for changes on someone else's work, or only approve? (and why)
- did DevTeam ever run a check for me, or did it only record what I claimed?
- the one thing that would have saved me the most time:
```

Answer those honestly, including when the honest answer is unflattering. A log that says
everything went fine is worth nothing if it did not.
