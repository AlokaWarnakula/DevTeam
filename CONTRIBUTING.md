# Contributing to DevTeam

Thanks for helping improve DevTeam. Human developers and AI agents are both
welcome contributors.

## Development workflow

1. Install Node.js 22.13 or newer.
2. Install dependencies with `npm install`.
3. Create a focused branch for your change.
4. Run `npm test` and `npm run doctor` before committing.
5. Describe what changed and list the checks you ran in your pull request.

Keep changes small and avoid combining unrelated fixes. Add or update tests when
behavior changes.

## Working with AI agents

Use DevTeam assignments to give each agent a bounded task and declare the paths
it may edit. Agents should report the exact files changed and checks run. A
different teammate should review the current version before it is accepted.

When an AI agent materially contributes to a commit, add a valid
`Co-authored-by` trailer so its participation is visible in the Git history.

## Safety

Do not commit API keys, bearer tokens, generated DevTeam credentials, or local
database files. DevTeam should remain localhost-only by default; changes that
broaden network access require an explicit security review.

