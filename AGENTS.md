# DeckGhost Agent Rules

DeckGhost uses Project-Janus-style file-first project management. This file is the
entry point for human and AI agents working in this repository.

## Source Of Truth

- Product behavior: `README.md`, `public/help.html`, and `docs/DESIGN.md`.
- Project management: `tasks/*.md`.
- Generated dashboards: `TASKS.md`, `tasks/INDEX.md`, `.github/metrics/*.svg`.
- Kanban limits: `.github/kanban.json`.
- Documentation index: `docs/README.md`.

Do not hand-edit generated dashboards. Update the task source files and run the
generation commands instead.

## Task Statuses

Use only these statuses:

`BACKLOG`, `READY`, `IN_PROGRESS`, `PARTIAL`, `WAITING_TEST`, `REVIEW`,
`BLOCKED`, `DONE`, `CANCELLED`, `DEFERRED`, `SUPERSEDED`, `FROZEN`.

`DONE` means acceptance criteria and evidence are satisfied. If real work remains,
use `PARTIAL`, `WAITING_TEST`, or create another task before marking the original
task `DONE`. Do not invent mixed statuses such as `DONE (core)`.

`FROZEN` preserves roadmap items without counting them as active WIP. Frozen tasks
must include `Frozen reason` and `Resume condition`.

## Issue, PR, And Branch Traceability

- New non-terminal tasks should have `- Issue: — (task-issue-sync pending)` until
  `npm run sync:issues -- --apply` writes the GitHub Issue link back.
- Active work should include `Owner`, `Issue`, and `PR` where applicable.
- Commit messages should start with or include the task ID, for example:
  `DG-PM-001: Add project management automation`.
- Pull requests should use `Refs #...` or `Closes #...` when tied to an Issue.

Existing historical commits imported during the first adoption are allowed to be
`DONE` without Issue links and are treated as legacy evidence.

## Skill Routing

Read all matching skill files before making the related change:

| Condition | Skill |
|---|---|
| Session start/end, handoff, final reporting | `.agents/skills/session-lifecycle/SKILL.md` |
| Branch, commit, push, shared files | `.agents/skills/multi-agent-coordination/SKILL.md` |
| Task, Issue, PR, status change | `.agents/skills/task-issue-pr-sync/SKILL.md` |
| Documentation add/move/rewrite/indexing | `.agents/skills/documentation-governance/SKILL.md` |
| Code/config/tests/build verification | `.agents/skills/quality-gates/SKILL.md` |

## Required Checks

Before committing project-management or documentation changes:

```bash
npm run check:project
npm test
```

If a check cannot be run, record the reason in the task evidence and final report.
