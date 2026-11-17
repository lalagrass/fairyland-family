# 童話家族・武俠美術規格書（`art/STYLE_BIBLE.md`，AI1）

本規格書定義「童話家族（`revamp` 武俠角色與相關介面／特效）」之統一視覺規範。所有文字與參數必須能**直接轉為生成模型提示詞與自動驗收腳本規則**，並確保新武俠角色置入原版《童話 Online》吉恩村場景後協調不突兀。

---

## 一、核心氣質與風格定位

> **「溫潤古紙工筆線描 × 市井煙火水墨平塗 × 原版斜俯等距點陣的現代復古平衡」**

- 不走高飽和霓虹仙俠（拒絕亮粉光翼、塑膠 3D 金屬質感、過度浮誇的光效堆砌）。
- **立繪（2D Illustration）**：明代畫譜式微粗細變化的墨筆勾線 ＋ 節制暈染的礦物彩平塗，臉部有真實情感戲劇感（忠於市井江湖的樸實幽默與俠氣，而非千篇一律網紅臉）。
- **場景小人（3D → 量化點陣）**：必須和原版吉恩村地表（綠草、黃土、木牌）與玩家模型 `PHM011` 並排融洽，色塊清晰、輪廓明確，在 80×120 畫格大小下遠看一眼能辨識武器、髮色與衣色。

---

## 二、規格盤（Color Palette）與 `ramps3` 相容對應

所有角色與武俠介面以 **10 核心固定色 ＋ 3 階點綴色** 為母色盤（輸出可由 W4 `atlas_lib.py` 自動量化至 256 色，必要時亦可映射到 `ramps3` 的 `hair: G` / `skin: B` / `outfit: R` 區塊）：

| 類別 | 色名 | Hex | RGB | 用途與 `ramps3` 對應說明 |
|---|---|---|---|---|
| **線條／陰影** | 松煙墨 | `#24201E` | `(36, 32, 30)` | 立繪外輪廓主線與深層暗部（避免純黑 `#000000` 死黑）；小人卡通描邊 |
| **紙底／留白** | 素宣米 | `#EFE6D5` | `(239, 230, 213)` | 介面紙底、捲軸亮面、白衣底色 |
| **紙底次色** | 熟絹黃 | `#D6C3A3` | `(214, 195, 163)` | 舊紙邊框、木牌底紋、羊皮卷暗角 |
| **木石結構** | 焦茶褐 | `#5E4736` | `(94, 71, 54)` | 樑柱、刀鞘木紋、靴履、皮帶（對齊原版吉恩村木牌／土路色溫） |
| **青衫主色** | 石青黛 | `#3E626A` | `(62, 98, 106)` | **青衫劍客**主外袍（可設 `outfit` 染色主色，明度溫和、貼合草地又不被吃掉） |
| **青衫輔色** | 霜青灰 | `#7C979C` | `(124, 151, 156)` | 內襯交領、袖口鑲邊、劍穗高光 |
| **江湖暖紅** | 印泥朱 | `#B54132` | `(181, 65, 50)` | **鏢局刀客**披肩／繫帶、印章、警示點綴、危急血量高亮 |
| **藥王青綠** | 苦艾青 | `#6B8C5B` | `(107, 140, 91)` | **藥王谷女醫**竹青短襖、草藥包、治療紋樣 |
| **富商／銅金** | 古銅金 | `#C29342` | `(194, 147, 66)` | **鐵算盤掌櫃**銅錢扣、算盤框架、武器金屬邊與高光 |
| **通用膚色** | 溫潤象牙膚 | `#F2CFAF` | `(242, 207, 175)` | `skin` 預設色（對齊原版 `PHM011 (255,218,190)` 略收飽和，避免過粉） |
| **烏髮／玄鐵** | 墨鴉青 | `#2F3238` | `(47, 50, 56)` | `hair` 預設黑髮及玄鐵刀身、算盤烏木珠 |
| **劍氣／內力** | 霜月青白 | `#D9F2F0` | `(217, 242, 240)` | W8 劍氣、內功發散高光（搭配 `#55B2AE` 柔青暈光） |

> **與原版 `ramps3` 相容規則**：場景小人若希望開放玩家換髮色／衣色，需把 **可換色部位** 在渲染階段獨立輸出純色通道斜坡圖層（`hair: G`, `skin: B`, `outfit: R`），或改用 W4 多槽位結構把「素體 (`body`) / 髮型 (`hair`) / 上衣 (`armor`) / 披風 (`cape`) / 武器 (`weapon`)」拆開打包進同一個 `manifest.json`。

