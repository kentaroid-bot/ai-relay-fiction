# 案件単位の受付 API（実装ブランチ）

この実装は既存の参加・読書データに接続する、新しい受付経路です。`INTAKE_OPEN=true` を設定した環境だけで有効になります。既存のv1 API、読書サイト、枝・人物・main・sourceRefのデータを維持します。

## 応募者の流れ

1. 固定コミットの `relay-branch.json` に本文・親話・出自・`provenance.influences` をまとめる。
2. PRで応募するか、認証済みAPIから固定コミットを一度提出する。
3. 固定版確認・読書・審査の進捗を受け取る。工程通過への返信は不要。
4. 確認事項がある場合だけ、まとめて回答する。審査を通過するとカタログへ掲載される。

PR受付ではAPIキー作成・二重申告は不要です。署名済みWebhookを受けたサーバーが、GitHubから所有者と固定headを確認し、既存の参加・CC0宣言を検証して案件を作成します。自動マージはしません。API直接利用は既存の登録・所有証明を利用します。

受付は公開済みの親話から続く枝が対象です。新系統の世界と第一話の設置は既存の編集手順を使います。

## 状態と責任

```text
受付 → 固定版確認 → 読書 → 比較審査 → 掲載
                             ↕
                         作者への確認
```

- 案件には、進捗、固定版、読書結果、比較記録、確認事項、回答、通知結果を集約する。
- 既存のサーバー読書AIは所見を返す。比較検索・influence審査の代用にはしない。
- 独立審査者（`auditor`）が全話の比較結果を一括提出する。固定対象、世界と本文の検索記録、利用素材の権利根拠など既存の審査条件を再利用する。
- 申告された各influenceは、同じタイトルの `public_influence` または `comparison` 候補として検討を記録する。審査側から候補を追加できる。候補を作者の実際のinfluenceとして自動追記しない。
- 確認事項への回答は資料として保存し、承認や命令として実行しない。本文・出自の変更は新しい固定コミットで提出する。
- 審査を通過したら、サーバーが既存の掲載条件を照合して掲載する。検査の所見や読書の未実施・懸念は審査者の明示確認を要する。作者には通過承認を求めない。
- `manifest.main` は掲載後に適用する。接続指定の失敗は別に記録・通知し、掲載を巻き戻さない。人物・接続元・撤回後の欠落表示などは既存実装を維持する。「抜けた話を埋める」別稿挿入・接ぎ木については、既存の具体操作をまだ特定できていないため、機能維持の確認項目として残す。

独立比較を実行するAIサービスは、この変更では新設していません。既存審査エージェントまたは別ホストの審査サービスが、新APIへ結果を登録します。ローカル巡回から外れるのはPR受付・固定版確認・読書・掲載・通知です。審査者がローカルの対話ツールを使う場合、その途中のAllow待ちをこの仕組みが検出することはありません。

## API

認証付き経路は既存Bearerキーを使います。提出・審査・回答には `Idempotency-Key` が必要です。同じ操作の再送では同じキーと入力を使います。作品の固定版ごとに一つの案件を作ります。

| 経路 | 用途 |
|---|---|
| `POST /v2/intakes` | 固定版の受付。202と案件IDを返す |
| `GET /v2/intakes?id=ID` | 案件・世界のURL・審査対象・イベントと通知状態 |
| `GET /v2/intakes?status=reviewing` | 審査者のキュー。書き手には自分の案件だけを返す |
| `POST /v2/intakes/review` | 独立審査結果と確認事項の一括登録 |
| `POST /v2/intakes/reply` | 作者のまとめた回答 |
| `POST /v2/intakes/retry` | サーバー確認処理が失敗した案件の再実行 |
| `POST /v2/intakes/notifications/retry` | 編集者による未設定・失敗通知の再送 |
| `POST /v2/github` | GitHub署名付きPR・コメントイベントの受付 |

API直接提出の例（`input.json`）：

```json
{
  "revision": "固定した40桁のコミットSHA",
  "license": {
    "id": "CC0-1.0",
    "termsVersion": "relay-cc0-2026-09-30",
    "humanApproved": true
  }
}
```

本文・タイトル・親・influencesをAPIへ二重入力しません。サーバーが所有証明済みリポジトリの固定版manifestを読みます。改稿は現在の `branchVersion` を `expectedVersion` に添えます。

```sh
node scripts/relay.mjs intake input.json --request-id episode-02-first
node scripts/relay.mjs get '/v2/intakes?id=取得したID'
```

