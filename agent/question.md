# 需求確認與 TDD 驗收標準

> 本文件由需求訪談產生，是本專案所有 TDD 的**唯一驗收標準**。
> 任何實作若與本文件衝突，以本文件為準；需求變更須先更新本文件。

建立日期：2026-11-15
專案定位：**由 OneDrive 團隊版驅動的自架 GitHub**（開源）

---

## 1. 核心定位（已確認）

用 **OneDrive for Business / SharePoint 團隊磁碟當作 Git 儲存後端**，在其上實作一個自架的
GitHub：多用戶、repo 託管、git clone/push、issues、pull request。

- OneDrive 是 Git 資料的**唯一權威來源（source of truth）**
- 本地不保留完整 repo，僅保留**有界快取**
- 本機可隨時重建，不得因本地資料遺失而丟失任何 git 資料

## 2. 技術棧（已確認）

| 層 | 選定 |
|---|---|
| 執行環境 | Node.js 20 LTS |
| 語言 | TypeScript（strict） |
| HTTP 框架 | Fastify |
| ORM / DB | Prisma + SQLite |
| 測試 | Vitest（TDD，先 RED 後 GREEN） |
| License | Apache-2.0 |
| 部署 | Docker + Docker Compose 一鍵啟動 |

## 3. Git 儲存架構：E+ 方案（已確認，7 項優化全做）

基礎：packfile 存 OneDrive，`object -> (pack, offset, size)` 索引，用 HTTP Range
只抓需要的 byte 範圍，**不下載整包、不在本地落完整 repo**。

必做優化：

| # | 優化 | 驗收要點 |
|---|---|---|
| E+1 | **索引雙存** | 權威索引以二進位格式存 OneDrive（含 checksum）；SQLite 僅為本地加速快取，刪除後可完整 rebuild 且資料不丟 |
| E+2 | **delta 路徑展平** | 索引直接記錄解開某 object 所需的**全部 byte 範圍清單**；讀取時一輪並發取得，不得遞迴往返 |
| E+3 | **downloadUrl 快取** | 快取 Graph 回傳的預簽名 downloadUrl（約 1 小時效期），後續 Range 請求直打 CDN，不每次繞 Graph API |
| E+4 | **Range 合併 + multipart** | 間距小於閾值的多段 range 合併為一次請求；支援 `multipart/byteranges` 一次取多段 |
| E+5 | **clone 快速路徑** | 背景為 ref tip 預生成全量 base pack；`git clone` 直接循序串流該檔，不逐 object 組裝 |
| E+6 | **有界 LRU 內容快取** | 預設上限 2GB、可設定；超限淘汰；快取僅影響速度不影響正確性 |
| E+7 | **commit-graph / ref 快照** | commit-graph 與 refs 清單存為單檔於 OneDrive，rev walk 與分支列表不需逐 commit 抓取 |

## 4. 儲存後端：HuggingFace 公共 Dataset + 加密（輪次 4 變更，已確認）

**本節取代原先的 OneDrive 授權章節。OneDrive 後端完全移除，`src/onedrive/` 連同其測試一併刪除。**

### 4.1 儲存位置

- 使用 **公開的 HuggingFace Dataset repository** 當作儲存桶。
- 上傳走 Hub commit API，下載走 `/datasets/<id>/resolve/<rev>/<path>`（CDN 支援 HTTP Range，與 E+ 的分段讀取相容）。
- 認證只在寫入時需要（`HF_TOKEN`）；讀取為公開路徑。

### 4.2 加密（因為桶是公開的，所以是硬性要求）

| 項目 | 決定 |
|---|---|
| 演算法 | **AES-256-GCM 分塊加密** |
| 分塊 | 明文切成固定大小區塊（預設 1 MiB），每塊獨立 nonce 與驗證標籤 |
| 隨機讀取 | 給定明文區間，換算出涉及的區塊，只以 Range 抓那些區塊再解密切片 |
| 完整性 | 每塊都驗標籤；標籤或檔頭被竄改必須讀取失敗而非回傳錯誤資料 |
| 金鑰 | **全站主金鑰（`STORAGE_ENCRYPTION_KEY`，32 byte）+ 每檔以 HKDF 用檔案路徑衍生子金鑰** |