---

## 三、線條、上色、頭身比與原版鏡頭對齊

### 3.1 線條（Linework）
- **立繪**：手繪感墨線（數位等效約 2.5–4.5 px @ 1024 px 畫布），**外輪廓較粗、衣褶與五官較細**，筆畫轉折帶輕微毛筆頓挫感，色彩使用「松煙墨 `#24201E`」而非死黑。
- **表情頭像**：線條略加粗以維持在 256×256 或 64×64 縮圖下的辨識度。
- **場景小人**：Blender 渲染加上 **1 px（或螢幕等比）深墨灰卡通外輪廓線**（Grease Pencil / Inverted Hull），不加內部過密雜線，避免縮成 80×120 時糊成一團。

### 3.2 上色（Shading）
- 採 **二階賽璐璐平塗 ＋ 局部水墨紙紋柔邊（Cel + Subtle Wash）**：
  - 陰影色不單純調暗灰度，而是**往冷灰紫／赭褐微移**；
  - 大面積衣料保持平淨，皺摺僅在關節轉折處畫 2–3 筆關鍵結構線；
  - 禁止強烈 3D 高光球面反射、禁止過曝霓虹發光。

### 3.3 頭身比與尺寸對齊（對齊實測 `PHM011`）
實測原版 `PHM011`（`extracted/.../sprites/PHM011/manifest.json`）：
- `canvas_w × canvas_h`：`220 × 243`，中心腳底錨點 `(center_x, center_y) = (110, 164)`
- 角色實繪包圍框：**寬 58–130 px（均寬 `82.8 px`），高 56–135 px（均高 `114.0 px`）**

因此本專案定案尺寸規範：
- **全身定錨立繪**：`1024 px` 高（等比例 768×1024 或 1024×1024 透明 PNG），**頭身比 1 : 6.0 ~ 1 : 6.5**（寫實偏修長俠客比例，非 Q 版大頭）。
- **表情頭像**：`256 × 256` 透明 PNG（胸部以上半身／肩領構圖，確保 `family` 角色卡 48–64 px 頭框裁切不切頭）。
- **場景小人（點陣輸出）**：站姿身體高約 **`105–120 px`**（對齊 `PHM011` 均高 114 px，頭身比微收至 **1 : 4.2 ~ 1 : 4.8** 以放大頭肩武器辨識度），單幀約 `80 × 120`；若採 `2x` 高解析渲染則設定 manifest `pixelScale: 0.5`，繪於畫布仍維持同一視覺比例。

### 3.4 光源方向與攝影機鏡頭（對齊原版吉恩村）
- **攝影機角度**：45° 等距斜俯視（Orthographic / 低視角透視，俯角約 **32°–38°**）；
  - 地圖 5 個基礎方向：`S(0), SW(1), W(2), NW(3), N(4)`（其餘 `NE/E/SE` 依原版 `SpriteManager` 水平鏡像）；
  - 戰鬥固定方向：我方（右下方站位）朝向 **NW**，敵方（左上方站位）朝向 **SE**。
- **主光源方向**：**來自左上方約 45° 的暖日光（`azimuth -45°, elevation 50°`）**＋ 地面暖綠微弱漫反彈光（與原版地磚陰影朝右下方投射完全一致！見實機截圖中 `愛麗絲` 與 `乳牛` 腳下陰影皆朝右下延伸）。

---

## 四、服裝考據原則與禁止事項

### 4.1 考據原則
- 以**宋明漢服江湖便服**為骨幹：**交領右衽（領口左襟壓右襟）**、窄袖或束袖護腕（利於揮劍／扛刀／撥算盤，不畫拖地宮廷大袖給戰鬥角色）、布巾包頭或束髮玉簪／木簪、繫於腰間的革帶與香囊／酒壺／護鏢腰牌。
- 配件貼合吉恩村鄉野與市鎮世界觀（粗麻、靛藍染布、風霜皮護具、竹簍草藥），避免華麗龍袍或仙氣飄帶。

### 4.2 絕對禁止事項
1. **禁止左衽**（右襟壓左襟，除非特定異域設定，主角群一律右衽）。
2. **禁止現代或二次元奇幻元素**：機械義肢、螢光髮色、拉鍊皮靴、網格絲襪、過大魔導水晶、西洋板甲肩盾、背後大光環／發光翅膀。
3. **禁止《活俠傳》或任何商業作品圖檔直接輸入**：不拿任何受版權保護截圖當 img2img、ControlNet 或風格參考圖。
4. **禁止不乾淨透明邊緣**：所有最終進入遊戲或外掛的角色圖檔必須無白邊／灰毛邊（背景殘留 alpha > 0 且色值近純白將被 `art_check` 擋下）。

