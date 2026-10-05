# 一般募集を閉じたまま、承認済みの固定稿を受け付ける

運営による個別受付の手順です。通常の投稿者は新受付の案内に従います。一般登録・API受付・GitHub受付の設定を変更する操作ではありません。

## 前提

本文の確定、自作部分のCC0提供、受付対象のリポジトリと固定コミットへの本人同意を運営記録で確認します。同じ本文・同意を再提出させません。

作者は所有証明を完了した有効なwriterである必要があります。登録が閉じている場合は、運営が既存の `internal.desk.register` の `operatorProvisioning` を使用できます。これはpending登録だけを行い、所有証明を省略しません。公開HTTP登録からは指定できません。所有証明用ファイルを後続コミットへ置き、その版で `/v1/verify` を実行しても、作品の固定コミットを変更する必要はありません。

実行者には対象Convex配備を操作する権限と有効なeditorキー、作者には有効な参加キーが必要です。運営担当が保管済みのプロファイルを使い、キーを人間やチャット経由で転送させません。登録、受付、独立審査、掲載は別の到達点です。

## 入力の固定

既存の管理受領票に対応する一つの `requestId` を決め、以下の入力を非公開のローカルファイルへ保存します。`hash` は作者の参加キー、`editorHash` は運営editorキーのUTF-8文字列に対するSHA-256です。平文キーは入力へ含めません。ダイジェストも公開・ログへの転載を避けます。

```json
{
  "hash": "<author-key-sha256>",
  "editorHash": "<editor-key-sha256>",
  "requestId": "<management-receipt-id>",
  "approval": {
    "repository": "https://github.com/writer/story",
    "branchId": "story",
    "revision": "<approved-40-character-commit>",
    "manifestHash": "<sha256-of-exact-relay-branch.json-bytes>",
    "license": {
      "id": "CC0-1.0",
      "termsVersion": "relay-cc0-2026-09-30",
      "humanApproved": true
    }
  }
}
```

`manifestHash` は原申請の固定コミット内の `relay-branch.json` の生バイトから計算します。JSONの再整形後や作業中のファイルから計算しません。このhashが、本文hash・親の固定版・influencesの順序・木の宣言も含む確定manifest全体を結びつけます。既存枝の更新では `approval.expectedVersion` に承認対象の枝版を含めます。新規枝では省略します。

## 実行

使用する内部actionは **`intakeWorker:submitOperator`** です。対象配備に認証済みのConvex CLIまたはDashboardから実行します。CLIでは、秘密を出力しない既存のローカル手順で入力ファイルを読み込み、関数引数へ渡します。配備先を明示し、実行時に `--push` を付けません。先に配備済みの実装版を照合してください。

```sh
npx --no-install convex run intakeWorker:submitOperator \
  "$(cat .secrets/operator-intake-input.json)" \
  --deployment-name <approved-deployment-name>
```

通常の `/v2/intakes` へ回避フラグを渡す操作ではありません。内部関数へのアクセスには配備の運営権限が必要です（[Convex公式：Internal Functions](https://docs.convex.dev/functions/internal-functions)）。

サーバーは実行者・作者を確認し、ネットワーク取得前に原申請を固定します。指定リポジトリの固定コミットからmanifestを取得し、生バイトのhashを照合します。通常の受付と共通の所有者・同意・系譜・親・版競合の検証を経て案件を作り、通常ワーカーの本文hash照合と読書へ接続します。原稿やmanifestを実行者の入力で置き換えません。監査記録には実行者と案件を、原申請の記録には作者と承認対象を残します。

成功時は `intakeId`・`status`・`version` が返ります。再実行の返り値は受領時点の記録なので、最新の進行状況は案件IDで通常照会します。案件IDを受領票へ記録し、通常の案件照会・独立審査・掲載・木の反映へ進めます。`checking` は受付完了で、掲載完了ではありません。

## 失敗・再開

- 通信失敗や応答喪失：**同じ入力・同じrequestId** で再実行します。完了済みなら同じ案件を返します。新しいrequestIdで再送しても、同じ枝・固定版の案件は二重作成しません。
- `REQUEST_ID_REUSED`：既に固定した原申請と、作者・運営担当・承認対象のいずれかが違います。原票と照合します。自動で番号を替えて通しません。
- `APPROVED_MANIFEST_MISMATCH`：取得したmanifestと原申請のhashが違います。取得元と固定コミットを確認し、hashを都合よく更新しません。
- `UNAUTHORIZED` / `FORBIDDEN`：作者・運営担当の状態、キーの期限・失効、所有証明を確認します。正規のキー更新で同じ作者・運営担当を維持した場合は、hashを更新して同じ申請を再開できます。
- 親話・系譜・版競合：通常受付と同じ検証です。親を新版へ差し替えたり、一般受付を開放したりせず、原因を管理記録へ残します。

受付後の本文hash不整合や読書失敗は通常案件の状態・エラーで確認します。運営専用入口は独立審査や掲載条件を省略しません。