### 4.3 驗收要點

- 公開桶上的任何檔案位元組**不得出現明文片段**（packfile 內容、issue JSON 文字皆然）。
- 主金鑰長度或編碼不合法時，組態層必須拒絕啟動，且錯誤訊息不得含金鑰值。
- 任意明文區間的讀取結果必須與未加密時逐位元組相同（加密對上層完全透明）。
- 單一區塊的密文被改動一個位元，讀取該區間必須拋錯。
- 相同內容寫入兩次，密文不得相同（nonce 必須每次重新產生）。
- 檔案路徑不同則子金鑰不同；把 A 檔的密文搬到 B 檔的路徑必須無法解密。
- `Store` 介面（`readRanges` / `readAll` / `readJson` / `putBytes` / `putJson` / `remove` / `cacheStats`）保持不變，上層 git 與 issue/PR 程式碼不得因換後端而改寫邏輯。

## 5. Git 傳輸協議（已確認）

- 本輪支援 **HTTPS Smart Protocol**：`git clone` / `fetch` / `push`
- 認證：帳號 + **Personal Access Token（PAT）**
- 本輪**不做 SSH**

## 6. 多用戶系統（用戶原始需求，最高優先）

### 6.1 註冊三模式（全站單一設定，管理員可切換）

| 模式 | 行為 |
|---|---|
| `open` 開放註冊 | 新用戶輸入**用戶名 + 密碼 + 密碼確認**即可註冊 |
| `invite` 邀請碼註冊 | 必須持有管理員產生的有效邀請碼才能註冊 |
| `closed` 關閉註冊 | **只有登入頁，沒有註冊頁** |

### 6.2 `closed` 模式的硬性要求

> 原始需求：「要確保註冊頁不會被各項腳本抓出來進行非法註冊之類的」

驗收標準（全部須有測試）：

- `closed` 時 `POST /api/auth/register` 必須回 **404**（不得回 403 或 400），
  使註冊端點與不存在的路徑**無法區分**
- `closed` 時任何回應（含 HTML、JSON、OpenAPI 文件、錯誤訊息、HTTP header）
  **不得洩漏註冊功能存在**
- 前端 `closed` 時不渲染註冊入口、不存在註冊路由
- 註冊端點有**速率限制**，且在 `closed` 模式下探測不同 payload 的回應
  **時間與內容須一致**（防時序側信道）
- `invite` 模式下，邀請碼錯誤與邀請碼不存在須回**相同**錯誤與相近耗時（防枚舉）

### 6.3 管理員預設帳號

- 帳號：`admin`
- 密碼：`s12ryt-huggingface-github`
- 首次啟動自動建立；必須標記為預設密碼並持續提示更換

### 6.4 邀請碼系統

管理員可產生邀請碼，且**可配置各項參數**（全部須有測試）：

- 有效期（絕對到期時間 / 相對天數 / 永不過期）
- 可使用次數（單次 / N 次 / 不限）
- 註冊後授予的角色
- 備註/標籤（用途說明）
- 允許註冊的用戶名規則（選配）
- 狀態：啟用 / 撤銷
- 查詢使用紀錄（誰、何時用掉）

## 7. Issues / PR 儲存（已確認）

**雙寫**：

- SQLite 為查詢層（列表、篩選、全文搜尋）
- 同時寫一份**可讀 JSON** 到 OneDrive，作為可離線閱讀的真相
- DB 可由 OneDrive JSON 完整重建

## 8. 本輪交付範圍（已確認）

一次做到**含 issues 與 PR**：

1. 認證 + 多用戶 + 註冊三模式 + 邀請碼 + PAT
2. OneDrive 存儲層（兩種授權 + E+ 七項優化）
3. Git 物件層 + Git Smart HTTP（clone / fetch / push）
4. Repo 管理與權限（public / private / collaborator）
5. Issues + Pull Request + diff review
6. 前端 UI
7. Docker Compose + README + OpenAPI

## 9. 全域工程約束

