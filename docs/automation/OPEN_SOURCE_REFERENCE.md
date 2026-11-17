# 自動化架構與開源參考整理（FM-A）

本文件整理童話家族「可組合行為模組＋單角策略」設計時所參考的開源專案與常見遊戲自動化／狀態協調做法。我們**只參考架構概念與設計模式，未複製任何第三方專案程式碼**；所有執行期指令仍嚴格通過宿主 `PluginCommand` 協定送出，不繞過遊戲伺服器規則。

## 參考之開源專案與授權

| 專案 / 技術 | 領域 | 授權 | 參考的概念與取捨 |
| --- | --- | --- | --- |
| **XState v5** (`xstate`) | 有限狀態機（FSM） / 狀態圖 | MIT | 以顯式事件轉換管理系統協調模式（`IDLE / NAVIGATING / WORKING / COMBAT / QUESTING / RESTING`），直接作為本專案 `src/automation/types.ts` 之協調狀態機 |
| **BehaviorTree.CPP** (`BehaviorTree/BehaviorTree.CPP`) | 行為樹設計模式 | MIT | 參考優先權排序、節點可組合與各自維護內部狀態的「Blackboard／HostContext」介面思想（未直接使用 C++ 程式庫） |
| **Mistreevous** (`nikkorn/mistreevous`) | TypeScript 行為樹概念參考 | MIT | 參考 TS 介面將「尋路、採集、戰鬥、任務」抽離為標準化 `BehaviorModule`，讓新行為能單檔註冊即插即用（未複製程式碼） |
| **Mineflayer** (`PrismarineJS/mineflayer`) | 外掛架構與移動／工作分離模式 | MIT | 參考「底層路徑追蹤器 + 專職工作佇列 + 事件訂閱通知 + per-bot 設定隔離」的插件拆分方式，對應 `AutoNavigator` / `WorkQueue` / `BehaviorModule` 分層（未複製任何程式） |

## 本專案採用的模組設計原則

1. **單一模組註冊介面 (`BehaviorModule`)**：每個行為自行實作 `isActive`、`getSummary`、`handleAction`、`onMessage` 與 `stop`。
2. **新增行為無須修改主流程**：`FamilyController` 只透過 `AutomationRegistry` 轉發事件與動作，範例擴充模組 `src/automation/modules/exampleRestModule.ts` 不改控制器即可掛載並運作。
3. **每角色獨立策略隔離 (`CharacterStrategyStore`)**：`battleStrategy`、`lowHpRetreatPct`、`bagFullPolicy`、`autoRestMinSatiety` 以 `characterId` 為鍵持久化在 `localStorage`，切換角色時不互相覆蓋。
4. **防抖與冷卻 (`cooldown`)**：延續既有任務與工作佇列的冷卻檢查與 `pending` 追蹤，避免重複發送移動／對話指令。
