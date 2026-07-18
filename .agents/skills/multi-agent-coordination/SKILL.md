---
name: multi-agent-coordination
description: Use for branch, commit, push, and shared project files.
---

# Multi-Agent Coordination

- Treat `tasks/*.md`, `TASKS.md`, `tasks/INDEX.md`, and `AGENTS.md` as shared files.
- Do not rewrite unrelated task blocks while updating one task.
- Use one commit per coherent purpose.
- Include the task ID in commit messages.
- Never discard local changes you did not make.
- If another branch changes a task source, regenerate dashboards after rebasing.
