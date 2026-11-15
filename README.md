# 童話家族 · Fairyland Family

以工作製作、家族角色分工與玩家互動為核心的童話延伸文字網路遊戲。

目前階段：規劃中，尚無可執行遊戲。完整規劃見 [產品藍圖與 milestones](docs/product/BLUEPRINT.md)；各節以【定案】【提案】【待試玩】標示狀態，改版方式見藍圖第 0 節。

## 近期目標：Mac 本機試玩【定案】

在 Mac 上可以實際試玩，並確認文字指令能讓遊戲角色正確操作。兩條軌道並行：

- **A 軌**：繼續推進單機版 fairyland 的遊玩完成度，並維持純淨宿主定位（只提供單步原子操作與場景快照，隔離非原版除錯與外掛功能）。
- **B 軌**：本 repo 的文字介面，作為 fairyland 的智慧文字外掛（承擔跨圖尋路導航、戰鬥託管、工作排程與行動佇列）。
- **接軌方式**：本機的遊戲本體與時鐘就是 fairyland。fairyland 分頁開著＝遊戲進行，關閉＝遊戲停止；family 送出單步原子指令、讀場景快照並持久化外掛佇列，關掉再打開時接上 fairyland 當下的狀況。

第一個試玩情境：開著 fairyland，用文字介面帶家族角色在第一個村莊接任務、走到礦場採礦、冶煉、鍛造，並在 fairyland 畫面上看到角色照指令行動。範圍與驗收見藍圖第 2 節。

## 產品方向（使用者提出）

- 每位玩家經營一個家族，多個角色分開工作或組隊探險。設計基準 5 人；免費／付費名額待定，見藍圖 9.5 節。
- 透過伺服器執行持續工作，讓玩家關閉網頁與電腦後仍能取得進度（多人階段；本機試玩不做，見藍圖 9.3 節）。
- 以文字介面低成本驗證老玩家是否有興趣，工作製作是重要玩法。
- 取消職業限制：角色可使用各系戰鬥技能；對應武器強化威力並提供熟練度成長。帶幻獸戰鬥可成長幻獸相關能力（藍圖 4.2 節）。
- 單體技能可透過連擊與轉移目標清理怪群；範圍技能依最大目標數限制追加次數（藍圖 4.3 節）。
- 點 NPC 後，依路徑與移動時間抵達再互動。

## 未來方向

- 點角色觀察原版對應的地圖、移動與戰鬥畫面（藍圖 9.2 節）。
- 跨玩家組隊、市集、聊天、代工委託、公會（藍圖第 6、9.1 節）。
- 常駐主機，電腦關機也持續工作（藍圖 9.3 節）。
- 官方允許下的整合是遠期可能性；近期以獨立延伸遊戲為主（藍圖 9.4 節）。

## 與 fairyland 的關係

兩個獨立 repo，各自維護產品與發布節奏。fairyland 是純淨的單機遊戲宿主與原版資料／規則來源：對外只暴露單步原子能力、場景快照與無狀態純演算法（`findPath`／`findMapRoute`）；跨圖導航狀態機、戰鬥託管、行動佇列與工作排程放在 family 外掛端，不污染主遊戲。本 repo 讀取附來源 commit 的資料快照，複用程式時記錄來源路徑與 commit，不整包複製；共用規則穩定後，再考慮有版本的共用套件。

本機來源：`/Users/chenyuying/workspace/fairyland`

本次盤點基準（2026-11-15）：`e93c59dd7b238662ba637ddb00162371a3bb101b`。

優先閱讀來源專案：

- `docs/design/NEXT_PHASE_PLAN.md`：系統改版、後續地圖與戰鬥修正進度。
- `docs/importer/MIGRATION_FIDELITY_MATRIX.md`：原版資料、推測與重建規則的界線。
- `packages/shared/src/data/`：道具、材料、武器、技能等資料。
- `packages/shared/src/engine/headless_battle_engine.ts`：無頭戰鬥與事件。
- `packages/shared/src/engine/pathfinding.ts`：尋路。
- `packages/shared/src/engine/combo.ts`：連擊。
- `packages/shared/src/engine/work_skills.ts`：現有工作示範，不能直接當成完整原版生產規則。
- `packages/server/src/`：目前以連線為生命週期的獨立戰鬥房，不能直接視為持久多人世界。
- `packages/client/src/stage/`：現有 Canvas 2D 畫面；觀察模式不必先改用 PixiJS。

## 資料與架構原則

- 伺服器決定遊戲時間、活動、資源與戰鬥結果；前端呈現倒數、文字與動畫。
- 網路連線不承載角色的生命週期；斷線不銷毀工作。
- 移動依可行走路徑計時。遇敵、取消或改目的地時，原抵達事件需失效。
- 文字與圖像觀察使用同一份狀態與事件；看畫面不改變結算速度。
- 保留來源 ID 與資料版本；區分原版提取、推測與家族版自訂。
- 名稱表不等於完整規則。配方需轉成材料 ID／數量，補齊時間、需求、產物與消耗。
- 不把示範配方、替代素材或未量測的容量寫成已確認的原版能力。

## 接手入口

先閱讀本檔、`AGENTS.md` 與藍圖，並在可存取來源 repo 的環境核對程式。若來源不在目前電腦／雲端環境，明確記錄缺少的依賴，不能假定本機絕對路徑在其他環境存在。

第一項建議任務：整理藍圖 M0 的可重用模組與資料缺口、指令格式，以及 family 與 fairyland 之間指令／事件連線的驗證計畫。本輪僅修訂規劃文件；技術驗證與 M1 家族離線工作閉環實作，須在另行安排執行後才啟動，不由此接手說明自動開工。角色數不預設為五人，初始名額與解鎖流程依藍圖 9.5 節試驗後決定。未來實作交付時附啟動方式、已完成範圍、驗證結果與已知限制。

