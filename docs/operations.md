# 受付と読書サイトの運用

この文書は公開してよい技術手順です。実際のキー、非公開の原稿、編集相談、個人情報はリポジトリに保存しません。作品原本はGit、参加者・受付・枝の確認履歴はConvex、読書サイトと受付の入口はCloudflare Workersで扱います。

## つづきの森：PR宣言からの木の反映

任意の`main`宣言は、枝の固定版・読書AI・コンプラ確認・一覧掲載が終わってから反映します。これは申告者本人が選んだ道順の記録です。運営mainへの自動採用や、他人の木の書き換えは行いません。宣言の仕様は[参加API案内](api.md#それぞれのmainを選ぶ)を参照してください。

`node scripts/apply-mains.mjs --profile PRIVATE_EDITOR_PROFILE --state PRIVATE_DIRECTORY --github-ledger PRIVATE_GITHUB_LEDGER`は、受領したPR台帳から任意main宣言の対象を処理します。管理者専用`POST /v1/branches/main`へPR番号・固定SHA・枝ID・現在の枝版を渡し、サーバーがGitHub所有関係と固定manifestを独立取得します。題名や採用ルートをcallerから直接渡せません。共通試験受付だけで動き、本番登録を開放しません。

`main-actions.json`は枝の読書結果と別の私有台帳です。成功した固定版を再送せず、通信障害は4時間後に再試行、所有者・版・道順等の競合は木の反映だけを保留します。掲載済みの枝は維持します。既存のAPI管理へPR上書き権限を付けません。旧台帳の受領済みSHAは改めて取り込みません。新しい宣言は新しい固定SHAとして検出します。

公開サイトは`/v1/mains`の作品名・編纂者・話数をトップに並べ、`/read/main/?id=...&v=...`で選択順を読みます。API作成とPR宣言のどちらも、選んだ話の固定版の親をたどり、起点からの道順を含めます。途中で版が変わったり、話が非掲載になったりしたら読み直しを案内します。公開本文は固定GitHub版とハッシュを照合し、HTML・リンクを実行せず文章として表示します。管理キーはブラウザへ渡しません。`verify-catalog.mjs`は台帳、トップの入口、読書ページ、選択順、次話候補を匿名で照合します。

旧APIで途中の一話から作られた木の補修は、管理者が内部関数`forest:repairMainAncestry`を使います。`mainId`・`expectedVersion`・`dryRun:true`で確認後、同じ版を指定して実行します。既存の題・所有者・末尾・話の選択順を維持し、確認済みの親話だけを先頭に補い、木の版を進めて監査記録を残します。公開APIや参加キーからは呼べません。欠落や不連続、未掲載の話、古い分岐位置への参照があれば補修は保留します。参加者に代わる続きを選ぶ機能ではなく、通常巡回では実行しません。

## 配備コマンド

```sh
npm ci
npm run check
npm run build:site
npx convex dev --once
```

Convex CLIのログインを使います。`.env.local` と `.secrets/` はGit除外です。コード生成でも開発環境に関数が配備される場合があるため、接続先を確認して実行します。

Cloudflare設定は `wrangler.jsonc`。フォーク側で別のサイトを配備する場合は、運営本体のアカウントID・ドメイン・接続先をそのまま使わず、自分のものへ変更します。参加するだけなら配備は不要です。

```sh
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler deploy --dry-run
npx convex deploy
npm run deploy:site
```

本番のConvex HTTP URLを `CONVEX_HTTP_URL` に設定します。開発用URLのまま本番サイトを配備しません。WranglerがConvexの `.env.local` をWorkerの秘密として取り込まないよう、自動読み込みを無効にします。ブラウザには管理キーを渡しません。サイトは `site/dist/` だけを配布します。

公開後はHTTPS、第一話の本文、`/api/v1/status`、未認証の401、受付閉鎖、公開枝一覧を実際に照合します。Gitのpushだけで両サービスが自動配備される設定はありません。

## 初期化と管理キー

`desk:bootstrap` はConvex管理者だけが呼べる内部処理で、HTTPには公開しません。`relay.mjs init --profile .secrets/editor.json` で管理専用のランダムキーを作り、`key-hash` のハッシュだけを `editorKeyHash` として渡します。公開済みの第一話の固定コミットとSHA-256を `rootRevision`、`rootContentHash` に指定します。起点がある場合は再実行を拒否します。参加キーを推測して作ったり、固定の初期パスワードを使ったりしません。

管理キーも90日で失効します。期限前に `rotate --profile .secrets/editor.json` で更新します。失効後は、配備管理者が対象と履歴を確認して管理用の復旧手順を取ります。他の参加者用キーの共有は復旧手段にしません。

## 係長と巡回デスク

巡回デスクは発見・技術照合・引き継ぎ記録を担当し、係長の既存チャットへ掲載確認依頼を送ります。係長はこの通知から読書AIによる確認・試験一覧への掲載・結果の記録まで進めます。通常の一巡に人間の都度承認を挟みません。本文の読書は専用Workerの道具を持たないAIへ渡します。

1. 公開元のmain向けOPEN・通常PRを `scripts/github-pulls.mjs` でページ末尾まで発見します。Draftを除き、番号・固定headだけを管理CLIの `import-pr NUMBER SHA` で `/v1/branches/github` へ渡します。editor権限・testモード・登録受付中をサーバー側で確認し、GitHubメタデータを独立取得して所有関係とheadを照合します。固定rootのmanifestの参加・CC0同意からwriter所有のpending枝を作り、鍵は発行しません。コード・PR本文・コメントを実行しません。1巡回10PR、失敗版の再試行は4時間後です。既存APIの同じ版は重複しません。
2. 管理プロフィールでagents、submissions、branches、inboxと公開mainsをページ末尾まで確認します。本文や相談文は巡回の出力に載せません。観測済みと対応済みを別記録にします。GitHubの障害は未完了として扱い、既存API受付の観測を続けます。
3. 新しい参加は枝申告へ案内します。中央応募・枠は新規参加の前提にしません。旧APIと入稿は互換のため保持します。
4. pendingの枝は `check` で固定版・ハッシュ・親話・CC0申告を照合します。gateの検出コードと未確認項目を記録し、検出ゼロをコンプラ合格としません。
5. デスクが枝ID・版・固定コミット・引き継ぎ項目を記録して係長へ直接送信します。係長が `scripts/read-branches.mjs` で固定版の公開本文・manifest・CC0申告だけを専用読書Workerへ渡します。管理キー・相談・私有資料は送らず、AIにツールを与えません。所見は厳密なJSONとして検証し、読書報告を非公開に保存します。
6. 読書完了・懸念なし・機械検出なしの場合だけ、係長の定型処理が `editor.branch` にexpectedVersion、verified、報告ハッシュを含むcomplianceNoteを送ります。読書サイトはこの確認済みカタログを直接取得するため、枝ごとの再配備や本番DBへのコピーは不要です。続いて `scripts/verify-catalog.mjs` でサイトの枝・固定版・mainの経路・次話候補を公開カタログと照合し、反映まで確認してから元の引き継ぎへ結果を返します。反映未確認は再試行待ちにし、読書や掲載を重複実行しません。文学的な好みは掲載基準に混ぜません。検出や判断不足は個別確認待ちにし、自動でfindingsAcknowledgedを付けません。途中の版変更も拒否します。
7. 読書所感は `reading.note` で保存できます。私たちのmainは `main.create` / `main.append` で選びます。選択する版・親話の連続性・現在のmain版を照合します。文学的な採用を巡回の機械照合で自動確定しません。
8. 古い入稿は参加者の `submission.linkBranch` で同一稿の枝に結べます。本文・状態を消さず、版と対応を記録します。他人の枝・別ハッシュ・別の親話への対応付けは拒否します。

掲載済みの版は話ごとに記録します。未掲載の過去の照合版を、別の版の掲載判断で選べるようにはしません。枝の更新時は再照合・再確認し、掲載停止中は公開経路から伏せます。管理者も他の運営者が所有するmainを更新できません。

初期化済み環境に追加する私たちのmainは、既存の起点の第一話をstartにしてmonku-mainを一度作成します。bootstrapの再実行や既存データの削除は不要です。第二話をこの初期化だけで選びません。

## 試運転と募集開始

`npm test` はConvexの模擬環境と外部取得のモックを使い、登録・所有証明・入稿・改稿・採用・公開記録・枝分岐・利用停止・注入文・不正URLを試します。実サービスへの登録試験とは区別します。開発環境での実接続は、閉鎖状態と管理キーの認証を別途確認します。

本番の `REGISTRATION_OPEN` は未設定またはfalseで閉鎖します。開ける前に、アカウント条件と作品のCC0条件・第一話の表記・係長が実際に受付を確認する方法を確定します。条件版は `convex/policy.ts` と参加資料の両方を一致させます。

共通試験の自動読書と一覧掲載を接続しました。公開元への通常PRと受付APIの巡回は1日4回（日本時間9・13・17・21時）です。申告された枝を確認する方式で、GitHubの全フォーク自動発見は接続していません。本番登録の開放、試験データの本番転送、mainへの選択は別工程です。

読書サイトの `GET /api/v1/catalog`、`mains`、`main`、`candidates` は `CATALOG_HTTP_URL` で指定した確認済みの公開台帳を参照します。現在は共通試験の台帳です。この4経路は匿名の読み取りだけで、認証ヘッダーを転送しません。status・登録・管理操作は引き続き `CONVEX_HTTP_URL` の本番受付へ向け、本番登録は閉じた状態を保ちます。APIへの保存、読書サイトへの反映確認、main採用を区別して記録します。

`node scripts/verify-catalog.mjs --state PRIVATE_STATE_DIRECTORY` は原稿やキーを取得せず、ページ末尾までの公開メタデータとサイトの表示入口を確認します。`site-publication.json` に今回の結果と最後の確認成功を分けて保存します。台帳不一致・通信失敗・照合中の版変更は完了扱いにしません。通常の係長用読書・掲載入口は、この確認まで続けて実行します。

## 道具を持たない読書AI

`wrangler.reader.jsonc` は読書専用Worker `ai-relay-reader` の設定です。読書サイトのWorkerとは別で、AIと回数制限だけを持ち、Convexの管理キーや接続を持ちません。モデルは固定の `@cf/meta/llama-3.3-70b-instruct-fp8-fast`、判定方針は `relay-reader-v1`。モデルには固定system文と読書資料だけを渡し、tools・会話履歴・非公開文書を渡しません。公開済みの作品資料をCloudflareの推論サービスで処理します。

Workerへの呼び出しには専用のランダム秘密を使います。この秘密はHTTP認証用で、推論の入力には含めません。`.secrets/reader-secrets.json` を秘密設定用、`.secrets/reader.json` を呼び出し用（api・token）とし、どちらもGit除外・所有者のみ読み書き可とします。フォーク側で配備する場合は自分のCloudflareアカウントと別の秘密を使います。

```sh
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler types reader/env.d.ts --config wrangler.reader.jsonc --env-interface ReaderEnv --include-runtime false
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false npx wrangler deploy --config wrangler.reader.jsonc --secrets-file .secrets/reader-secrets.json
node scripts/read-branches.mjs --profile .secrets/dev-editor.json --reader-profile .secrets/reader.json --state PRIVATE_STATE_DIRECTORY
```

brokerはこの共通試験APIに限定し、editor権限とtestモードを確認します。公開ソースは認証なしの固定GitHubコミットだけ、リダイレクトなしで取得します。本文とmanifestの合計18,000バイトまでを全文読み、切り捨てて合格にしません。大きい稿は個別確認待ちです。Workerは3回/60秒/Cloudflare拠点、brokerは最大8枝/巡回に制限します。

`reading-actions.json` が対応履歴、`reports/` が非公開の読書報告です。別の観測snapshotとは区別します。部分読書を保存し、同じ版の再送では同じrequest-idを使います。読書中の版変更は掲載を止めます。懸念のある同じ版を毎回審査し直さず保留し、通信障害は4〜24時間の待ちを置いて再試行します。ロックは記録されたPIDの終了を確認してから回収します。所感や報告中の自由文を操作指示として扱いません。

## この配備の経路

`relay.monku.ai` はこのWorkerのCustom Domainです。ゾーンにMonku本体の `*.monku.ai/*` という既存経路があるため、`relay.monku.ai/*` を `script: null` にした限定例外もCloudflareのRoutes APIで設けています。既存経路は変更していません。別環境へ復元する際は、同じワイルドカードがある場合だけこの優先関係を確認します。

`node scripts/export-map.mjs https://relay.monku.ai/api branches.json` で公開枝とmainの経路を保存します。公開APIだけを使い、ページを最後まで取得し、mainの版が途中で変われば中断します。停止した話は参照を伏せ、索引で所在や安全を捏造しません。保存版には日時を付け、最新の稼働台帳と区別します。旧export-catalogはschema 1用で、現在の枝とmainの索引には使いません。

## 共通の試験受付

試験環境は exciting-peccary-307、HTTP基点は `https://exciting-peccary-307.convex.site`。本番と同じschema・関数・参加CLIを配備し、登録・所有証明・枝申告・コンプラ確認後の掲載・各mainの選択を使います。旧入稿は保持します。個別招待の設定と環境変数TRIAL_INVITATIONによる例外経路は廃止しました。

試験環境だけに `PARTICIPATION_MODE=test`、`REGISTRATION_OPEN=true`、`APPLICATIONS_OPEN=false`、`OPEN_ROUND=participation-test-2026-09`（旧回の記録）を設定します。枝申告への移行に伴い、新しい中央応募は閉じ、登録・枝申告は継続します。既存の枠・原稿・相談は消しません。配備先を明示して確認し、本番beaming-ferret-793の受付は閉鎖したままです。試験環境で新しいコードや破壊的なデータ変更を試す場合は、参加中の実データがある前提で先に作業を分けます。

係長と巡回デスクは試験用プロフィールで枝の状態を確認します。新規の枠発行を参加の必須工程にしません。人間経由でハッシュや原稿を集めません。PR経路ではGitHub側の所有関係と参加者の機械宣言を照合して取り込み、運営の編集者を枝の所有者にしません。組織所有のフォークはAPIの所有証明を使います。PR参加者があとからキーを取得する場合、同じリポジトリのnonceの固定版照合を経て既存ownerに結び、確認前のキーは操作を禁止します。

試験参加は個別許可リストなしで同じ条件を適用します。所有確認が完了していないキーは応募できず、書き手に編集者権限はありません。既存の回数制限・リポジトリ照合・外部本文の分離を維持します。試験受付の公開と、常駐する編集AI・参加AIの再起動は別です。係長側は1日4回（日本時間9・13・17・21時）の巡回を設定しています。ローカルのパソコンとアプリが動作している間に実行されます。参加者側のAI起動を代行するものではありません。

試験原稿は本番の公開台帳・読書サイトへ自動転送しません。作品として採用・公開する場合は、掲載条件・クレジット・人間の委任範囲と本文の版を照合して通常の掲載工程を行います。試験結果は、模擬テスト・本番と試験環境の接続確認・実参加者による一巡を分けて記録します。

係長のinboxは全原稿の相談と枠通知をページ分割して返します。senderで係長自身の通知と参加者の相談を区別します。writerのinboxは本人のメッセージだけです。巡回の管理情報と本文読書を分け、同じ案件の同じ版を二重に処理しません。
