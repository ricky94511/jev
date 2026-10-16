# jev：讓 JEV 幫 Claude Code 判斷

[JEV（TypeSafe System One）](https://docs.typesafe.ai/introduction)只回答選擇題、打分、是非題，快又便宜。這個 Claude Code 外掛用它做兩件事：

1. **每句 prompt 先問 JEV**：建議這一輪用哪個模型（haiku／sonnet／opus），並**自動切換**；同時把「哪些步驟交給 JEV」的規則附給 Claude。
2. **分類、打分、是非判斷交給 JEV**：`scripts/jev.py ask`（單筆）、`scripts/jev.py batch`（整份 CSV）。

提示框上方有開關，也可以用 `/jev on|off|status`。開關是每個專案各自的，存在 `~/.claude/jev/`。

每輪 Claude 會在回答最後加一行通知（App 的雲端對話看不到外掛的 toast，所以寫進回答裡），例如：

```
> JEV：開 · 判斷 haiku（信心 0.98） · 這輪用 claude-haiku-5-5 · ask ×1
> JEV：關
```

## 自動換模型的規則

| JEV 建議 | 實際模型 | 什麼時候換 |
|---|---|---|
| haiku | `claude-haiku-5-5` | 信心 ≥ 0.7，且對話在 30 萬 token 內（單價低，整段重讀也划算） |
| sonnet | `claude-sonnet-5-5` | 只在新對話第一句換，之後整段黏著 sonnet（sonnet 讀快取跟 opus 同價，每輪換來換去只會虧） |
| opus | `claude-opus-5-5` | 升級不限；黏著 sonnet 時遇到 opus 等級的請求就升回去 |

子代理不動；對話本身的模型不是這三種（例如 Fable）時完全不動。版本寫在 `hooks/register.tsx` 的 `MODEL_ID`。

## 專案設定（都可省略）

- `.claude/jev_rules.md`：這個專案「哪些步驟交給 JEV」的規則，每句附給 Claude，接在通用規則後面
- `.claude/jev_tiers.json`：覆寫三個模型等級的說明，讓 JEV 分得更準，例如 `{"sonnet": "照既有流程做一支片的某一步…"}`

## 安裝

需要 Claude Code 2.1.29x 以上（function hooks）、`python3`；`ask --image` 另外需要 `ffmpeg`。

**本機**：clone 到固定位置，在 `~/.claude/settings.json` 的 `env` 加上（多個資料夾用 `:` 分隔）：

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/Documents/jev", "TYPESAFE_API_KEY": "<你的金鑰>" } }
```

**雲端 session**：從 App 開的雲端 session 不會讀專案裡的外掛，要在雲端環境的 Setup script 裡 clone 並寫進 `~/.claude/settings.json`（Setup script 裡 export 的變數不會傳給 Claude Code）：

```bash
git clone --depth 1 https://github.com/ricky94511/jev /home/user/jev
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home() / ".claude/settings.json"
d = json.loads(p.read_text()) if p.exists() else {}
d.setdefault("env", {})["CLAUDE_CODE_PLUGIN_DIRS"] = "/home/user/jev"
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(d, indent=2))
EOF
```

金鑰放在環境的 secrets（`TYPESAFE_API_KEY`），網路允許清單加 `api.typesafe.ai`；沒有金鑰時會由雲端代理注入。

## 開發

```bash
claude plugin validate .
claude plugin test .
```

`tests/jev.test.ts` 模擬「送出 prompt → JEV 判斷 → 這一輪換模型」與開關、`/jev` 指令。
