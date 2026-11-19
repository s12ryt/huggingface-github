/**
 * 前端腳本內容
 *
 * 1. APP_JS — 以原生 fetch 驅動的頁面行為，依 data-page 分派
 *
 * 設計取向：零建置、零框架、零第三方腳本。所有資料以使用者自身憑證向 API 索取，
 * 失敗時顯示原因與下一步，而不是空白或無限載入。
 */
export const APP_JS = `const body = document.body;
const page = body.dataset.page;

const ERRORS = {
  duplicate_token_name: '這個憑證名稱已經用過了',
  forbidden: '你的權限不足',
  invalid_credentials: '帳號或密碼不正確',
  invalid_invite_params: '邀請碼參數不正確',
  invalid_issue: '標題不可空白',
  invalid_payload: '請把欄位填完整',
  invalid_pull: '分支或物件識別碼不正確',
  invalid_repo_name: '儲存庫名稱只接受英數與 . _ -，長度 3 至 100',
  invalid_scope: '權限範圍不正確',
  invite_invalid: '邀請碼無效或已用盡',
  invite_required: '此站台需要邀請碼才能註冊',
  invite_username_not_allowed: '這張邀請碼不允許這個使用者名稱',
  not_found: '找不到資料，或你沒有讀取權限',
  password_mismatch: '兩次輸入的密碼不一致',
  repo_exists: '你已經有同名的儲存庫',
  reserved_username: '這個名稱被系統保留',
  unauthenticated: '請先登入',
  username_taken: '這個使用者名稱已被註冊',
  weak_password: '密碼至少 8 個字元',
};

function say(code) {
  return ERRORS[code] || '操作失敗：' + code;
}

function el(id) {
  return document.getElementById(id);
}

function show(target, message) {
  const node = el(target);
  if (node) node.textContent = message;
}

async function call(method, url, payload) {
  const init = { headers: {}, method };
  if (payload !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(say(data.error || String(res.status)));
  return data;
}

function fields(form) {
  const out = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (value !== '') out[key] = value;
  }
  return out;
}

function onSubmit(id, handler) {
  const form = el(id);
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    show('error', '');
    try {
      await handler(fields(form), form);
    } catch (error) {
      show('error', error.message);
    }
  });
}

function render(id, items, line) {
  const node = el(id);
  if (!node) return;
  if (items.length === 0) {
    node.innerHTML = '<li class="note">' + node.dataset.empty + '</li>';
    return;
  }
  node.innerHTML = items.map(line).join('');
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const repoPath = () => '/api/repos/' + body.dataset.owner + '/' + body.dataset.repo;

const pages = {
  admin() {
    onSubmit('mode-form', async (data) => {
      await call('PATCH', '/api/admin/settings/registration', { registrationMode: data.registrationMode });
      show('error', '已套用註冊模式：' + data.registrationMode);
    });
    onSubmit('invite-form', async (data) => {
      const payload = { note: data.note, role: data.role };
      if (data.maxUses) payload.maxUses = Number(data.maxUses);
      const out = await call('POST', '/api/admin/invites', payload);
      el('issued').textContent = out.code;
      await pages.admin.list();
    });
    pages.admin.list = async () => {
      const out = await call('GET', '/api/admin/invites');
      render('invites', out.codes, (code) =>
        '<li><span class="mono">' + esc(code.codePrefix) + '…</span>' +
        '<span class="meta">' + esc(code.role) + ' · ' + code.usedCount + '/' + code.maxUses + '</span>' +
        '<button data-revoke="' + esc(code.id) + '">撤銷</button></li>');
    };
    el('invites').addEventListener('click', async (event) => {
      const id = event.target.dataset.revoke;
      if (!id) return;
      await call('DELETE', '/api/admin/invites/' + id).catch((error) => show('error', error.message));
      await pages.admin.list();
    });
    call('GET', '/api/auth/registration')
      .then((out) => { el('current-mode').textContent = out.mode; })
      .catch((error) => show('error', error.message));
    pages.admin.list().catch((error) => show('error', error.message));
  },

  issues() {
    const load = async () => {
      const out = await call('GET', repoPath() + '/issues');
      render('items', out.issues, (issue) =>
        '<li><span class="num">#' + issue.number + '</span>' +
        '<a href="#issue-' + issue.number + '">' + esc(issue.title) + '</a>' +
        '<span class="tag" data-state="' + esc(issue.state) + '">' + esc(issue.state) + '</span>' +
        '<span class="meta">' + esc(issue.author) + '</span></li>');
    };
    onSubmit('issue-form', async (data, form) => {
      await call('POST', repoPath() + '/issues', data);
      form.reset();
      await load();
    });
    load().catch((error) => show('error', error.message));
  },

  login() {
    onSubmit('login-form', async (data) => {
      await call('POST', '/api/auth/login', data);
      location.assign('/repos');
    });
  },

  pulls() {
    const load = async () => {
      const out = await call('GET', repoPath() + '/pulls');
      render('items', out.pulls, (pull) =>
        '<li><span class="num">#' + pull.number + '</span>' +
        '<a href="#pull-' + pull.number + '">' + esc(pull.title) + '</a>' +
        '<span class="tag" data-state="' + esc(pull.state) + '">' + esc(pull.state) + '</span>' +
        '<span class="meta">' + esc(pull.headRef) + ' → ' + esc(pull.baseRef) + '</span></li>');
    };
    onSubmit('pull-form', async (data, form) => {
      await call('POST', repoPath() + '/pulls', data);
      form.reset();
      await load();
    });
    load().catch((error) => show('error', error.message));
  },

  register() {
    onSubmit('register-form', async (data) => {
      await call('POST', '/api/auth/register', data);
      location.assign('/repos');
    });
  },

  repo() {
    call('GET', repoPath())
      .then((out) => {
        el('clone').value = out.repo.cloneUrl;
        el('visibility').textContent = out.repo.visibility;
        el('branch').textContent = out.repo.defaultBranch;
        if (out.repo.description) el('description').textContent = out.repo.description;
      })
      .catch((error) => show('error', error.message));
  },

  repos() {
    const load = async () => {
      const out = await call('GET', '/api/repos');
      render('items', out.repos, (repo) =>
        '<li><a href="/' + esc(repo.owner) + '/' + esc(repo.name) + '">' +
        esc(repo.owner) + '/' + esc(repo.name) + '</a>' +
        '<span class="tag">' + esc(repo.visibility) + '</span>' +
        '<span class="meta">' + esc(repo.description || '') + '</span></li>');
    };
    onSubmit('repo-form', async (data, form) => {
      await call('POST', '/api/repos', data);
      form.reset();
      await load();
    });
    load().catch((error) => show('error', error.message));
  },

  tokens() {
    const load = async () => {
      const out = await call('GET', '/api/tokens');
      render('items', out.tokens, (token) =>
        '<li><strong>' + esc(token.name) + '</strong>' +
        '<span class="mono">' + esc(token.tokenPrefix) + '…</span>' +
        '<span class="meta">' + esc(token.scopes) + '</span>' +
        '<button data-revoke="' + esc(token.id) + '">撤銷</button></li>');
    };
    onSubmit('token-form', async (data, form) => {
      const out = await call('POST', '/api/tokens', { name: data.name, scopes: [data.scope || 'repo'] });
      el('issued').textContent = out.token;
      form.reset();
      await load();
    });
    el('items').addEventListener('click', async (event) => {
      const id = event.target.dataset.revoke;
      if (!id) return;
      await call('DELETE', '/api/tokens/' + id).catch((error) => show('error', error.message));
      await load();
    });
    load().catch((error) => show('error', error.message));
  },
};

const logout = el('logout');
if (logout) {
  logout.addEventListener('click', async () => {
    await call('POST', '/api/auth/logout').catch(() => {});
    location.assign('/login');
  });
}

if (pages[page]) pages[page]();
`;
