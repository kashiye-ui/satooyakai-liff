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

const state = {
  profile: null,
  idToken: null,
  // 入力中データ
  agreedTerms: false,
  agreedPrivacy: false,
  newHousehold: null, // { ku, lastName, firstName, phone, fosterType }
  joinHousehold: null, // 検索ヒット結果
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

  const result = await callApi('checkUser', {});
  if (result.ok && result.registered) {
    renderHome(result);
  } else {
    renderAgreement();
  }
}

async function callApi(action, payload) {
  try {
    const res = await fetch(window.APP_CONFIG.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      <h1>さいたま市里親会</h1>
      <p>${escapeHtml(m.name || '')} さん、こんにちは。</p>
      <div class="card">
        <p><strong>世帯ID:</strong> ${escapeHtml(h.householdId || '')}</p>
        <p><strong>世帯代表者:</strong> ${escapeHtml(h.representativeName || '')}</p>
        <p><strong>区:</strong> ${escapeHtml(h.ku || '')}</p>
        <p><strong>あなたのお立場:</strong> ${escapeHtml(m.role || '')}</p>
      </div>
      <p class="muted">ご家族も「家族として参加」から登録できます。</p>
    </section>
  `;
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
  document.getElementById('open-terms').onclick = (e) => { e.preventDefault(); alert('利用規約は別途整備予定です'); };
  document.getElementById('open-privacy').onclick = (e) => { e.preventDefault(); alert('プライバシーポリシーは別途整備予定です'); };
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
      <button class="btn primary" id="close-btn">閉じる</button>
    </section>
  `;
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