## P1：與 fairyland 並排執行

目前可執行的只有「遊戲 → 文字」的唯讀對照：family 顯示遊戲連線狀態、角色、場景選單（對話／前往／採集／商店）與事件日誌。點選單或輸入文字會送出原子指令，P1 的 fairyland 一律回 `NOT_IMPLEMENTED_P1`（日誌會顯示，屬預期）。

```bash
npm ci
npm run build        # 輸出 dist，base 為 /family/
npm test
npm run check-protocol   # 與並排的 ../fairyland 協定副本比對（找不到 fairyland 時略過）
npm run sync-protocol    # 重新複製協定（來源路徑與 commit 寫在檔頭）
```

1. 在 `../fairyland` 執行 `npm run client`（它會把本 repo 的 `dist` 掛在同源 `/family/`；位置可用 `FL_FAMILY_DIST` 覆寫）。
2. 開 `http://localhost:3000/?dev=1`（遊戲，並顯示收發紀錄）與 `http://localhost:3000/family/`（兩個分頁必須同源，BroadcastChannel 才通）。
3. 不開遊戲時可用 `http://localhost:3000/family/?replay=1`（或 `npm run dev` 後開 `http://localhost:3100/family/?replay=1`）播放 `fixtures/replay_village.json`；`&speed=2`、`&loop=1` 可選。快照來自真實地圖，事件順序為手排（`scripts/make-replay-fixture.ts` 產生）。

### P1 對照檢查表（人工）

- [ ] family 顯示「遊戲執行中」；關閉遊戲分頁 3 秒內變「遊戲未執行」，重開後自動接上並取得快照。
- [ ] 遊戲裡點地板走路 → 日誌出現「走到 (x, y)」，角色列位置與遊戲一致。
- [ ] 遊戲裡點 NPC 對話 → 日誌與場景區出現該 NPC 與對白；關閉對話 → 「對話結束」。
- [ ] 買東西 → 金錢與道具變動事件；走進傳送點 → 「移動到…（換圖）」且場景選單換成新地圖的 NPC／出口。
- [ ] （P1 版本；P2 起指令會真的執行，見下節）family 點「對話：某 NPC」或輸入 `前往 村長` → commandId 與遊戲 `?dev=1` 面板相同。

## P2：自動導航、自動戰鬥與文字操作（文字 → 遊戲）

協定版本 2。宿主（fairyland）真的執行 `WALK_TO`（只限同一張圖）、`TALK_TO_NPC`、`CHOOSE_DIALOG_OPTION`、`ACCEPT_QUEST`、`BUY_ITEM`、`SELL_ITEM`、`BATTLE_ACTION`、`BATTLE_FLEE`；每個指令先回「已接受／被拒絕＋原因碼」，需要時間的再送 `COMMAND_COMPLETED`。`WORK_ONCE` 仍是 `NOT_IMPLEMENTED`（P3）。

- **自動導航**（`src/navigator.ts`）：`前往 村長`＝規劃跨圖路線（協定資料夾的 `planMapRoute`，鄰接來自快照 `nav.portalGraph` 與外掛看過的各圖出口）→ 每張圖用 `WALK_TO` 走到下一個出口 → 換圖後等新快照再繼續 → 抵達後 `TALK_TO_NPC`。遇敵暫停，戰鬥結束從目前位置續走；遊戲回 `GAME_BUSY`（結算視窗還沒關）就每秒重試。重新派發、取消（`停止導航`）或遊戲重啟都會讓舊的完成處理失效。出口走不通（`BLOCKED`、或走到卻沒換圖）會換同一目的地的另一個出口。
- **自動戰鬥**（`src/battler.ts`）：策略 手動（預設，什麼都不做）／普通攻擊／逃跑，記在 localStorage。只在 `BATTLE_TURN_READY` 出手，同一（場次, 回合）最多一次；非手動策略在戰鬥結束後會送 `RETURN_TO_MAP`／`DEFEAT_RESCUE` 關掉結算視窗。逃跑公式是宿主的**佔位值**（見 fairyland NEXT_PHASE_PLAN §13.6），不是原版數值。
- **已知目錄**（`src/directory.ts`）：預設知道村長傑夫在市鎮中心 20010；每份快照看到的 NPC 與出口都會記住（localStorage）。宿主沒有世界目錄，所以沒去過的地方只能靠 `portalGraph` 與這份預設清單。
- **面板**：對話選項、商店（買／賣）、戰鬥（攻擊／防禦／逃跑、勝敗視窗）、導航狀態與取消、策略下拉；文字輸入與按鈕走同一個 `UiAction`（`src/parse.ts`）。日誌每個指令都顯示「預期 vs 實際」（例如 `預期 MAP_CHANGED／實際 ENCOUNTER ✗`）。
- **回放模式**（`?replay=1`）只回應 `REQUEST_SNAPSHOT`，其他指令回 `NOT_IMPLEMENTED`（不模擬遊戲）；P2 的真實行為用 fairyland 的 `scripts/plugin_p2_check.mjs` 兩分頁端到端檢查。

文字指令：`前往 村長`、`對話 阿爾`、`走到 x y`、`選項 <id 或文字>`、`買／賣 <id 或名稱> [數量]`、`攻擊 [目標]`、`防禦`、`逃跑`、`策略 手動|普通攻擊|逃跑`、`停止導航`、`快照`、`talk <名>`（不走過去，太遠會 `TOO_FAR`）。

已知限制：模擬野外地圖（如 `FIELD_MEADOW`）宿主不送場景快照，外掛只知道所在地圖 id（選單不更新）；市鎮中心沒有走得通的出口回吉恩村。
