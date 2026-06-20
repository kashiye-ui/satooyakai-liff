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
};

const $app = document.getElementById('app');

// ===== 起動 =====
async function init() {
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

// マイページ（ホーム）へ戻る。最新の登録状態を取り直して表示する。
async function goHome() {
  const result = await callApi('checkUser', {});
  if (result.ok && result.registered) {
    renderHome(result);
  } else {
    renderAgreement();
  }
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

      <button class="card-btn" id="nav-events">
        <strong>イベント</strong>
        <span>行事の案内・出欠の回答・参加履歴</span>
      </button>
      <button class="card-btn" id="nav-docs">
        <strong>お役立ち資料</strong>
        <span>しおり・会報・総会資料・Q&amp;A</span>
      </button>

      ${data.isAdmin ? `
      <button class="card-btn" id="nav-admin">
        <strong>管理メニュー</strong>
        <span>運営・理事用（会員名簿・行事・会費・資料）</span>
      </button>` : ''}

      <p class="muted">ご家族も、それぞれのLINEから「家族として参加」でご登録いただけます。</p>
    </section>
  `;
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

  const openCard = (e) => `
    <div class="card">
      <p><strong>${escapeHtml(e.name)}</strong></p>
      <p class="muted">${escapeHtml(e.date)}${e.place ? ' ／ ' + escapeHtml(e.place) : ''}</p>
      <p class="muted">${feeText(e)}${e.deadline ? ' ／ 申込締切 ' + escapeHtml(e.deadline) : ''}</p>
      ${e.myResponse ? `<p>✓ 回答済み：大人 ${e.myResponse.adultCount}名・子ども ${e.myResponse.childCount}名${e.myResponse.total > 0 ? '（参加費 ' + e.myResponse.total.toLocaleString() + '円）' : ''}</p>` : ''}
      <button class="btn primary act" data-id="${escapeAttr(e.eventId)}">${e.myResponse ? '回答を変更する' : '出欠を回答する'}</button>
    </div>`;

  const pastCard = (e) => `
    <div class="card">
      <p><strong>${escapeHtml(e.name)}</strong> <span class="muted">（${escapeHtml(e.status)}）</span></p>
      <p class="muted">${escapeHtml(e.date)}${e.place ? ' ／ ' + escapeHtml(e.place) : ''}</p>
      ${e.myResponse ? `<p>参加：大人 ${e.myResponse.adultCount}名・子ども ${e.myResponse.childCount}名</p>` : '<p class="muted">参加記録なし</p>'}
    </div>`;

  $app.innerHTML = `
    <section class="screen">
      ${topBar('イベント', 'マイページ')}
      <h1>イベント</h1>
      <h2 class="sub">受付中の行事</h2>
      ${open.length ? open.map(openCard).join('') : '<p class="muted">現在、受付中の行事はありません。</p>'}
      ${past.length ? `<h2 class="sub">過去の行事</h2>${past.map(pastCard).join('')}` : ''}
      <button class="btn" id="home-btn" style="margin-top:24px;">マイページへ戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
    mats.forEach(m => { (groups[m.category] = groups[m.category] || []).push(m); });
    body = Object.keys(groups).map(cat => `
      <h2 class="sub">${escapeHtml(cat)}</h2>
      ${groups[cat].map(m => `
        <button class="card-btn doc-link" data-url="${escapeAttr(m.url)}">
          <strong>${escapeHtml(m.title)}</strong>
          <span>${escapeHtml(m.publishedAt || '')}${m.visibility === '会員限定' ? '・会員限定' : ''}</span>
        </button>`).join('')}
    `).join('');
  }

  $app.innerHTML = `
    <section class="screen">
      ${topBar('お役立ち資料', 'マイページ')}
      <h1>お役立ち資料</h1>
      ${body}
      <button class="btn" id="home-btn" style="margin-top:24px;">マイページへ戻る</button>
    </section>
  `;
  document.getElementById('topback').onclick = goHome;
  document.getElementById('home-btn').onclick = goHome;
  document.querySelectorAll('button.doc-link').forEach(b => {
    b.onclick = () => {
      if (b.dataset.url) openUrl(b.dataset.url, true);
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
      <button class="btn" id="home-btn">マイページへ戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
      <h1>登録が完了しました</h1>
      <p>さいたま市里親会へようこそ。</p>
      <div class="card">
        <p><strong>${escapeHtml(name)}</strong> さん</p>
        <p>世帯ID: ${escapeHtml(householdId)}</p>
      </div>
      <p class="muted">ご家族の方も、同じ手順で「家族として参加」からご登録いただけます。</p>
      <div class="actions">
        <button class="btn" id="home-btn">マイページへ</button>
        <button class="btn primary" id="close-btn">閉じる</button>
      </div>
    </section>
  `;
  document.getElementById('home-btn').onclick = goHome;
  document.getElementById('close-btn').onclick = () => {
    if (liff.isInClient()) liff.closeWindow();
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

// ===== 管理画面（運営・理事向け / ?view=admin） =====
async function renderAdmin() {
  $app.innerHTML = `<section class="screen"><h1>管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminCheck', {});
  if (!res.ok) return renderActionError('管理', res.error);
  if (!res.isAdmin) {
    $app.innerHTML = `
      <section class="screen">
        <h1>管理</h1>
        <div class="card warn">
          <p>この画面は運営（理事）専用です。閲覧権限がありません。</p>
          <p class="muted">権限が必要な場合は、次のIDを管理者にお伝えください。</p>
          <p class="mono">${escapeHtml(res.userId || '')}</p>
        </div>
        <button class="btn" id="home-btn">マイページへ戻る</button>
      </section>`;
    document.getElementById('home-btn').onclick = goHome;
    return;
  }
  renderAdminHome();
}

function renderAdminHome() {
  $app.innerHTML = `
    <section class="screen">
      <h1>管理メニュー</h1>
      <button class="card-btn" id="a-events"><strong>行事の参加者管理</strong><span>申込状況・参加費の回収・代理入力・CSV出力</span></button>
      <button class="card-btn" id="a-members"><strong>会員名簿</strong><span>世帯・個人の一覧・LINEなし世帯の代理登録・CSV出力</span></button>
      <button class="card-btn" id="a-fees"><strong>会費の管理</strong><span>年会費の納付状況・未納一覧</span></button>
      <button class="card-btn" id="a-materials"><strong>資料の管理</strong><span>会報・しおり等の追加・公開/非公開</span></button>
      <button class="btn" id="home-btn" style="margin-top:24px;">マイページへ戻る</button>
    </section>
  `;
  document.getElementById('a-events').onclick = renderAdminEvents;
  document.getElementById('a-members').onclick = renderAdminHouseholds;
  document.getElementById('a-fees').onclick = renderAdminFees;
  document.getElementById('a-materials').onclick = renderAdminMaterials;
  document.getElementById('home-btn').onclick = goHome;
}

async function renderAdminEvents() {
  $app.innerHTML = `<section class="screen"><h1>行事の参加者管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListEvents', {});
  if (!res.ok) return renderActionError('行事の参加者管理', res.error);
  const evs = res.events || [];
  state.adminEvents = evs;
  const card = (e, i) => `
    <div class="card">
      <p><strong>${escapeHtml(e.name)}</strong> <span class="muted">（${escapeHtml(e.status)}）${e.hasFeeSchedule ? '・区分別料金' : ''}</span></p>
      <p class="muted">${escapeHtml(e.date)}${e.place ? ' ／ ' + escapeHtml(e.place) : ''}</p>
      <p class="muted">${e.counts.households}世帯・大人${e.counts.adults}・子ども${e.counts.children}</p>
      <div class="actions" style="margin-top:6px;">
        <button class="chip roster-btn" data-id="${escapeAttr(e.eventId)}">参加者一覧</button>
        <button class="chip ev-edit" data-i="${i}">編集</button>
      </div>
    </div>`;
  $app.innerHTML = `
    <section class="screen">
      ${topBar('行事の参加者管理', '管理メニュー')}
      <h1>行事の参加者管理</h1>
      <button class="btn" id="new-ev-btn">＋ 行事を新規作成</button>
      ${evs.length ? evs.map(card).join('') : '<p class="muted">行事がありません。</p>'}
      <button class="btn" id="back-btn" style="margin-top:24px;">管理メニューへ</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  document.getElementById('new-ev-btn').onclick = () => renderEventForm(null);
  document.querySelectorAll('button.roster-btn').forEach(b => {
    b.onclick = () => renderAdminRoster(b.dataset.id);
  });
  document.querySelectorAll('button.ev-edit').forEach(b => {
    b.onclick = () => renderEventForm(state.adminEvents[+b.dataset.i]);
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
      <label>ステータス</label>
      <select id="ev-status">${EVENT_STATUSES.map(s => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <label>備考</label>
      <input id="ev-note" value="${escapeAttr(c.note)}">
      <div class="actions">
        <button class="btn" id="back-btn">戻る</button>
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
  $app.innerHTML = `<section class="screen"><h1>参加者一覧</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminEventRoster', { eventId });
  if (!res.ok) return renderActionError('参加者一覧', res.error);
  state.adminRoster = { eventId, event: res.event, rows: res.rows || [] };
  drawAdminRoster();
}

// state.adminRoster をもとに名簿を描画する（支払トグルの即時反映に使う）
function drawAdminRoster() {
  const { eventId, event, rows } = state.adminRoster;
  const hasFee = rows.some(r => r.total > 0);

  // 回収集計（参加費が発生する行事のみ意味がある）
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

  const trs = rows.map((r, i) => `
    <tr>
      <td>${escapeHtml(r.ku)}</td><td>${escapeHtml(r.representativeName)}</td>
      <td class="num">${r.adultCount}</td><td class="num">${r.childCount}</td>
      <td class="num">${r.total > 0 ? r.total.toLocaleString() : '—'}</td>
      <td>${r.total > 0
        ? `<button class="chip ${r.payStatus === '済' ? 'on' : 'off'} pay-toggle" data-i="${i}">${r.payStatus === '済' ? '済' : '未'}</button>`
        : '<span class="muted">—</span>'}</td>
      <td><button class="chip edit-att" data-i="${i}">編集</button></td>
    </tr>`).join('');

  $app.innerHTML = `
    <section class="screen">
      ${topBar('参加者一覧', '行事一覧')}
      <h1>${escapeHtml(event.name)}</h1>
      <p class="muted">${escapeHtml(event.date || '')} ／ ${rows.length}世帯</p>
      ${summary}
      ${rows.length ? `
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>区</th><th>世帯代表者</th><th>大人</th><th>子</th><th>参加費</th><th>支払</th><th></th></tr></thead>
          <tbody>${trs}</tbody>
        </table></div>
        <p class="hint">「支払」の済/未はタップで切り替わります。${hasFee ? '' : 'この行事は参加費が無料です。'}</p>
        <button class="btn primary" id="csv-btn" style="margin-top:8px;">CSVをダウンロード</button>
        <p class="hint">ダウンロードはPCのブラウザ推奨です。</p>
      ` : '<p class="muted">まだ回答がありません。</p>'}
      <button class="btn" id="proxy-btn" style="margin-top:8px;">LINEなし世帯を代理で入力</button>
      <button class="btn" id="back-btn" style="margin-top:8px;">行事一覧へ</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminEvents;
  document.getElementById('back-btn').onclick = renderAdminEvents;
  document.getElementById('proxy-btn').onclick = () => renderProxyHouseholdPicker(eventId, event);

  document.querySelectorAll('button.pay-toggle').forEach(b => {
    b.onclick = async () => {
      const r = rows[+b.dataset.i];
      const next = r.payStatus === '済' ? '未' : '済';
      b.disabled = true;
      const resp = await callApi('adminSetPayStatus', { eventId, householdId: r.householdId, payStatus: next });
      if (resp.ok) { r.payStatus = next; drawAdminRoster(); }
      else { alert('支払状況の更新に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
  document.querySelectorAll('button.edit-att').forEach(b => {
    b.onclick = () => {
      const r = rows[+b.dataset.i];
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
      <button class="btn" id="back-btn" style="margin-top:16px;">参加者一覧へ戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
  $app.innerHTML = `<section class="screen"><h1>会員名簿</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListHouseholds', {});
  if (!res.ok) return renderActionError('会員名簿', res.error);
  const hs = (res.households || []).slice()
    .sort((a, b) => ((a.ku + a.representativeName) < (b.ku + b.representativeName) ? -1 : 1));

  // 1会員=1行に展開（世帯順）。世帯情報は各行に繰り返す＝PCで一覧・並べ替えしやすい。
  const rows = [];
  hs.forEach((h) => {
    const ms = (h.members && h.members.length) ? h.members : [null];
    ms.forEach((m, mi) => rows.push({ h, m, isRep: mi === 0 }));
  });
  const memberCount = rows.filter(r => r.m).length;

  const adminCell = (m) => {
    const isLine = m.lineUserId && String(m.lineUserId).indexOf('U') === 0;
    if (m.isFixedAdmin) return '<span class="chip on" style="pointer-events:none;">固定</span>';
    if (isLine) return `<button class="chip ${m.isAdmin ? 'on' : ''} admin-toggle" data-uid="${escapeAttr(m.lineUserId)}" data-on="${m.isAdmin ? '1' : '0'}" data-name="${escapeAttr(m.name)}">${m.isAdmin ? '管理者' : '管理者にする'}</button>`;
    return '<span class="muted">—</span>';
  };
  const trOf = (r) => {
    const h = r.h, m = r.m;
    return `<tr>
      <td>${escapeHtml(h.ku)}</td>
      <td>${escapeHtml(h.representativeName)}</td>
      <td>${m ? escapeHtml(m.name) : '<span class="muted">（会員なし）</span>'}</td>
      <td>${m ? escapeHtml(m.role) : ''}</td>
      <td>${escapeHtml(h.fosterType || '')}</td>
      <td>${escapeHtml(h.feeStatus || '')}</td>
      <td>${m ? (m.status !== '有効' ? '<span class="muted">' + escapeHtml(m.status) + '</span>' : '有効') : ''}</td>
      <td>${m ? adminCell(m) : ''}</td>
      <td>${r.isRep ? `<button class="chip add-member" data-hid="${escapeAttr(h.householdId)}" data-label="${escapeAttr(h.ku + ' ' + h.representativeName)}">＋家族</button>` : ''}</td>
    </tr>`;
  };

  $app.innerHTML = `
    <section class="screen">
      ${topBar('会員名簿', '管理メニュー')}
      <h1>会員名簿</h1>
      <p class="muted">${hs.length}世帯・${memberCount}名</p>
      <button class="btn" id="new-h-btn">＋ LINEなし世帯を登録</button>
      ${rows.length ? `
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>区</th><th>世帯代表者</th><th>氏名</th><th>立場</th><th>里親種別</th><th>会費</th><th>状態</th><th>管理者</th><th>操作</th></tr></thead>
          <tbody>${rows.map(trOf).join('')}</tbody>
        </table></div>
        <button class="btn primary" id="csv-btn" style="margin-top:8px;">CSVをダウンロード（個人単位）</button>
        <p class="hint">PCのブラウザでの操作・ダウンロードを推奨します。表は横にスクロールできます。</p>
      ` : '<p class="muted">登録された世帯がありません。</p>'}
      <button class="btn" id="back-btn" style="margin-top:8px;">管理メニューへ</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  document.getElementById('new-h-btn').onclick = renderProxyNewHousehold;
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
  const csvBtn = document.getElementById('csv-btn');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const header = ['世帯ID', '区', '世帯代表者', '電話', '里親種別', '会費納付', '氏名', '立場', '状態'];
      const data = [];
      hs.forEach(h => h.members.forEach(m => data.push([h.householdId, h.ku, h.representativeName, h.phone, h.fosterType, h.feeStatus, m.name, m.role, m.status])));
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
        <button class="btn" id="back-btn">戻る</button>
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
        <button class="btn" id="back-btn">戻る</button>
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
  $app.innerHTML = `<section class="screen"><h1>会費の管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListHouseholds', {});
  if (!res.ok) return renderActionError('会費の管理', res.error);
  state.adminFees = {
    fiscalYear: res.fiscalYear,
    households: (res.households || []).filter(h => h.status === '有効'),
    unpaidOnly: false,
  };
  drawAdminFees();
}

function drawAdminFees() {
  const { fiscalYear, households, unpaidOnly } = state.adminFees;
  const paidN = households.filter(h => h.feePaid).length;
  const unpaidN = households.length - paidN;
  const list = unpaidOnly ? households.filter(h => !h.feePaid) : households;

  const row = (h, i) => `
    <div class="card">
      <p><strong>${escapeHtml(h.ku)} ${escapeHtml(h.representativeName)}</strong>
         <span class="muted">${escapeHtml(h.householdId)}</span></p>
      <button class="chip ${h.feePaid ? 'on' : 'off'} fee-toggle" data-id="${escapeAttr(h.householdId)}">
        ${h.feePaid ? '納付済' : '未納'}
      </button>
    </div>`;

  $app.innerHTML = `
    <section class="screen">
      ${topBar('会費の管理', '管理メニュー')}
      <h1>会費の管理</h1>
      <div class="card">
        <p><strong>${fiscalYear}年度</strong></p>
        <p>納付済：${paidN}世帯 ／ 未納：${unpaidN}世帯（計 ${households.length}世帯）</p>
      </div>
      <label class="check"><input type="checkbox" id="unpaid-only" ${unpaidOnly ? 'checked' : ''}> 未納のみ表示</label>
      ${list.length ? list.map(row).join('') : '<p class="muted">該当する世帯はありません。</p>'}
      <button class="btn primary" id="csv-btn" style="margin-top:8px;">未納一覧をCSVで出力</button>
      <p class="hint">「納付済 / 未納」はタップで切り替わります（${fiscalYear}年度分）。</p>
      <button class="btn" id="back-btn" style="margin-top:8px;">管理メニューへ</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
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
  $app.innerHTML = `<section class="screen"><h1>資料の管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListAllMaterials', {});
  if (!res.ok) return renderActionError('資料の管理', res.error);
  state.adminMaterials = res.materials || [];
  drawAdminMaterials();
}

function drawAdminMaterials() {
  const mats = state.adminMaterials;
  const card = (m, i) => `
    <div class="card${m.status === '非公開' ? ' warn' : ''}">
      <p><strong>${escapeHtml(m.title)}</strong>
         <span class="muted">${escapeHtml(m.category)}${m.visibility === '会員限定' ? '・会員限定' : ''}</span></p>
      <p class="muted" style="word-break:break-all;">${escapeHtml(m.url)}</p>
      <div class="actions" style="margin-top:6px;">
        <button class="chip ${m.status === '公開' ? 'on' : 'off'} mat-toggle" data-i="${i}">${escapeHtml(m.status)}</button>
        <button class="chip mat-edit" data-i="${i}">編集</button>
      </div>
    </div>`;
  $app.innerHTML = `
    <section class="screen">
      ${topBar('資料の管理', '管理メニュー')}
      <h1>資料の管理</h1>
      <p class="hint">PDFはGoogleドライブ等の共有URLを登録します（このアプリにファイルは保存しません）。共有設定は「リンクを知っている全員が閲覧可」にしてください。</p>
      <button class="btn" id="new-btn">＋ 資料を追加</button>
      ${mats.length ? mats.map(card).join('') : '<p class="muted">資料がありません。</p>'}
      <button class="btn" id="back-btn" style="margin-top:8px;">管理メニューへ</button>
    </section>
  `;
  document.getElementById('topback').onclick = renderAdminHome;
  document.getElementById('back-btn').onclick = renderAdminHome;
  document.getElementById('new-btn').onclick = () => renderMaterialForm(null);
  document.querySelectorAll('button.mat-edit').forEach(b => {
    b.onclick = () => renderMaterialForm(mats[+b.dataset.i]);
  });
  document.querySelectorAll('button.mat-toggle').forEach(b => {
    b.onclick = async () => {
      const m = mats[+b.dataset.i];
      const next = m.status === '公開' ? '非公開' : '公開';
      b.disabled = true;
      const resp = await callApi('adminSetMaterialStatus', { id: m.id, status: next });
      if (resp.ok) { m.status = next; drawAdminMaterials(); }
      else { alert('公開状態の更新に失敗しました：' + (resp.error || 'unknown')); b.disabled = false; }
    };
  });
}

const MATERIAL_CATEGORIES = ['会報', 'しおり', '総会資料', 'Q&A', 'その他'];

function renderMaterialForm(m) {
  const cur = m || { title: '', category: 'その他', url: '', visibility: '公開', status: '公開' };
  $app.innerHTML = `
    <section class="screen">
      <h1>${m ? '資料の編集' : '資料の追加'}</h1>
      <label>タイトル <span class="req">*</span></label>
      <input id="m-title" value="${escapeAttr(cur.title)}">
      <label>カテゴリ</label>
      <select id="m-cat">
        ${MATERIAL_CATEGORIES.map(c => `<option value="${c}" ${cur.category === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <label>URL（PDF等の共有リンク） <span class="req">*</span></label>
      <input id="m-url" type="url" placeholder="https://drive.google.com/..." value="${escapeAttr(cur.url)}">
      <label>公開範囲</label>
      <div class="radios">
        <label class="radio"><input type="radio" name="m-vis" value="公開" ${cur.visibility !== '会員限定' ? 'checked' : ''}> 全員に公開</label>
        <label class="radio"><input type="radio" name="m-vis" value="会員限定" ${cur.visibility === '会員限定' ? 'checked' : ''}> 会員限定</label>
      </div>
      <label class="check"><input type="checkbox" id="m-pub" ${cur.status !== '非公開' ? 'checked' : ''}> 公開する（オフで非公開）</label>
      <div class="actions">
        <button class="btn" id="back-btn">戻る</button>
        <button class="btn primary" id="submit-btn">保存</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminMaterials;
  document.getElementById('submit-btn').onclick = async () => {
    const title = document.getElementById('m-title').value.trim();
    const url = document.getElementById('m-url').value.trim();
    const category = document.getElementById('m-cat').value;
    const visEl = document.querySelector('input[name="m-vis"]:checked');
    const visibility = visEl ? visEl.value : '公開';
    const status = document.getElementById('m-pub').checked ? '公開' : '非公開';
    if (!title || !url) {
      alert('タイトルとURLは必須です。');
      return;
    }
    const payload = { title, url, category, visibility, status };
    if (m) payload.id = m.id;
    const res = await callApi('adminUpsertMaterial', payload);
    if (res.ok) { renderAdminMaterials(); }
    else { alert('保存に失敗しました：' + (res.error || 'unknown')); }
  };
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

init();
