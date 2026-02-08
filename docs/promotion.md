# Promoting Experiment Code to Shared Packages

Use this process when an experiment implementation should become reusable.

1. Validate in experiment first
- Keep implementation local while iterating quickly.
- Confirm behavior with at least one additional usage scenario.

2. Extract minimal stable API
- Move only stable pieces into one of:
- `@common/core` for generic utils/data logic.
- `@common/render` for rendering helpers.
- `@common/gameplay` for gameplay systems like inventory/state rules.

3. Add tests in shared package
- Add unit tests that cover expected behavior and basic failure inputs.
- Promotion is not complete without coverage gating in the shared package.
- Minimum policy for promoted modules:
- `test:coverage` script with enforced thresholds.
- Browser-level smoke coverage for critical user flows using Playwright (real click/key paths).

4. Replace local experiment logic
- Update experiment imports to use shared package API.
- Keep experiment-specific glue code local.

5. Record rationale
- Update the experiment README with what was promoted and why.
