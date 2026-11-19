/**
 * 頁面主體內容
 *
 * 1. navFor — 導覽列（只列出真實存在的目的地）
 * 2. authPages — 登入頁與三模式註冊頁
 * 3. appPages — 儲存庫列表、單一儲存庫、issues、pulls、憑證、管理
 *
 * 不變量：導覽列不出現未實作的連結；註冊入口只在註冊開放時出現。
 */
import type { RegistrationMode } from '../config/schema.js';
import { escapeHtml } from './shell.js';

export function navFor(current: string): string {
  const items: ReadonlyArray<readonly [string, string, string]> = [
    ['repos', '/repos', '儲存庫'],
    ['tokens', '/settings/tokens', '存取憑證'],
    ['admin', '/admin', '站台管理'],
  ];
  const links = items
    .map(([key, href, label]) => {
      const mark = key === current ? ' aria-current="page"' : '';
      return `<a href="${href}"${mark}>${label}</a>`;
    })
    .join('\n');
  return `<nav class="bar">
<strong>onedrive-github</strong>
${links}
<button id="logout" type="button">登出</button>
</nav>`;
}

export function loginNav(): string {
  return '<nav class="bar"><strong>onedrive-github</strong></nav>';
}

export function loginBody(mode: RegistrationMode): string {
  const invite =
    mode === 'closed'
      ? '<p class="note">本站台目前不開放註冊，請向管理員索取帳號。</p>'
      : '<p class="note">還沒有帳號？<a href="/register">建立一個</a></p>';
  return `<h1>登入</h1>
<p class="lede">使用你的帳號密碼登入，或用個人存取憑證操作 git。</p>
<form class="panel" id="login-form">
<label>使用者名稱<input name="username" autocomplete="username" required></label>
<label>密碼<input name="password" type="password" autocomplete="current-password" required></label>
<p class="error" id="error" role="alert"></p>
<button type="submit">登入</button>
</form>
${invite}`;
}

export function registerBody(mode: RegistrationMode): string {
  const invite =
    mode === 'invite'
      ? '<label>邀請碼<input name="inviteCode" required></label>'
      : '';
  const lede =
    mode === 'invite'
      ? '本站台採邀請制，請填入管理員給你的邀請碼。'
      : '選一個使用者名稱並設定密碼即可開始。';
  return `<h1>建立帳號</h1>
<p class="lede">${lede}</p>
<form class="panel" id="register-form">
<label>使用者名稱<input name="username" autocomplete="username" required minlength="3" maxlength="32"></label>
<label>密碼<input name="password" type="password" autocomplete="new-password" required minlength="8"></label>
<label>再次輸入密碼<input name="passwordConfirm" type="password" autocomplete="new-password" required minlength="8"></label>
${invite}
<p class="error" id="error" role="alert"></p>
<button type="submit">建立帳號</button>
</form>
<p class="note"><a href="/login">已經有帳號了</a></p>`;
}

export function reposBody(): string {
  return `<h1>儲存庫</h1>
<p class="lede">這裡只列出你擁有或參與協作的儲存庫。</p>
<form class="panel" id="repo-form">
<label>名稱<input name="name" required placeholder="my-project"></label>
<label>描述（選填）<input name="description" placeholder="這個儲存庫做什麼用"></label>
<label>可見性
<select name="visibility">
<option value="private">私有</option>
<option value="public">公開</option>
</select>
</label>
<p class="error" id="error" role="alert"></p>
<button type="submit">建立儲存庫</button>
</form>
<h2>你的儲存庫</h2>
<ul class="list" id="items" data-empty="還沒有儲存庫。用上面的表單建立第一個。"></ul>`;
}

