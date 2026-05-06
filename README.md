# satooyakai-liff

さいたま市里親会 公式LINE 会員管理システム の **LIFF (LINE Front-end Framework) フロントエンド**。

GitHub Pages にデプロイされる静的ファイル一式です。

## 公開 URL

- LIFF アプリ(GitHub Pages): https://kashiye-ui.github.io/satooyakai-liff/
- LIFF URL(LINE で開く): `https://liff.line.me/{LIFF_ID}`

## ファイル構成

```
.
├── index.html      エントリ HTML
├── config.js       LIFF_ID / GAS_URL の設定(デプロイ前に書き換え)
├── app.js          画面遷移・API 呼び出しロジック
└── style.css       スタイル
```

## セットアップ

`config.js` を編集して、LINE Developers Console と GAS Web App の値を入れる。

```js
window.APP_CONFIG = {
  LIFF_ID: 'xxxxxxxxxx-xxxxxxxx',
  GAS_URL: 'https://script.google.com/macros/s/.../exec',
};
```

## デプロイ

`main` ブランチへの push が GitHub Pages に反映されます(リポジトリ Settings → Pages を参照)。

## 関連リポジトリ

- バックエンド (GAS) と仕様書: 別リポジトリ(Private)で管理
