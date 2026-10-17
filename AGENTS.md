<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project knowledge and change log protocol

`PROJECT_CONTEXT.md` is the repository's tool-independent project reference. Keep it current so a future developer can continue from the repository alone.

### Before making changes

- Read `PROJECT_CONTEXT.md` and this `AGENTS.md` before editing code.
- Inspect the relevant implementation, tests, database schema, and recent changes.
- Confirm that the proposed change follows the documented architecture and constraints.
- If this context conflicts with the code, investigate and update the documentation from verified facts.
- For Next.js work, follow the managed Next.js instructions above and consult the installed guides under `node_modules/next/dist/docs/` before writing code.

### After every change

- Update `PROJECT_CONTEXT.md` in the same task as every code or configuration change. This is mandatory.
- Record what changed and why, implementation details, affected paths, schema/configuration changes, tests changed, commands run, and actual results.
- Update current state, feature inventory, known issues, and pending tasks whenever the change affects them.
- Record architectural or business-logic decisions and rationale. Preserve earlier history and append a concise dated entry for each meaningful change.
- Document failed checks and unresolved issues honestly. Never claim a check passed unless it ran and passed; state explicitly when no tests were run.
- If a task changes no code but changes verified project state, update the context accordingly.
- Never put credentials, API keys, tokens, passwords, or secret values in project documentation.

### Before finishing

- Cross-check `PROJECT_CONTEXT.md` against the resulting code and repository records.
- Keep documentation updates in the same changeset as the corresponding implementation change.
- Report the documentation sections updated in the final response.
- If the context could not be updated, say why and treat the task as incomplete.
