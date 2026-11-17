# 童話家族・AI 美術生產與工具評估（`art/README.md`）

本目錄存放「武俠試點角色」與後續介面／特效／地圖的美術規格書、角色設定、公有領域參考、生成品產出與完整 provenance（來源與提示詞紀錄）。

---

## 一、AI0：生成服務比較表與推薦（供 Yuying 選定帳號與預算）

> 依工作規則：任何需要開帳號、API 金鑰或產生費用的服務，**需由 Yuying 選定與核准**；選定前可繼續推進程式與主線（W5–W10）。

### 1.1 圖像生成服務（立繪、5 表情頭像、三視圖、UI 紋理、未來圖塊）

| 項目 | **選項 A：Google Gemini Image API（`gemini-2.5-flash-image` / `gemini-3-pro-image`）＋ 去背** | **選項 B：fal.ai（FLUX Pro / Kontext / Instant Character）＋ BiRefNet 去背** | **選項 C：OpenAI `gpt-image-1`（Images API）** |
|---|---|---|---|
| **定價概算** | Flash 約 **\$0.037–0.08 / 張**；Pro（高階多圖參考／高解析）約 **\$0.15–0.30 / 張**；Batch 可半價 | FLUX Schnell ~\$0.003–0.009／張；FLUX Pro／Kontext ~\$0.03–0.06／張；背景去除 ~\$0.002／次 | 約 **\$0.04–0.19 / 張**（視品質 mid/high 與尺寸而定） |
| **API 整合** | 官方 REST / Python / Node SDK（`GEMINI_API_KEY`） | 官方無伺服器 REST / JS / Python SDK（`FAL_KEY`），可一條管線串聯生成＋去背 | 官方 REST / JS / Python SDK（`OPENAI_API_KEY`） |
| **商業授權與所有權** | 付費 API 層級產出皆具完整商業使用權（受 ToS 安全政策規範） | fal 付費端點與 FLUX Pro／商用端點具商業授權（自託管 Schnell/Dev 需注意各自權重授權） | 付費 API 產出歸使用者所有，允許商業使用 |
| **角色一致性功能** | 原生支援 **多圖參考（Multi-reference，最多 6–14 張）** ＋對話式微調，從「定錨立繪」延伸 5 個表情與三視圖最穩定 | 支援 **FLUX Kontext / Instant Character / Seed / LoRA**，可固定種子或接角色參考圖 | 支援 `images.edits` 參考原圖修改表情與角度，細節保持度佳 |
| **解析度與透明背景** | 支援 1K–4K；預設實色底，需後處理去背（可用 Python/fal BiRefNet 或純色綠幕／白底去背） | 支援 1024px+；可於同一 API 內直接串 `bria/background/remove` 輸出乾淨透明 PNG | 原生支援 **`background: "transparent"`** 直接輸出 RGBA PNG（1024×1536 等直立比例） |
| **綜合評價** | **多圖參考一致性極強**，與既有 Gemini 生態最容易共用計費；只需多一步本機去背 | **成本最低、可控性最高**（seed＋LoRA＋同站去背一步到位） | **原生透明背景最省事**，線條理解佳，單價略高於 FLUX |

- **2D 推薦組合**：
  - **首推**：**Google Gemini Image API（多圖參考延伸表情／三視圖）或 OpenAI `gpt-image-1`（原生透明立繪）**，試點單一角色（約 30–40 次實驗＋篩選）預估總花費僅 **\$2–8 USD**。
  - 若追求大量試驗最低單價，改走 **fal.ai（FLUX Kontext / Pro ＋ 去背）**，每組探索成本可壓到 **\$1–3 USD**。

---

### 1.2 3D 生成服務（AI6：從定錨立繪＋三視圖生成 3D 網格，供 Blender 渲染成 80×120 點陣小人）

| 項目 | **選項 A：Tripo3D API / Pro** | **選項 B：Meshy Pro / API** | **選項 C：Hyper3D Rodin（直連或經 fal.ai）** |
|---|---|---|---|
| **定價概算** | 免費 200 點（**非商用**）；Pro 約 **\$20/月**；API 可經官方或 fal.ai 按次計費 | 免費 100 點（CC BY 4.0 需署名）；Pro 約 **\$20/月** 起，API 按幾何／貼圖預付點數 | Creator 約 **\$30/月**（\$280/年）、Business API **\$120/月**；經 **fal.ai / Replicate 按次計費**（每次數毛美金） |
| **商業授權與隱私** | **付費方案／API 享完整私有商業授權**（免署名） | **付費方案享完整私有商業授權**（免署名）；免費版僅 CC BY 4.0 | 付費生成／下載即具商業授權 |
| **多視圖輸入／幾何品質** | 支援單圖／多視圖轉 3D，人物體型比例與四肢分離乾淨 | 支援多視圖＋貼圖 2K/4K，風格化卡通與奇幻人物穩定 | **幾何拓樸與服飾垂墜細節最佳**（Gen-2/3），布料褶皺最接近立繪 |
| **內建綁骨 / API** | 內建 **Auto-rigging ＋ Retargeting**（可從 API/Studio 直接出骨骼） | 專有 **Rigging ＋ Animation API** 完整端點（一鍵綁骨與套動作） | 偏重高精度網格與部件拆解，綁骨需交由 Blender / Mixamo / AccuRIG |

