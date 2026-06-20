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

  // 管理画面は登録の有無に関わらず、許可されたLINEユーザーのみ（認可はGAS側で検証）
  if (getView() === 'admin') {
    return renderAdmin();
  }

  const result = await callApi('checkUser', {});
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

async function callApi(action, payload) {
  try {
    // Content-Type ヘッダーを指定しないことで preflight (OPTIONS) を回避する。
    // GAS Web App は OPTIONS をサポートしないため、CORS preflight が発生するとエラーになる。
    // body を文字列として渡すと、ブラウザは Content-Type を text/plain で送信する。
    const res = await fetch(window.APP_CONFIG.GAS_URL, {
      method: 'POST',
      body: JSON.stringify({ action, idToken: state.idToken, payload }),
    });
    return await res.json();
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
      <h1>マイページ</h1>
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

      <p class="muted">ご家族も、それぞれのLINEから「家族として参加」でご登録いただけます。</p>
    </section>
  `;
  document.getElementById('nav-events').onclick = renderEvents;
  document.getElementById('nav-docs').onclick = renderDocs;
}

// ===== 画面: イベント一覧 =====
function feeText(e) {
  if (e.adultFee === 0 && e.childFee === 0) return '参加費：無料';
  return `参加費：大人 ${e.adultFee.toLocaleString()}円 / 子ども ${e.childFee.toLocaleString()}円`;
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
      ${e.myResponse ? `<p>✓ 回答済み：大人 ${e.myResponse.adultCount}名・子ども ${e.myResponse.childCount}名</p>` : ''}
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
      <h1>イベント</h1>
      <h2 class="sub">受付中の行事</h2>
      ${open.length ? open.map(openCard).join('') : '<p class="muted">現在、受付中の行事はありません。</p>'}
      ${past.length ? `<h2 class="sub">過去の行事</h2>${past.map(pastCard).join('')}` : ''}
      <button class="btn" id="home-btn" style="margin-top:24px;">マイページへ戻る</button>
    </section>
  `;
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

      <label>参加する大人の人数 <span class="req">*</span></label>
      <input id="adult" type="number" inputmode="numeric" min="0" value="${r.adultCount != null ? r.adultCount : 1}">

      <label>参加する子どもの人数 <span class="req">*</span></label>
      <input id="child" type="number" inputmode="numeric" min="0" value="${r.childCount != null ? r.childCount : 0}">

      <label>特記事項（アレルギー等・任意）</label>
      <input id="notes" type="text" value="${escapeAttr(r.notes)}">
      <p class="hint">欠席される場合は、大人・子どもとも 0 にしてください。</p>

      <div class="actions">
        <button class="btn" id="back-btn">戻る</button>
        <button class="btn primary" id="submit-btn">この内容で回答</button>
      </div>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderEvents;
  document.getElementById('submit-btn').onclick = async () => {
    const adultCount = parseInt(document.getElementById('adult').value, 10);
    const childCount = parseInt(document.getElementById('child').value, 10);
    const notes = document.getElementById('notes').value.trim();
    if (isNaN(adultCount) || isNaN(childCount) || adultCount < 0 || childCount < 0) {
      alert('参加人数を正しく入力してください。');
      return;
    }
    const res = await callApi('submitAttendance', {
      eventId: ev.eventId, adultCount, childCount, notes,
    });
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
      <h1>お役立ち資料</h1>
      ${body}
      <button class="btn" id="home-btn" style="margin-top:24px;">マイページへ戻る</button>
    </section>
  `;
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
  var dbgAud = '';
  try {
    var _p = state.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    var _pad = _p + '==='.slice((_p.length + 3) % 4);
    dbgAud = (JSON.parse(atob(_pad)).aud) || '';
  } catch (e) { dbgAud = '(decode失敗)'; }
  $app.innerHTML = `
    <section class="screen">
      <h1>ようこそ</h1>
      <p>さいたま市里親会 公式LINE をご利用いただきありがとうございます。</p>
      <p>ご登録にあたり、利用規約およびプライバシーポリシーをご確認・同意ください。</p>
      <p class="muted">（診断: IDトークン ${state.idToken ? 'あり' : '【なし】'} ／ aud=<strong>${escapeHtml(dbgAud)}</strong>）</p>
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
      <p class="muted">${escapeHtml(detail || '')}</p>
    </section>
  `;
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
      <button class="card-btn" id="a-events"><strong>行事の参加者管理</strong><span>申込状況の確認・CSV出力</span></button>
      <button class="card-btn" id="a-members"><strong>会員名簿</strong><span>世帯・個人の一覧・CSV出力</span></button>
      <button class="btn" id="home-btn" style="margin-top:24px;">マイページへ戻る</button>
    </section>
  `;
  document.getElementById('a-events').onclick = renderAdminEvents;
  document.getElementById('a-members').onclick = renderAdminHouseholds;
  document.getElementById('home-btn').onclick = goHome;
}

async function renderAdminEvents() {
  $app.innerHTML = `<section class="screen"><h1>行事の参加者管理</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListEvents', {});
  if (!res.ok) return renderActionError('行事の参加者管理', res.error);
  const evs = res.events || [];
  const card = (e) => `
    <button class="card-btn admin-ev" data-id="${escapeAttr(e.eventId)}">
      <strong>${escapeHtml(e.name)} <span class="muted">（${escapeHtml(e.status)}）</span></strong>
      <span>${escapeHtml(e.date)} ／ ${e.counts.households}世帯・大人${e.counts.adults}・子ども${e.counts.children}</span>
    </button>`;
  $app.innerHTML = `
    <section class="screen">
      <h1>行事の参加者管理</h1>
      ${evs.length ? evs.map(card).join('') : '<p class="muted">行事がありません。</p>'}
      <button class="btn" id="back-btn" style="margin-top:24px;">管理メニューへ</button>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminHome;
  document.querySelectorAll('button.admin-ev').forEach(b => {
    b.onclick = () => renderAdminRoster(b.dataset.id);
  });
}

async function renderAdminRoster(eventId) {
  $app.innerHTML = `<section class="screen"><h1>参加者一覧</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminEventRoster', { eventId });
  if (!res.ok) return renderActionError('参加者一覧', res.error);
  const rows = res.rows || [];
  const trs = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.ku)}</td><td>${escapeHtml(r.representativeName)}</td>
      <td class="num">${r.adultCount}</td><td class="num">${r.childCount}</td>
      <td>${escapeHtml(r.payStatus)}</td><td>${escapeHtml(r.notes)}</td>
    </tr>`).join('');
  $app.innerHTML = `
    <section class="screen">
      <h1>${escapeHtml(res.event.name)}</h1>
      <p class="muted">${escapeHtml(res.event.date || '')} ／ ${rows.length}世帯</p>
      ${rows.length ? `
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>区</th><th>世帯代表者</th><th>大人</th><th>子</th><th>支払</th><th>特記</th></tr></thead>
          <tbody>${trs}</tbody>
        </table></div>
        <button class="btn primary" id="csv-btn" style="margin-top:16px;">CSVをダウンロード</button>
        <p class="hint">ダウンロードはPCのブラウザ推奨です。</p>
      ` : '<p class="muted">まだ回答がありません。</p>'}
      <button class="btn" id="back-btn" style="margin-top:8px;">行事一覧へ</button>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminEvents;
  const csvBtn = document.getElementById('csv-btn');
  if (csvBtn) {
    csvBtn.onclick = () => {
      const header = ['区', '世帯代表者', '世帯ID', '大人', '子ども', '参加費合計', '支払状況', '特記事項', '回答日時'];
      const data = rows.map(r => [r.ku, r.representativeName, r.householdId, r.adultCount, r.childCount, r.total, r.payStatus, r.notes, r.answeredAt]);
      downloadCsv(`roster_${eventId}.csv`, [header].concat(data));
    };
  }
}

async function renderAdminHouseholds() {
  $app.innerHTML = `<section class="screen"><h1>会員名簿</h1><p>読み込み中...</p></section>`;
  const res = await callApi('adminListHouseholds', {});
  if (!res.ok) return renderActionError('会員名簿', res.error);
  const hs = res.households || [];
  const card = (h) => `
    <div class="card">
      <p><strong>${escapeHtml(h.ku)} ${escapeHtml(h.representativeName)}</strong>
         <span class="muted">${escapeHtml(h.householdId)}${h.fosterType ? '・' + escapeHtml(h.fosterType) : ''}</span></p>
      <p class="muted">${escapeHtml(h.phone || '')}${h.feeStatus ? ' ／ 会費:' + escapeHtml(h.feeStatus) : ''}</p>
      ${h.members.map(m => `<p>・${escapeHtml(m.name)}（${escapeHtml(m.role)}）${m.status !== '有効' ? '<span class="muted">[' + escapeHtml(m.status) + ']</span>' : ''}</p>`).join('')}
    </div>`;
  $app.innerHTML = `
    <section class="screen">
      <h1>会員名簿</h1>
      <p class="muted">${hs.length}世帯</p>
      ${hs.length ? hs.map(card).join('') : '<p class="muted">登録された世帯がありません。</p>'}
      ${hs.length ? '<button class="btn primary" id="csv-btn">CSVをダウンロード（個人単位）</button><p class="hint">ダウンロードはPCのブラウザ推奨です。</p>' : ''}
      <button class="btn" id="back-btn" style="margin-top:8px;">管理メニューへ</button>
    </section>
  `;
  document.getElementById('back-btn').onclick = renderAdminHome;
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
