// テスト専用LIFF（/preview/）の設定。本番（ルートの config.js）とは別物。
//
//  LIFF_ID : 新しく作る「テスト用LIFFアプリ」のID（本番とは別の新規LIFF）。
//            LINE Developers → 同じ「LINEログインチャネル」→ LIFF → 追加 →
//            エンドポイントURL = https://kashiye-ui.github.io/satooyakai-liff/preview/
//            scope: profile, openid → 発行されたLIFF IDをここに貼る。
//  GAS_URL : APIの接続先。移行検証のため Cloudflare Worker (+D1) を指している。
//            ※フロントは項目名 GAS_URL を「APIのURL」として使うだけなので値の中身は何でもよい。
//            元の本番GAS: https://script.google.com/macros/s/AKfycbzqa17JDteHDQ1eo_HnSmwhY_Jo76nI5AmCeppmm1dKd6hSP8KHPW4Yd6aOZAZkDlk0Mg/exec
window.APP_CONFIG = {
  LIFF_ID: '2009988645-lL2iVTRT',
  GAS_URL: 'https://satooyakai-api.kashiye.workers.dev',
};
