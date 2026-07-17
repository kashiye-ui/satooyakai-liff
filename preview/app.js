/**
 * さいたま市里親会 LIFF 会員登録アプリ
 *
 * 画面遷移:
 *   loading → agreement → choose → newHousehold → newMember(代表者)
 *                                 → searchHousehold → joinConfirm → joinMember → done
 *   loading → home (登録済み)
 */

const KU_OPTIONS = [
  '西区', '北区', '大宮区', '見沼区', '中央区',
  '桜区', '浦和区', '南区', '緑区', '岩槻区',
];
const FOSTER_TYPES = ['養育里親', '養子縁組里親', '親族里親', '専門里親', 'その他'];
const JOIN_ROLES = ['配偶者', '子ども', '同居家族', 'その他'];

// 同意取得時の文書バージョン（terms.html / privacy.html の版と一致させること）
const TERMS_VERSION = 'v0.2';
const PRIVACY_VERSION = 'v0.2';

const state = {
  profile: null,
  idToken: null,
  // 入力中データ
  agreedTerms: false,
  agreedPrivacy: false,
  newHousehold: null, // { ku, lastName, firstName, phone, fosterType }
  joinHousehold: null, // 検索ヒット結果
  events: null,        // listEvents の結果キャッシュ
  adminRoster: null,   // 管理: 行事名簿 { eventId, event, rows }
  adminEvents: null,   // 管理: 行事一覧（編集フォーム用）
  adminFees: null,     // 管理: 会費 { fiscalYear, households, unpaidOnly }
  adminMaterials: null,// 管理: 資料一覧
  isGuest: false,      // ゲスト（児相・共有パスコード）でログイン中か
  matView: { q: '', filter: 'all', sort: 'date' },   // 資料の絞り込み・並べ替え
  evtView: { q: '', filter: 'all', sort: 'date' },   // 行事の絞り込み・並べ替え
};

// ===== 一覧の検索＋絞り込みチップ＋並べ替えバー（資料・行事で共用） =====
// opts: { view, filters:[{key,label,cls}], sorts:[{key,label}], placeholder, onChange }
function listControlsHtml(opts) {
  const v = opts.view;
  const chips = opts.filters.map(f =>
    `<button class="fchip${v.filter === f.key ? ' sel' : ''}${f.cls ? ' ' + f.cls : ''}" data-f="${f.key}">${escapeHtml(f.label)}</button>`).join('');
  const sorts = opts.sorts.map(s =>
    `<option value="${s.key}" ${v.sort === s.key ? 'selected' : ''}>${escapeHtml(s.label)}</option>`).join('');
  return `
    <div class="toolbar">
      <span style="position:relative;flex:1 1 200px;display:flex;align-items:center">
        <span style="position:absolute;left:10px;color:var(--muted);display:flex">${icon('search')}</span>
        <input class="search-input" id="lc-q" style="padding-left:32px;flex:1" placeholder="${escapeHtml(opts.placeholder || '検索…')}" value="${escapeAttr(v.q)}">
      </span>
      <select class="sortselect" id="lc-sort">${sorts}</select>
    </div>
    <div class="filterbar" id="lc-filters">${chips}</div>`;
}
// onChange は「一覧部分だけ」を再描画する。検索欄・チップ自体は作り直さないので
// 入力中にフォーカスが外れない。
function wireListControls(opts) {
  const v = opts.view;
  const q = document.getElementById('lc-q');
  if (q) q.oninput = () => { v.q = q.value; opts.onChange(); };
  const sort = document.getElementById('lc-sort');
  if (sort) sort.onchange = () => { v.sort = sort.value; opts.onChange(); };
  document.querySelectorAll('#lc-filters .fchip').forEach(b => {
    b.onclick = () => {
      v.filter = b.dataset.f;
      document.querySelectorAll('#lc-filters .fchip').forEach(x => x.classList.toggle('sel', x === b));
      opts.onChange();
    };
  });
}
// 検索語の一致（タイトル・カテゴリ等の連結文字列に対して）
function matchQuery(q, text) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return true;
  return String(text || '').toLowerCase().includes(s);
}

const $app = document.getElementById('app');

// ===== 起動 =====
async function init() {
  // ゲスト用URL（児相など）：LINEを使わず、共有パスコードで管理画面に入る
  if (window.GUEST_MODE) return initGuest();
  try {
    await liff.init({ liffId: window.APP_CONFIG.LIFF_ID });
  } catch (e) {
    return renderError('LIFFの初期化に失敗しました', e.message);
  }
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  try {
    state.profile = await liff.getProfile();
    state.idToken = liff.getIDToken();
  } catch (e) {
    return renderError('プロフィール取得に失敗しました', e.message);
  }

  // PC等で古い（期限切れの）IDトークンが残っていると invalid_token になる。
  // その場合はログインし直してトークンを取り直す（ループ防止フラグ付き）。
  if (tokenLooksExpired(state.idToken)) {
    if (reauthFlagGet()) {
      reauthFlagSet(false);
      return renderError('ログイン情報の更新に失敗しました',
        'お手数ですが、LINEでこのページを開き直してください。解決しない場合は管理者へご連絡ください。\n[診断] ' + tokenDiag());
    }
    return reauthRedirect(); // リダイレクト（戻ってこない）
  }

  // 管理画面は登録の有無に関わらず、許可されたLINEユーザーのみ（認可はGAS側で検証）
  if (getView() === 'admin') {
    return renderAdmin();
  }

  const result = await callApi('checkUser', {});
  if (result.error === 'invalid_token') {
    return renderError('ログインの確認に失敗しました',
      'LINEでこのページを開き直してください。解決しない場合は管理者へご連絡ください。\n[診断] ' + tokenDiag());
  }
  if (result.ok && result.registered) {
    if (result.pending) return renderPending(result); // 承認待ちは内容を見せない
    routeByView(result);
  } else {
    // 未登録の場合は、どのビューで開かれても先に同意・登録を行う
    renderAgreement();
  }
}

// リッチメニュー等から渡される ?view= に応じて画面を振り分ける（登録済みユーザー向け）
function routeByView(homeData) {
  const view = getView();
  if (view === 'events') return renderEvents();
  if (view === 'docs') return renderDocs();
  return renderHome(homeData);
}

// view パラメータを取得する。LIFF は元のクエリを liff.state に退避することがあるため両方を見る。
function getView() {
  try {
    const qs = new URLSearchParams(location.search);
    const direct = qs.get('view');
    if (direct) return direct;
    const liffState = qs.get('liff.state');
    if (liffState) {
      const inner = new URLSearchParams(liffState.replace(/^\?/, ''));
      const v = inner.get('view');
      if (v) return v;
    }
  } catch (e) { /* noop */ }
  return 'mypage';
}

// ===== ゲスト（児相など・共有パスコード）ログイン =====
async function initGuest() {
  document.body.classList.add('lean');
  let saved = null;
  try { saved = sessionStorage.getItem('kl_guest'); } catch (e) { /* noop */ }
  if (saved) {
    state.idToken = 'guest:' + saved;
    const r = await callApi('adminCheck', {});
    if (r.ok && r.isAdmin) { state.isGuest = true; return renderAdminHome(); }
  }
  renderGuestLogin('');
}

function renderGuestLogin(msg) {
  $app.innerHTML = `
    <section class="screen">
      <h1>${icon('lock')} ゲスト用ログイン</h1>
      <p class="muted">さいたま市里親会 管理ページ（児童相談所むけ）。合言葉を入力してください。</p>
      ${msg ? `<div class="card warn"><p>${escapeHtml(msg)}</p></div>` : ''}
      <label>合言葉（パスコード）</label>
      <input id="g-code" type="password" autocomplete="off">
      <div class="actions"><button class="btn primary" id="g-login">入る</button></div>
    </section>`;
  const submit = async () => {
    const code = document.getElementById('g-code').value.trim();
    if (!code) { alert('合言葉を入力してください。'); return; }
    state.idToken = 'guest:' + code;
    const r = await callApi('adminCheck', {});
    if (r.ok && r.isAdmin) {
      try { sessionStorage.setItem('kl_guest', code); } catch (e) { /* noop */ }
      state.isGuest = true; renderAdminHome();
    } else {
      try { sessionStorage.removeItem('kl_guest'); } catch (e) { /* noop */ }
      renderGuestLogin('合言葉が違うようです。もう一度お試しください。');
    }
  };
  document.getElementById('g-login').onclick = submit;
  document.getElementById('g-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// マイページ（ホーム）へ戻る。最新の登録状態を取り直して表示する。
async function goHome() {
  rememberAdmin(null); // 管理画面から離れるので記憶クリア
  if (window.GUEST_MODE) return renderAdminHome(); // ゲストは会員マイページを持たない
  const result = await callApi('checkUser', {});
  if (result.ok && result.registered) {
    if (result.pending) return renderPending(result);
    renderHome(result);
  } else {
    renderAgreement();
  }
}

// 承認待ち画面（登録済みだが管理者承認前）
function renderPending(data) {
  const m = data.member || {};
  const h = data.household || {};
  $app.innerHTML = `
    <section class="screen">
      <h1>承認をお待ちください</h1>
      <div class="card">
        <p>ご登録ありがとうございます。</p>
        <p>現在、運営（理事）の<strong>承認待ち</strong>です。承認されると、イベントや資料をご利用いただけます。</p>
      </div>
      <div class="card">
        <p><strong>${escapeHtml(m.name || '')}</strong> さん</p>
        <p class="muted">${escapeHtml(h.ku || '')} ${escapeHtml(h.representativeName || '')} の世帯</p>
      </div>
      <p class="muted">しばらくしてから、もう一度開いてご確認ください。</p>
      <button class="btn" id="reload-btn">最新の状態に更新</button>
    </section>
  `;
  document.getElementById('reload-btn').onclick = goHome;
}

// 再ログイン中フラグ（無限リダイレクト防止）。sessionStorage が無い環境でも壊れないようにする。
const REAUTH_KEY = 'kl_reauth';
function reauthFlagGet() { try { return sessionStorage.getItem(REAUTH_KEY) === '1'; } catch (e) { return false; } }
function reauthFlagSet(on) { try { on ? sessionStorage.setItem(REAUTH_KEY, '1') : sessionStorage.removeItem(REAUTH_KEY); } catch (e) { /* noop */ } }

// IDトークン(JWT)の有効期限(ミリ秒)。読めなければ 0。
function decodeJwtExpMs(token) {
  try {
    let b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b.length % 4; if (pad) b += '===='.slice(pad);
    const obj = JSON.parse(decodeURIComponent(escape(atob(b))));
    return obj && obj.exp ? obj.exp * 1000 : 0;
  } catch (e) { return 0; }
}
// 期限切れ/欠落か。exp が読めない場合はサーバ判定に委ねる（false）。
function tokenLooksExpired(token) {
  if (!token) return true;
  const exp = decodeJwtExpMs(token);
  if (!exp) return false;
  return Date.now() >= exp - 60000; // 期限60秒前で切れ扱い
}
// 再ログインしてIDトークンを取り直す（同じURLへ戻る）。リダイレクトするので以降は実行されない。
// liff.login() はログイン済みだと何もしないことがあるため、一度ログアウトしてから強制的に再ログインする。
function reauthRedirect() {
  reauthFlagSet(true);
  try { if (liff.isLoggedIn && liff.isLoggedIn()) liff.logout(); } catch (e) { /* noop */ }
  liff.login({ redirectUri: location.href });
}

// 診断用：ログイン状態とトークンの様子を1行で返す（原因切り分け用）。
function tokenDiag() {
  let loggedIn = '?';
  try { loggedIn = String(liff.isLoggedIn()); } catch (e) { /* noop */ }
  const t = state.idToken;
  const len = t ? ('len=' + t.length) : 'null';
  let expStr = '-';
  if (t) { const ms = decodeJwtExpMs(t); expStr = ms ? new Date(ms).toLocaleString() : 'exp無'; }
  return `login=${loggedIn} / token=${len} / exp=${expStr} / now=${new Date().toLocaleString()}`;
}

async function callApi(action, payload) {
  try {
    // Content-Type ヘッダーを指定しないことで preflight (OPTIONS) を回避する。
    // GAS Web App は OPTIONS をサポートしないため、CORS preflight が発生するとエラーになる。
    // body を文字列として渡すと、ブラウザは Content-Type を text/plain で送信する。
    const res = await fetch(window.APP_CONFIG.GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ action, idToken: state.idToken, payload }),
    });
    const data = await res.json();
    if (data && data.error === 'invalid_token') {
      if (window.GUEST_MODE) return data; // ゲストは合言葉違い→呼び出し側で処理（LINE再ログインしない）
      // トークンが弾かれた。未試行なら再ログインで取り直す（PC等の期限切れ対策）。
      if (!reauthFlagGet()) { reauthRedirect(); return await new Promise(() => {}); }
      // 再ログイン後も弾かれる＝設定不一致等。ループせずそのまま返す。
      return data;
    }
    reauthFlagSet(false); // トークンが受理されたので再ログインフラグ解除
    return data;
  } catch (e) {
    console.error('callApi failed', e);
    return { ok: false, error: 'network_error' };
  }
}

