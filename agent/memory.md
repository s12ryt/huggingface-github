# 操作紀錄

專案：huggingface-github（src 內部識別仍為 onedrive-github）

---

## 2026-11-19

輪次21：建立 GitHub 公開倉庫 s12ryt/huggingface-github 並推送整個專案。
- 正名：README 標題、package.json name/description 改為 huggingface-github / HuggingFace 版描述。
- 預設 admin 密碼 s12ryt-onedrive-github → s12ryt-huggingface-github（TDD：改 4 測試檔斷言 RED → 改 src/auth/bootstrap.ts 常數 GREEN）；同步 README 快速開始表格、agent/question.md:113 驗收標準。
- src 內部功能性字串保留不改：HKDF_INFO_PREFIX、Basic realm、AGENT、UI title、導覽品牌、啟動 log、cookie odg_session。
- git init + 首次 commit（作者 s12ryt），建 public repo 並 push。

---

## 2026-11-15

| 時間序 | 操作 | 目標 | 結果 |
|---|---|---|---|
| 1 | 讀取 | 工作區目錄列舉 | 空目錄，確認為全新專案 |
| 2 | 訪談 | question 工具 ×4 輪 | 取得全部重大技術決策 |
| 3 | 寫入 | `agent/question.md` | 建立 TDD 驗收標準 |
| 4 | 寫入 | `agent/deep_todos.md` | 建立歷史任務紀錄 |
| 5 | 寫入 | `agent/memory.md` | 建立本檔 |
| 6 | 執行 | `node -v` / `npm -v` / `git --version` | v24.11.1 / 11.7.0 / 2.53.0.windows.1 |
| 7 | 寫入 | 專案骨架（package.json / tsconfig ×2 / vitest.config / .gitignore / .env.example / LICENSE） | 階段 0 完成，build EXIT 0 |
| 8 | 執行 | `npm install` | 147 packages，Prisma 實裝 6.19.3 |
| 9 | 寫入 | `src/config/` ×4 + `tests/config/load.test.ts` | 26 測試綠 |
| 10 | 寫入 | `prisma/schema/` ×7 + `tests/setup/global.ts` + `tests/helpers/db.ts` + `tests/db/` ×4 | 43 測試綠 |
| 11 | 寫入 | `src/auth/` ×5 + `tests/auth/` ×4 | 72 測試綠 |
| 12 | 修改 | `prisma/schema/user.prisma` 加 `tokenPrefix`；連帶修 user-model 測試 5 處 | 回歸綠 |
| 13 | 寫入 | `src/auth/bootstrap.ts` + `tests/auth/bootstrap.test.ts` | 16 測試綠 |
| 14 | 寫入 | `src/invite/` ×3 + `tests/invite/code.test.ts` | 25 測試綠，含併發不超賣 |
| 15 | 寫入 | `src/users/` ×2、`src/http/` ×6、`tests/helpers/app.ts`、`tests/http/register-*.test.ts` ×3 | 44 測試綠 |
| 16 | 寫入 | `prisma/schema/setting.prisma` + `src/settings/registration.ts` | 新增執行期設定表 |
| 17 | 執行 | `npx prisma generate` | EXIT 0，PrismaClient 含 setting |
| 18 | 寫入 | `src/http/routes/` 新增 password/tokens/admin-invites/admin-settings | 路由無條件全掛載 |
| 19 | 修改 | `src/http/principal.ts` 加 Bearer PAT 與 `requireAdmin`；`register.ts` 改用 `resolveMode()` | 支援註冊模式熱切換 |
| 20 | 寫入 | `tests/helpers/auth.ts` + `tests/http/account|admin-invite|admin-settings.test.ts` | 45 測試綠 |
| 21 | 修正 | `src/users/create.ts` 的 `@/auth/password.js` → 相對路徑 | build EXIT 0 |
| 22 | 執行 | 全量回歸 `npx vitest run` + 雙 tsc | 17 檔 / 271 測試綠，兩個 tsc 皆 EXIT 0 |
| 23 | 寫入 | `agent/項目表.md` 新建、`deep_todos.md` 與 `memory.md` 補記 | 追蹤文件同步至階段 6b |
| 24 | 寫入 | `src/onedrive/` ×5 + `tests/onedrive/` ×5 | 99 測試綠 |
| 25 | 修改 | `StoreOptions` 加 `mergeMaxGap`/`mergeMaxSpan` | 合併閾值可調，拆成兩條測試 |
| 26 | 寫入 | `src/git/` object/delta/pack/index-store + `tests/helpers/pack.ts` + `tests/git/` ×4 | 74 測試綠 |
| 27 | 修正 | `index-store.ts` 的 `cacheEntries` 追加按 oid 清理 | 同 repo 一個 oid 只留一筆索引 |
| 28 | 寫入 | `src/git/` pktline/protocol/parse/reader/writer | 96 測試綠 |
| 29 | 修正 | `writer.ts` 的 `buildPackFile` 改用實際寫出數寫標頭 | Set 無 .length，原本寫入 undefined |
| 30 | 寫入 | `src/http/basic-auth.ts`、`src/git/receive.ts`、`src/http/routes/git.ts` + `tests/helpers/store.ts` | 37 測試綠 |
| 31 | 修改 | `IndexStoreIo` 回傳型放寬為 `unknown` | 讓 Store 可直接注入 |
| 32 | 寫入 | `src/repos/` access/name/service + `src/http/routes/repos.ts` | 63 測試綠 |
| 33 | 寫入 | `src/issues/` ×3、`src/pulls/` ×3 | 52 測試綠 |
| 34 | 修正 | issues/pulls 路由 5 處 `findFirst` 改 `findUnique` | 複合唯一鍵只有 findUnique 支援 |
| 35 | 寫入 | `src/http/repo-scope.ts`、`routes/issues.ts`、`routes/pulls.ts` | 45 測試綠 |
| 36 | 寫入 | `src/web/` ×4 + `src/http/routes/web.ts` + `tests/http/web.test.ts` | 23 測試綠 |
| 37 | 修正 | `routes/web.ts` 加 `repoShellParams` 守門 | `/assets/secrets.css` 由 200 改回 404 |
| 38 | 寫入 | `src/bootstrap/runtime.ts` + `src/server.ts` + `tests/bootstrap/runtime.test.ts` | 7 測試綠 |
| 39 | 寫入 | `Dockerfile`、`docker-compose.yml`、`.dockerignore`、`README.md` | 部署與文件完成 |
| 40 | 寫入 | 三份 agent 追蹤文件補記階段 7~13 | 文件同步至階段 13 |
| 41 | 搬遷 | `src/onedrive/{ranges,lru}.ts` → `src/storage/`、測試同步 | 通用工具與後端解耦 |
| 42 | 寫入 | `src/storage/crypto.ts` + `tests/storage/crypto.test.ts` | 45 測試綠 |
| 43 | 寫入 | `src/storage/hf.ts` + `tests/storage/hf.test.ts` | 31 測試綠 |
| 44 | 寫入 | `src/storage/store.ts` + `tests/storage/store.test.ts` | 29 測試綠 |
| 45 | 改寫 | `src/config/{schema,load}.ts` + 測試（HF_* 與金鑰守門） | 36 測試綠 |
| 46 | 修正 | `src/config/validate.ts` 的 `deepFreeze` 跳過 TypedArray | 主金鑰 Buffer 不再使 loadConfig 拋錯 |
| 47 | 刪除 | `src/onedrive/`、`tests/onedrive/` | 舊後端下線 |
| 48 | 改寫 | `prisma/schema/git.prisma`（PackFile 刪三欄）+ 22 檔批次改名 storagePath | prisma generate 通過 |
| 49 | 改寫 | `src/bootstrap/runtime.ts`、`tests/helpers/{store,app}.ts`、`tests/bootstrap/runtime.test.ts` | 11 測試綠 |
| 50 | 修正 | `tests/db/git-index-model.test.ts`、`tests/storage/hf.test.ts` 型別與契約 | 雙 tsc EXIT 0 |
| 51 | 改寫 | `.env.example`、`docker-compose.yml`、`Dockerfile`、`README.md` | 移除 ONEDRIVE_* 與 CACHE_DIR |
| 52 | 改寫 | `agent/{question,項目表,deep_todos,memory}.md` | 追蹤文件同步至輪次 4 |
| 53 | 執行 | 全量回歸 `npx vitest run` + 雙 tsc | 39 檔 828 測試綠，TSC/BUILD 皆 0 |
| 54 | 寫入 | `src/storage/lfs.ts` + `tests/storage/lfs.test.ts` | 27 測試綠 |
| 55 | 改寫 | `src/storage/hf.ts` 加入 LFS 上傳/下載/href TTL 快取 + `tests/storage/hf-lfs.test.ts` | 21 測試綠 |
| 56 | 修正 | `tests/storage/hf.test.ts` 四條測試改用非 LFS 副檔名 | storage 199 測試綠 |
| 57 | 改寫 | `src/config/{schema,load}.ts` 加 `LFS_THRESHOLD_BYTES`、`readCacheMaxBytes` 一般化為 `readSize` | config 39 測試綠 |
| 58 | 改寫 | `src/bootstrap/runtime.ts` 傳入 lfsThresholdBytes | TSC 0 |
| 59 | 改寫 | `.env.example`、`docker-compose.yml`、`README.md` 補 LFS 章節與組態 | 文件與實作一致 |
| 60 | 改寫 | `agent/{項目表,deep_todos,memory}.md` | 追蹤文件同步至輪次 5 |
| 61 | 執行 | 全量回歸 + 雙 tsc | 41 檔 876 測試綠，TSC/BUILD 皆 0 |
| 62 | 改寫 | `src/storage/store.ts` readRanges 改 Promise.all 並行抓 span + `tests/storage/store.test.ts` 並行測試 | store 30 測試綠 |
| 63 | 改寫 | `src/storage/hf.ts` uploadViaLfs 直傳 Buffer（零複製）+ `tests/storage/hf-lfs.test.ts` 參考等性測試 | hf-lfs 22 測試綠 |
| 64 | 改寫 | `src/storage/crypto.ts` encryptBytes 預配置輸出、刪 sealChunk、校正檔頭索引 | crypto 45 測試綠 |
| 65 | 執行 | 全量回歸 + 雙 tsc | 41 檔 881 測試綠，TSC/BUILD 皆 0 |
| 66 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 6 |
| 67 | 改寫 | `src/git/reader.ts` fetchSlices 多 pack 並行 + `tests/git/reader.test.ts` gate io 測試 | reader 16 測試綠 |
| 68 | 改寫 | `src/git/reader.ts` readMany 並行 planFor（依序 null 檢查）+ gate prisma 測試 | 同上 |
| 69 | 改寫 | `src/git/writer.ts` buildPackFile 串流雜湊+單次 concat | tests/git 167 測試綠 |
| 70 | 執行 | 全量回歸 + 雙 tsc | 41 檔 883 測試綠，TSC/BUILD 皆 0 |
| 71 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 7 |
| 72 | 改寫 | `src/git/pktline.ts` sideBand 單次配置 + `tests/git/pktline.test.ts` 邊界測試 ×2 | pktline 27 測試綠 |
| 73 | 改寫 | `src/http/routes/git.ts` authorize Promise.all 並行 | git-transport 38 測試綠 |
| 74 | 改寫 | `tests/http/git-transport.test.ts` 授權並行 RED→GREEN（Prisma mock cast 教訓） | RED 超時→GREEN |
| 75 | 執行 | 全量回歸 + 雙 tsc | 41 檔 886 測試綠，TSC/BUILD 皆 0 |
| 76 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 8 |
| 77 | 改寫 | `src/repos/access.ts` resolveAccess 並行 + `tests/repos/access.test.ts` gate 測試 | RED→GREEN |
| 78 | 改寫 | `src/http/repo-scope.ts` locate 並行 + `tests/http/issues.test.ts` gate 測試 | RED→GREEN |
| 79 | 改寫 | `src/http/routes/repos.ts` readable 並行 | 4 檔 110 測試綠 |
| 80 | 執行 | 全量回歸 + 雙 tsc | 41 檔 888 測試綠，TSC/BUILD 皆 0 |
| 81 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 9 |
| 82 | 寫入 | `tests/http/logout.test.ts`（RED：登出後 401） | 缺陷證據 |
| 83 | 改寫 | `src/http/routes/session.ts` logout 直接以 token 撤銷 | 缺陷修復 |
| 84 | 改寫 | `src/auth/session.ts` lastSeenAt 節流 + 測試改寫 | RED→GREEN |
| 85 | 寫入+改寫 | `tests/auth/basic-auth.test.ts` + `src/http/basic-auth.ts` 單查詢 | RED→GREEN |
| 86 | 執行 | 全量回歸 + 雙 tsc | 43 檔 895 測試綠，TSC/BUILD 皆 0 |
| 87 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 10 |
| 88 | 改寫 | `src/pulls/diff.ts` flatten/diffTrees 並行 + `tests/pulls/service.test.ts` gate 測試 | RED→GREEN |
| 89 | 改寫 | `src/issues/service.ts` resolveAuthor 記憶體化 + `tests/issues/service.test.ts` 計數測試 | RED→GREEN |
| 90 | 執行 | 全量回歸 + 雙 tsc | 43 檔 897 測試綠，TSC/BUILD 皆 0 |
| 91 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 11 |
| 92 | 改寫 | `src/git/index-store.ts` writeIndex 並行上傳 + `tests/git/index-store.test.ts` gate 測試 | RED→GREEN |
| 93 | 改寫 | `src/auth/pat.ts` lastUsedAt 節流 + `tests/auth/pat.test.ts` 兩側測試 | RED→GREEN |
| 94 | 執行 | 全量回歸 + 雙 tsc | 43 檔 899 測試綠，TSC/BUILD 皆 0 |
| 95 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 12 |
| 96 | 新增 | `tests/settings/registration.test.ts`（3 測試） | RED：計數 2≠1 |
| 97 | 改寫 | `src/settings/registration.ts` WeakMap 快取 + 寫入失效 | settings+http 245 綠 |
| 98 | 改寫 | `tests/http/web.test.ts` 熱切換改走 writeRegistrationMode | 對齊服務邊界 |
| 99 | 執行 | 全量回歸 + 雙 tsc | 44 檔 902 測試綠，TSC/BUILD 皆 0 |
| 100 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 13 |
| 101 | 改寫 | `tests/git/reader.test.ts` 批量契約測試 ×2 | RED：2 failed |
| 102 | 改寫 | `src/git/index-store.ts` lookupObjects + toLocation 抽出 | 批量查詢 |
| 103 | 改寫 | `src/git/reader.ts` resolveLocations BFS + readMany 改批量 | tests/git 171 綠 |
| 104 | 改寫 | `src/storage/lru.ts` deletePrefix 免鍵陣列 | lru 回歸綠 |
| 105 | 執行 | 全量回歸 + 雙 tsc | 44 檔 903 測試綠，TSC/BUILD 皆 0 |
| 106 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 14 |
| 107 | 新增 | `tests/bootstrap/db-pragma.test.ts`（WAL/busy_timeout 2 測試） | RED：journal=delete |
| 108 | 改寫 | `src/bootstrap/runtime.ts` tuneSqlite + `src/server.ts` 呼叫 | 生產切 WAL |
| 109 | 改寫 | `tests/setup/global.ts` template 切 WAL（async setup） | 測試庫繼承 WAL |
| 110 | 執行 | 全量回歸 + 雙 tsc | 45 檔 905 測試綠，TSC/BUILD 皆 0 |
| 111 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 15 |
| 112 | 新增 | `tests/git/receive.test.ts`（7 測試：行為錨定+P2002+足跡） | RED 足跡失敗 |
| 113 | 改寫 | `src/git/receive.ts` applyCommands 條件式寫入 | 7 測試綠 |
| 114 | 改寫 | `src/auth/bootstrap.ts` changePassword 先查後 hash | bootstrap 測試綠 |
| 115 | 執行 | 全量回歸 + 雙 tsc | 46 檔 912 測試綠，TSC/BUILD 皆 0 |
| 116 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 16 |
| 117 | 讀取 | admin-settings/admin-invites/register/users-create/invite/ranges/object/issues-document | R17 掃描 |
| 118 | 改寫 | `agent/{question,deep_todos,memory}.md` | R17 誠實無變更記錄 |
| 119 | 改寫 | `src/git/pack.ts` inflateWithConsumed 上界啟發式+先探回退 + `tests/git/pack-probes.test.ts` | RED 39 次→GREEN <32 |
| 120 | 執行 | 全量回歸 + 雙 tsc | 47 檔 913 測試綠，TSC/BUILD 皆 0 |
| 121 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 18 |
| 122 | 改寫 | `src/git/index-store.ts` rebuildCacheFromStore 推導 byteSize（刪 readAll）+ `tests/git/index-store.test.ts` 重建免下載測試 | RED→GREEN 15 測試綠 |
| 123 | 執行 | 全量回歸 + 雙 tsc | 47 檔 914 測試綠，TSC/BUILD 皆 0 |
| 124 | 改寫 | `agent/{question,deep_todos,memory,項目表}.md` | 追蹤文件同步至輪次 19 |
| 125 | 改寫 | `agent/項目表.md` 分組實測校正（repos/settings 歸屬重複、bootstrap 11→13、http 250→242） | 加總 914 吻合 |
| 126 | 執行 | R20 收尾審計：全量 47 檔/914 + 雙 tsc 複驗 | 與 R19 一致 |
| 127 | 改寫 | `agent/{question,deep_todos,memory}.md` R20 收尾記錄 | 追蹤文件同步至輪次 20（全部完成） |
