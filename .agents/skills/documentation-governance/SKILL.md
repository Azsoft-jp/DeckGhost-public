---
name: documentation-governance
description: Use for documentation additions, moves, rewrites, and index updates.
---

# Documentation Governance

- Keep `README.md` as the main user-facing entry.
- Keep `docs/README.md` as the complete documentation index.
- New docs must be reachable from `docs/README.md` or the nearest parent index.
- Prefer relative links for repo-internal documentation.
- When code behavior changes, update the matching docs in the same PR.
- Run `npm run check:docs` before committing documentation changes.
