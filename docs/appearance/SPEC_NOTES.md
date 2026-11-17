# 外觀規格與缺漏檢查說明（FM3 + FL4）

- 規格檔案：`scripts/appearance_spec/martial_artist_spec.json` 與 `scripts/appearance_spec/check_appearance_spec.mjs`
- 來源出處：`lalagrass/fairyland#14`（FL4 武鬥家素材盤點，commit `codex/14-fl4`，無圖結構規格，不含任何原版像素、模型數值或文案）
- 本倉庫原創測試外觀：`public/assets/appearances/wuxia_test/manifest.json`（純幾何矢量定義，無原版素材）

## 執行方式

```bash
node scripts/appearance_spec/check_appearance_spec.mjs public/assets/appearances/wuxia_test
```

此測試外觀刻意只完成基礎站立、走路、跑步、戰鬥預備、普攻與工作動作（以及 1 張測試頭像與 1 個圖示），因此缺漏檢查會正確列出剩餘尚未補齊的二轉／表情動作、特效、立繪、圖示與音效項目。