---

## 五、五種 AI 生成提示詞模板與負面詞

> 使用時將 `{SUBJECT}` 換為具體角色／物件英文敘述，並嚴格保留共通風格尾綴與負面詞。

### 5.1 全身定錨立繪（Portrait / Full-Body Anchor）
- **Prompt Template**:
  > `Full-body character portrait of {SUBJECT}, traditional Chinese wuxia martial artist in grounded Song-Ming dynasty traveling attire (crossed collar wrapping left-over-right yorouji, fitted cuffs, leather belt and practical gear). Illustrated in crisp Chinese ink brush linework (#24201E charcoal ink, expressive varying stroke weight) with muted mineral watercolor flat-cel shading, restrained paper grain texture, palette dominated by slate-cyan (#3E626A), warm parchment (#EFE6D5), ochre leather (#5E4736), and subtle cinnabar red (#B54132) accents. Standing in a balanced martial stance facing 3/4 view, warm top-left natural lighting, clean solid neutral off-white background (#FFFFFF) with wide margin around head and feet, 1:6.5 heroic proportions, hand-drawn 2D indie RPG key art.`
- **Negative Prompt**:
  > `modern clothing, zippers, sci-fi armor, glowing wings, floating runes, neon colors, glossy 3D render, anime chibi proportions, oversized glowing sword, western medieval plate armor, left-over-right reversed collar (hidari-mae), busy background, scenery, drop shadow on floor, watermark, text, frame, cropped head or feet`

### 5.2 五表情頭像（Expression Portraits — 搭配已定稿定錨立繪作唯一輸入）
- **Prompt Template**:
  > `Close-up bust portrait from chest up of the exact same character shown in the attached anchor illustration, maintaining identical face, hair, crossed-collar robe, colors, and ink brush linework style (#24201E outlines, flat muted watercolor cel shading). Expression: {EXPRESSION_DESC} (e.g. calm composed half-smile / fierce battle grit / startled comedy sweat / wry exasperated smirk / injured wince). Centered head and shoulders with headroom, pure clean solid #FFFFFF background, 1:1 square aspect ratio.`
- **Negative Prompt**:
  > `changing outfit, changing hair style, different face, glossy 3D skin, full body, busy background, speech bubble, text, frame`

### 5.3 地圖圖塊（Terrain & Seamless Tiles）
- **Prompt Template**:
  > `Top-down 45-degree isometric game terrain tile of {TILE_DESC} (e.g. sun-dappled meadow grass with clover patches / compacted ochre dirt village path), painted in muted traditional Chinese ink-and-mineral gouache style matching warm parchment (#D6C3A3), earthy ochre (#5E4736), and soft sage green (#6B8C5B), subtle hand-painted brushwork, soft ambient lighting from top-left, seamless repeating edges, zero perspective horizon, crisp RPG tilemap asset.`
- **Negative Prompt**:
  > `3D photorealistic render, harsh shadows, characters, grid lines, text, perspective vanishing point, neon grass, blurry`

### 5.4 建築與物件部件（Props & Architecture）
- **Prompt Template**:
  > `Isolated isometric 45-degree 2D game prop sprite of {OBJECT_DESC} (e.g. weathered timber wuxia escort agency signboard with faded red banner / herbalist bamboo drying rack with medicinal leaves), hand-drawn charcoal ink outline (#24201E) and muted flat gouache coloring matching Song-Ming rustic village aesthetic, cast shadow excluded, lit softly from top-left, clean pure #FFFFFF background with generous padding.`
- **Negative Prompt**:
  > `modern plastic, concrete, neon signs, ground floor terrain, cast shadow, multiple unrelated objects, text labels, 3D plastic gloss`

### 5.5 介面圖示（UI Icons）
- **Prompt Template**:
  > `Minimalist square 2D RPG UI icon depicting {ICON_DESC} (e.g. coiled iron abacus bead / bamboo medicine gourd / crossed steel jian sword), crisp dark charcoal ink contour (#24201E) with clean two-tone flat fill using slate-cyan (#3E626A), aged bronze gold (#C29342), and warm cream (#EFE6D5), centered with clear silhouette at small 32x32 scale, solid #FFFFFF background.`
- **Negative Prompt**:
  > `photorealistic metal, intricate noisy filigree, thin vanishing lines, text, glow halo, dark background`
