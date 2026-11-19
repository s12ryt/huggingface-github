/**
 * 樣式表內容
 *
 * 1. APP_CSS — 單一設計系統的 token 與元件樣式
 *
 * 設計取向：以紙本工程文件為母題 —— 中性底、單一琥珀強調色只用於當前位置與主要動作、
 * 細線分隔取代陰影堆疊。無漸層、無毛玻璃、無發光、無永久動畫。
 */
export const APP_CSS = `:root {
  --ink: #16150f;
  --ink-soft: #57544a;
  --paper: #f7f5ef;
  --surface: #fffefb;
  --line: #ddd8c9;
  --accent: #9a5b06;
  --danger: #8d2416;
  --radius: 3px;
  --gap: 1rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #f0ede3;
    --ink-soft: #a8a294;
    --paper: #15140f;
    --surface: #1d1b15;
    --line: #322f26;
    --accent: #e0a44a;
    --danger: #e07c68;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.6 ui-sans-serif, system-ui, "Noto Sans TC", sans-serif;
}

.skip {
  position: absolute;
  left: -9999px;
}

.skip:focus {
  left: 1rem;
  top: 1rem;
  z-index: 10;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 2px solid var(--accent);
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--gap);
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.bar a { color: var(--ink-soft); text-decoration: none; }
.bar a:hover { color: var(--ink); text-decoration: underline; }
.bar a[aria-current="page"] { color: var(--accent); font-weight: 600; }
.bar strong { margin-right: auto; font-size: 1.05rem; letter-spacing: 0.01em; }

.wrap {
  max-width: 62rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}

h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; }
.lede { color: var(--ink-soft); margin: 0 0 1.75rem; }

form.panel {
  max-width: 24rem;
  display: grid;
  gap: 0.85rem;
}

label { display: grid; gap: 0.3rem; font-size: 0.9rem; color: var(--ink-soft); }

input, select, textarea {
  font: inherit;
  color: var(--ink);
  padding: 0.5rem 0.6rem;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

textarea { min-height: 6rem; resize: vertical; }

button {
  font: inherit;
  padding: 0.5rem 0.9rem;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
}

button[type="submit"], button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--surface);
  font-weight: 600;
}

button:hover { border-color: var(--ink-soft); }

.list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }

.list li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  align-items: baseline;
  padding: 0.7rem 0;
  border-bottom: 1px solid var(--line);
}

.list a { color: var(--ink); text-decoration: none; font-weight: 600; }
.list a:hover { text-decoration: underline; }
.meta { color: var(--ink-soft); font-size: 0.85rem; }
.num { color: var(--ink-soft); font-variant-numeric: tabular-nums; }

.tag {
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--ink-soft);
}

.tag[data-state="open"] { color: var(--accent); border-color: var(--accent); }

code, .mono {
  font-family: ui-monospace, "Cascadia Mono", monospace;
  font-size: 0.9em;
}

.clone {
  display: block;
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

.note { color: var(--ink-soft); }
.error { color: var(--danger); min-height: 1.4rem; }
.error:empty { min-height: 0; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.55rem 0.5rem; border-bottom: 1px solid var(--line); }
th { font-size: 0.8rem; color: var(--ink-soft); font-weight: 600; }

@media (max-width: 36rem) {
  .wrap { padding: 1.5rem 1rem 3rem; }
  .bar { padding: 0.6rem 1rem; }
}
`;
