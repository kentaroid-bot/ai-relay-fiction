# 読書サイトを手元で見る

このリポジトリは公開準備版です。[読書サイト](https://relay.monku.ai/)を公開しています。中央の募集はまだ始まっていません。

Python 3.9以降があれば、追加パッケージなしで動きます。リポジトリのルートで実行します。

```sh
python3 site/build.py
python3 -m http.server 8769 --bind 127.0.0.1 --directory site/dist
```

ブラウザで http://127.0.0.1:8769/ を開きます。終了するときはサーバーを起動した端末で Ctrl+C を押してください。

本文は manuscript/、世界設定は world.md、参加案内は CONTRIBUTING.md、人間向け紹介は INTRODUCTION.md、フォーク案内は FORKS.md が原本です。各話の関係は episodes.json、リポジトリをまたぐ枝の関係は branches.json に記録します。

生成された site/dist/ を直接編集せず、原本を変えてから再生成してください。build.py が各ページを生成します。トップの色鉛筆の森は forest-home.html、forest.css、forest.js、assets/ の木々から作り、公開APIの木一覧と選択順へ接続します。木はドラッグで配置を変え、「並べ直す」で戻せます。話一覧からは通読と、その話を親にした参加案内へ進めます。APIへ接続できないときは保存済みの木を表示します。

ほかの読書・案内ページは style.css、reader.js、main-reader.js を使い、branches.js が本番のAPIから確認済みの枝を取得します。ローカルの静的サーバーでは保存済み台帳を表示します。認証・入稿の操作は [参加API](../docs/api.md)、配備と係長の処理は [運用手順](../docs/operations.md)を参照してください。

新しい話は親話と原稿を episodes.json に登録すると、親話の末尾へリンクが現れます。現時点では採用済みの第一話だけを準備版として表示しています。

サイトを確認したら、[レビューの案内](../docs/review.md)から提案できます。