// ===== 画面: ホーム =====
function renderHome(data) {
  const m = data.member || {};
  const h = data.household || {};
  $app.innerHTML = `
    <section class="screen">
      <h1>さいたま市里親会 マイページ</h1>
      <p>${escapeHtml(m.name || '')} さん、こんにちは。</p>
      <div class="card">
        <p><strong>世帯ID:</strong> ${escapeHtml(h.householdId || '')}</p>
        <p><strong>世帯代表者:</strong> ${escapeHtml(h.representativeName || '')}</p>
        <p><strong>区:</strong> ${escapeHtml(h.ku || '')}</p>
        <p><strong>あなたのお立場:</strong> ${escapeHtml(m.role || '')}</p>
      </div>

      <button class="card-btn cat-event" id="nav-events">
        <span class="cat-ic">${icon('calendar', 'ic-lg')}</span>
        <span class="cat-tx"><strong>行事・申込</strong><span>行事の案内・出欠の回答・参加履歴</span></span>
      </button>
      <button class="card-btn cat-docs" id="nav-docs">
        <span class="cat-ic">${icon('book', 'ic-lg')}</span>
        <span class="cat-tx"><strong>お役立ち資料</strong><span>しおり・会報・総会資料・Q&amp;A</span></span>
      </button>

      ${data.isAdmin ? `
      <button class="card-btn cat-admin" id="nav-admin">
        <span class="cat-ic">${icon('admin', 'ic-lg')}</span>
        <span class="cat-tx"><strong>管理メニュー</strong><span>運営・理事用（会員名簿・行事・会費・資料）</span></span>
      </button>` : ''}

      <p class="muted">ご家族も、それぞれのLINEから「家族として参加」でご登録いただけます。</p>
    </section>
  `;
  document.body.classList.remove('lean'); // 会員向けは温かい背景のまま
  document.getElementById('nav-events').onclick = renderEvents;
  document.getElementById('nav-docs').onclick = renderDocs;
  if (data.isAdmin) {
    document.getElementById('nav-admin').onclick = renderAdmin;
  }
}

// ===== 画面: イベント一覧 =====
// 多段階料金（区分ごとの料金表）を持つ行事か
function isMultiTier(ev) { return !!(ev && ev.feeSchedule && Array.isArray(ev.feeSchedule.tiers)); }

function feeText(e) {
  if (isMultiTier(e)) return '参加費：区分・人数によって異なります';
  if (e.adultFee === 0 && e.childFee === 0) return '参加費：無料';
  return `参加費：大人 ${e.adultFee.toLocaleString()}円 / 子ども ${e.childFee.toLocaleString()}円`;
}

// 出欠フォームの人数入力欄（多段階 or 2区分）の本文HTMLを返す
function feeFormBody(ev, cur) {
  cur = cur || {};
  if (isMultiTier(ev)) {
    const fs = ev.feeSchedule;
    const counts = (cur.breakdown && cur.breakdown.counts) || {};
    const isFHB = cur.breakdown ? !!cur.breakdown.isFHB : false;
    const fhbBlock = fs.fhb ? `
      <label class="check"><input type="checkbox" id="fhb" ${isFHB ? 'checked' : ''}> ${escapeHtml(fs.fhbLabel || 'ファミリーホーム')}（料金が変わります）</label>` : '';
    const tierInputs = fs.tiers.map(t => `
      <label>${escapeHtml(t.label)} の人数</label>
      <input class="tier-input" data-key="${escapeAttr(t.key)}" type="number" inputmode="numeric" min="0" value="${counts[t.key] != null ? counts[t.key] : 0}">`).join('');
    return `
      ${fhbBlock}
      ${tierInputs}
      <p class="hint">参加されない区分は 0 のままにしてください。措置児は無料です。</p>
      <div class="card"><p><strong>参加費合計：<span id="fee-total">0</span>円</strong></p></div>`;
  }
  return `
    <label>参加する大人の人数 <span class="req">*</span></label>
    <input id="adult" type="number" inputmode="numeric" min="0" value="${cur.adultCount != null ? cur.adultCount : 1}">
    <label>参加する子どもの人数 <span class="req">*</span></label>
    <input id="child" type="number" inputmode="numeric" min="0" value="${cur.childCount != null ? cur.childCount : 0}">`;
}

// 多段階の現在値（合計・区分人数・FHB）を画面から読む
function computeMultiTier(ev) {
  const fs = ev.feeSchedule;
  const isFHB = document.getElementById('fhb') ? document.getElementById('fhb').checked : false;
  let total = 0; const counts = {};
  document.querySelectorAll('.tier-input').forEach(inp => {
    const key = inp.dataset.key;
    const n = parseInt(inp.value, 10) || 0;
    counts[key] = n;
    const t = fs.tiers.find(x => x.key === key);
    const price = (isFHB && fs.fhb && t && t.feeB != null) ? t.feeB : (t ? t.fee : 0);
    total += n * (Number(price) || 0);
  });
  return { total, counts, isFHB };
}

// 合計の即時表示を配線する
function wireFeeInputs(ev) {
  if (!isMultiTier(ev)) return;
  const update = () => {
    const el = document.getElementById('fee-total');
    if (el) el.textContent = computeMultiTier(ev).total.toLocaleString();
  };
  document.querySelectorAll('.tier-input').forEach(i => { i.oninput = update; });
  const fhb = document.getElementById('fhb');
  if (fhb) fhb.onchange = update;
  update();
}

// 出欠フォームの入力を送信用 payload に変換（不正なら null＋alert）
function readAttendancePayload(ev) {
  const notes = (document.getElementById('notes').value || '').trim();
  if (isMultiTier(ev)) {
    const { counts, isFHB } = computeMultiTier(ev);
    const sum = Object.keys(counts).reduce((a, k) => a + (counts[k] || 0), 0);
    if (sum <= 0) { alert('参加する人数を入力してください（欠席の場合はこの行事は申込不要です）。'); return null; }
    return { eventId: ev.eventId, breakdown: { isFHB, counts }, notes };
  }
  const adultCount = parseInt(document.getElementById('adult').value, 10);
  const childCount = parseInt(document.getElementById('child').value, 10);
  if (isNaN(adultCount) || isNaN(childCount) || adultCount < 0 || childCount < 0) {
    alert('参加人数を正しく入力してください。'); return null;
  }
  return { eventId: ev.eventId, adultCount, childCount, notes };
}

async function renderEvents() {
  $app.innerHTML = `<section class="screen"><h1>イベント</h1><p>読み込み中...</p></section>`;
  const res = await callApi('listEvents', {});
  if (!res.ok) return renderActionError('イベント', res.error);
  state.events = res.events || [];

  const open = state.events.filter(e => e.status === '募集中');
  const past = state.events.filter(e => e.status !== '募集中');

  // ひもづいた資料（案内・しおり等）をタップで開ける導線に
  const eventDocs = (e) => (e.materials && e.materials.length)
    ? `<div class="docrow">${e.materials.map(d => `<button class="chip evt-doc" data-mid="${escapeAttr(d.id)}">${icon('book')} ${escapeHtml(d.title)}</button>`).join('')}</div>`
    : '';

  const openCard = (e) => `
    <div class="card">
      <p><strong>${escapeHtml(e.name)}</strong>${e.signup === 'external' ? ' ' + statusBadge('hold', '案内のみ') : ''}</p>
      <p class="muted">${escapeHtml(e.date)}${e.place ? ' ／ ' + escapeHtml(e.place) : ''}</p>
      <p class="muted">${feeText(e)}${e.deadline ? ' ／ 申込締切 ' + escapeHtml(e.deadline) : ''}</p>
      ${eventDocs(e)}
      ${e.signup === 'external'
        ? '<p class="muted">お申し込み・お問い合わせは、上の案内をご覧ください。</p>'
        : `${e.myResponse ? `<p>${statusBadge('ok', '回答済み')} 大人 ${e.myResponse.adultCount}名・子ども ${e.myResponse.childCount}名${e.myResponse.total > 0 ? '（参加費 ' + e.myResponse.total.toLocaleString() + '円）' : ''}</p>` : ''}
      <button class="btn primary act" data-id="${escapeAttr(e.eventId)}">${e.myResponse ? '回答を変更する' : '出欠を回答する'}</button>`}
    </div>`;

  const pastCard = (e) => `
    <div class="card">
      <p><strong>${escapeHtml(e.name)}</strong> ${statusBadge(eventStatusKind(e.status), e.status)}</p>
      <p class="muted">${escapeHtml(e.date)}${e.place ? ' ／ ' + escapeHtml(e.place) : ''}</p>
      ${eventDocs(e)}
      ${e.myResponse ? `<p>参加：大人 ${e.myResponse.adultCount}名・子ども ${e.myResponse.childCount}名</p>` : ''}
    </div>`;

  document.body.classList.remove('lean');
  $app.innerHTML = `
    <section class="screen">
      ${topBar('行事・申込', 'マイページ')}
      <h1>行事・申込</h1>
      <h2 class="sub">受付中の行事</h2>
      ${open.length ? open.map(openCard).join('') : '<p class="muted">現在、受付中の行事はありません。</p>'}
      ${past.length ? `<h2 class="sub">過去の行事</h2>${past.map(pastCard).join('')}` : ''}
      <button class="btn back" id="home-btn" style="margin-top:24px;">‹ マイページ</button>
    </section>
  `;
  document.getElementById('topback').onclick = goHome;
  document.getElementById('home-btn').onclick = goHome;
  document.querySelectorAll('button.act').forEach(b => {
    b.onclick = () => {
      const ev = (state.events || []).find(e => e.eventId === b.dataset.id);
      if (ev) renderAttendanceForm(ev);
    };
  });
  document.querySelectorAll('button.evt-doc').forEach(b => {
    b.onclick = async () => {
      const res = await callApi('materialUrl', { id: b.dataset.mid });
      if (res.ok && res.url) { openUrl(res.url, true); }
      else { alert('資料を開けませんでした：' + (res.error || 'unknown')); }
    };
  });
}

// ===== 画面: 出欠回答フォーム =====
function renderAttendanceForm(ev) {
  const r = ev.myResponse || {};
  $app.innerHTML = `
    <section class="screen">
      <h1>出欠の回答</h1>
      <div class="card">
        <p><strong>${escapeHtml(ev.name)}</strong></p>
        <p class="muted">${escapeHtml(ev.date)}${ev.place ? ' ／ ' + escapeHtml(ev.place) : ''}</p>
        <p class="muted">${feeText(ev)}</p>
      </div>

      ${feeFormBody(ev, r)}

      <label>特記事項（アレルギー等・任意）</label>
      <input id="notes" type="text" value="${escapeAttr(r.notes)}">

      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">この内容で回答</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderEvents;
  wireFeeInputs(ev);
  document.getElementById('submit-btn').onclick = async () => {
    const payload = readAttendancePayload(ev);
    if (!payload) return;
    const res = await callApi('submitAttendance', payload);
    if (res.ok) {
      renderAttendanceDone(ev, res);
    } else {
      alert('回答の送信に失敗しました：' + (res.error || 'unknown'));
    }
  };
}

function renderAttendanceDone(ev, res) {
  $app.innerHTML = `
    <section class="screen">
      <h1>回答を受け付けました</h1>
      <div class="card">
        <p><strong>${escapeHtml(ev.name)}</strong></p>
        <p>${res.updated ? '回答を更新しました。' : '回答を登録しました。'}</p>
        ${res.total != null ? `<p>参加費合計：${Number(res.total).toLocaleString()}円</p>` : ''}
      </div>
      <button class="btn primary" id="back-btn">イベント一覧へ</button>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderEvents;
}

