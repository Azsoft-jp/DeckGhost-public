---
name: quality-gates
description: Use for code, config, automation, and verification work.
---

# Quality Gates

Run the smallest check set that proves the change:

```bash
npm run check:project
npm test
```

For generated project assets:

```bash
npm run gen:project
npm run check:project
```

If a GitHub token is unavailable, `npm run gen:github-metrics` may be skipped
locally, but CI will regenerate it on `main`.
