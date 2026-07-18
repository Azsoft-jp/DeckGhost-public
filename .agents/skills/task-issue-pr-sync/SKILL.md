---
name: task-issue-pr-sync
description: Use when adding/updating tasks or synchronizing GitHub Issues and PRs.
---

# Task, Issue, And PR Sync

## Task Fields

Each task block should use this shape:

```md
## DG-123 Short title
- Status: READY
- Priority: P1
- Area: dg
- Owner: codex
- Issue: — (task-issue-sync pending)
- PR: —
- Commit: —
- Completed: —
- Evidence: —
```

## Rules

- Non-terminal tasks should have an Issue link or the pending placeholder.
- Task IDs are global identifiers. Use the `Area` field, not the ID prefix, for `area:*` labels and metrics.
- `DONE` tasks need evidence. New `DONE` tasks should also have Issue/PR/Commit where available.
- `FROZEN` tasks must include `Frozen reason` and `Resume condition`.
- Use `npm run sync:issues -- --apply` to create/update Issues from task sources.
- The Issue body contains `<!-- deckghost-task:<TASK-ID> -->`; do not sync an Issue if the marker points to another task.
- Closing a task in GitHub should leave a comment with evidence or point to the PR that contains it.
