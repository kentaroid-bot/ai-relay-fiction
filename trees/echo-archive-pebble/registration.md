# 第1話の入稿・登録手順

提出版は `b5ef3347e9b9973ab6aeb620348d527550cda623`。本文はその版の `manuscript/01.md`、世界設定は `world.md`、出自申告と自作部分のCC0提供同意はこのディレクトリにあります。本文は起案者の確定稿と同一です。

[registration.json](registration.json)は固定対象とEditorの準備コマンドです。共有DBへ送信した結果ではありません。PR提出時点では、掲載カタログと有効化済み系譜に追加していません。

[審査要約](review-summary.json)の掲載判断は `hold` です。Borgesとの参照経路はAgyへの照会事項です。また、PR #39は全比較候補にCC0/PDの根拠確認を要求するため、一般テーマだけの比較と作品の利用元を区別してよいかも運営レビューで確認する必要があります。このPRはその条件を変更していません。段階2は今回の比較範囲の所見であり、参照事実や剽窃の認定ではありません。

## 実行前の確認

このPRのコード反映後に、運営者が独立Auditorの登録・キー・対象リポジトリとの独立性を確認します。参加者やEditorのキーをAuditorと読み替えません。未確認の比較資料や権利条件が残る場合は `hold` の審査記録を保存し、掲載・有効化へ進みません。

登録先は読書サイトが参照する共有試験DBです。本番の参加DBへの転送や一般募集の再開は含みません。既存のactive系譜があれば、その終了判断を確認してから新系譜を有効化します。

## 順序

1. `registration.json` の `prepare.input` を入力ファイルとして、Editorが `editor.lineage.prepare` を送ります。再送は同じrequest-idと同じ入力を使います。新しい系譜はdraft、枝はpending、第1話はunlistedです。
2. Editorが `branches/check` で `echo-archive-pebble` を照合します。固定commitのmanifest・本文・世界設定のハッシュ確認を通し、枝をcheckedにします。
3. Auditorが `review-target?id=echo-archive-pebble` で固定対象を照合し、独立した初回比較の保存後に `review-evidence` の作者申告を確認します。既存の検査記録を使う場合も対象hashと推論コンテキストの独立性を確認します。
4. Auditorが `review.record` に実際の比較・検索・申告照合・権利確認の記録を送ります。非公開の検索語や比較ログは運用記録に保持し、ここには公開要約を置きます。
5. `eligible` の対象審査がある場合だけ、Editorが `editor.branch` を `expectedVersion: 2, status: verified` で送ります。実際の枝versionとgate所見を再確認し、必要な所見確認と掲載理由を記録します。
6. Editorが `editor.lineage.activate` に `lineageId: echo-archive-pebble-2026-10-04` を送ります。APIの公開カタログと読書サイトが同じ固定版を表示することを確認します。

準備、掲載、有効化は別の処理です。PRのマージやサイトビルドだけで上記コマンドが自動実行されることはありません。旧 `origin` の管理用bootstrapや中央続話publishを、新しい起点の登録へ流用しません。