- **3D 推薦方案**：
  - **首推**：**Meshy Pro（\$20/月）或 Tripo3D Pro（\$20/月）**（預算相同，先挑一家的「月訂 Pro ＋ API」；4 位角色分批生成只需 1 個月訂閱即綽綽有餘）。其中 **Meshy** 具備獨立完整的 **Image-to-3D → Rigging → Animation API** 鏈，最適合自動化腳本驗證；若對古風長袍幾何要求極高，可用 **fal.ai 單次呼叫 Hyper3D Rodin** 生成網格再進自動綁骨。

---

### 1.3 自動綁骨與共用動作庫服務（AI6：站、走、跑、攻、招、傷、倒 7 套通用動作）

| 項目 | **Adobe Mixamo** | **Meshy / Tripo 內建 Auto-Rig API** | **ActorCore AccuRIG（Reallusion）＋ Blender** |
|---|---|---|---|
| **價格與商業授權** | **完全免費**（需 Adobe 帳號）；產出骨骼與動作可免權利金用於商業遊戲 | 包含在 Meshy/Tripo Pro 訂閱／點數內；付費層可商業使用 | **免費桌面軟體**（macOS/Windows）；綁骨結果完全自有商用 |
| **API 自動化** | 無公開 REST API（需網頁手動上傳下載 FBX），動作庫最龐大（含劍術／揮砍／受擊／倒地） | **有公開 API**，可直接把 3D 網格串成帶骨 GLB/FBX | 無雲端 API（可本機手動一鍵綁骨＋匯出 FBX 給 Blender 套 Mixamo 動作庫） |
| **古風長衫支援提醒** | 偶爾將寬袖／下擺誤判為腿部，需在 Blender 腳本微調權重 | 同上，對 A-pose / T-pose 較穩定 | **指節與衣物基準點可手動拖曳校準**，對長袍容錯最高 |

- **綁骨推薦組合**：
  - 先用 **Meshy／Tripo Auto-Rig API**（或本機免費 **AccuRIG**）綁出標準人形骨架，動作庫採用 **Mixamo 免費武打動作包（下載一次進 repo 共用腳本）**，之後由 Blender Python 腳本自動套用並對齊 `PHM011` 鏡頭渲染（P-ART3）。

---

## 二、生產規範與資料夾結構

```text
art/
  README.md                 # AI0 工具比較、授權條款、待核准預算與目錄規範
  STYLE_BIBLE.md            # AI1 畫風規格書（色盤、線條、頭身比、鏡頭與五種提示詞模板）
  references/
    REFERENCES.md           # 商業連結文字分析＋公有領域來源表
    public_domain/          # 僅放置已驗證為 PD / CC0 的傳統繪畫參考圖
  characters/
    qingshan/sheet.md       # AI2 試點角色 1：青衫劍客（劍法）
    biaoju/sheet.md         # AI2 角色 2：鏢局刀客（刀法）
    tiesuanpan/sheet.md     # AI2 角色 3：鐵算盤掌櫃（鐵算盤）
    yaowang/sheet.md        # AI2 角色 4：藥王谷女醫（內家真氣／符籙）
  review/                   # 留存各階段 AI 篩選候選對照表 PNG（P-ART2/3）
  provenance/               # 每張生成檔的 <檔名>.json（模型、版本、prompt、seed、後處理）
```

---

## 三、待 Yuying 決定的事項（開始 P-ART2 前需確認）

1. **圖像生成服務選擇與預算**：
   - 請從上表選定一家並提供對應環境變數金鑰（不入 git）：`GEMINI_API_KEY`（Google Gemini Image API，推薦多圖一致性）、`FAL_KEY`（fal.ai FLUX，單張成本最低）或 `OPENAI_API_KEY`（`gpt-image-1`，原生透明底）。試點（立繪＋5 表情＋三視圖＋UI 紋理）建議預算上限：**\$5–15 USD**。
2. **3D 與綁骨服務（可等 P-ART2 立繪定稿前再定）**：
   - 推薦 **Meshy Pro（\$20/月）** 或 **Tripo3D Pro（\$20/月）** ＋ 免費 **Mixamo**／**AccuRIG** 動作庫。
3. **風格規格審閱**：
   - 請檢視 [`STYLE_BIBLE.md`](STYLE_BIBLE.md) 與第一位試點 [`characters/qingshan/sheet.md`](characters/qingshan/sheet.md) 是否符合預期氣質（不另等回覆，未改方向前提下，待選定服務即依此執行 P-ART2）。