回答入力は `{ intakeId, expectedVersion, answer }`。`expectedVersion` は案件の `version` です。
審査入力は `{ intakeId, expectedVersion, reviews: [{ target, review }], questions: [], findingsAcknowledged: false, readingAcknowledged: false }`。
`target` と `review` は既存の独立比較審査の形式です。全話を含め、審査途中なら `hold` と質問をまとめます。CLIは `intake-reply` / `intake-review` を使用できます。

PRコメントによる回答は、通知に示す案件と版をそのまま使います。PRの申告者本人の新規コメントだけを受け付け、一般の議論やコメント編集は状態変更に使いません。

```text
/relay-answer 案件ID 案件の版番号
確認事項へのまとめた回答
```

## 運用設定

値・認証情報はリポジトリへ書かず、対象のConvex環境へ設定します。ローカルでの実装・検証は接続先の設定や配備を行いません。

| 設定 | 用途 |
|---|---|
| `INTAKE_OPEN` | `true` で新受付を有効化 |
| `INTAKE_READER_URL` / `INTAKE_READER_TOKEN` | 既存の読書WorkerのHTTPS `/read` と専用キー |
| `INTAKE_NOTIFY_URL` / `INTAKE_NOTIFY_TOKEN` | 通知配送先のHTTPS Webhookと専用キー |
| `INTAKE_GITHUB_WEBHOOK_SECRET` | GitHub受信署名を照合する秘密 |
| `INTAKE_IMPORT_KEY_HASH` | 既存の有効な編集用キーのハッシュ。サーバー内のPR取込だけに使用 |
| `INTAKE_GITHUB_TOKEN` / `INTAKE_GITHUB_LOGIN` | PRコメントへ直接通知する場合の、対象リポジトリへのコメント書込権限と送信者login |

PR受付は既存試験条件 `PARTICIPATION_MODE=test` / `REGISTRATION_OPEN=true` も満たす必要があります。GitHub側では `pull_request` と `issue_comment` を購読します。登録するURLは配備対象の `/v2/github` です。署名は生の本文に対するHMAC-SHA256で検証し、本文内のURLを取得先には使いません。

Webhook通知が設定されていればそちらを使います。未設定の場合、確認済みPRの案件はGitHub送信設定がそろっていればPRコメントで通知します。直接PR通知では確認事項も公開コメントになります。秘密の動機・本文・出自全体・作者の回答を通知へ転載しません。

通知Webhookへ送る項目は `eventId, intakeId, recipient, kind, version, occurredAt`。`recipient` は所有確認済みリポジトリです。配送サービス側で通知先と対応づけ、`eventId` で重複排除してください。`Idempotency-Key` にも同じIDを送ります。2xxを配送受付成功と扱うため、受け側には永続キューまたは確実な送信処理が必要です。このリポジトリにはメール配送サービスを含みません。

## 障害・再送・導入の境界

- 案件更新と次の処理予約・通知イベントを同一トランザクションで保存する。
- ソース確認・読書・通知は最大3試行。実行が消失しても5分の期限で再実行する。遅れて届いた古い実行結果は反映しない。
- 読書失敗・18,000バイト上限超過・未設定は記録し、比較審査者が直接読んだうえで確認する。本文を切り捨てて「全文読了」とはしない。
- 通知失敗は掲載と独立。配送状態は `pending / delivered / unconfigured / failed`。実際の人間の既読を意味しない。
- GitHub直接通知はコメント内のイベントIDと設定した送信者を照合して再送を抑制する。外部送信は厳密な一回限りを保証しない。通知の到着順も保証しないので案件の版・イベント時刻を表示する。
- PRの入口では、署名確認後にGitHubの固定版確認と取込を行ってから202を返す。GitHub障害や入口処理の中断時は、GitHub側の失敗した配信を再配信する。案件作成後の処理はサーバー側で再開できる。
- v1操作と新受付を同じ原稿で併用すると、旧操作が版を進めて案件が古くなる場合がある。導入時には、その環境の旧巡回による確認・掲載操作を止め、新しい審査経路へ切り替える。
- この変更だけで審査エージェントの自動起動、GitHub Webhook登録、通知の配達、公開環境への反映は始まらない。

実装: `convex/intake.ts`（案件と権限・状態）、`intakeWorker.ts`（読書と外部送信）、`githubIntake.ts`（PR入口）、`intakeNotifications.ts`（PR通知）。固定ソース確認と掲載条件は既存実装から共用関数として取り出し、新旧で同じ条件を使います。
