// LIFF とバックエンドの設定
// 本ファイルはデプロイ環境ごとに書き換える(秘匿情報は含めない)
// API接続先は Cloudflare Worker (+D1)。LIFF_ID は本番（リッチメニューから開く）アプリ。
// 旧GAS: https://script.google.com/macros/s/AKfycbzqa17JDteHDQ1eo_HnSmwhY_Jo76nI5AmCeppmm1dKd6hSP8KHPW4Yd6aOZAZkDlk0Mg/exec
window.APP_CONFIG = {
  LIFF_ID: '2009988645-lL2iVTRT',
  GAS_URL: 'https://satooyakai-api.kashiye.workers.dev',
};
