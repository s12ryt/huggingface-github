# huggingface-github

自架的 Git 託管服務，把 HuggingFace 的公開 Dataset 當成物件儲存後端，
所有寫入前都先以 AES-256-GCM 加密。Git packfile、issue 與合併請求的權威副本
都放在儲存桶裡，SQLite 只是可隨時重建的查詢快取。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

## 這是什麼

一般的 Git 伺服器需要一塊自己的磁碟。這個專案改用 HuggingFace Dataset：

- `git push` 上來的 packfile 加密後寫進資料集，同時產生 `object → (pack, offset, size)` 索引。
- `git clone` / `git fetch` 時用 HTTP Range 只抓需要的位元組，不在本機留整份 repo。
- 索引同時存在儲存桶（權威）與 SQLite（快取）。SQLite 整個刪掉也能從儲存桶重建。
- issue 與合併請求以 JSON 形式儲存（同樣加密），資料庫可由這份權威副本完整重建。

資料集是**公開**的，任何人都能下載檔案，所以加密不是選項而是前提：
沒有 `STORAGE_ENCRYPTION_KEY` 伺服器不會啟動。

## 加密設計

| 項目 | 做法 |
|---|---|
| 演算法 | AES-256-GCM |
| 金鑰層級 | 全站主金鑰（32 byte）→ 每個檔案以 HKDF-SHA256 依**檔案路徑**衍生子金鑰 |
| 分塊 | 預設 1 MiB 一塊，每塊獨立 nonce 與驗證標籤 |
| 隨機讀取 | 明文區間換算成所需區塊，只抓那幾塊的密文 |
| 竄改偵測 | 任何一塊被改一個位元，該區間的讀取就失敗 |

分塊而非整檔加密，是因為 packfile 的讀取是隨機位移的：整檔模式下讀 40 個位元組
也要下載整份 pack。串流模式（例如 CTR）雖然也能隨機讀取，但做不到逐塊驗證。

路徑參與金鑰衍生，所以把 A 檔的密文搬到 B 檔的位置也解不開。

## Git LFS

HuggingFace 資料集的預設 `.gitattributes` 會把 `*.pack`、`*.idx`、`*.bin` 這類副檔名
交給 Git LFS，超過門檻的大檔也一樣。LFS 檔在 git 樹裡只留一份幾十位元組的文字指標，
真正的位元組放在另一個儲存服務上，所以上傳與下載都要多一次協商。

| 情境 | 行為 |
|---|---|
| 上傳小檔（非 LFS 副檔名且小於門檻） | 內容以 base64 夾帶在 commit 裡 |
| 上傳大檔或 LFS 副檔名 | batch 協商 → `PUT` 到轉送網址 → commit 記 `lfsFile` |
| 協商回報物件已存在 | 跳過上傳，只記 `lfsFile`（去重） |
| 下載時讀到指標 | batch 協商 download，改向轉送網址取位元組，href 快取 10 分鐘 |
| 查詢大小 | 優先採用 `x-linked-size`（LFS 的 `content-length` 是指標長度） |

門檻由 `LFS_THRESHOLD_BYTES` 控制，預設 10 MiB。

兩個設計重點：

- **指標偵測必須在很短的前置上成立。** 儲存層第一次讀一個檔案只會取回密文檔頭那 16 個
  位元組；如果那時認不出指標，指標文字就會被送進解密，得到一個難以追查的失敗。
  所以偵測只看前 14 個位元組（`version https:`）。
- **向協商取得的轉送網址發請求時不附上 Hub 權杖**，只帶該網址自己要求的標頭。
  轉送目標是第三方儲存服務，不該拿到我們的憑證。

## 已實作

| 範圍 | 內容 |
|---|---|
| Git 傳輸 | HTTPS Smart Protocol：`info/refs`、`git-upload-pack`、`git-receive-pack`。帳號密碼或 PAT 以 Basic auth 認證 |
| 儲存最佳化 | 密文 Range 讀取與相鄰區間合併、delta 鏈展平（免遞迴）、有界 LRU 密文快取、索引雙存 |
| 加密 | 每檔 HKDF 子金鑰、GCM 分塊、明文區間到密文區塊的換算、竄改與錯位偵測 |
| 多用戶 | 三種註冊模式（開放 / 邀請碼 / 關閉）、工作階段 cookie、個人存取權杖、站台管理員 |
| 邀請碼 | 管理員產生，可設角色、使用次數、有效期、備註、使用者名稱規則，可撤銷 |
| 儲存庫 | 公開 / 私有、協作者三級權限（read / write / admin） |
| Issue / PR | 建立、留言、開關狀態、審查與行級留言、合併、樹對樹 diff |
| 介面 | 零建置的伺服端渲染頁面 + 原生 JS，無第三方前端框架 |

尚未實作：SSH 傳輸、webhook、CI 整合、組織帳號。

## 快速開始

### 需求

- Node.js 20.11 或更新版本
- 一個 HuggingFace Dataset repository（公開即可）
- 一組對該資料集有寫入權的 HuggingFace 存取權杖
- 一把 32 byte 的加密主金鑰

```bash
openssl rand -hex 32      # STORAGE_ENCRYPTION_KEY
openssl rand -base64 48   # SESSION_SECRET
```

### 本機執行

```bash
npm install
cp .env.example .env     # 填入 HF_DATASET_ID / HF_TOKEN / STORAGE_ENCRYPTION_KEY / SESSION_SECRET
npm run db:push
npm run dev
```

打開 `http://localhost:3000`，以預設管理員帳號登入：

