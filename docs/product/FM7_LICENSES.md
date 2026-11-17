# FM7 面板套件授權

核對日期：2026-11-18。直接安裝前用 `npm view <pkg> license` 看過，安裝後再讀 `node_modules/<pkg>/package.json` 的 `license` 欄。新套件只接受 MIT、BSD（含 0BSD）、Apache-2.0、ISC、zlib。

## 這次加入的直接依賴

| 套件 | 版本 | 授權 | 用途 |
| --- | --- | --- | --- |
| `@dnd-kit/core` | 6.3.1 | MIT | 背包與倉庫之間拖曳 |
| `@dnd-kit/utilities` | 3.2.2 | MIT | 拖曳位移 |
| `@tanstack/react-table` | 9.3.1 | MIT | 名稱排序與篩選。畫面用套件自己的 `legacy` 入口（`useLegacyTable`），因為 v9 主 API 與這次要的表格寫法不同 |
| `@tanstack/react-virtual` | 3.14.26 | MIT | 技能與物品長清單只畫視窗裡的列 |
| `@radix-ui/react-popover` | 1.3.1 | MIT | 物品詳情。既有的 Dialog、Tabs 已是 Radix，不再加 Floating UI |

## 跟著進來的依賴

| 套件 | 版本 | 授權 |
| --- | --- | --- |
| `@dnd-kit/accessibility` | 3.1.1 | MIT |
| `tslib` | 2.9.1 | 0BSD |
| `@tanstack/table-core` | 9.3.1 | MIT |
| `@tanstack/react-store` | 0.11.2 | MIT |
| `@tanstack/virtual-core` | 3.19.11 | MIT |
| `@floating-ui/react-dom` | 2.1.9 | MIT |
| `@floating-ui/dom` | 1.8.0 | MIT |
| `@floating-ui/core` | 1.8.0 | MIT |
| `@radix-ui/react-popover` 其餘 `@radix-ui/*` | 隨 1.3.1 | MIT |

上表是從這五個直接依賴的 `dependencies` 往下走、讀每個 `package.json` 得到的。其中只有 `tslib` 不是字面上的 MIT，它是 0BSD，屬於 BSD 家族。

## 沒有放進來的東西

- `@iconify/react` 與 game-icons.net：圖示本體是 CC BY 3.0，不在允許的授權裡。標題旁的小圖是這個 repo 自己畫的 SVG，出處在 `art/FM7_ICONS.md`。
- Playwright：不寫進 `package.json`。`npm ci` 不該為了截圖去下載瀏覽器。截圖用 `scripts/fm7_panel_shots.mjs`，執行時才動態載入。
- RPGUI（zlib）、NES.css（MIT）、A Dark Room（MPL-2.0）、Melvor Idle、Kittens Game：只看過介面做法，沒有複製程式碼。MPL 不複製。
