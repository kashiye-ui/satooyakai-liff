// テスト専用LIFF（/preview/）の設定。本番（ルートの config.js）とは別物。
//
//  LIFF_ID : 新しく作る「テスト用LIFFアプリ」のID（本番とは別の新規LIFF）。
//            LINE Developers → 同じ「LINEログインチャネル」→ LIFF → 追加 →
//            エンドポイントURL = https://kashiye-ui.github.io/satooyakai-liff/preview/
//            scope: profile, openid → 発行されたLIFF IDをここに貼る。
//  GAS_URL : 本番と同じGASウェブアプリ（テストも本番と同じスプレッドシートに書き込む点に注意）。
window.APP_CONFIG = {
  LIFF_ID: '2009988645-lL2iVTRT',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzqa17JDteHDQ1eo_HnSmwhY_Jo76nI5AmCeppmm1dKd6hSP8KHPW4Yd6aOZAZkDlk0Mg/exec',
};
