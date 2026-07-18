# DeckGhost Public Release

[← docs/README.md](README.md)

DeckGhostのPublic版は、Privateリポジトリを正本にした手動スナップショットです。
Private側の履歴、Issue、PR、Actions、タスク正本を公開せず、実行に必要なファイルと
マスク済み公開ステータス、公開用のエージェント/タスク管理サンプルをPublicリポジトリへ送ります。

## Source Of Truth

Privateリポジトリが常に正本です。Publicリポジトリは配布用の読み取り専用スナップショットとして扱います。

- 既定の公開先は `Azsoft-jp/DeckGhost-public` です。
- 実際の公開先はGitHub ActionsのRepository Variable `PUBLIC_REPOSITORY` で上書きできます。
- 公開操作は手動workflow dispatchのみです。pushやPull Requestでは自動公開しません。
- Public側の `main` は、毎回単一root commitの最新スナップショットとして更新します。

## Export Allowlist

公開対象は `config/public-export.json` のallowlistで管理します。
denylistだけに依存せず、必要なファイルやディレクトリを明示してから検証します。

主な公開対象は次の通りです。

- アプリ実行に必要な `server/`、`worker/`、`public/`、`data/`、`package*.json`
- Public向けREADME、MIT License、サンプル音源ライセンス
- `AGENTS.md` と `.agents/skills/` の公開用サンプル
- Project Janus型運用を説明する公開用ドキュメント
- マスク済みの公開状態SVG

## Private Material Excluded From Public

Public snapshotには次を含めません。

- `.github/` とGitHub Actions
- `node_modules/`
- `TASKS.md`
- `tasks/`
- タスクJSON/YAML、ログ、履歴、Issue/PR対応表
- PrivateリポジトリURL、private branch、private commit SHA、ローカルパス、secret

## Public Status SVGs

Private側で生成したMetrics SVGは、そのままではなく公開用にマスクしてコピーします。

| Private source | Public target |
|---|---|
| `.github/metrics/kanban.svg` | `public/status/deckghost-status.svg` |
| `.github/metrics/repository.svg` | `public/status/deckghost-repository.svg` |
| `.github/metrics/issue-trend.svg` | `public/status/deckghost-issue-trend.svg` |

公開SVGは自己完結型にし、script、foreignObject、外部URL、イベントハンドラ、
private task ID、Issue/PR番号、commit SHA、ローカルパスを含めません。

### SVGマスキングの仕組み

SVG内部のプライベートデータの漏洩を完全に防ぐため、視覚的なぼかしフィルターではなく、エクスポート処理中に**ソーステキストレベルでの置換および消去**を行います。これにより、ブラウザの開発者ツールでSVGのDOMやソースコードを検証されても、元のデータは一切読み取れません。
- **タスクID**: `DG-XXX` といったタスクIDは、対応する文字数分の四角ブロック `◽◽◽◽◽◽` へ完全置換されます。
- **コミットハッシュ**: `b2f102c` などのコミットハッシュ（7桁〜40桁）は、ソースコードから完全に消去（空文字列 `""` に置換）されます。
- **合計コミット統計**: `Total Commits` やその差分情報（1d/7d増分）の数値はすべて `◽` で置き換えられます。
- **Issue/PR参照番号**: `Issue #10` や `PR #12` などの具体的な参照番号数値はすべて `◽` に置換されます。

## Sample Audio License

DeckGhostのソースコードはMIT Licenseです。一方、`public/samples/` のサンプル音源には
MIT Licenseを適用しません。サンプル音源はDeckGhostの動作確認、評価、デモ用途に限定し、
条件は [`public/samples/LICENSE.md`](../public/samples/LICENSE.md) に分けて記載します。

## Dry Run

Privateリポジトリ上で、Public snapshotをローカル生成して検証できます。

```bash
npm ci
npm test
node scripts/export-public.mjs --config config/public-export.json --output .public-export
VERIFY_DIR="$(mktemp -d)"
cp -a .public-export "$VERIFY_DIR/deckghost-public-verify"
cd "$VERIFY_DIR/deckghost-public-verify"
npm ci
npm test
```

`.public-export/` は公開する清潔なtreeです。`npm ci` は `.public-export` ではなく、
使い捨てコピーで実行します。これにより `node_modules/` が公開treeへ混入しません。

## Authentication

Public repositoryへの書き込みはDeploy Key方式で行います。

1. Public側リポジトリ `Azsoft-jp/DeckGhost-public` のDeploy keysへ、公開鍵 `.pub` の一行を登録します。
2. 登録時に `Allow write access` をONにします。
3. Private側 `Azsoft-jp/DeckGhost` のActions Secretに、秘密鍵を改行込みで保存します。

Secret名:

```text
PUBLIC_REPO_DEPLOY_KEY
```

Secret値:

```text
[SSH private key block stored only in the private repository secret]
```

`PUBLIC_REPOSITORY_TOKEN` は使いません。`https://x-access-token:...@github.com/...` に入れられるのは
改行のないPATなどのHTTPSトークンであり、SSH秘密鍵を入れてはいけません。

## Manual Publication

GitHub Actionsの `Publish public snapshot` を手動実行します。

1. `dry_run=true` でPublic snapshotを生成・検証します。
2. 問題がなければ `dry_run=false` で公開します。
3. Workflowは `.public-export` 内で新しいGitリポジトリを初期化し、単一root commitを作成します。
4. `PUBLIC_REPO_DEPLOY_KEY` を使って `git@github.com:<PUBLIC_REPOSITORY>.git` へSSHでforce pushします。
5. 公開後にcloneし直し、ActionsやPrivateタスク正本が混入していないことと、Public smoke testが通ることを確認します。

このworkflow自体はPrivateリポジトリの `.github/workflows/` にだけ存在し、Public snapshotには含めません。