// ===== 画面: お役立ち資料 =====
async function renderDocs() {
  $app.innerHTML = `<section class="screen"><h1>お役立ち資料</h1><p>読み込み中...</p></section>`;
  const res = await callApi('listMaterials', {});
  if (!res.ok) return renderActionError('お役立ち資料', res.error);
  const mats = res.materials || [];

  let body;
  if (!mats.length) {
    body = '<p class="muted">現在、公開されている資料はありません。</p>';
  } else {
    const groups = {};
    mats.forEach(m => { (groups[m.category || 'その他'] = groups[m.category || 'その他'] || []).push(m); });
    // カテゴリ順（イベント→会報→…）に並べ、一覧外カテゴリは末尾
    const cats = Object.keys(groups).sort((a, b) => {
      const ia = MATERIAL_CATEGORIES.indexOf(a), ib = MATERIAL_CATEGORIES.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    body = cats.map(cat => {
      const c = CATEGORY_COLORS[cat] || CATEGORY_COLORS['その他'];
      const ic = categoryIcon(cat);
      return `
      <h2 class="sub">${categoryChip(cat)}</h2>
      ${groups[cat].map(m => `
        <button class="card-btn cat-docs doc-link" data-id="${escapeAttr(m.id)}" style="background:${c[0]};border-left-color:${c[1]}">
          <span class="cat-ic" style="color:${c[1]}">${icon(ic, 'ic-lg')}</span>
          <span class="cat-tx"><strong style="color:${c[1]}">${escapeHtml(m.title)}</strong>${isNewMaterial(m) ? ' ' + newBadge() : ''}<span>${escapeHtml(m.publishedAt || '')}</span></span>
        </button>`).join('')}`;
    }).join('');
  }

  document.body.classList.remove('lean');
  $app.innerHTML = `
    <section class="screen">
      ${topBar('お役立ち資料', 'マイページ')}
      <h1>お役立ち資料</h1>
      ${body}
      <button class="btn back" id="home-btn" style="margin-top:24px;">‹ マイページ</button>
    </section>
  `;
  document.getElementById('topback').onclick = goHome;
  document.getElementById('home-btn').onclick = goHome;
  document.querySelectorAll('button.doc-link').forEach(b => {
    b.onclick = async () => {
      // 承認会員にだけ、開けるURL（R2は署名付き）を発行してから開く
      const res = await callApi('materialUrl', { id: b.dataset.id });
      if (res.ok && res.url) { openUrl(res.url, true); }
      else { alert('資料を開けませんでした：' + (res.error || 'unknown')); }
    };
  });
}

// ===== 画面: 一覧系の読み込みエラー =====
function renderActionError(title, err) {
  $app.innerHTML = `
    <section class="screen">
      <h1>${escapeHtml(title)}</h1>
      <div class="card warn">
        <p>読み込みに失敗しました。</p>
        <p class="muted">${escapeHtml(err || '')}</p>
      </div>
      <button class="btn back" id="home-btn">‹ マイページ</button>
    </section>
  `;
  document.getElementById('home-btn').onclick = goHome;
}

// ===== 画面: 利用規約 =====
function renderAgreement() {
  $app.innerHTML = `
    <section class="screen">
      <h1>ようこそ</h1>
      <p>さいたま市里親会 公式LINE をご利用いただきありがとうございます。</p>
      <p>ご登録にあたり、利用規約およびプライバシーポリシーをご確認・同意ください。</p>
      <ul class="links">
        <li><a href="#" id="open-terms">利用規約を見る</a></li>
        <li><a href="#" id="open-privacy">プライバシーポリシーを見る</a></li>
      </ul>
      <label class="check"><input type="checkbox" id="agree-terms"> 利用規約に同意します</label>
      <label class="check"><input type="checkbox" id="agree-privacy"> プライバシーポリシーに同意します</label>
      <button class="btn primary" id="next-btn" disabled>次へ</button>
    </section>
  `;
  const t = document.getElementById('agree-terms');
  const p = document.getElementById('agree-privacy');
  const btn = document.getElementById('next-btn');
  const sync = () => {
    state.agreedTerms = t.checked;
    state.agreedPrivacy = p.checked;
    btn.disabled = !(t.checked && p.checked);
  };
  t.onchange = sync;
  p.onchange = sync;
  btn.onclick = renderChoose;
  document.getElementById('open-terms').onclick = (e) => { e.preventDefault(); openDoc('terms.html'); };
  document.getElementById('open-privacy').onclick = (e) => { e.preventDefault(); openDoc('privacy.html'); };
}

// URLを開く。LIFF内ブラウザ(external:false)か、外部ブラウザ(external:true)。
function openUrl(url, external) {
  if (window.liff && typeof liff.openWindow === 'function' && liff.isInClient()) {
    liff.openWindow({ url: url, external: !!external });
  } else {
    window.open(url, '_blank');
  }
}

// 規約・プライバシーポリシーを開く（同一サイト内の相対パス。登録途中の状態を失わない）
function openDoc(path) {
  openUrl(new URL(path, location.href).href, false);
}

// ===== 画面: 登録方法選択 =====
function renderChoose() {
  $app.innerHTML = `
    <section class="screen">
      <h1>ご登録の方法</h1>
      <button class="card-btn" id="choose-new">
        <strong>新しい世帯として登録</strong>
        <span>ご家族で初めて登録される方</span>
      </button>
      <button class="card-btn" id="choose-join">
        <strong>家族として参加</strong>
        <span>ご家族が既に登録済みの方</span>
      </button>
    </section>
  `;
  document.getElementById('choose-new').onclick = renderNewHouseholdForm;
  document.getElementById('choose-join').onclick = renderSearchHouseholdForm;
}

// ===== 画面: 新規世帯登録フォーム =====
function renderNewHouseholdForm() {
  const cur = state.newHousehold || {};
  $app.innerHTML = `
    <section class="screen">
      <h1>世帯情報の登録</h1>
      <label>世帯代表者のお名前 <span class="req">*</span></label>
      <div class="row">
        <input id="lastName" placeholder="姓" value="${escapeAttr(cur.lastName)}">
        <input id="firstName" placeholder="名" value="${escapeAttr(cur.firstName)}">
      </div>
      <p class="hint">姓と名を分けて入力してください。</p>

      <label>お住まいの区 <span class="req">*</span></label>
      <select id="ku">
        <option value="">選択してください</option>
        ${KU_OPTIONS.map(k => `<option value="${k}" ${cur.ku === k ? 'selected' : ''}>${k}</option>`).join('')}
      </select>

      <label>ご連絡先電話番号 <span class="req">*</span></label>
      <input id="phone" type="tel" placeholder="048-xxx-xxxx" value="${escapeAttr(cur.phone)}">

      <label>里親種別 <span class="req">*</span></label>
      <div class="radios">
        ${FOSTER_TYPES.map(f => `
          <label class="radio"><input type="radio" name="fosterType" value="${f}" ${cur.fosterType === f ? 'checked' : ''}> ${f}</label>
        `).join('')}
      </div>

      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="next-btn">次へ</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderChoose;
  document.getElementById('next-btn').onclick = () => {
    const lastName = document.getElementById('lastName').value.trim();
    const firstName = document.getElementById('firstName').value.trim();
    const ku = document.getElementById('ku').value;
    const phone = document.getElementById('phone').value.trim();
    const fosterTypeEl = document.querySelector('input[name="fosterType"]:checked');
    const fosterType = fosterTypeEl ? fosterTypeEl.value : '';
    if (!lastName || !firstName || !ku || !phone || !fosterType) {
      alert('すべての必須項目を入力してください。');
      return;
    }
    state.newHousehold = { lastName, firstName, ku, phone, fosterType };
    renderNewMemberForm();
  };
}

// ===== 画面: 新規世帯の本人情報(立場は世帯代表者で固定) =====
function renderNewMemberForm() {
  const h = state.newHousehold;
  $app.innerHTML = `
    <section class="screen">
      <h1>ご本人の情報</h1>
      <p>世帯情報を登録する方は <strong>世帯代表者</strong> として登録されます。</p>
      <div class="card">
        <p><strong>お名前:</strong> ${escapeHtml(h.lastName)} ${escapeHtml(h.firstName)}</p>
        <p><strong>区:</strong> ${escapeHtml(h.ku)}</p>
        <p><strong>里親種別:</strong> ${escapeHtml(h.fosterType)}</p>
      </div>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">この内容で登録</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderNewHouseholdForm;
  document.getElementById('submit-btn').onclick = submitNewHousehold;
}

async function submitNewHousehold() {
  const h = state.newHousehold;
  const fullName = `${h.lastName} ${h.firstName}`;
  const result = await callApi('registerHousehold', {
    household: {
      representativeName: fullName,
      ku: h.ku,
      phone: h.phone,
      fosterType: h.fosterType,
    },
    member: {
      name: fullName,
      displayName: state.profile.displayName,
      consent: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    },
  });
  if (result.ok) {
    renderDone(result.householdId, fullName);
  } else if (result.error === 'duplicate_household') {
    renderDuplicateConfirm(result.existing);
  } else {
    alert('登録に失敗しました: ' + (result.error || 'unknown'));
  }
}

// ===== 画面: 重複検出時の確認 =====
function renderDuplicateConfirm(existing) {
  $app.innerHTML = `
    <section class="screen">
      <h1>同じ世帯が既に登録されています</h1>
      <div class="card warn">
        <p><strong>${escapeHtml(existing.ku)} ${escapeHtml(existing.representativeName)}</strong> さん</p>
        <p>世帯ID: ${escapeHtml(existing.householdId)}</p>
        <p>登録日: ${escapeHtml(existing.registeredDate)}</p>
      </div>
      <p>ご家族と同じ世帯ですか?</p>
      <div class="actions">
        <button class="btn" id="back-btn">いいえ(やり直す)</button>
        <button class="btn primary" id="join-btn">はい、家族として参加</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderNewHouseholdForm;
  document.getElementById('join-btn').onclick = () => {
    state.joinHousehold = existing;
    renderJoinMemberForm();
  };
}

// ===== 画面: 家族参加(世帯検索) =====
function renderSearchHouseholdForm() {
  $app.innerHTML = `
    <section class="screen">
      <h1>ご家族の世帯を検索</h1>
      <label>お住まいの区 <span class="req">*</span></label>
      <select id="ku">
        <option value="">選択してください</option>
        ${KU_OPTIONS.map(k => `<option value="${k}">${k}</option>`).join('')}
      </select>

      <label>世帯代表者のお名前 <span class="req">*</span></label>
      <p class="hint">既にご登録済みのご家族のお名前を入力してください。</p>
      <div class="row">
        <input id="lastName" placeholder="姓">
        <input id="firstName" placeholder="名">
      </div>

      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="search-btn">検索</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderChoose;
  document.getElementById('search-btn').onclick = async () => {
    const ku = document.getElementById('ku').value;
    const lastName = document.getElementById('lastName').value.trim();
    const firstName = document.getElementById('firstName').value.trim();
    if (!ku || !lastName || !firstName) {
      alert('すべての項目を入力してください。');
      return;
    }
    const fullName = `${lastName} ${firstName}`;
    const result = await callApi('searchHousehold', { ku, representativeName: fullName });
    if (result.ok && result.found) {
      state.joinHousehold = result.household;
      renderJoinConfirm();
    } else {
      renderNotFound();
    }
  };
}

function renderNotFound() {
  $app.innerHTML = `
    <section class="screen">
      <h1>該当する世帯が見つかりませんでした</h1>
      <p>入力内容に間違いがないかご確認ください。</p>
      <p>もしくは、ご家族でまだどなたも登録されていない場合は「新規世帯として登録」からお進みください。</p>
      <div class="actions">
        <button class="btn" id="retry-btn">入力し直す</button>
        <button class="btn primary" id="new-btn">新規世帯登録へ</button>
      </div>
    </section>
  `;
  document.getElementById('retry-btn').onclick = renderSearchHouseholdForm;
  document.getElementById('new-btn').onclick = renderNewHouseholdForm;
}

function renderJoinConfirm() {
  const h = state.joinHousehold;
  $app.innerHTML = `
    <section class="screen">
      <h1>該当する世帯が見つかりました</h1>
      <div class="card">
        <p><strong>${escapeHtml(h.ku)} ${escapeHtml(h.representativeName)}</strong> さんの世帯</p>
        <p>登録日: ${escapeHtml(h.registeredDate)}</p>
      </div>
      <p>この世帯のご家族として登録します。</p>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="next-btn">次へ</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderSearchHouseholdForm;
  document.getElementById('next-btn').onclick = renderJoinMemberForm;
}

// ===== 画面: 家族参加 本人情報 =====
function renderJoinMemberForm() {
  const h = state.joinHousehold;
  $app.innerHTML = `
    <section class="screen">
      <h1>ご本人の情報</h1>
      <div class="card">
        <p>${escapeHtml(h.ku)} ${escapeHtml(h.representativeName)} さんの世帯に参加します。</p>
      </div>

      <label>世帯内でのお立場 <span class="req">*</span></label>
      <div class="radios">
        ${JOIN_ROLES.map(r => `
          <label class="radio"><input type="radio" name="role" value="${r}"> ${r}</label>
        `).join('')}
      </div>

      <label>お名前 <span class="req">*</span></label>
      <div class="row">
        <input id="lastName" placeholder="姓">
        <input id="firstName" placeholder="名">
      </div>

      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">登録</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderJoinConfirm;
  document.getElementById('submit-btn').onclick = submitJoinMember;
}

async function submitJoinMember() {
  const roleEl = document.querySelector('input[name="role"]:checked');
  const role = roleEl ? roleEl.value : '';
  const lastName = document.getElementById('lastName').value.trim();
  const firstName = document.getElementById('firstName').value.trim();
  if (!role || !lastName || !firstName) {
    alert('すべての必須項目を入力してください。');
    return;
  }
  const fullName = `${lastName} ${firstName}`;
  const result = await callApi('registerMember', {
    householdId: state.joinHousehold.householdId,
    role,
    name: fullName,
    displayName: state.profile.displayName,
    consent: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
  });
  if (result.ok) {
    renderDone(state.joinHousehold.householdId, fullName);
  } else {
    alert('登録に失敗しました: ' + (result.error || 'unknown'));
  }
}

// ===== 画面: 完了 =====
function renderDone(householdId, name) {
  $app.innerHTML = `
    <section class="screen">
      <h1>登録を受け付けました</h1>
      <p>さいたま市里親会へようこそ。</p>
      <div class="card">
        <p><strong>${escapeHtml(name)}</strong> さん</p>
        <p>世帯ID: ${escapeHtml(householdId)}</p>
      </div>
      <div class="card warn">
        <p>ご利用には<strong>運営（理事）の承認</strong>が必要です。承認されると、イベントや資料をご利用いただけるようになります。</p>
      </div>
      <p class="muted">ご家族の方も、同じ手順で「家族として参加」からご登録いただけます。</p>
      <div class="actions">
        <button class="btn" id="home-btn">状態を確認</button>
        <button class="btn primary" id="close-btn">閉じる</button>
      </div>
    </section>
  `;
  document.getElementById('home-btn').onclick = goHome;
  document.getElementById('close-btn').onclick = () => {
    if (window.liff && typeof liff.isInClient === 'function' && liff.isInClient()) liff.closeWindow();
  };
}

// ===== エラー画面 =====
function renderError(title, detail) {
  $app.innerHTML = `
    <section class="screen">
      <h1>エラー</h1>
      <p>${escapeHtml(title)}</p>
      <p class="muted" style="white-space:pre-line; word-break:break-all;">${escapeHtml(detail || '')}</p>
    </section>
  `;
}

// 画面上部の固定戻りバー。呼び出し側で document.getElementById('topback').onclick を設定する。
function topBar(title, backLabel) {
  return `<div class="topbar">
      <button class="back-link" id="topback">‹ ${escapeHtml(backLabel || '戻る')}</button>
      <span class="topbar-title">${escapeHtml(title)}</span>
    </div>`;
}

// ===== 並べ替え・検索つきテーブルの共通部品 =====
// 並べ替え可能な見出しセル。view={q,sortKey,sortDir}
function sortTh(label, key, view) {
  const active = view.sortKey === key;
  const arrow = active ? (view.sortDir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th class="sortable" data-sort="${escapeAttr(key)}">${escapeHtml(label)}${arrow}</th>`;
}
// 検索で絞り込み＋指定キーで並べ替えた行を返す。cols[key](row)=ソート値、searchText(row)=検索対象文字列。
function applyTableView(rows, view, cols, searchText) {
  let r = rows;
  const q = (view.q || '').trim().toLowerCase();
  if (q) r = r.filter(row => String(searchText(row) || '').toLowerCase().includes(q));
  if (view.sortKey && cols[view.sortKey]) {
    const dir = view.sortDir === 'desc' ? -1 : 1;
    r = r.slice().sort((a, b) => {
      const av = cols[view.sortKey](a), bv = cols[view.sortKey](b);
      const c = (typeof av === 'number' && typeof bv === 'number')
        ? av - bv
        : String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv), 'ja');
      return c * dir;
    });
  }
  return r;
}
// 見出しクリック（並べ替え）と検索入力を配線し、draw を再実行する。
function wireTableControls(view, draw) {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (view.sortKey === k) view.sortDir = (view.sortDir === 'asc' ? 'desc' : 'asc');
      else { view.sortKey = k; view.sortDir = 'asc'; }
      draw();
    };
  });
  const s = document.getElementById('tbl-search');
  if (s) {
    s.oninput = () => { view.q = s.value; draw(); };
    if (view.q) { s.focus(); const v = s.value; s.value = ''; s.value = v; } // 再描画後もフォーカス維持＋末尾
  }
}

// ===== 管理画面（運営・理事向け / ?view=admin） =====
// 直近に開いていた管理ページを記憶し、リロード時に復元する（?view=admin はURL不変のため）。
function rememberAdmin(name, param) {
  try {
    if (name) sessionStorage.setItem('kl_admin_sec', JSON.stringify({ name, param: param || null }));
    else sessionStorage.removeItem('kl_admin_sec');
  } catch (e) { /* noop */ }
}
function lastAdmin() {
  try { return JSON.parse(sessionStorage.getItem('kl_admin_sec') || 'null'); } catch (e) { return null; }
}

async function renderAdmin() {
  document.body.classList.add('lean'); // 管理画面はすっきり（背景を淡く）
  $app.innerHTML = `<section class="screen"><h1>管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminCheck', {});
  if (!res.ok) return renderActionError('管理', res.error);
  state.isGuest = !!res.isGuest;
  if (!res.isAdmin) {
    $app.innerHTML = `
      <section class="screen">
        <h1>管理</h1>
        <div class="card warn">
          <p>この画面は運営（理事）専用です。閲覧権限がありません。</p>
          <p class="muted">権限が必要な場合は、次のIDを管理者にお伝えください。</p>
          <p class="mono">${escapeHtml(res.userId || '')}</p>
        </div>
        <button class="btn back" id="home-btn">‹ マイページ</button>
      </section>`;
    document.getElementById('home-btn').onclick = goHome;
    return;
  }
  // リロード時：直近に見ていた管理ページを復元
  const sec = lastAdmin();
  if (sec) {
    if (sec.name === 'members') return renderAdminHouseholds();
    if (sec.name === 'fees') return renderAdminFees();
    if (sec.name === 'materials') return renderAdminMaterials();
    if (sec.name === 'events') return renderAdminEvents();
    if (sec.name === 'roster' && sec.param) return renderAdminRoster(sec.param);
  }
  return renderAdminHome();
}

async function renderAdminHome() {
  document.body.classList.add('lean'); // 管理画面はすっきり（背景を淡く）
  rememberAdmin(null); // 管理トップ：記憶クリア
  // 承認待ち件数（バッジ用）。取得失敗時は0扱い。
  let pending = 0;
  try { const r = await callApi('adminPendingCount', {}); if (r.ok) pending = r.count || 0; } catch (e) { /* noop */ }
  const badge = pending ? ` <span class="badge">承認待ち ${pending}</span>` : '';
  $app.innerHTML = `
    <section class="screen">
      <h1>さいたま市里親会 管理メニュー</h1>
      ${state.isGuest ? `<div class="card"><p>${icon('lock')} <strong>ゲスト（共有）で閲覧中</strong></p><p class="muted">さいたま市児童相談所との共同利用の範囲でご利用いただけます。会費・承認・配信は当会が行います。</p></div>` : ''}
      ${(pending && !state.isGuest) ? `<button class="card-btn alert-btn" id="a-pending"><strong>${icon('alert')} 承認待ちが ${pending}件あります</strong><span>タップして会員名簿で承認/却下</span></button>` : ''}
      <button class="card-btn" id="a-events"><strong>${icon('calendar')} 行事の参加者管理</strong><span>${state.isGuest ? '行事の作成・編集・参加者名簿の閲覧' : '申込状況・参加費の回収・代理入力・CSV出力'}</span></button>
      <button class="card-btn" id="a-members"><strong>${icon('user')} 会員名簿${state.isGuest ? '' : badge}</strong><span>${state.isGuest ? '世帯・個人の一覧（閲覧）' : '世帯・個人の一覧・承認・LINEなし世帯の代理登録・CSV'}</span></button>
      ${state.isGuest ? '' : `<button class="card-btn" id="a-fees"><strong>${icon('money')} 会費の管理</strong><span>年会費の納付状況・未納一覧</span></button>`}
      <button class="card-btn" id="a-materials"><strong>${icon('book')} 資料の管理</strong><span>会報・しおり等の追加・公開/非公開</span></button>
      ${state.isGuest
        ? `<button class="btn back" id="logout-btn" style="margin-top:24px;">${icon('lock')} ログアウト</button>`
        : `<button class="btn back" id="home-btn" style="margin-top:24px;">‹ マイページ</button>`}
    </section>
  `;
  const pb = document.getElementById('a-pending');
  if (pb) pb.onclick = renderAdminHouseholds;
  document.getElementById('a-events').onclick = renderAdminEvents;
  document.getElementById('a-members').onclick = renderAdminHouseholds;
  const fb = document.getElementById('a-fees');
  if (fb) fb.onclick = renderAdminFees;
  document.getElementById('a-materials').onclick = renderAdminMaterials;
  const hb = document.getElementById('home-btn');
  if (hb) hb.onclick = goHome;
  const lb = document.getElementById('logout-btn');
  if (lb) lb.onclick = () => {
    try { sessionStorage.removeItem('kl_guest'); } catch (e) { /* noop */ }
    state.isGuest = false; state.idToken = null; renderGuestLogin('ログアウトしました。');
  };
}

async function renderAdminEvents() {
  document.body.classList.add('lean');
  rememberAdmin('events');
  $app.innerHTML = `<section class="screen"><h1>行事の参加者管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListEvents', {});
  if (!res.ok) return renderActionError('行事の参加者管理', res.error);
  state.adminEvents = res.events || [];
  const v = state.evtView;
  const controls = listControlsHtml({
    view: v,
    placeholder: '行事名・場所で検索…',
    filters: [
      { key: 'all', label: 'すべて' },
      { key: '募集中', label: '募集中' },
      { key: '開催済', label: '開催済' },
      { key: '中止', label: '中止' },
    ],
    sorts: [
      { key: 'date', label: '開催日が新しい順' },
      { key: 'date-asc', label: '開催日が近い順' },
      { key: 'name', label: '行事名順' },
    ],
  });
  $app.innerHTML = `
    <section class="screen">
      ${topBar('行事の参加者管理', '管理メニュー')}
      <h1>${icon('calendar')} 行事の参加者管理</h1>
      <button class="btn" id="new-ev-btn">${icon('plus')} 行事を新規作成</button>
      ${controls}
      <div id="evt-list"></div>
      <button class="btn back" id="back-btn" style="margin-top:24px;">‹ 管理メニュー</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  document.getElementById('new-ev-btn').onclick = () => renderEventForm(null);
  wireListControls({ view: v, onChange: paintAdminEvents });
  paintAdminEvents();
}

function eventAdminCard(e) {
  return `
    <div class="card">
      <p><strong>${escapeHtml(e.name)}</strong> ${statusBadge(eventStatusKind(e.status), e.status)}${e.signup === 'external' ? ' ' + statusBadge('hold', '案内のみ') : ''}${e.hasFeeSchedule ? ' <span class="muted">区分別料金</span>' : ''}</p>
      <p class="muted">${escapeHtml(e.date)}${e.place ? ' ／ ' + escapeHtml(e.place) : ''}</p>
      <p class="muted">${e.signup === 'external' ? '案内のみ（外部申込）' : `${e.counts.households}世帯・大人${e.counts.adults}・子ども${e.counts.children}`}${(e.materials && e.materials.length) ? ' ／ 📄資料' + e.materials.length + '件' : ''}</p>
      <div class="actions" style="margin-top:6px;">
        <button class="chip roster-btn" data-id="${escapeAttr(e.eventId)}">${icon('list')}参加者一覧</button>
        <button class="chip ev-edit" data-id="${escapeAttr(e.eventId)}">${icon('edit')}編集</button>
        ${state.isGuest ? '' : `<button class="chip ev-notify" data-id="${escapeAttr(e.eventId)}">${icon('send')}LINEにて通知</button>`}
      </div>
    </div>`;
}

function paintAdminEvents() {
  const v = state.evtView;
  let list = (state.adminEvents || []).filter(e => {
    if (v.filter !== 'all' && e.status !== v.filter) return false;
    return matchQuery(v.q, (e.name || '') + ' ' + (e.place || ''));
  });
  list.sort((a, b) => {
    if (v.sort === 'name') return (a.name || '').localeCompare(b.name || '', 'ja');
    if (v.sort === 'date-asc') return (a.date || '').localeCompare(b.date || '');
    return (b.date || '').localeCompare(a.date || ''); // 新しい順
  });
  const el = document.getElementById('evt-list');
  if (!el) return;
  el.innerHTML = list.length ? list.map(eventAdminCard).join('') : '<p class="muted">該当する行事がありません。</p>';
  const byId = (id) => (state.adminEvents || []).find(e => e.eventId === id);
  el.querySelectorAll('button.roster-btn').forEach(b => { b.onclick = () => renderAdminRoster(b.dataset.id); });
  el.querySelectorAll('button.ev-edit').forEach(b => { b.onclick = () => renderEventForm(byId(b.dataset.id)); });
  el.querySelectorAll('button.ev-notify').forEach(b => {
    b.onclick = () => renderBroadcastCompose({ text: defaultEventNoticeText(byId(b.dataset.id)), back: renderAdminEvents, backLabel: '行事の参加者管理', remember: 'events' });
  });
}

const EVENT_STATUSES = ['募集中', '開催済', '中止'];
const EVENT_TARGETS = ['全員', '会員のみ'];

function renderEventForm(ev) {
  const c = ev || {};
  const multi = !!c.hasFeeSchedule;
  const targetOpts = EVENT_TARGETS.slice();
  if (c.target && !targetOpts.includes(c.target)) targetOpts.unshift(c.target);
  $app.innerHTML = `
    <section class="screen">
      ${topBar(ev ? '行事の編集' : '行事の新規作成', '行事一覧')}
      <h1>${ev ? '行事の編集' : '行事の新規作成'}</h1>
      <label>行事名 <span class="req">*</span></label>
      <input id="ev-name" value="${escapeAttr(c.name)}">
      <label>開催日 <span class="req">*</span></label>
      <input id="ev-date" type="date" value="${escapeAttr(c.date)}">
      <label>開催場所</label>
      <input id="ev-place" value="${escapeAttr(c.place)}">
      ${multi ? `<div class="card warn"><p>この行事は<strong>区分別の料金表</strong>（夏レク等）です。料金の変更は事務局へご依頼ください。下の参加費欄は使いません。</p></div>` : `
      <label>参加費（大人）円</label>
      <input id="ev-af" type="number" inputmode="numeric" min="0" value="${c.adultFee != null ? c.adultFee : 0}">
      <label>参加費（子ども）円</label>
      <input id="ev-cf" type="number" inputmode="numeric" min="0" value="${c.childFee != null ? c.childFee : 0}">`}
      <label>定員（世帯数・0=制限なし）</label>
      <input id="ev-cap" type="number" inputmode="numeric" min="0" value="${c.capacity != null ? c.capacity : 0}">
      <label>申込締切日</label>
      <input id="ev-deadline" type="date" value="${escapeAttr(c.deadline)}">
      <label>対象</label>
      <select id="ev-target">${targetOpts.map(t => `<option ${c.target === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
      <label>申込方式</label>
      <select id="ev-signup">
        <option value="liff" ${c.signup !== 'external' ? 'selected' : ''}>アプリで出欠を受け付ける（LIFF出欠）</option>
        <option value="external" ${c.signup === 'external' ? 'selected' : ''}>案内のみ（申込は児相直通など外部）</option>
      </select>
      <p class="hint">「案内のみ」にすると出欠ボタンを出さず、ひもづけた案内（資料）だけを表示します。</p>
      <label>ステータス</label>
      <select id="ev-status">${EVENT_STATUSES.map(s => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label>備考</label>
      <input id="ev-note" value="${escapeAttr(c.note)}">
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">保存</button>
      </div>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminEvents;
  document.getElementById('back-btn').onclick = renderAdminEvents;
  document.getElementById('submit-btn').onclick = async () => {
    const name = document.getElementById('ev-name').value.trim();
    const date = document.getElementById('ev-date').value;
    if (!name || !date) { alert('行事名と開催日は必須です。'); return; }
    const payload = {
      name, date,
      place: document.getElementById('ev-place').value.trim(),
      capacity: parseInt(document.getElementById('ev-cap').value, 10) || 0,
      deadline: document.getElementById('ev-deadline').value,
      target: document.getElementById('ev-target').value,
      signup: document.getElementById('ev-signup').value,
      status: document.getElementById('ev-status').value,
      note: document.getElementById('ev-note').value.trim(),
    };
    if (!multi) {
      payload.adultFee = parseInt(document.getElementById('ev-af').value, 10) || 0;
      payload.childFee = parseInt(document.getElementById('ev-cf').value, 10) || 0;
    }
    if (ev) payload.id = ev.eventId;
    const res = await callApi('adminUpsertEvent', payload);
    if (res.ok) { renderAdminEvents(); }
    else { alert('保存に失敗しました：' + (res.error || 'unknown')); }
  };
}

async function renderAdminRoster(eventId) {
  rememberAdmin('roster', eventId);
  $app.innerHTML = `<section class="screen"><h1>参加者一覧</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminEventRoster', { eventId });
  if (!res.ok) return renderActionError('参加者一覧', res.error);
  const prevView = (state.adminRoster && state.adminRoster.eventId === eventId) ? state.adminRoster.view : null;
  state.adminRoster = { eventId, event: res.event, rows: res.rows || [], view: prevView || { q: '', sortKey: 'ku', sortDir: 'asc' } };
  drawAdminRoster();
}

// state.adminRoster をもとに名簿を描画する（支払トグルの即時反映に使う）
function drawAdminRoster() {
  const { eventId, event, rows, view } = state.adminRoster;
  const hasFee = rows.some(r => r.total > 0);

  // 回収集計（全件ベース。参加費が発生する行事のみ意味がある）
  let collected = 0, outstanding = 0, paidN = 0, unpaidN = 0;
  rows.forEach(r => {
    if (r.total <= 0) return;
    if (r.payStatus === '済') { collected += r.total; paidN++; }
    else { outstanding += r.total; unpaidN++; }
  });
  const summary = hasFee ? `
    <div class="card">
      <p><strong>参加費の回収</strong></p>
      <p>済：${paidN}世帯 ／ ${collected.toLocaleString()}円</p>
      <p>未：${unpaidN}世帯 ／ ${outstanding.toLocaleString()}円</p>
    </div>` : '';

  const cols = { ku: r => r.ku, rep: r => r.representativeName, adult: r => r.adultCount, child: r => r.childCount, total: r => r.total, pay: r => r.payStatus };
  const searchText = r => `${r.ku} ${r.representativeName} ${r.notes}`;
  const shown = applyTableView(rows, view, cols, searchText);

  const trs = shown.map((r) => `
    <tr>
      <td>${escapeHtml(r.ku)}</td><td>${escapeHtml(r.representativeName)}</td>
      <td class="num">${r.adultCount}</td><td class="num">${r.childCount}</td>
      <td class="num">${r.total > 0 ? r.total.toLocaleString() : '—'}</td>
      <td>${r.total > 0
        ? (state.isGuest
            ? `<span class="st ${r.payStatus === '済' ? 'st-ok' : 'st-todo'}">${icon(r.payStatus === '済' ? 'check' : 'alert')}${r.payStatus === '済' ? '済' : '未'}</span>`
            : `<button class="chip ${r.payStatus === '済' ? 'on' : 'off'} pay-toggle" data-id="${escapeAttr(r.householdId)}">${r.payStatus === '済' ? '済' : '未'}</button>`)
        : '<span class="muted">—</span>'}</td>
      <td>${state.isGuest ? '' : `<button class="chip edit-att" data-id="${escapeAttr(r.householdId)}">編集</button>`}</td>
    </tr>`).join('');

  $app.innerHTML = `
    <section class="screen wide">
      ${topBar('参加者一覧', '行事一覧')}
      <h1>${escapeHtml(event.name)}</h1>
      <p class="muted">${escapeHtml(event.date || '')} ／ ${rows.length}世帯${view.q ? `（表示 ${shown.length}）` : ''}</p>
      ${summary}
      <div class="toolbar">
        <input class="search-input" id="tbl-search" type="search" placeholder="区・世帯代表者・特記で検索…" value="${escapeAttr(view.q)}">
      </div>
      ${shown.length ? `
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>${sortTh('区', 'ku', view)}${sortTh('世帯代表者', 'rep', view)}${sortTh('大人', 'adult', view)}${sortTh('子', 'child', view)}${sortTh('参加費', 'total', view)}${sortTh('支払', 'pay', view)}<th></th></tr></thead>
          <tbody>${trs}</tbody>
        </table></div>
        <p class="hint">見出しクリックで並べ替え。${state.isGuest ? '' : '「支払」の済/未はタップで切替。'}${hasFee ? '' : 'この行事は参加費が無料です。'}</p>
        <button class="btn primary" id="csv-btn" style="margin-top:8px;">CSVをダウンロード（全件）</button>
        <p class="hint">ダウンロードはPCのブラウザ推奨です。</p>
      ` : '<p class="muted">該当する回答がありません。</p>'}
      ${state.isGuest ? '' : '<button class="btn" id="proxy-btn" style="margin-top:8px;">LINEなし世帯を代理で入力</button>'}
      <button class="btn back" id="back-btn" style="margin-top:8px;">‹ 行事一覧</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminEvents;
  document.getElementById('back-btn').onclick = renderAdminEvents;
  const proxyBtn = document.getElementById('proxy-btn');
  if (proxyBtn) proxyBtn.onclick = () => renderProxyHouseholdPicker(eventId, event);
  wireTableControls(view, drawAdminRoster);

  document.querySelectorAll('button.pay-toggle').forEach(b => {
    b.onclick = async () => {
      const r = rows.find(x => x.householdId === b.dataset.id);
      const next = r.payStatus === '済' ? '未' : '済';
      b.disabled = true;
      const resp = await callApi('adminSetPayStatus', { eventId, householdId: r.householdId, payStatus: next });
      if (resp.ok) { r.payStatus = next; drawAdminRoster(); }
      else { alert('支払状況の更新に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
  document.querySelectorAll('button.edit-att').forEach(b => {
    b.onclick = () => {
      const r = rows.find(x => x.householdId === b.dataset.id);
      renderProxyAttendanceForm(eventId, event, { householdId: r.householdId, label: `${r.ku} ${r.representativeName}` },
        { adultCount: r.adultCount, childCount: r.childCount, notes: r.notes, breakdown: r.breakdown });
    };
  });

  const csvBtn = document.getElementById('csv-btn');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const fs = event.feeSchedule;
      const header = ['区', '世帯代表者', '世帯ID', '大人', '子ども', '参加費合計', '支払状況', '内訳', '特記事項', '回答日時'];
      const data = rows.map(r => [r.ku, r.representativeName, r.householdId, r.adultCount, r.childCount, r.total, r.payStatus, breakdownText(r.breakdown, fs), r.notes, r.answeredAt]);
      downloadCsv(`roster_${eventId}.csv`, [header].concat(data));
    };
  }
}

// 内訳JSON を人が読める文字列にする（例: "FH / 大人・高校生2,小学生1"）
function breakdownText(breakdown, feeSchedule) {
  if (!breakdown || !breakdown.counts) return '';
  const labels = {};
  if (feeSchedule && Array.isArray(feeSchedule.tiers)) {
    feeSchedule.tiers.forEach(t => { labels[t.key] = t.label; });
  }
  const parts = Object.keys(breakdown.counts)
    .filter(k => breakdown.counts[k] > 0)
    .map(k => `${labels[k] || k}${breakdown.counts[k]}`);
  return (breakdown.isFHB ? 'FH / ' : '') + parts.join('，');
}

// 代理入力：世帯を選ぶ → 出欠フォーム
async function renderProxyHouseholdPicker(eventId, event) {
  $app.innerHTML = `<section class="screen"><h1>代理入力</h1><p>世帯を読み込み中...</p></section>`;
  const res = await callApi('adminListHouseholds', {});
  if (!res.ok) return renderActionError('代理入力', res.error);
  const hs = (res.households || []).filter(h => h.status === '有効');
  const cards = hs.map(h => `
    <button class="card-btn pick-h" data-id="${escapeAttr(h.householdId)}" data-label="${escapeAttr(h.ku + ' ' + h.representativeName)}">
      <strong>${escapeHtml(h.ku)} ${escapeHtml(h.representativeName)}</strong>
      <span>${escapeHtml(h.householdId)}${h.fosterType ? '・' + escapeHtml(h.fosterType) : ''}</span>
    </button>`).join('');
  $app.innerHTML = `
    <section class="screen">
      ${topBar('代理入力する世帯', '参加者一覧')}
      <h1>代理入力する世帯</h1>
      <p class="muted">${escapeHtml(event.name)}</p>
      <p class="hint">LINEで回答できない世帯の出欠を、運営が代わりに入力します。締切後でも入力できます。</p>
      ${hs.length ? cards : '<p class="muted">世帯がありません。</p>'}
      <button class="btn back" id="back-btn" style="margin-top:16px;">‹ 参加者一覧</button>
    </section>
  `;
  document.getElementById('topback').onclick = () => renderAdminRoster(eventId);
  document.getElementById('back-btn').onclick = () => renderAdminRoster(eventId);
  document.querySelectorAll('button.pick-h').forEach(b => {
    b.onclick = () => renderProxyAttendanceForm(eventId, event,
      { householdId: b.dataset.id, label: b.dataset.label }, {});
  });
}

function renderProxyAttendanceForm(eventId, event, hh, cur) {
  cur = cur || {};
  // 料金計算用の ev（多段階/2区分の両対応）
  const ev = {
    eventId: eventId, name: event.name,
    feeSchedule: event.feeSchedule || null,
    adultFee: event.adultFee || 0, childFee: event.childFee || 0,
  };
  $app.innerHTML = `
    <section class="screen">
      <h1>代理で出欠を入力</h1>
      <div class="card">
        <p><strong>${escapeHtml(event.name)}</strong></p>
        <p class="muted">${escapeHtml(hh.label)}</p>
      </div>
      ${feeFormBody(ev, cur)}
      <label>特記事項（任意）</label>
      <input id="notes" type="text" value="${escapeAttr(cur.notes)}">
      <p class="hint">支払状況は名簿側で管理します。</p>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">この内容で登録</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = () => renderAdminRoster(eventId);
  wireFeeInputs(ev);
  document.getElementById('submit-btn').onclick = async () => {
    const payload = readAttendancePayload(ev);
    if (!payload) return;
    payload.householdId = hh.householdId;
    const res = await callApi('adminSubmitAttendance', payload);
    if (res.ok) { renderAdminRoster(eventId); }
    else { alert('登録に失敗しました：' + (res.error || 'unknown')); }
  };
}

async function renderAdminHouseholds() {
  rememberAdmin('members');
  $app.innerHTML = `<section class="screen"><h1>会員名簿</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListHouseholds', {});
  if (!res.ok) return renderActionError('会員名簿', res.error);
  const hs = res.households || [];
  // 1会員=1行に展開。世帯情報を各行に持たせる（検索・並べ替え用）。
  const rows = [];
  hs.forEach((h) => {
    const ms = (h.members && h.members.length) ? h.members : [null];
    ms.forEach((m, mi) => rows.push({
      householdId: h.householdId, ku: h.ku || '', rep: h.representativeName || '',
      foster: h.fosterType || '', fee: h.feeStatus || '',
      name: m ? m.name : '', role: m ? m.role : '', status: m ? m.status : '',
      m: m, isRep: mi === 0,
    }));
  });
  const prevView = state.adminMembers && state.adminMembers.view;
  state.adminMembers = { rows, hs, pendingCount: res.pendingCount || 0, view: prevView || { q: '', sortKey: 'ku', sortDir: 'asc' } };
  drawAdminMembers();
}

function drawAdminMembers() {
  const { rows, hs, view, pendingCount } = state.adminMembers;
  const cols = { ku: r => r.ku, rep: r => r.rep, name: r => r.name, role: r => r.role, foster: r => r.foster, fee: r => r.fee, status: r => r.status };
  const searchText = r => `${r.ku} ${r.rep} ${r.name} ${r.role} ${r.foster} ${r.householdId}`;
  const shown = applyTableView(rows, view, cols, searchText);
  const memberCount = rows.filter(r => r.m).length;

  const adminCell = (m) => {
    const isLine = m.lineUserId && String(m.lineUserId).indexOf('U') === 0;
    if (m.isFixedAdmin) return '<span class="chip on" style="pointer-events:none;">固定</span>';
    if (state.isGuest) return m.isAdmin ? '<span class="muted">管理者</span>' : '<span class="muted">—</span>';
    if (isLine) return `<button class="chip ${m.isAdmin ? 'on' : ''} admin-toggle" data-uid="${escapeAttr(m.lineUserId)}" data-on="${m.isAdmin ? '1' : '0'}" data-name="${escapeAttr(m.name)}">${m.isAdmin ? '管理者' : '管理者にする'}</button>`;
    return '<span class="muted">—</span>';
  };
  const statusCell = (r) => {
    if (!r.m) return '';
    if (r.status === '承認待ち') {
      if (state.isGuest) return statusBadge('hold', '承認待ち');
      return `<span style="white-space:nowrap;">承認待ち<br><button class="chip on approve-btn" data-uid="${escapeAttr(r.m.lineUserId)}" data-name="${escapeAttr(r.name)}">承認</button> <button class="chip off reject-btn" data-uid="${escapeAttr(r.m.lineUserId)}" data-name="${escapeAttr(r.name)}">却下</button></span>`;
    }
    return r.status !== '有効' ? '<span class="muted">' + escapeHtml(r.status) + '</span>' : '有効';
  };
  const trOf = (r) => `<tr>
      <td>${escapeHtml(r.ku)}</td>
      <td>${escapeHtml(r.rep)}</td>
      <td>${r.m ? escapeHtml(r.name) : '<span class="muted">（会員なし）</span>'}</td>
      <td>${escapeHtml(r.role)}</td>
      <td>${escapeHtml(r.foster)}</td>
      <td>${escapeHtml(r.fee)}</td>
      <td>${statusCell(r)}</td>
      <td>${r.m ? adminCell(r.m) : ''}</td>
      <td>${(r.isRep && !state.isGuest) ? `<button class="chip add-member" data-hid="${escapeAttr(r.householdId)}" data-label="${escapeAttr(r.ku + ' ' + r.rep)}">＋家族</button>` : ''}</td>
    </tr>`;

  $app.innerHTML = `
    <section class="screen wide">
      ${topBar('会員名簿', '管理メニュー')}
      <h1>会員名簿</h1>
      <p class="muted">${hs.length}世帯・${memberCount}名${pendingCount ? ` ／ <strong style="color:var(--pink);">承認待ち ${pendingCount}件</strong>` : ''}${view.q ? `（表示 ${shown.length}行）` : ''}</p>
      <div class="toolbar">
        <input class="search-input" id="tbl-search" type="search" placeholder="区・氏名・里親種別などで検索…" value="${escapeAttr(view.q)}">
        ${state.isGuest ? '' : '<button class="btn" id="new-h-btn" style="flex:0 0 auto;">＋ LINEなし世帯を登録</button>'}
      </div>
      ${shown.length ? `
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            ${sortTh('区', 'ku', view)}${sortTh('世帯代表者', 'rep', view)}${sortTh('氏名', 'name', view)}${sortTh('立場', 'role', view)}${sortTh('里親種別', 'foster', view)}${sortTh('会費', 'fee', view)}${sortTh('状態', 'status', view)}<th>管理者</th><th>操作</th>
          </tr></thead>
          <tbody>${shown.map(trOf).join('')}</tbody>
        </table></div>
        <button class="btn primary" id="csv-btn" style="margin-top:8px;">CSVをダウンロード（個人単位・全件）</button>
        <p class="hint">見出しをクリックで並べ替え。検索ボックスで絞り込み。PC推奨・表は横スクロール可。</p>
      ` : '<p class="muted">該当する会員がいません。</p>'}
      <button class="btn back" id="back-btn" style="margin-top:8px;">‹ 管理メニュー</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  const newHBtn = document.getElementById('new-h-btn');
  if (newHBtn) newHBtn.onclick = renderProxyNewHousehold;
  wireTableControls(view, drawAdminMembers);
  document.querySelectorAll('button.add-member').forEach(b => {
    b.onclick = () => renderProxyAddMember({ householdId: b.dataset.hid, label: b.dataset.label });
  });
  document.querySelectorAll('button.admin-toggle').forEach(b => {
    b.onclick = async () => {
      const make = b.dataset.on !== '1';
      const msg = make
        ? `${b.dataset.name} さんに管理者権限を付与します。\n会員名簿・電話番号・CSVなど、すべての会員情報を閲覧できるようになります。よろしいですか？`
        : `${b.dataset.name} さんの管理者権限を解除します。よろしいですか？`;
      if (!confirm(msg)) return;
      b.disabled = true;
      const resp = await callApi('adminSetAdmin', { targetUserId: b.dataset.uid, makeAdmin: make });
      if (resp.ok) { renderAdminHouseholds(); }
      else { alert('変更に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
  document.querySelectorAll('button.approve-btn').forEach(b => {
    b.onclick = async () => {
      if (!confirm(`${b.dataset.name} さんを承認します（利用開始）。よろしいですか？`)) return;
      b.disabled = true;
      const resp = await callApi('adminApproveMember', { targetUserId: b.dataset.uid, approve: true });
      if (resp.ok) { renderAdminHouseholds(); }
      else { alert('承認に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
  document.querySelectorAll('button.reject-btn').forEach(b => {
    b.onclick = async () => {
      if (!confirm(`${b.dataset.name} さんの登録を却下します。よろしいですか？`)) return;
      b.disabled = true;
      const resp = await callApi('adminApproveMember', { targetUserId: b.dataset.uid, approve: false });
      if (resp.ok) { renderAdminHouseholds(); }
      else { alert('却下に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
  const csvBtn = document.getElementById('csv-btn');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const header = ['世帯ID', '区', '世帯代表者', '電話', '里親種別', '会費納付', '氏名', '立場', '状態'];
      const data = [];
      hs.forEach(h => (h.members || []).forEach(m => data.push([h.householdId, h.ku, h.representativeName, h.phone, h.fosterType, h.feeStatus, m.name, m.role, m.status])));
      downloadCsv('members.csv', [header].concat(data));
    };
  }
}

// 代理：LINEなし世帯の新規登録（世帯＋世帯代表者）
function renderProxyNewHousehold() {
  $app.innerHTML = `
    <section class="screen">
      <h1>LINEなし世帯の登録</h1>
      <p class="hint">紙で受け付けた、LINEを使わない世帯を運営が登録します。</p>
      <label>世帯代表者のお名前 <span class="req">*</span></label>
      <div class="row">
        <input id="lastName" placeholder="姓">
        <input id="firstName" placeholder="名">
      </div>
      <label>お住まいの区 <span class="req">*</span></label>
      <select id="ku">
        <option value="">選択してください</option>
        ${KU_OPTIONS.map(k => `<option value="${k}">${k}</option>`).join('')}
      </select>
      <label>ご連絡先電話番号</label>
      <input id="phone" type="tel" placeholder="048-xxx-xxxx">
      <label>里親種別 <span class="req">*</span></label>
      <div class="radios">
        ${FOSTER_TYPES.map(f => `<label class="radio"><input type="radio" name="fosterType" value="${f}"> ${f}</label>`).join('')}
      </div>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">登録</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminHouseholds;
  document.getElementById('submit-btn').onclick = async () => {
    const lastName = document.getElementById('lastName').value.trim();
    const firstName = document.getElementById('firstName').value.trim();
    const ku = document.getElementById('ku').value;
    const phone = document.getElementById('phone').value.trim();
    const ftEl = document.querySelector('input[name="fosterType"]:checked');
    const fosterType = ftEl ? ftEl.value : '';
    if (!lastName || !firstName || !ku || !fosterType) {
      alert('代表者氏名・区・里親種別は必須です。');
      return;
    }
    const fullName = `${lastName} ${firstName}`;
    const res = await callApi('adminRegisterHousehold', {
      household: { representativeName: fullName, ku, phone, fosterType },
      member: { name: fullName },
    });
    if (res.ok) { renderAdminHouseholds(); }
    else if (res.error === 'duplicate_household') {
      alert('同じ区・代表者名の世帯が既に登録されています（' + (res.existing ? res.existing.householdId : '') + '）。');
    } else { alert('登録に失敗しました：' + (res.error || 'unknown')); }
  };
}

// 代理：既存世帯にLINEなし家族を追加
function renderProxyAddMember(hh) {
  $app.innerHTML = `
    <section class="screen">
      <h1>家族を追加（LINEなし）</h1>
      <div class="card"><p>${escapeHtml(hh.label)} さんの世帯</p></div>
      <label>世帯内でのお立場 <span class="req">*</span></label>
      <div class="radios">
        ${JOIN_ROLES.map(r => `<label class="radio"><input type="radio" name="role" value="${r}"> ${r}</label>`).join('')}
      </div>
      <label>お名前 <span class="req">*</span></label>
      <div class="row">
        <input id="lastName" placeholder="姓">
        <input id="firstName" placeholder="名">
      </div>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">追加</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminHouseholds;
  document.getElementById('submit-btn').onclick = async () => {
    const roleEl = document.querySelector('input[name="role"]:checked');
    const role = roleEl ? roleEl.value : '';
    const lastName = document.getElementById('lastName').value.trim();
    const firstName = document.getElementById('firstName').value.trim();
    if (!role || !lastName || !firstName) {
      alert('立場と氏名は必須です。');
      return;
    }
    const res = await callApi('adminAddMember', { householdId: hh.householdId, role, name: `${lastName} ${firstName}` });
    if (res.ok) { renderAdminHouseholds(); }
    else { alert('追加に失敗しました：' + (res.error || 'unknown')); }
  };
}

// ===== 管理: 会費の管理 =====
async function renderAdminFees() {
  document.body.classList.add('lean');
  // 会費は当会に留保（児相との共同利用の範囲外）。ゲストは開けない。
  if (state.isGuest) return renderActionError('会費の管理', 'この画面は当会（里親会）専用です。');
  rememberAdmin('fees');
  $app.innerHTML = `<section class="screen"><h1>会費の管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListHouseholds', {});
  if (!res.ok) return renderActionError('会費の管理', res.error);
  const prevView = state.adminFees && state.adminFees.view;
  state.adminFees = {
    fiscalYear: res.fiscalYear,
    households: (res.households || []).filter(h => h.status === '有効'),
    unpaidOnly: state.adminFees ? state.adminFees.unpaidOnly : false,
    view: prevView || { q: '', sortKey: 'ku', sortDir: 'asc' },
  };
  drawAdminFees();
}

function drawAdminFees() {
  const { fiscalYear, households, unpaidOnly, view } = state.adminFees;
  const paidN = households.filter(h => h.feePaid).length;
  const unpaidN = households.length - paidN;
  const base = unpaidOnly ? households.filter(h => !h.feePaid) : households;
  const cols = { ku: h => h.ku, rep: h => h.representativeName, id: h => h.householdId, fee: h => (h.feePaid ? 1 : 0) };
  const searchText = h => `${h.ku} ${h.representativeName} ${h.householdId}`;
  const list = applyTableView(base, view, cols, searchText);

  const tr = (h) => `
    <tr>
      <td>${escapeHtml(h.ku)}</td>
      <td>${escapeHtml(h.representativeName)}</td>
      <td>${escapeHtml(h.householdId)}</td>
      <td><button class="chip ${h.feePaid ? 'on' : 'off'} fee-toggle" data-id="${escapeAttr(h.householdId)}">${h.feePaid ? '納付済' : '未納'}</button></td>
    </tr>`;

  $app.innerHTML = `
    <section class="screen wide">
      ${topBar('会費の管理', '管理メニュー')}
      <h1>会費の管理</h1>
      <div class="card">
        <p><strong>${fiscalYear}年度</strong></p>
        <p>納付済：${paidN}世帯 ／ 未納：${unpaidN}世帯（計 ${households.length}世帯）</p>
      </div>
      <div class="toolbar">
        <input class="search-input" id="tbl-search" type="search" placeholder="区・世帯代表者で検索…" value="${escapeAttr(view.q)}">
        <label class="check" style="margin-top:0;"><input type="checkbox" id="unpaid-only" ${unpaidOnly ? 'checked' : ''}> 未納のみ</label>
      </div>
      ${list.length ? `
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>${sortTh('区', 'ku', view)}${sortTh('世帯代表者', 'rep', view)}${sortTh('世帯ID', 'id', view)}${sortTh(fiscalYear + '年度会費', 'fee', view)}</tr></thead>
          <tbody>${list.map(tr).join('')}</tbody>
        </table></div>` : '<p class="muted">該当する世帯はありません。</p>'}
      <button class="btn primary" id="csv-btn" style="margin-top:8px;">未納一覧をCSVで出力</button>
      <p class="hint">見出しクリックで並べ替え。「納付済 / 未納」はタップで切替（${fiscalYear}年度分）。PC推奨・横スクロール可。</p>
      <button class="btn back" id="back-btn" style="margin-top:8px;">‹ 管理メニュー</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  wireTableControls(view, drawAdminFees);
  document.getElementById('unpaid-only').onchange = (e) => {
    state.adminFees.unpaidOnly = e.target.checked;
    drawAdminFees();
  };
  document.getElementById('csv-btn').onclick = () => {
    const header = ['世帯ID', '区', '世帯代表者', `${fiscalYear}年度会費`];
    const data = households.filter(h => !h.feePaid).map(h => [h.householdId, h.ku, h.representativeName, '未納']);
    downloadCsv(`fees_unpaid_${fiscalYear}.csv`, [header].concat(data));
  };
  document.querySelectorAll('button.fee-toggle').forEach(b => {
    b.onclick = async () => {
      const h = households.find(x => x.householdId === b.dataset.id);
      const next = !h.feePaid;
      b.disabled = true;
      const resp = await callApi('adminSetFeeStatus', { householdId: h.householdId, paid: next });
      if (resp.ok) { h.feePaid = next; h.feeStatus = resp.feeStatus; drawAdminFees(); }
      else { alert('会費の更新に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
}

// ===== 管理: 資料の管理 =====
async function renderAdminMaterials() {
  document.body.classList.add('lean');
  rememberAdmin('materials');
  $app.innerHTML = `<section class="screen"><h1>資料の管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListAllMaterials', {});
  if (!res.ok) return renderActionError('資料の管理', res.error);
  state.adminMaterials = res.materials || [];
  // 「関連する行事」選択肢のために行事一覧も読む（失敗しても資料管理は動く）
  try { const ev = await callApi('adminListEvents', {}); if (ev.ok) state.adminEvents = ev.events || []; } catch (e) { /* noop */ }
  drawAdminMaterials();
}

function materialCard(m) {
  const isPub = m.status === '公開';
  return `
    <div class="card${isPub ? '' : ' warn'}">
      <p><strong>${escapeHtml(m.title)}</strong>${isNewMaterial(m) ? ' ' + newBadge() : ''}</p>
      <p>${categoryChip(m.category)} <span class="muted">${m.isFile ? '📎アップロード' : 'リンク'}・${escapeHtml(m.publishedAt || '')}</span>${m.eventName ? ` <span class="muted">／🔗 ${escapeHtml(m.eventName)}</span>` : ''}</p>
      <p class="muted" style="word-break:break-all;">${m.isFile ? '（Cloudflareに保管・認証配信）' : escapeHtml(m.url)}</p>
      <div class="actions" style="margin-top:6px;">
        <button class="chip ${isPub ? 'on' : 'off'} mat-toggle" data-id="${escapeAttr(m.id)}">${icon(isPub ? 'check' : 'ban')}${isPub ? '公開中' : '非公開'}</button>
        <button class="chip mat-edit" data-id="${escapeAttr(m.id)}">${icon('edit')}編集</button>
        ${state.isGuest ? '' : `<button class="chip mat-notify" data-id="${escapeAttr(m.id)}">${icon('send')}LINEにて通知</button>`}
      </div>
    </div>`;
}

function drawAdminMaterials() {
  const v = state.matView;
  const controls = listControlsHtml({
    view: v,
    placeholder: 'タイトル・カテゴリで検索…',
    filters: [
      { key: 'all', label: 'すべて' },
      { key: 'pub', label: '公開のみ' },
      { key: 'hidden', label: '非公開のみ' },
      { key: 'file', label: 'ファイル' },
      { key: 'link', label: 'リンク' },
    ],
    sorts: [
      { key: 'date', label: '公開日が新しい順' },
      { key: 'title', label: 'タイトル順' },
      { key: 'cat', label: 'カテゴリ順' },
    ],
  });
  $app.innerHTML = `
    <section class="screen">
      ${topBar('資料の管理', '管理メニュー')}
      <h1>${icon('book')} 資料の管理</h1>
      <p class="hint">「資料を追加」で<strong>ファイルをアップロード</strong>（承認会員のみ閲覧）するか、共有<strong>URL</strong>を登録できます。</p>
      <button class="btn" id="new-btn">${icon('plus')} 資料を追加</button>
      ${controls}
      <div id="mat-list"></div>
      <button class="btn back" id="back-btn" style="margin-top:8px;">‹ 管理メニュー</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  document.getElementById('new-btn').onclick = () => renderMaterialForm(null);
  wireListControls({ view: v, onChange: paintAdminMaterials });
  paintAdminMaterials();
}

function paintAdminMaterials() {
  const v = state.matView;
  let list = (state.adminMaterials || []).filter(m => {
    if (v.filter === 'pub' && m.status !== '公開') return false;
    if (v.filter === 'hidden' && m.status !== '非公開') return false;
    if (v.filter === 'file' && !m.isFile) return false;
    if (v.filter === 'link' && m.isFile) return false;
    return matchQuery(v.q, (m.title || '') + ' ' + (m.category || ''));
  });
  list.sort((a, b) => {
    if (v.sort === 'title') return (a.title || '').localeCompare(b.title || '', 'ja');
    if (v.sort === 'cat') return (a.category || '').localeCompare(b.category || '', 'ja') || (a.title || '').localeCompare(b.title || '', 'ja');
    return (b.publishedAt || '').localeCompare(a.publishedAt || ''); // 公開日の新しい順
  });
  const el = document.getElementById('mat-list');
  if (!el) return;
  el.innerHTML = list.length ? list.map(materialCard).join('') : '<p class="muted">該当する資料がありません。</p>';
  const byId = (id) => (state.adminMaterials || []).find(m => m.id === id);
  el.querySelectorAll('button.mat-edit').forEach(b => { b.onclick = () => renderMaterialForm(byId(b.dataset.id)); });
  el.querySelectorAll('button.mat-notify').forEach(b => {
    b.onclick = () => {
      const m = byId(b.dataset.id);
      renderBroadcastCompose({ text: defaultMaterialNoticeText(m), back: renderAdminMaterials, backLabel: '資料の管理', remember: 'materials' });
    };
  });
  el.querySelectorAll('button.mat-toggle').forEach(b => {
    b.onclick = async () => {
      const m = byId(b.dataset.id);
      const next = m.status === '公開' ? '非公開' : '公開';
      b.disabled = true;
      const resp = await callApi('adminSetMaterialStatus', { id: m.id, status: next });
      if (resp.ok) { m.status = next; paintAdminMaterials(); }
      else { alert('公開状態の更新に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
}

// ===== 管理: LINE一斉配信（資料/行事の「LINEにて通知」から開く） =====
// 既定文は自由に編集できる。資料・行事それぞれで雛形が違う。
function liffViewUrl(view) { return `https://liff.line.me/${window.APP_CONFIG.LIFF_ID}?view=${view}`; }

function defaultMaterialNoticeText(m) {
  return `【さいたま市里親会】お知らせ\n\n`
    + `新しい資料「${m ? m.title : ''}」を公開しました。\n`
    + `アプリの「お役立ち資料」からご覧ください。\n\n`
    + `▼ひらく\n${liffViewUrl('docs')}`;
}

function defaultEventNoticeText(e) {
  const lines = ['【さいたま市里親会】行事のご案内', '', `「${e ? e.name : ''}」`];
  if (e && e.date) lines.push(`日時：${e.date}`);
  if (e && e.place) lines.push(`場所：${e.place}`);
  if (e && e.deadline) lines.push(`申込締切：${e.deadline}`);
  lines.push('', 'アプリから出欠をご回答ください。', '', '▼出欠を回答', liffViewUrl('events'));
  return lines.join('\n');
}

// opts = { text, back, backLabel, remember }
async function renderBroadcastCompose(opts) {
  const o = opts || {};
  const initial = o.text || '';
  const backFn = o.back || renderAdminMaterials;
  const backLabel = o.backLabel || '資料の管理';
  rememberAdmin(o.remember || 'materials'); // リロード時の戻り先
  $app.innerHTML = `
    <section class="screen">
      ${topBar('LINEにて通知', backLabel)}
      <h1>LINEにて通知</h1>
      <div class="card warn">
        <p><strong>公式LINEの友だち全員に一斉配信します。</strong></p>
        <p class="muted">送信は取り消せません。配信前に文面と残り通数をご確認ください。</p>
      </div>
      <p class="muted" id="quota-line">残り通数を確認中...</p>
      <label>配信する文面 <span class="req">*</span></label>
      <textarea id="bc-text" rows="12" style="width:100%;box-sizing:border-box;">${escapeHtml(initial)}</textarea>
      <p class="hint"><span id="bc-count">0</span>/4900字。リンクを載せると会員はタップで資料一覧を開けます（未承認の方は閲覧できません）。</p>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ ${escapeHtml(backLabel)}</button>
        <button class="btn primary" id="send-btn">この内容で配信する</button>
      </div>
    </section>
  `;
  const ta = document.getElementById('bc-text');
  const cnt = document.getElementById('bc-count');
  const updateCount = () => { cnt.textContent = String(ta.value.length); };
  ta.addEventListener('input', updateCount); updateCount();
  document.getElementById('topback').onclick = backFn;
  document.getElementById('back-btn').onclick = backFn;

  // 残り通数を表示
  (async () => {
    const q = await callApi('broadcastQuota', {});
    const el = document.getElementById('quota-line');
    if (!el) return;
    if (!q.ok) {
      el.innerHTML = q.error === 'no_token'
        ? '⚠️ 配信用トークンが未設定です（管理者にご連絡ください）。'
        : '残り通数を取得できませんでした（' + escapeHtml(q.error || '') + '）。';
      el.className = 'muted warn';
      return;
    }
    if (q.remaining == null) { el.textContent = '今月の配信可能数：上限なし'; return; }
    el.innerHTML = `今月の残り：<strong>約${q.remaining}通</strong>（上限${q.limit}・使用済${q.used}）。友だち1人につき1通を消費します。`;
    if (q.remaining < 120) el.className = 'muted warn';
  })();

  document.getElementById('send-btn').onclick = async () => {
    const text = ta.value.trim();
    if (!text) { alert('文面を入力してください。'); return; }
    if (!confirm('公式LINEの友だち全員に配信します。送信後は取り消せません。よろしいですか？')) return;
    const btn = document.getElementById('send-btn');
    btn.disabled = true; btn.textContent = '配信中...';
    const res = await callApi('broadcast', { text });
    if (res.ok && res.sent) {
      $app.innerHTML = `
        <section class="screen">
          <h1>配信しました</h1>
          <div class="card"><p>✅ 公式LINEの友だち全員に配信しました。</p></div>
          <button class="btn back" id="done-btn">‹ ${escapeHtml(backLabel)}</button>
        </section>`;
      document.getElementById('done-btn').onclick = backFn;
    } else {
      const msg = res.error === 'no_token' ? '配信用トークンが未設定です。'
        : res.error === 'line_api_error' ? `LINE側でエラー（${res.status}）：${res.detail || ''}`
        : (res.error || 'unknown');
      alert('配信に失敗しました：' + msg);
      btn.disabled = false; btn.textContent = 'この内容で配信する';
    }
  };
}

const MATERIAL_CATEGORIES = ['イベント', '会報', '総会資料', 'Q&A', 'その他'];

// カテゴリ別の色（淡い地＋濃い文字）。未知カテゴリは「その他」色。
const CATEGORY_COLORS = {
  'イベント': ['var(--ok-soft)', 'var(--ok-ink)'],
  '会報': ['var(--cat-member-soft)', 'var(--cat-member-ink)'],
  '総会資料': ['var(--cat-docs-soft)', 'var(--cat-docs-ink)'],
  'Q&A': ['var(--hold-soft)', 'var(--hold-ink)'],
  'その他': ['var(--off-soft)', 'var(--off-ink)'],
};
function categoryChip(cat) {
  const c = CATEGORY_COLORS[cat] || CATEGORY_COLORS['その他'];
  return `<span class="catchip" style="background:${c[0]};color:${c[1]}">${escapeHtml(cat || 'その他')}</span>`;
}
const CATEGORY_ICONS = { 'イベント': 'calendar', '会報': 'book', '総会資料': 'list', 'Q&A': 'bell', 'その他': 'book' };
function categoryIcon(cat) { return CATEGORY_ICONS[cat] || 'book'; }
// 直近 NEW_DAYS 日以内に登録/公開された資料は「NEW」
const NEW_DAYS = 31;
function isNewByDate(publishedAt) {
  if (!publishedAt) return false;
  const t = Date.parse(publishedAt + 'T00:00:00');
  if (isNaN(t)) return false;
  return (Date.now() - t) <= NEW_DAYS * 24 * 3600 * 1000 && (Date.now() - t) >= -2 * 24 * 3600 * 1000;
}
function newBadge() { return `<span class="newbadge">NEW</span>`; }
// 資料がNEW＝直近31日に登録 または ひもづく行事が募集中（終了で自動的に消える）
function isNewMaterial(m) { return isNewByDate(m && m.publishedAt) || !!(m && m.eventOpen); }

function renderMaterialForm(m) {
  const cur = m || { title: '', category: 'イベント', url: '', status: '公開' };
  const isFileMat = !!(m && m.isFile);
  // 既存資料が一覧外の旧カテゴリ（例：しおり）を持つ場合は先頭に足して保持
  const catOpts = MATERIAL_CATEGORIES.slice();
  if (cur.category && !catOpts.includes(cur.category)) catOpts.unshift(cur.category);
  $app.innerHTML = `
    <section class="screen">
      <h1>${m ? '資料の編集' : '資料の追加'}</h1>
      <label>タイトル <span class="req">*</span></label>
      <input id="m-title" value="${escapeAttr(cur.title)}">
      <label>カテゴリ</label>
      <select id="m-cat">
        ${catOpts.map(c => `<option value="${c}" ${cur.category === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <label>関連する行事（任意）</label>
      <select id="m-event">
        <option value="">（なし）</option>
        ${(state.adminEvents || []).map(e => `<option value="${escapeAttr(e.eventId)}" ${cur.eventId === e.eventId ? 'selected' : ''}>${escapeHtml(e.name)}（${escapeHtml(e.date || '')}）</option>`).join('')}
      </select>
      <p class="hint">行事にひもづけると、その行事一覧にも資料が表示され、募集中の間は「NEW」が付きます。行事側は「行事の管理」で作成できます。</p>
      ${isFileMat ? `
      <div class="card"><p>アップロード済みファイル：<strong>${escapeHtml(cur.note || cur.title)}</strong></p>
      <p class="muted">差し替えるときは、新しく「資料を追加」してください。</p></div>` : `
      ${m ? '' : `
      <label>① ファイルをアップロード（PDF等）</label>
      <input id="m-file" type="file" accept="application/pdf,image/*">
      <p class="hint">アップロードしたファイルは Cloudflare に安全に保管し、<strong>承認会員だけ</strong>が閲覧できます（リンクが漏れても期限切れ＆認証で保護）。</p>
      <label>② または URL（Googleドライブ等の共有リンク）</label>` /* edit-link: just URL */}
      ${m ? '<label>URL（共有リンク）</label>' : ''}
      <input id="m-url" type="url" placeholder="https://drive.google.com/..." value="${escapeAttr(cur.url)}">`}
      <p class="hint">資料はすべて会員限定です（登録会員のみ閲覧）。</p>
      <label class="check"><input type="checkbox" id="m-pub" ${cur.status !== '非公開' ? 'checked' : ''}> 公開する（オフで非公開＝会員にも表示されません）</label>
      <div class="actions">
        <button class="btn back" id="back-btn">‹ 戻る</button>
        <button class="btn primary" id="submit-btn">保存</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminMaterials;
  document.getElementById('submit-btn').onclick = async () => {
    const title = document.getElementById('m-title').value.trim();
    const category = document.getElementById('m-cat').value;
    const eventId = document.getElementById('m-event').value;
    const status = document.getElementById('m-pub').checked ? '公開' : '非公開';
    if (!title) { alert('タイトルは必須です。'); return; }

    const fileInput = document.getElementById('m-file');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (file) {
      const btn = document.getElementById('submit-btn');
      btn.disabled = true; btn.textContent = 'アップロード中...';
      const res = await uploadMaterialFile(file, { title, category, status, eventId });
      if (res.ok) { renderAdminMaterials(); }
      else { alert('アップロードに失敗しました：' + (res.error || 'unknown')); btn.disabled = false; btn.textContent = '保存'; }
      return;
    }

    const urlEl = document.getElementById('m-url');
    const url = urlEl ? urlEl.value.trim() : '';
    if (!isFileMat && !url) { alert('ファイルを選ぶか、URLを入力してください。'); return; }
    const payload = { title, url, category, status, eventId };
    if (m) payload.id = m.id;
    const res = await callApi('adminUpsertMaterial', payload);
    if (res.ok) { renderAdminMaterials(); }
    else { alert('保存に失敗しました：' + (res.error || 'unknown')); }
  };
}

// 管理者によるファイルアップロード（R2へ。認証はX-Id-Tokenヘッダ）
async function uploadMaterialFile(file, meta) {
  try {
    const qs = new URLSearchParams({ title: meta.title, category: meta.category, status: meta.status, filename: file.name, eventId: meta.eventId || '' }).toString();
    const res = await fetch(window.APP_CONFIG.GAS_URL.replace(/\/$/, '') + '/upload?' + qs, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Id-Token': state.idToken },
      body: file,
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: 'network_error' };
  }
}

// CSV生成＆ダウンロード（Excelの文字化け回避にUTF-8 BOMを付与）
function downloadCsv(filename, rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');
  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert('CSVのダウンロードに失敗しました。PCのブラウザでお試しください。');
  }
}

// ===== ユーティリティ =====
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ===== インラインSVGアイコン（外部依存なし。currentColorで色がつく） =====
const ICONS = {
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/>',
  book: '<path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 0-2 2z"/><path d="M5 19.5a2 2 0 0 1 2-2h11"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c0-3.6 3-5.6 7-5.6s7 2 7 5.6"/>',
  admin: '<path d="M4 8h9M19 8h1M4 16h5M15 16h5"/><circle cx="15.5" cy="8" r="2"/><circle cx="11.5" cy="16" r="2"/>',
  money: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.4"/>',
  bell: '<path d="M6 9.5a6 6 0 0 1 12 0c0 4.5 2 5.5 2 5.5H4s2-1 2-5.5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v5M12 15.5h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/>',
  send: '<path d="M20.5 4 3.5 11l6.5 2.2L12 20l2-6z"/><path d="M20.5 4 9.8 13.2"/>',
  download: '<path d="M12 4v10M8 11l4 4 4-4M5 19h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  back: '<path d="M14 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};
function icon(name, cls) {
  const p = ICONS[name];
  if (!p) return '';
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

// 状態バッジ（色＋アイコン＋文字の三点で伝える）。kind: ok/todo/hold/off
function statusBadge(kind, label) {
  const map = { ok: ['st-ok', 'check'], todo: ['st-todo', 'alert'], hold: ['st-hold', 'clock'], off: ['st-off', 'ban'] };
  const [cls, ic] = map[kind] || map.off;
  return `<span class="st ${cls}">${icon(ic)}${escapeHtml(label)}</span>`;
}
// 行事の状態 → バッジ種別
function eventStatusKind(s) { return s === '募集中' ? 'ok' : s === '中止' ? 'off' : 'hold'; }

init();
