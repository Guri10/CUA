<!-- JARVIS_CLAUDE_INIT_START -->
# JARVIS / Claude Code project workflow

## Project shape

- App type / stack: TypeScript on Node, single CLI. An LLM discovers how to drive a legacy web app,
  then the flow is replayed deterministically with no model in the loop.
- Frontend: none. The UI we drive is ParaBank's, not ours.
- Backend: one process, three commands (`discover`, `replay`, `serve`). No services, no queue.
- Tests: Vitest. Unit and integration against a fake Surface; one real-browser end-to-end run
  excluded from the default test command.
- Main entry point: `src/cli.ts`
- Config: `.env` for `ANTHROPIC_API_KEY`. The Surface profile and the policy allowlist are
  checked-in config, not environment.

Read `CONTEXT.md` for the domain vocabulary and `docs/adr/` for the decisions behind the shape
above. ADR 0001 in particular bans CSS and XPath selectors — that is deliberate, not an oversight.

## Commands

**The project is not scaffolded yet.** These are the intended commands, decided during grilling and
recorded here so they don't get reinvented. They will not run until the first ticket lands.

- Install dependencies: `npm install` (npm deliberately — reviewers must be able to run this
  without installing another package manager first)
- Start the target app: `docker run -d -p 8080:8080 parasoft/parabank`
- Run app: `npm run discover -- --goal "..."`, `npm run replay -- --capability <id>@<v>`,
  `npm run serve`
- Run tests: `npm test` (fast, no browser)
- Run end-to-end: `npm run test:e2e` (real browser against ParaBank)
- Run typecheck: `npm run typecheck`
- Run lint: not configured yet
- Build: `npm run build`

## Planning style

- Use plain English in plans.
- Avoid technical jargon unless necessary.
- If a technical term is necessary, define it in one sentence.
- Keep plans short: goal, files, steps, verification, risks.
- Do not implement until the plan is approved unless the user explicitly asks for immediate execution.

## Engineering rules

- Keep changes surgical.
- Prefer simple solutions.
- Do not touch unrelated code.
- Do not refactor unless the task requires it.
- Do not silently assume unclear requirements.
- Ask only when ambiguity changes implementation.
- Preserve existing style and conventions.

## Workflow

For small tasks:
1. Inspect relevant files.
2. Give a short plain-English plan.
3. Implement after approval.
4. Run targeted verification.
5. Report changed files and exact command results.

For medium or large tasks:
1. Clarify requirements.
2. Write or update a short spec.
3. Break into small tasks.
4. Implement one task at a time.
5. Verify after each meaningful change.
6. Review before final summary.

## Verification

- Never claim completion without evidence.
- Show exact commands run and results.
- If tests fail, diagnose root cause before patching.
- Prefer regression tests for bug fixes.

## Side questions

- Keep the main chat focused on implementation.
- Use `/btw` for explanation questions.
- Explanation-only questions must not modify files.
- Bring side-question conclusions back only if they change the plan.
<!-- JARVIS_CLAUDE_INIT_END -->

## Agent skills

### Issue tracker

Issues live as GitHub issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
