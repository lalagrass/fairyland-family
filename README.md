# 童話家族 · Fairyland Family

[fairyland](https://github.com/lalagrass/fairyland)（《童話 Online》百分百還原，私有）的智慧外掛：文字介面、自動化（尋路、採集、戰鬥、任務）、多角色家族玩法與所有新畫面。本 repo 公開，只改顯示、不改遊戲規則，不放任何原版素材、提取資料或考據數值；原版素材執行時從同源的 fairyland 讀取。授權：程式碼 MIT，美術保留權利（見 `LICENSE`）。

- 開發接手：[`AGENTS.md`](AGENTS.md)、協作流程 [`docs/AGENT_WORKFLOW.md`](docs/AGENT_WORKFLOW.md)
- 產品藍圖：[`docs/product/BLUEPRINT.md`](docs/product/BLUEPRINT.md)（現行方向在 1.1 節）；多人與商業長期規劃：[`docs/product/FUTURE.md`](docs/product/FUTURE.md)
- 進度與待辦：[Roadmap lalagrass/fairyland#16](https://github.com/lalagrass/fairyland/issues/16)

## 怎麼跑

```bash
npm ci
npm run build            # 輸出 dist，base 為 /family/
npm test                 # 單元測試
npm run check-assets     # 公開 repo 檢查：不能有原版圖、音訊、封包
npm run check-protocol   # 與並排的 ../fairyland 協定副本比對（找不到 fairyland 時略過）
npm run sync-protocol    # 從 fairyland 重新複製協定（來源路徑與 commit 寫在檔頭）
```

1. 在 `../fairyland` 執行 `npm run client`，它會把本 repo 的 `dist` 掛在同源 `/family/`（位置可用 `FL_FAMILY_DIST` 改）。
2. 開兩個分頁：`http://localhost:3000/?dev=1`（遊戲，`?dev=1` 顯示收發紀錄）與 `http://localhost:3000/family/`。兩個分頁必須同源，`BroadcastChannel` 才通。
3. 不開遊戲時可用 `/family/?replay=1` 播放 `fixtures/replay_village.json`（`&speed=2`、`&loop=1`），只回應快照請求，不模擬遊戲。

協定一律在 fairyland 改，再在這裡 `npm run sync-protocol`。

## 現在做得到的

- **導航**（`src/navigator.ts`）：跨圖路線規劃，逐圖 `WALK_TO` 走到出口，抵達後對話；遇敵暫停、戰後續走，出口不通換另一個。
- **戰鬥託管**（`src/battler.ts`）：每角色策略（手動／普通攻擊／逃跑），低血先用恢復道具；開場捕捉。
- **工作佇列**（`src/queue.ts`）：採集、製作、缺工具先去買、背包滿存家族倉庫、停工原因。
- **任務**：任務面板、單筆自動推進，以及無人任務鏈（讀宿主快照的任務目錄、採集點與商店，依前置順序執行）。
- **多角色家族**（`src/dispatch.ts`）：每位角色一份派工（採集／任務鏈／新手循環／待機），停止條件與停工原因各自記錄，重開分頁後接回。宿主限制：背景角色只能採集，同一時間只有視角角色能跑任務（藍圖 2.6）。
- **面板**：目前角色工作台（總覽、技能、物品欄、家族倉庫、策略）、派工面板、事件欄；寬螢幕是電腦版，窄螢幕是手機版。
- **畫面**（`src/render/`）：觀察視窗與戰鬥畫面；每位角色可切「原版」（從 fairyland 同源讀素材）或「現代」（程式產生的圖形）檢視（藍圖 2.7）。

## 文字指令

選單與按鈕送出的指令和文字輸入相同。

`前往 村長`、`對話 阿爾`、`走到 x y`、`選項 <id 或文字>`、`買／賣 <物品> [數量]`、`攻擊 [目標]`、`防禦`、`逃跑`、`策略 手動|普通攻擊|逃跑`、`停止導航`、`採集 <材料> <次數|到滿>`、`製作 <配方> <次數>`、`停止工作`、`切換視角 <角色>`、`存倉／取倉 <物品> [數量]`、`存倉／取倉 <金額> 金`、`<角色名> <指令>`（例如 `小石 採集 青銅礦 2`）、`快照`。

## 已知限制

- 背景角色遇敵時佇列只會暫停，不會自動戰鬥；多角色同時跑任務要等 fairyland FX17（#52）。
- 只在本機、同一個瀏覽器；不跨裝置，關掉 fairyland 分頁遊戲就停。
- 數值都來自 fairyland 宿主；宿主標為佔位的（例如逃跑公式）在這裡一樣是佔位。
