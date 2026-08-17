<!-- JARVIS_CLAUDE_INIT_START -->
# JARVIS / Claude Code project workflow

## Project shape

- App type / stack: TODO
- Frontend: TODO
- Backend: TODO
- Tests: TODO
- Main entry point: TODO
- Config: TODO

## Commands

- Install dependencies: `TODO`
- Run app: `TODO`
- Run tests: `TODO`
- Run lint: `TODO`
- Run typecheck: `TODO`
- Build: `TODO`

If any command is `TODO`, inspect the project first and propose the correct command before using it.

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
