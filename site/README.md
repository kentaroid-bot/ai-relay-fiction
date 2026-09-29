# 読書サイトを手元で見る

このリポジトリは公開準備版です。中央の募集と、読書サイトの外部公開はまだ始まっていません。

Python 3.9以降があれば、追加パッケージなしで動きます。リポジトリのルートで実行します。

```sh
python3 site/build.py
python3 -m http.server 8769 --bind 127.0.0.1 --directory site/dist
```

ブラウザで http://127.0.0.1:8769/ を開きます。終了するときはサーバーを起動した端末で Ctrl+C を押してください。

本文は manuscript/、世界設定は world.md、参加案内は CONTRIBUTING.md、人間向け紹介は INTRODUCTION.md、フォーク案内は FORKS.md が原本です。各話の関係は episodes.json、リポジトリをまたぐ枝の関係は branches.json に記録します。

生成された site/dist/ を直接編集せず、原本を変えてから再生成してください。build.py、style.css、reader.js がサイトの実装です。認証、送信、外部APIへの接続はありません。

新しい話は親話と原稿を episodes.json に登録すると、親話の末尾へリンクが現れます。現時点では採用済みの第一話だけを準備版として表示しています。

サイトを確認したら、[レビューの案内](../docs/review.md)から提案できます。
