/**
 * HTML 文件殼層
 *
 * 1. escapeHtml — 任何進入標記的動態值都必須先經過此處
 * 2. renderDocument — 產生完整 HTML 文件（含 data-page 標記與無障礙跳躍連結）
 *
 * 安全不變量：殼層不內嵌任何伺服器端查到的資料。
 * 頁面內容一律由前端以使用者自己的憑證向 API 索取，
 * 使「頁面可見」與「資料可讀」兩件事分開判定，避免殼層成為越權洩漏管道。
 */

const ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export interface DocumentOptions {
  attributes?: Readonly<Record<string, string>>;
  body: string;
  nav: string;
  page: string;
  title: string;
}

function renderAttributes(attributes: Readonly<Record<string, string>>): string {
  return Object.entries(attributes)
    .map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`)
    .join('');
}

export function renderDocument(options: DocumentOptions): string {
  const extra = renderAttributes(options.attributes ?? {});
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body data-page="${escapeHtml(options.page)}"${extra}>
<a class="skip" href="#main">跳至主內容</a>
${options.nav}
<main id="main" class="wrap">
${options.body}
</main>
<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;
}
