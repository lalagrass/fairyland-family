# 美術參考索引（`art/references/REFERENCES.md`）

本文件整理「童話家族・武俠試點」的美術風格參考來源。依 `docs/history/WORLD_AND_WUXIA_DIRECTION_2026-11-16.md`（已封存；現行規則見 `docs/product/BLUEPRINT.md` 2.7） §3.1 與 §3.6.2 規定：
- **受版權保護之商業遊戲參考**：**僅存連結與文字風格分析，嚴禁下載圖片進 repo，亦不可作為任何 AI 生成模型的圖生圖（img2img）、角色參考（cref）或訓練輸入**。
- **公有領域（Public Domain / CC0）傳統中國繪畫**：經確認授權後下載至 [`public_domain/`](public_domain/)，可作為色彩、服飾考據與構圖輔助參考（詳見 [`public_domain/manifest.json`](public_domain/manifest.json)）。

---

## 一、商業武俠參考（僅連結與文字分析，禁止圖檔下載與餵入 AI）

| 作品 | 官方／公開連結 | 用途 | 授權與使用邊界 | 風格特徵文字分析 |
|---|---|---|---|---|
| **《活俠傳》（Legend of Mortal, 2024）** | Steam 商店頁：<https://store.steampowered.com/app/1859910/Legend_of_Mortal/><br>Steam 社群截圖：<https://steamcommunity.com/app/1859910/screenshots/> | 立繪、表情誇張張力、水墨紙質 UI 氛圍 | 商業版權所有（Obb Studio）。**嚴禁存圖或作為生成輸入**，僅供文字轉譯風格規格。 | 1. **粗細變化的手繪毛筆／鋼筆描線**，筆觸帶飛白與情緒張力；<br>2. **微暈染平塗＋溫潤米黃宣紙質感底色**（整體飽和度節制，靠朱砂紅／青靛／赭石點亮焦點）；<br>3. **極高辨識度的臉部神態與微表情**（喜、怒、驚愕、無奈等喜劇與悲壯反差）；<br>4. 介面偏書卷、竹簡、木牌與印章語彙，和文字遊戲天然契合。 |
| **《大俠立志傳》（Hero's Adventure）** | Steam 商店頁：<https://store.steampowered.com/app/1948980/> | 立繪＋點陣雙層結構參考、市井江湖 UI | 商業版權所有（Half Amateur Studio）。僅供文字分析。 | 1. **場景 2D 點陣小人＋對話高精立繪**的雙層表現，與本專案「場景小人 80×120＋立繪 1024」路線一致；<br>2. 村鎮生活氣息濃厚（客棧、佈告欄、鏢局、行商），色調偏暖土褐與草木綠，能自然銜接童話原有《吉恩村》綠野村鎮色調。 |
| **《逸劍風雲決》（Wandering Sword）** | Steam 商店頁：<https://store.steampowered.com/app/1876890/> | 3D 場景打光與點陣融合參考 | 商業版權所有（The Swordman Studio）。僅供文字分析。 | 1. **3D 光影結合像素小人（HD-2D 感）**：等距／斜俯視視角下，以清晰輪廓線與明確方向陰影維持小人可讀性；<br>2. 招式特效採「核心亮白＋單一主色劍氣拖尾」，在草地綠底上對比明確，與本專案 W4/W8 特效方向相通。 |
| **《覓長生》** | Steam 商店頁：<https://store.steampowered.com/app/1189490/> | 水墨山嵐 UI 與內功人物氛圍 | 商業版權所有（Chalcedony Studio）。僅供文字分析。 | 1. 偏向清雅水墨與工筆設色，強調衣袖垂墜與留白呼吸感；<br>2. 適合提供「藥王谷女醫」等內家／道醫角色的氣質參考。 |

---

## 二、公有領域參考（可作生成輸入與考據，已存於 `art/references/public_domain/`）

以下素材皆來自 Wikimedia Commons 並驗證為 **Public Domain（PD-old）**，已附本地縮圖與來源紀錄：

| 檔名 | 作品／對象 | 作者／時代 | 授權 | 來源 URL | 擷取風格重點 |
|---|---|---|---|---|---|
| [`scholar_pine.jpg`](public_domain/scholar_pine.jpg) | *Tang Yin（唐寅像，1898 年臨本）* | Li Yueyun（1898） | Public domain | <https://commons.wikimedia.org/wiki/File:Tang_Yin_-_%E5%94%90%E5%AF%85_(1470_-_1524).jpg> | **交領右衽文士／俠客便裝**：素灰青外衫配石青藍領緣（`#4D6472` 灰藍）、細緻流暢墨線勾勒衣褶與軟巾帽，神態沉靜自然。可作為**青衫劍客**立繪筆觸與衣領結構依據。 |
| [`shanshui_ink.jpg`](public_domain/shanshui_ink.jpg) | *Landscape in the Style of Fan Kuan（仿范寬山水圖）* | 宋／明仿作（LACMA M.71.73.120） | Public domain | <https://commons.wikimedia.org/wiki/File:Landscape_in_the_Style_of_Fan_Kuan_LACMA_M.71.73.120_(1_of_2).jpg> | **古紙色盤與山村建築結構**：暖舊絹底（`#9D896B`）、重墨斧劈皴岩壁、朱砂印章紅（`#A63A2E`）、翹角木構山門與茅舍，提供**地圖圖塊與介面紙紋**的基準色盤。 |
| [`knight_portrait.jpg`](public_domain/knight_portrait.jpg) | *A Seated Portrait of Ming Emperor Taizu* | 明代宮廷畫師（佚名） | Public domain | <https://commons.wikimedia.org/wiki/File:A_Seated_Portrait_of_Ming_Emperor_Taizu.jpg> | **工筆平塗＋玉帶／織錦幾何紋**：大面積素色袍服只做極克制明暗暈染，細節集中在革帶、玉飾與坐墊繁複幾何紋，適合轉譯為**鐵算盤掌櫃**與**鏢局刀客**的衣飾層次。 |
| [`qiu_ying_han_palace.jpg`](public_domain/qiu_ying_han_palace.jpg) | *《漢宮春曉圖》細部（箜篌樂伎）* | 仇英（明代，約 1494–1552） | Public domain | <https://commons.wikimedia.org/wiki/File:Konghou_from_silk_painting_by_Qiu_Ying,_%22Spring_Morning_in_the_Han_Palace%22.jpg> | **重彩工筆設色＋輕柔披帛線條**：竹青綠短襖（`#79945E`）配米白長裙與朱紅雙結絲絛（`#C24735`），髮髻微飾與細線輪廓可作為**藥王谷女醫**設色與線稿藍本。 |