- **TDD**：每段功能先寫失敗測試（RED），再實作至通過（GREEN）
- **模塊化**：每個檔案只含 1~5 個功能
- **文件標註**：每個檔案開頭 1~35 行標註各功能實現位置
- **極簡化 / 最佳化**：不寫裝飾性與死程式碼
- Git 提交不得使用 `sisyphus-dev-ai` / `sisyphus@mengmota.com`

## 10. 輪次 6 驗收範圍（自主疊代升級）

用戶需求原文：「自主疊代升級」— 不加新功能，只做效能/佔用優化。

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | `store.readRanges` 多個合併段並行抓取 | RED：deferred hub 證明序列實作只啟動 1 個 span 請求；GREEN：段請求在彼此未完成前都已發出 |
| B | LFS PUT 零複製（移除 `new Uint8Array(body)`） | RED：錄到的 PUT body 與傳入 Buffer 參考不同；GREEN：參考相同（toBe） |
| C | `encryptBytes` 預配置輸出緩衝 | 純重構（隨機 nonce 無法等值斷言）：45 個 crypto 測試 + store 測試全數回歸通過，輸出格式不變 |
| 共 | 不新增對外功能、不改組態介面 | 全量 41 檔 / 881 測試綠（879 基準 + 2 新測試）；雙 tsc EXIT 0 |

## 11. 輪次 7 驗收範圍（自主疊代升級）

用戶需求原文：「自主疊代升級」— 不加新功能，只做效能/佔用優化。

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | `reader.fetchSlices` 多 pack 並行 readRanges | RED：deferred io 證明序列實作只發出第 1 包請求；GREEN：第 2 包請求在第 1 包未完成前已發出，內容順序不變 |
| B | `reader.readMany` 並行 planFor，缺失檢查依輸入順序 | RED：deferred prisma 證明第 2 個 findUnique 未發出；GREEN：兩查詢並行、釋放後內容正確 |
| C | `writer.buildPackFile` 串流雜湊 + 單次 concat | 純重構：sha1 trailer 與 scanPack 往返測試回歸通過，輸出位元組不變 |
| 共 | 不新增對外功能、不改介面 | 全量 41 檔 / 883 測試綠（881 基準 + 2 新測試）；雙 tsc EXIT 0 |

## 12. 輪次 8 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | pktline.sideBand 單次配置輸出（移除頻道前綴 concat + encodePkt 再 concat） | 純重構：輸出位元組不變，27 個 pktline 測試 + 2 個新增邊界錨定測試（上限-1 恰好合法=fff0、空內容=0005+頻道）全綠 |
| B | git.ts authorize 內 authenticateBasic ∥ repo.findFirst 並行 | RED：deferred gate 證明序列實作下 repo 查詢未與認證並行發出；GREEN：兩查詢並行且 401/404/403 分支語意不變 |
| 共 | 不新增對外功能 | 全量 41 檔 / 886 測試綠（883 基準 + 3 新測試）；雙 tsc EXIT 0 |

## 13. 輪次 9 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | repos/access.ts resolveAccess：repo.findUnique ∥ collaborator.findUnique | RED：gate 證明序列下 collaborator 查詢未先發出；GREEN：兩查詢並行、Access 事實不變 |
| B | http/repo-scope.ts locate()：findRepoByPath ∥ readPrincipal | RED：issues 端點 gate session+repo 查詢序列超時；GREEN：並行、401/404/403 語意不變 |
| C | http/routes/repos.ts readable()：findRepoByPath ∥ readPrincipal | 與 B 同型，repos 五端點受惠；以 repos/issues/pulls 全量契約測試回歸 |
| 共 | 不新增對外功能 | 全量 41 檔 / 888 測試綠（886+2）；雙 tsc EXIT 0 |

## 14. 輪次 10 驗收範圍（自主疊代升級）

