# DeckGhost Project Management

[← docs/README.md](README.md)

DeckGhostはProject Janusの運用を取り込み、GitHub Projects APIではなく
リポジトリ内のMarkdownを正本にします。タスク、Kanban、GitHub Issue、
GitHub Metrics、エージェントルールが同じ情報から再生成されるため、
チャットやPR本文だけに進捗が残らない構成です。

## Source Of Truth

| Asset | Role |
|---|---|
| `tasks/*.md` | タスクの正本。Status、Priority、Area、Owner、Issue、PR、Evidenceを保持 |
| `TASKS.md` | 生成ダッシュボード。手動編集しない |
| `tasks/INDEX.md` | 生成タスク索引。手動編集しない |
| `.github/metrics/kanban.svg` | Pull Kanbanの可視化 |
| `.github/metrics/repository.svg` | GitHubメトリクスの可視化。Issue状況、優先度別進捗、エリア別進捗、言語内訳、Contributor、コミット数、コード行数、1日/7日差分を含む |
| `.github/metrics/issue-trend.svg` | Issue/PRの時系列トレンド |
| `.github/metrics/issue-history.json` | IssueTrendのスナップショット履歴 |
| `AGENTS.md` | エージェント作業ルール入口 |
| `.agents/skills/*/SKILL.md` | 条件付きの詳細作業手順 |

## Status Model

`BACKLOG → READY → IN_PROGRESS → REVIEW / WAITING_TEST → DONE` を基本経路にします。
残件がある完了は作らず、実作業が残る場合は `PARTIAL` または別タスクへ分割します。

`BLOCKED` は停止理由がある状態です。`FROZEN` はロードマップから削除しないが、
今は着手しないタスクを保持するために使います。`FROZEN` には `Frozen reason` と
`Resume condition` が必須です。

## Issue Sync

タスクIDは `DG-001` のようなグローバル連番として扱い、エリア分類には使いません。
エリアは各タスクの `Area` フィールドを正とし、Issue label と Repository Metrics の
エリア別進捗はこの値から生成します。現在の標準エリアは `dg`、`docs`、`test`、`audio`、
`samples` です。

非終端タスクはGitHub Issueを持ちます。新規タスクを追加した直後は次の行で
一時的に置けます。

```md
- Issue: — (task-issue-sync pending)
```

その後、次を実行するとIssueが作成または更新され、Issue番号がタスクへ書き戻されます。

```bash
npm run sync:issues -- --apply
```

Issue本文には `<!-- deckghost-task:<TASK-ID> -->` のIDマーカーが入り、別タスクのIssueを
誤更新しないようにします。

## Generated Assets

```bash
npm run gen:dashboard
npm run gen:kanban
GITHUB_TOKEN="$(gh auth token)" npm run gen:github-metrics
npm run gen:project
```

CIでは `.github/workflows/project-management.yml` が `main` へのpush、手動実行、定期実行で
生成物とIssue同期を更新します。

## Checks

```bash
npm run check:docs
npm run check:project
npm test
```

`check:docs` はタスク状態、Frozenメタデータ、Issueリンク、docs索引、Markdownリンクを検査します。
`check:project` はdocs、dashboard、Kanban生成物が最新かを検査します。

GitHub MetricsはGitHub APIとGit履歴を使うため、ローカル生成では `GITHUB_TOKEN` または
`GH_TOKEN` を渡してください。CIでは `GITHUB_TOKEN` で `repository.svg`、`issue-trend.svg`、
`issue-history.json` を更新します。生成スクリプトはJanusと同じく `gen-metrics.mjs` で
Repository/IssueTrendを作り、`gen-repository-metrics.mjs` でコミット数・コード行数差分を
Repository SVGへ追加します。

## Historical Backfill

導入時点で到達可能だった既存コミットは `tasks/history.md` に `DONE` として取り込みます。
これは移行用の一回限りの棚卸しです。将来の通常作業は個別タスクを作成し、Issue/PR/Commitを
紐付けて追跡します。
