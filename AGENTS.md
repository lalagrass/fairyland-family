# fairyland-family 開發接手說明

公開 repo。fairyland 的智慧外掛：文字介面、自動化、多角色與新畫面。

**先讀**：[`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md)（流程與共同規則，兩個 repo 同一份）→ 交辦的 issue → [`docs/product/BLUEPRINT.md`](docs/product/BLUEPRINT.md) 第 1.1、2 節。`docs/product/FUTURE.md` 與 `docs/history/` 只有 issue 引用時才讀。進度與待辦只在 GitHub issue（總表 lalagrass/fairyland#16）。

## 本 repo 專屬規則

- **公開**：不放原版素材、提取資料、考據數值、任務編號或座標、金鑰。`npm run check-assets` 會擋圖檔與封包；數值與資料靠自律，執行時一律從宿主快照或同源素材讀。
- 只改顯示、不改規則：金錢、掉落、戰鬥結果、工作時間都由 fairyland 宿主決定，family 不自補數值。
- 協定只在 fairyland 改，這裡用 `npm run sync-protocol` 同步；不從本 repo 順手改 fairyland。
- 套件授權只收 MIT／BSD／Apache-2.0／ISC／zlib（清單在 `docs/product/FM7_LICENSES.md`）。開源外掛可參考做法與介面，程式碼只取授權相容的；支援串接 fairyland 宿主與本機 Wine 遊戲視窗進行自動化。
- 公開美術一律原創；原版圖與受版權保護的作品不當生成輸入；成品附生成紀錄。
- 方向改變時改寫藍圖對應章節並在第 11 節決策紀錄加一行；文件以【定案】【提案】【待試玩】標狀態，只有【定案】可當成已決定的規則。

## 常用指令（與 CI 相同）

```bash
npm ci && npm run check-assets && npm run check-effects && npm run build && npm test
```

需要 fairyland 分頁的檢查在 fairyland repo（`golden:mac`、`plugin_*_check.mjs`），一律 headless，跑完關掉伺服器與瀏覽器。
