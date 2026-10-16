---
name: jev-judge
description: 用 JEV（TypeSafe）做分類、打分、是非判斷：單筆用 ask、整份 CSV 用 batch。需要對一批項目做固定選項的判斷（分類、篩選、檢查有沒有某個問題）時使用。
---

JEV 只回答選擇題／打分／是非題（附機率），快又便宜；不會產生文字。指令在這個 skill 所屬外掛的 `scripts/jev.py`（外掛根目錄 = 這個檔案往上兩層），在專案資料夾裡執行：

- 單筆：`python3 <外掛>/scripts/jev.py ask --state '{"x":"..."}' --q '{"q":{"type":"noul","instructions":"`x` ..."}}'`（可加 `--image 圖`）
- 一批：`python3 <外掛>/scripts/jev.py batch 資料.csv --column 欄位 --q '{...}' --out 結果.csv`，每列做同一個判斷，結果加成新欄位（choice 另有 `_conf` 欄）
- 題型：`noul` 是非（回 0–1）、`choice` 選擇（`criteria` 給 {選項: 說明}）、`score` 打分（`criteria` 給由低到高的等級清單）
- instructions 裡用反引號引用 state 的欄位名稱（例如 `title`），JEV 才知道要看哪一欄
- 判斷結果只是篩選：被標出來、或信心低於 0.6 的項目再由你或使用者細看
- 開關與用量：`python3 <外掛>/scripts/jev.py status|on|off`（每個專案各自的開關，紀錄在 `~/.claude/jev/`）
