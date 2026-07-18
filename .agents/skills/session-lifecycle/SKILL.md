---
name: session-lifecycle
description: Apply at session start and before final reporting to keep repository state, tasks, and evidence aligned.
---

# Session Lifecycle

## Start

1. Read `AGENTS.md`.
2. Check `git status -sb` and the current branch.
3. Read `TASKS.md` and `tasks/INDEX.md` when the task touches project state.
4. Identify the relevant `tasks/*.md` source block and its acceptance criteria.
5. Prefer a branch and commit message that include the task ID.

## Finish

1. Run the checks that match the change. For management/docs changes, run
   `npm run check:project`; for code changes, also run `npm test`.
2. Update the relevant task evidence with commands, result, PR, and commit when known.
3. Regenerate dashboards with `npm run gen:dashboard` and `npm run gen:kanban`.
4. Report any checks that could not be run.