| # | 項目 | 驗收標準 |
|---|---|---|
| F | 修復 logout 撤銷缺陷（原把 sessionId 當 token 雜湊刪除，session 永不失效） | RED：登出後 /api/me 應 401（原 200）；GREEN：cookie 失效、DB 列刪除、未知 token 冪等 204 |
| A | resolveSession 的 lastSeenAt 改 5 分鐘節流（原每請求寫一次 DB） | RED：窗內驗證 spy update 計數應 0（原 1）；GREEN：窗內 0、超窗 1、DB 值正確 |
| C | authenticateBasic 密碼路徑合併為單次 user 查詢（原 2 次） | RED：findUnique 計數應 1（原 2）；GREEN：1 次且主體不含 passwordHash |
| 共 | 不新增對外功能 | 全量 43 檔 / 895 測試綠（888+7，含新 logout/basic-auth 測試檔）；雙 tsc EXIT 0 |

## 15. 輪次 11 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | pulls/diff.ts flatten：同層子樹並行展開 + base/head 兩樹並行 | RED：gate 非根讀取，waitFor(pending≥2) 超時；GREEN：並行且 diff 結果（路徑/狀態/排序）不變 |
| B | issues rebuild 的 resolveAuthor 以 Map 記憶體化（原每則留言重查一次） | RED：同作者 issue+2 留言重建時 user.findUnique 計數 1（原 3）；GREEN：1 次 |
| 共 | 不新增對外功能 | 全量 43 檔 / 897 測試綠（895+2）；雙 tsc EXIT 0 |

## 16. 輪次 12 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | index-store.writeIndex：pack（LFS 大檔）與索引 JSON 並行上傳 | RED：gate 兩個 put，waitFor(2) 超時；GREEN：並行、雙存與 SQLite 快取不變 |
| B | resolveAccessToken 的 lastUsedAt 改 5 分鐘節流（原每個 PAT 請求寫一次 DB） | RED：窗內 spy update 計數應 0（原 1）；GREEN：首次/超窗更新、窗內 0 寫 |
| 共 | 不新增對外功能 | 全量 43 檔 / 899 測試綠（897+2）；雙 tsc EXIT 0 |

## 17. 輪次 13 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | settings/registration.ts：readRegistrationMode 以 WeakMap<PrismaClient> 快取已解析模式，writeRegistrationMode 成功後刪除該鍵 | RED：連續兩讀 spy findUnique 計數 2；GREEN：計數 1 且寫入後立即生效（admin 熱切換行為不變）、跨 prisma 實例不互染 |
| 共 | 不新增對外功能 | 全量 44 檔 / 902 測試綠（899+3 新 settings 測試）；雙 tsc EXIT 0 |

附帶：web.test.ts 熱切換測試改走 writeRegistrationMode（與管理員介面同一路徑；直接 upsert Setting 會繞過快取失效，屬測試對齊服務邊界，非放寬）。

## 18. 輪次 14 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | index-store 新增 lookupObjects（oid IN 批量）；reader.readMany 改 BFS 分層批量解析（含 delta 鏈 base 補查） | RED：兩 blob readMany 斷言 findUnique===0 且 findMany===1（原 3 點查 0 批查）失敗；GREEN：成立、鏈缺失時 findMany===2 且錯誤訊息 `delta base X is not indexed` 依序確定 |
| B | lru.deletePrefix 直接在 Map 迭代中刪除，免複製整份鍵陣列 | 純重構：17 個 lru 測試回歸綠 |
| 共 | 不新增對外功能 | 全量 44 檔 / 903 測試綠；雙 tsc EXIT 0 |

附帶：R7-B 的「readMany 並行點查」測試改寫為「readMany 單批查詢」——批量是同一目標（查表不序列）更徹底的達成。

## 19. 輪次 15 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | SQLite 切換 WAL：bootstrap 新增 tuneSqlite（生產入口呼叫）；測試 template 建立時切 WAL，複製出的測試庫自動繼承 | RED：`PRAGMA journal_mode` 為 'delete'；GREEN：'wal'（busy_timeout Prisma 已內建 ≥5000，驗證測試守住） |
| 共 | 不新增對外功能 | 全量 45 檔 / 905 測試綠；雙 tsc EXIT 0 |

刻意不做（本輪記錄）：merge/setPullState 條件式更新（updateMany 不回列，回補查詢後淨零）、
addReview 預檢查移除（快樂路徑微幅、錯誤映射複雜化）、web 殼層字串 memo（µs 級且 repo
殼層鍵無界有洩漏風險）。