export function repoBody(owner: string, repo: string): string {
  const base = `/${escapeHtml(owner)}/${escapeHtml(repo)}`;
  return `<h1>${escapeHtml(owner)}/${escapeHtml(repo)}</h1>
<p class="lede" id="description">（沒有描述）</p>
<p class="meta">可見性 <span id="visibility">—</span> · 預設分支 <span id="branch">—</span></p>
<h2>複製這個儲存庫</h2>
<label>Clone URL<input class="clone mono" id="clone" readonly value="載入中…"></label>
<p class="note">推送時使用者名稱填你的帳號，密碼填個人存取憑證。</p>
<h2>協作</h2>
<ul class="list">
<li><a href="${base}/issues">議題</a><span class="meta">追蹤待辦與缺陷</span></li>
<li><a href="${base}/pulls">合併請求</a><span class="meta">審查與合併變更</span></li>
</ul>
<p class="error" id="error" role="alert"></p>`;
}

export function issuesBody(owner: string, repo: string): string {
  return `<h1>議題</h1>
<p class="lede">${escapeHtml(owner)}/${escapeHtml(repo)} 的議題，與編號序列和合併請求共用。</p>
<form class="panel" id="issue-form">
<label>標題<input name="title" required></label>
<label>內容（選填）<textarea name="body"></textarea></label>
<p class="error" id="error" role="alert"></p>
<button type="submit">開立議題</button>
</form>
<h2>議題清單</h2>
<ul class="list" id="items" data-empty="還沒有議題。"></ul>`;
}

export function pullsBody(owner: string, repo: string): string {
  return `<h1>合併請求</h1>
<p class="lede">${escapeHtml(owner)}/${escapeHtml(repo)} 的合併請求。</p>
<form class="panel" id="pull-form">
<label>標題<input name="title" required></label>
<label>來源分支<input name="headRef" required placeholder="refs/heads/feature"></label>
<label>目標分支<input name="baseRef" required placeholder="refs/heads/main"></label>
<label>來源提交<input class="mono" name="headOid" required minlength="40" maxlength="40"></label>
<label>目標提交<input class="mono" name="baseOid" required minlength="40" maxlength="40"></label>
<p class="error" id="error" role="alert"></p>
<button type="submit">開啟合併請求</button>
</form>
<h2>合併請求清單</h2>
<ul class="list" id="items" data-empty="還沒有合併請求。"></ul>`;
}

export function tokensBody(): string {
  return `<h1>存取憑證</h1>
<p class="lede">個人存取憑證用於 git 推送與拉取。憑證只在建立時顯示一次。</p>
<form class="panel" id="token-form">
<label>名稱<input name="name" required placeholder="筆記型電腦"></label>
<label>權限範圍
<select name="scope">
<option value="repo">儲存庫讀寫</option>
<option value="admin">站台管理</option>
</select>
</label>
<p class="error" id="error" role="alert"></p>
<button type="submit">建立憑證</button>
</form>
<p class="mono" id="issued"></p>
<h2>現有憑證</h2>
<ul class="list" id="items" data-empty="還沒有建立任何憑證。"></ul>`;
}

export function adminBody(): string {
  return `<h1>站台管理</h1>
<p class="lede">目前註冊模式：<strong id="current-mode">載入中…</strong></p>
<h2>切換註冊模式</h2>
<form class="panel" id="mode-form">
<label>模式
<select name="registrationMode">
<option value="closed">關閉註冊</option>
<option value="invite">邀請碼註冊</option>
<option value="open">開放註冊</option>
</select>
</label>
<button type="submit">套用</button>
</form>
<h2>產生邀請碼</h2>
<form class="panel" id="invite-form">
<label>授予角色
<select name="role">
<option value="user">一般使用者</option>
<option value="admin">管理員</option>
</select>
</label>
<label>可使用次數<input name="maxUses" type="number" min="1" value="1"></label>
<label>備註（選填）<input name="note" placeholder="給誰用的"></label>
<button type="submit">產生</button>
</form>
<p class="mono" id="issued"></p>
<p class="error" id="error" role="alert"></p>
<h2>邀請碼</h2>
<ul class="list" id="invites" data-empty="還沒有邀請碼。"></ul>`;
}
