# ニコ生風コメントオーバーレイ

OBS用のコメントオーバーレイサーバー。Node.js標準モジュールのみで動作(外部npmパッケージ依存ゼロ)。

## 機能

- ニコ生風・縦型コメント表示
- フォロワー数・閲覧数ヘッダー(ふわっち + Kick 同時表示)
- アンケート機能
- クイズ(ミリオネア風 + オーディエンス参加)
- トークのお題(Gemini APIによるAI生成)
- フォロワー目標 & プレゼント演出
- アイテムエフェクト
- コメントログ(永続保存)
- ルーレット機能(最大30項目・音付き)
- 配信統計(5分おきの閲覧数記録、配信ごとのフォロワー増減・タイトルを自動記録、カレンダー表示、期間指定グラフ)

## ローカルで起動する

```bash
npm install   # 依存パッケージはありませんが念のため実行
npm start     # または: node overlay_server.js
```

- コントロールドック: http://localhost:3941/dock
- オーバーレイ画面(ニコ生風): http://localhost:3941/overlay-nico
- オーバーレイ画面(縦型): http://localhost:3941/overlay-vertical
- 表示モード自動切り替え: http://localhost:3941/overlay-auto

Windowsでは `start.bat` をダブルクリックしても起動します。

Kick連携・Gemini連携を使う場合は `.env.example` を `.env` にコピーして値を入れてください(`.env` はgit管理対象外)。

## GitHubへのプッシュ

このフォルダはgit初期化・コミット済みです。GitHub上に空のリポジトリを作成後、以下でプッシュしてください。

```bash
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git branch -M main
git push -u origin main
```

`overlay_config.json` / `gift_log.json` / `stats_history.json` / `debug_*.json` / `.env` は `.gitignore` 済みのため、配信設定やAPIキー、コメント履歴、配信統計はリポジトリに含まれません。

## Renderへのデプロイ

1. https://render.com で「New +」→「Web Service」
2. プッシュ済みのGitHubリポジトリを選択
3. 設定:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
4. 「Environment」タブで環境変数を設定:
   - `KICK_CLIENT_ID`
   - `KICK_CLIENT_SECRET`
   - `GEMINI_API_KEY` (任意。未設定でもドックUIから後で入力可)
   - `PORT` は設定不要(Renderが自動的に注入し、サーバー側が自動で読み取ります)
5. Deployを実行

デプロイ後は `https://<サービス名>.onrender.com/dock` がコントロールドック、`https://<サービス名>.onrender.com/overlay-nico` などがOBSのブラウザソースURLになります。

`render.yaml` も同梱しているので、Render上で「Blueprint」からリポジトリを指定すればビルド/起動コマンドは自動設定されます(APIキー自体はダッシュボードで手動入力が必要です)。

## 注意点

- **設定の永続化**: `overlay_config.json` はgit管理外です。Render上では初回アクセス時にデフォルト値で作成され、ドックUIから設定した内容がその後のプロセス稼働中は保持されます。ただしRenderの無料/標準プランはディスクが永続化されないため、**再デプロイやサービス再起動のたびに設定・コメントログ・プレゼント履歴(`gift_log.json`)・配信統計(`stats_history.json`)がリセットされます**。
- **配信統計の手動バックアップ**: ドックの「配信統計」→「バックアップ(念のため)」から、いつでもJSONファイルに保存・復元できます(どのブラウザ・OBSのカスタムブラウザドックでも使えます)。下記のPersistent Diskを設定していれば通常はこの手動操作は不要です。
- **サーバー側で永続化する(Persistent Disk・有料)**: ブラウザ側のバックアップに頼らず、Renderのサーバー側だけで自動的にデータを残したい場合は以下の手順です。
  1. Renderのサービス画面で「Upgrade your instance」からStarterプラン以上に変更(Persistent DiskはFreeプランでは使えません。Starterは$7/月〜)
  2. サービス画面の「Disks」タブで「Add Disk」→ マウントパスを `/var/data` などに設定してディスクを追加(料金は $0.25/GB/月。1GBもあれば十分)
  3. 「Environment」タブで環境変数 `DATA_DIR` を追加し、値をマウントパスと同じ `/var/data` に設定
  4. 保存すると自動で再デプロイされ、以降は `overlay_config.json` / `gift_log.json` / `stats_history.json` がそのディスク上に保存され、再デプロイやサービス再起動をしても消えなくなります(起動ログに「データ保存先: /var/data(Persistent Disk)」と出れば成功)
  
  `DATA_DIR` を設定しない場合は今まで通りアプリ本体と同じ場所に保存されます(無料プランはここが再デプロイで消えます)。
- **公開URLのセキュリティ**: `/dock` や `/api/overlay/config` には認証がありません。URLを知っていれば誰でも配信設定を変更できてしまうため、公開後はURLを他人と共有しないでください。必要であればBasic認証やアクセストークンの追加を検討してください(要望があれば実装します)。
- **ふわっち/Kickのポーリング・WebSocket接続**: どちらも外部(Render)からそのまま動作します。
- **Kick APIキーについて**: `overlay_server.js` に直書きされていたクライアントID/シークレットは環境変数化しました。過去にこのリポジトリを一度も公開していなければ流出の心配はありませんが、念のため [Kick Developer](https://kick.com/developer) 側で必要に応じてローテーションすることをおすすめします。

## 既知の未解決課題

- ドックの「ふわっち/Kickのヘッダー表示チェックボックス」をOFFにしても表示が消えない問題(調査未着手、優先度低)。