## 20. 輪次 16 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | applyCommands 條件式寫入（updateMany/deleteMany 帶 oldOid + create 捕 P2002），移除每指令 findUnique 預查 | 新檔 tests/git/receive.test.ts 7 測試：5 條行為錨定（建立/條件更新/stale/刪除/冪等刪空）+ P2002 併發碰撞回 stale + 足跡測試（findUnique===0）。RED：足跡測試失敗（原實作每指令點查）；GREEN 全數通過。附帶封閉原讀改寫的 TOCTOU 競態（註解宣稱樂觀鎖但原實作比對與寫入非原子） |
| B | changePassword 先查帳號再 argon2 | 行為不變（bootstrap 既有測試回歸）；帳號不存在時免付 ~百 ms 雜湊成本 |
| 共 | 不新增對外功能 | 全量 46 檔 / 912 測試綠（905+7 新測試）；雙 tsc EXIT 0 |

## 21. 輪次 17 驗收範圍（自主疊代升級 — 誠實無變更輪）

掃描：admin-settings、admin-invites、register、users/create、invite 流程、storage/ranges、
git/object、issues/document、admin PATCH 回讀。

結論：**無值得做的變更**。逐一評估與排除理由：
- admin-settings PATCH 寫後回讀：R13 快取失效後 1 次 DB 讀，管理員稀有路徑，省一次查詢需改
  writeRegistrationMode 回傳型別（服務邊界擾動 > 收益）。
- register.ts 佔用預檢（步驟 5）與 createUser P2002 捕捉重複：檔頭明文記載流程順序「刻意如此」
  （驗證失敗絕不消耗邀請碼配額）；移除預檢改變文件化行為契約，不動。
- prepareCredentials 在佔用預檢前 argon2：同上，註冊冷路徑且順序刻意。
- storage/ranges.ts：純函數、subarray 零複製切片、合併演算法已線性 optimal。
- git/object.ts encodeLoose concat：deflateSync 同步 API 必要輸入。
- users/create、admin-invites、invite/code：結構已最小。

驗收標準：本輪零程式碼變更；基準維持 46 檔 / 912 測試綠（不重跑破壞性驗證，以 R16 全量為準）。

## 22. 輪次 18 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | pack.ts inflateWithConsumed 以壓縮長度上界啟發式縮小二分搜尋窗 | RED：mock zlib 計數 scanPack 探測 39 次（斷言<32 失敗）；GREEN：<32（tiny≈9+big≈21）且回退路徑保證正確性（上界失效時全長二分，僅浪費 1 探測） |
| 共 | 輸出位元組不變、掃描結果不變 | 全量 47 檔 / 913 測試綠（912+1 新測試）；雙 tsc EXIT 0 |

教訓：Node deflateSync 對不可壓縮資料的實際輸出可超過 stored-block 理論上界（300000B→300101B），
故啟發式必須「先探再信」：上界探測成功才用它收窗，失敗回退全長——正確性不依賴啟發式成立。

## 23. 輪次 19 驗收範圍（自主疊代升級）

| # | 優化點 | 驗收標準 |
|---|---|---|
| A | index-store rebuildCacheFromStore 的 byteSize 改由索引文件推導（max(packOffset+storedSize)+20 trailer），刪除整包 readAll 下載+解密 | RED：countingStore 斷言 rebuild 期間對 .pack 路徑 readAll 計數===0（舊實作=1）→ 失敗；GREEN：計數 0、byteSize===原 pack.length、lookupObject 重建後可查回 |
| 共 | 不新增對外功能、災難恢復語意不變（loadIndex null 级續 continue） | 全量 47 檔 / 914 測試綠（913+1）；雙 tsc EXIT 0 |

## 24. 輪次 20 驗收範圍（收尾審計輪）

