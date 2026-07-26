// ゲスト用（児相など）の設定。LINEログインは使わず、共有パスコードで入る。
// 秘匿情報は含めない（合言葉は Worker の Secret 側）。
window.APP_CONFIG = {
  LIFF_ID: '2009988645-lL2iVTRT', // 通知の既定文リンク（liff.line.me）用
  GAS_URL: 'https://satooyakai-api.kashiye.workers.dev',
};
