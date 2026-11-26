<p align="center"><img src="src/client/favicon.png" height="200" alt="Horizon Browser"></p>

<h1 align="center">Horizon Browser</h1>

UltraVioletを使用したプロキシブラウザ。タブ、履歴、ブックマーク、設定、検索、キーボードショートカットを備えた実用的なプロキシです。

---

## Links

- [https://horizon-browser.cc.cd:25188/](https://horizon-browser.cc.cd:25188/)
- [https://horizon.myaddr.tools:25188/](https://horizon.myaddr.tools:25188/)
- [https://horizon-browser.mytunnel.org:25188/](https://horizon-browser.mytunnel.org:25188/)

## 機能

- ドラッグ操作によるタブの並べ替え、ミドルクリックによるタブの閉じる操作、タブの複製、閉じたタブの再表示に対応したマルチタブブラウジング
- 履歴やブックマークの候補表示、カスタム検索エンジン、URLの正規化に対応したアドレスバー
- 戻る／進む／再読み込み／読み込み停止、読み込み進捗表示、オフライン状態およびページエラー状態への対応
- ブックマーク、最近の閲覧履歴、検索機能を備えた新しいタブページ
- ブックマークバー、ブックマーク管理機能、全文検索による絞り込みが可能な閲覧履歴
- ページ内検索、タブごとのズーム機能、フルスクリーン表示
- セッション復元、ダーク／ライト／システム設定テーマ、スマートフォンやタブレットに対応したレスポンシブレイアウト
- ブックマーク、閲覧履歴、設定情報のJSON形式でのインポート／エクスポート
- すべての通信は、同梱されているUltraviolet Service WorkerおよびEpoxy/Wispトランスポートを経由

## プロジェクト構成

- `src/index.js` — Expressサーバー、ファビコンのプロキシ、静的ファイルのルーティング
- `src/client/` — ブラウザーのUI、記事ページ、フロントエンド関連のアセット
- `src/client/credits-content.html` — ライセンスおよびクレジットページのソースファイル
- `public/sites/index` — 数秒後に読み込まれるBase64エンコード済みページ

`/` と `/credits.html` は、どちらも最初に記事ページを表示します。

ルートページは `sites/index` を取得し、`/credits.html` は `sites/credits` を取得します。

各データは、表示前にUTF-8のBase64形式からデコードされます。

リクエストまたはデコードに失敗した場合は、記事ページをそのまま表示し、再試行できるようにします。

## 遅延読み込みページのビルド（Building the delayed page）

以下のコマンドを実行します。

```bash
npm run build
```

デフォルトでは、次の2つのページデータがビルドされます。

- `src/client/browser.html` → `public/sites/index`
- `src/client/credits-content.html` → `public/sites/credits`

単一のページだけをビルドする場合は、入力ファイルのパスを指定します。

出力先を指定しない場合、`public/sites/index` に書き込まれます。

```bash
npm run build -- path/to/page.html
npm run build -- path/to/page.html public/sites/credits
```

出力ファイルはアトミックに書き込まれ、必要に応じて `public/sites` ディレクトリが自動作成されます。

`/sites/index` と `/sites/credits` はExpressによって `public` ディレクトリから直接配信され、Ultravioletを経由することはありません。

## HTTPS

標準ではHTTPで起動します。次のいずれかの方法でHTTPSを有効にできます。

- `HTTPS_KEY_PATH` と `HTTPS_CERT_PATH` に秘密鍵・証明書（フルチェーン）のパスを指定する
- `HTTPS_KEY` と `HTTPS_CERT` にPEM本文を直接指定する
- `HTTPS_CERTIFICATE_DIR`（既定は `/etc/lego-production/certificates`）を指定するか、そのディレクトリが存在する場合はlego形式の証明書を自動で読み込む

`TLS_KEY_PATH` / `TLS_CERT_PATH`、`SSL_KEY_PATH` / `SSL_CERT_PATH` などの別名にも対応しています。

```bash
HTTPS_KEY_PATH=/path/to/privkey.pem \
HTTPS_CERT_PATH=/path/to/fullchain.pem \
PORT=25188 \
npm start
```

### 複数の証明書

1つのポートで複数ドメインを受ける場合、SNIでホスト名ごとに証明書を選び分けます。

**lego形式のディレクトリ**（`<ドメイン>/<ドメイン>.key` と `fullchain.pem` または `.crt`）を配置するだけで、すべてのドメインが自動的に読み込まれます。

```text
/etc/lego-production/certificates/
├── horizon.myaddr.tools/
│   ├── horizon.myaddr.tools.key
│   └── fullchain.pem
└── app.horizon-browser.cc.cd/
    ├── app.horizon-browser.cc.cd.key
    └── fullchain.pem
```

**任意の場所の証明書**を使う場合は、鍵と証明書を同じ順序のリストで指定します。

```bash
HTTPS_KEY_PATHS=/path/a.key,/path/b.key \
HTTPS_CERT_PATHS=/path/a-fullchain.pem,/path/b-fullchain.pem \
npm start
```

- 各証明書はホスト名（SAN、なければCN）で照合され、該当する証明書が返されます
- 重複・ワイルドカードのホスト名は、先に読み込まれた証明書が優先されます
- 秘密鍵と証明書が一致しない場合、またはリストの件数が異なる場合は起動エラーになります
- SNIがない接続には最初の証明書が返されます

### 証明書の再読み込み

`SIGHUP` を受けると、プロセスを再起動せずに証明書を読み直します（同じポートで新しいリスナを立ててから切り替えるため、接続は途切れません）。証明書を自動更新する場合は、更新後に次のように通知します。

```bash
kill -HUP "$(pgrep -f 'node src/index.js' | head -1)"
```

### その他の設定

- `HTTPS=1`：HTTPSを必須にする（証明書がない場合は起動エラー）
- `HTTPS=0`：証明書が設定されていてもHTTPで起動する
- `HOST`：待ち受けアドレス（既定は `0.0.0.0`）

HTTPSを有効にすると、WispのWebSocketも自動的に `wss://` を使用します。HTTPSモードではHTTPSのみで待ち受け、HTTPからの自動リダイレクトは行いません。リバースプロキシやPaaS側でTLS終端する環境では、HTTPのまま起動してください。

## キーボードショートカット（Keyboard shortcuts）

| 操作                               | ショートカット               |
| ---------------------------------- | ---------------------------- |
| アドレスバーにフォーカス           | `Ctrl` + `L`                 |
| 新しいタブを開く／タブを閉じる     | `Ctrl` + `T` ／ `Ctrl` + `W` |
| 閉じたタブを再度開く               | `Ctrl` + `Shift` + `T`       |
| 戻る／進む                         | `Alt` + `←` ／ `Alt` + `→`   |
| ページを再読み込み                 | `Ctrl` + `R` または `F5`     |
| ページをブックマークに追加         | `Ctrl` + `D`                 |
| ページ内検索                       | `Ctrl` + `F`                 |
| 閲覧履歴を開く                     | `Ctrl` + `H`                 |
| ズームイン／ズームアウト／リセット | `Ctrl` + `+` ／ `-` ／ `0`   |
| ブックマークバーの表示／非表示     | `Ctrl` + `Shift` + `B`       |
| フルスクリーン表示                 | `F11`                        |

## インストールと起動

依存関係をインストールするには、以下を実行します。

bash

```bash
npm install
```

アドレス解析のユニットテストを実行するには、以下を実行します。

bash

```bash
node test/url.test.js
```

アプリケーションを起動するには、以下を実行します。

bash

```bash
npm start
```

アプリケーションは、HTTPSの設定がない場合はポート `8080` でHTTP起動します。

別のポートを使用する場合は、例えば次のように指定します。

bash

```bash
PORT=8099 npm start
```