無代碼變更。工作內容：
1. 全量最終審計：47 檔 / 914 測試全綠、雙 tsc EXIT 0（與 R19 交付時一致）。
2. agent/項目表.md 分組數字實測校正：config/db/auth/invite 199、storage 201、git 180、
   repos/issues/pulls/settings 79（22+26+28+3）、bootstrap 13（runtime 11 + db-pragma 2）、
   http 242；加總 914 與全量一致（此前 repos/settings 歸屬重複、bootstrap/http 過時）。
3. R8→R20 總成果報告交付。

## 25. 輪次 21 驗收範圍（建立 GitHub 倉庫並推送）

用戶需求原文：「幫我創建一個github倉庫並更新readme之後推上那個倉庫」

決策（question 工具確認）：
- 倉庫名稱與可見性：`s12ryt/huggingface-github`，**公開**
- README 更新方向：**全面正名為 HuggingFace**（標題、專案名、package.json name 一併改）
- 推送範圍：**整個專案**（git init + 首次 commit）

| # | 項目 | 驗收標準 |
|---|---|---|
| A | README.md 標題正名 | `# onedrive-github` → `# huggingface-github`；內文既有 HuggingFace 敘述維持；功能性字串（admin 密碼表格 `s12ryt-onedrive-github`、開發章節 `HKDF_INFO_PREFIX`）保留不改 |
| B | package.json metadata 正名 | `name`：`onedrive-github` → `huggingface-github`；`description` 改為反映 HuggingFace 加密後端；未被任何測試斷言，回歸須全綠 |
| C | 保留功能性常數 | `auth/bootstrap.ts` 預設密碼、`storage/crypto.ts` HKDF_INFO_PREFIX、`git.ts` Basic realm、`protocol.ts` AGENT、src UI title 一律不動（超出「更新 README」範圍且部分改動會破壞既有密文/登入） |
| D | git 初始化與首次 commit | git init；依 `.gitignore` 排除 `.env`/`node_modules`/`dist`/`data`/`*.db` 等敏感檔；commit 作者為 s12ryt 本人憑證，**禁用** `sisyphus-dev-ai` / `sisyphus@mengmota.com` |
| E | 建立公開倉庫並推送 | 建立 `s12ryt/huggingface-github`（public）；推送後遠端含完整原始碼，且 `.env`/`node_modules`/`data`/`*.db` 不出現在遠端；遠端 README 標題為 `huggingface-github` |
| 共 | 不新增功能、不改程式邏輯 | 基準維持 47 檔 / 914 測試綠；雙 tsc EXIT 0 |

## 26. 輪次 22 驗收範圍（ghcr 自動建置 workflow + releases 版本顯示）

用戶需求原文：「做一個workflow自動編譯ghcr的docker鏡像,還要有releases版本顯示」

決策（question 工具確認）：
- 觸發與版本策略：**推 git tag `v*`（如 v0.1.0）→ 自動發 GitHub Release + 建置鏡像打版本號 tag**
- README：**加 Release 版本徽章 + ghcr 鏡像徽章**（另附 workflow 狀態徽章）

| # | 項目 | 驗收標準 |
|---|---|---|
| A | workflow 觸發 | `.github/workflows/release.yml` 僅在 `push` tag `v*` 觸發；具 `contents: write`（建 Release）與 `packages: write`（推 ghcr）權限 |
| B | ghcr 建置與推送 | 以既有 `Dockerfile` 建置，`docker/login-action` 登入 `ghcr.io`（`GITHUB_TOKEN`），`docker/build-push-action` push 至 `ghcr.io/s12ryt/huggingface-github`；用 `metadata-action` semver 產生 `{{version}}`、`{{major}}.{{minor}}`、非 prerelease 自動 `latest` |
| C | GitHub Release | `softprops/action-gh-release` 於同一 tag 自動建立 Release，含自動產生的 release notes 與對應鏡像座標 |
| D | README 版本顯示 | 頂部加 Release 版本徽章（`github/v/release`）、ghcr 鏡像徽章、release workflow 狀態徽章 |
| E | YAML 合法性 | `release.yml` 為合法 YAML，關鍵欄位（on.push.tags、permissions、jobs.docker.steps）齊備 |
| 共 | 不改應用程式碼 | 不動 src/tests；基準維持 47 檔 / 914 測試綠；雙 tsc EXIT 0 |