| 帳號 | 密碼 |
|---|---|
| `admin` | `s12ryt-huggingface-github` |

首次登入後系統會要求改密碼。改密碼會同時撤銷該帳號的所有工作階段。

### Docker

```bash
cp .env.example .env     # 至少要填 PUBLIC_URL / SESSION_SECRET / HF_DATASET_ID / STORAGE_ENCRYPTION_KEY
docker compose up -d
```

資料庫掛在 `app-data` 卷冊上。內容快取在記憶體裡，不需要卷冊。

## 組態

所有設定走環境變數，完整清單與註解見 [`.env.example`](.env.example)。

| 變數 | 說明 |
|---|---|
| `PUBLIC_URL` | 對外網址。以 `https://` 開頭時 cookie 會加上 `Secure` |
| `SESSION_SECRET` | 至少 32 字元 |
| `REGISTRATION_MODE` | `open` / `invite` / `closed`，預設 `closed` |
| `HF_DATASET_ID` | 資料集識別碼，格式 `<擁有者>/<名稱>` |
| `HF_REVISION` | 分支或修訂版本，預設 `main` |
| `HF_TOKEN` | 存取權杖。讀公開內容不需要，推送與寫 issue 必須有 |
| `STORAGE_ENCRYPTION_KEY` | **必填**。32 byte，64 個 hex 字元或 base64 |
| `LFS_THRESHOLD_BYTES` | 超過此大小改走 Git LFS，預設 `10MB`。LFS 副檔名不論大小一律走 LFS |
| `CACHE_MAX_BYTES` | 密文片段的記憶體快取上限，接受 `1024` / `512MB` / `2GB`，預設 `2GB` |

註冊模式也可由管理員在執行期切換（`PATCH /api/admin/settings`），不需重啟。環境變數只是尚未設定過時的回落值。

> `STORAGE_ENCRYPTION_KEY` 遺失等於資料全部遺失，請另行備份。
> 換金鑰不會重新加密既有檔案，舊內容會解不開。

## 使用

### 建立並推送儲存庫

在網頁上建立儲存庫，再到 `設定 → 存取權杖` 簽發一組 PAT：

```bash
git remote add origin https://你的網域/你的帳號/你的儲存庫.git
git push origin main
# 帳號填使用者名稱，密碼填 PAT
```

### API

全部端點都在 `/api` 底下，回應為 JSON，錯誤格式統一為 `{ "error": "錯誤碼" }`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/api/auth/registration` | 查詢目前註冊模式 |
| `POST` | `/api/auth/register` | 註冊（關閉模式下回 404） |
| `POST` | `/api/auth/login` / `logout` | 工作階段 |
| `POST` | `/api/auth/password` | 改密碼 |
| `GET` `POST` `DELETE` | `/api/tokens` | 個人存取權杖 |
| `GET` `POST` | `/api/repos` | 儲存庫列表與建立 |
| `GET` `DELETE` | `/api/repos/:owner/:repo` | 單一儲存庫 |
| `GET` `PUT` `DELETE` | `/api/repos/:owner/:repo/collaborators` | 協作者 |
| `GET` `POST` `PATCH` | `/api/repos/:owner/:repo/issues` | 議題與留言 |
| `GET` `POST` | `/api/repos/:owner/:repo/pulls` | 合併請求、審查、合併、diff |
| `GET` `POST` `DELETE` | `/api/admin/invites` | 邀請碼（管理員） |
| `GET` `PATCH` | `/api/admin/settings` | 註冊模式（管理員） |

認證方式二擇一：工作階段 cookie（`odg_session`）或 `Authorization: Bearer <PAT>`。

## 安全性設計

這些行為有測試保護，修改時請先看對應的測試再動手：

- **寫進公開資料集的位元組一律是密文。** 相同內容兩次寫入的密文不同；密文裡不會出現明文片段。
- **關閉註冊時，`/register` 與 `POST /api/auth/register` 回傳與「路徑不存在」逐位元組相同的 404。** 回應、標頭與耗時都不洩漏註冊是否存在。
- **私有儲存庫對無權者一律回 404**，不回 403，避免洩漏儲存庫是否存在。
- **邀請碼驗證失敗一律回同一個錯誤**（不存在、已撤銷、過期、用盡皆相同），防止枚舉。
- **登入耗時等化**：查無帳號時仍跑一次密碼雜湊驗證。
- **密碼與權杖只存雜湊**。查詢使用者一律走 select 白名單，`passwordHash` 在型別上就不會隨行。
- **邀請碼配額以單一 SQL 敘述搶佔**，併發情境下不會超賣。
- **錯誤訊息不含機密**。組態錯誤只說變數名與原因，不回報金鑰內容或長度；上游錯誤不轉述回應內文。

## 開發

```bash
npm test          # 全量測試
npm run typecheck # 型別檢查
npm run build     # 產出 dist/
```

本專案以測試驅動開發，提交前請確認測試與型別檢查都通過。

程式碼約定：

- `src/` 內部用相對路徑 import（`../x/y.js`），`@/` 別名只在 `tests/` 使用。
- 每個檔案 1~5 個功能，檔首以註解標出各功能所在行號。
- 資料模型分檔放在 `prisma/schema/`，改完要跑 `npm run db:generate`。
- `src/storage/crypto.ts` 的 `HKDF_INFO_PREFIX` 與密文檔頭格式一經發布就不可改，否則既有密文解不開。

架構與各檔案職責見 [`agent/項目表.md`](agent/項目表.md)。

## 授權

[Apache-2.0](LICENSE)
