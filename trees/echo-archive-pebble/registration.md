# 第1話の入稿・登録手順

固定審査対象は `ed382247480e9564feb430708f5b48e18292db64`。本文 `manuscript/01.md` と世界設定 `world.md` は旧固定版から内容不変で、補正済み出自申告を含む `relay-branch.json` をこのrevisionに固定しています。出自申告と自作部分のCC0提供同意はこのディレクトリにあります。

[registration.json](registration.json)は固定対象とEditorの準備コマンドです。共有DBへ送信した結果ではありません。PR提出時点では、掲載カタログと有効化済み系譜に追加していません。

[審査要約](review-summary.json)の掲載判断は `eligible` です。Agyの正式回答により、Borges『バベルの図書館』は素材利用出典ではなく、公然の影響（古典的SFモチーフの継承）として出自申告へ明記しました。`statedSources` は素材利用出典だけを扱い、`influences` は文化的・概念的影響を記録するため、CC0/PDの権利根拠チェックとは分離します。独立比較で人物・場面・表現の移植は確認されておらず、自作部分のCC0提供同意も確認済みです。

## 実行前の確認

このPRのコード反映後に、運営者が独立Auditorの登録・キー・対象リポジトリとの独立性を確認します。参加者やEditorのキーをAuditorと読み替えません。今回の補正済み出自申告と `eligible` 判定を固定対象のハッシュに結び付けて記録してから、掲載・有効化へ進みます。

登録先は読書サイトが参照する共有試験DBです。本番の参加DBへの転送や一般募集の再開は含みません。既存のactive系譜があれば、その終了判断を確認してから新系譜を有効化します。

## 順序

1. `registration.json` の `prepare.input` を入力ファイルとして、Editorが `editor.lineage.prepare` を送ります。再送は同じrequest-idと同じ入力を使います。新しい系譜はdraft、枝はpending、第1話はunlistedです。
2. Editorが `branches/check` で `echo-archive-pebble` を照合します。固定commitのmanifest・本文・世界設定のハッシュ確認を通し、枝をcheckedにします。
3. Auditorが `review-target?id=echo-archive-pebble` で固定対象を照合し、独立した初回比較の保存後に `review-evidence` の作者申告を確認します。既存の検査記録を使う場合も対象hashと推論コンテキストの独立性を確認します。
4. Auditorが `review.record` に実際の比較・検索・申告照合・権利確認の記録を送ります。非公開の検索語や比較ログは運用記録に保持し、ここには公開要約を置きます。
5. `eligible` の対象審査がある場合だけ、Editorが `editor.branch` を `expectedVersion: 2, status: verified` で送ります。実際の枝versionとgate所見を再確認し、必要な所見確認と掲載理由を記録します。
6. Editorが `editor.lineage.activate` に `lineageId: echo-archive-pebble-2026-10-04` を送ります。APIの公開カタログと読書サイトが同じ固定版を表示することを確認します。

準備、掲載、有効化は別の処理です。PRのマージやサイトビルドだけで上記コマンドが自動実行されることはありません。旧 `origin` の管理用bootstrapや中央続話publishを、新しい起点の登録へ流用しません。
