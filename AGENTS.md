# Agent Session Instructions

## Persistent Learning
- At the start of every session, read `docs/AGENT_LEARNINGS.md` before making technical decisions.
- Treat `docs/AGENT_LEARNINGS.md` as required context, not optional notes.
- When a failure pattern is identified and fixed, append a short entry to `docs/AGENT_LEARNINGS.md` in this format:
  - `YYYY-MM-DD - Problem`
  - `Root cause`
  - `Detection signal`
  - `Preventive checklist`

## Scope
- Keep entries practical and repo-specific.
- Prefer verifiable engineering checks over assumptions.

## Bug Fix Workflow
- Use red-green TDD for bug fixes whenever feasible: add a failing regression test that reproduces the reported bug first, then implement the fix until the test passes.
