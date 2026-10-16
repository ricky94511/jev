#!/usr/bin/env python3
"""JEV（TypeSafe System One）通用工具：把「只是分類、打分、是非判斷」的步驟交給 JEV，不用大模型。

JEV 不產生文字，只回答選擇題／打分／是非題（附機率），快又便宜（只收輸入 token）。
文件：https://docs.typesafe.ai/introduction

用法（在專案資料夾裡執行；--project 可指定別的資料夾）：
  jev.py status|on|off                         # 這個專案的 JEV 開關與累計用量
  jev.py state                                 # 只印 on 或 off（給 hook 用）
  jev.py ask --state '{"x":"..."}' --q '{"q":{"type":"noul","instructions":"..."}}' [--image 圖]
  jev.py batch 資料.csv --q '{"q":{...}}' [--column 欄位] [--out 輸出.csv] [--workers 8]
  jev.py route "<prompt>"                      # 給 hook 用：建議模型等級、skill、是否含判斷步驟

題目格式（--q 每個題目一個 key）：
  {"type":"noul","instructions":"..."}                               是非題，回傳 0–1 機率
  {"type":"choice","instructions":"...","criteria":{"a":"說明",...}}   選擇題，回傳 choice 與 confidence
  {"type":"score","instructions":"...","criteria":["低","中","高"]}      打分，回傳 0–(n-1) 的分數

專案設定（都可省略）：
  .claude/jev_rules.md     這個專案「哪些步驟交給 JEV」的規則，hook 每句會附給 Claude
  .claude/jev_tiers.json   覆寫模型等級的說明 {"haiku":"...","sonnet":"...","opus":"..."}

金鑰：環境變數 TYPESAFE_API_KEY；沒有時依序讀專案 .claude/settings.local.json、~/.claude/settings.json 的 env；
雲端（CLAUDE_CODE_REMOTE）有代理時由代理注入。
"""
import argparse
import base64
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = "https://api.typesafe.ai/v1/systemone"
MODEL = os.environ.get("JEV_MODEL", "jev-latest")
HOME_DIR = Path.home() / ".claude" / "jev"      # 跨專案的狀態：開關、用量紀錄
LOG = HOME_DIR / "log.jsonl"

PROJECT = Path.cwd()


def set_project(path):
    global PROJECT
    PROJECT = Path(path).resolve()


def slug(path):
    p = str(Path(path).resolve())
    return re.sub(r"[^A-Za-z0-9]+", "-", p).strip("-")[-60:] + "-" + hashlib.sha1(p.encode()).hexdigest()[:8]


def off_flag():
    return HOME_DIR / "off" / slug(PROJECT)


def legacy_off_flag():
    # shorts-studio 早期把開關放在專案裡；還認得它
    return PROJECT / ".claude" / "jev_off"


def is_on():
    return not off_flag().exists() and not legacy_off_flag().exists()


# ---------- API ----------

def _env_from(path):
    try:
        return json.loads(Path(path).read_text()).get("env", {}).get("TYPESAFE_API_KEY")
    except (OSError, ValueError):
        return None


def api_key():
    k = (os.environ.get("TYPESAFE_API_KEY")
         or _env_from(PROJECT / ".claude" / "settings.local.json")
         or _env_from(Path.home() / ".claude" / "settings.json"))
    if k:
        return k
    if os.environ.get("CLAUDE_CODE_REMOTE") and os.environ.get("HTTPS_PROXY"):
        return "proxy-injected"  # 雲端：代理會換成環境 secrets 裡的真金鑰
    raise RuntimeError("沒有 TYPESAFE_API_KEY（本機設在 ~/.claude/settings.json 的 env；雲端設在環境 secrets）")


def call(state, questions, assets=None, timeout=30, tag="ask"):
    """送一次 System One 請求，回傳 answers。assets 有圖片時自動加測試功能 header。"""
    body = {"model": MODEL, "state": state, "questions": questions}
    headers = {"Authorization": "Bearer " + api_key(), "Content-Type": "application/json"}
    if assets:
        body["assets"] = assets
        headers["TypeSafe-Danger-Zone-Images"] = "true"
    req = urllib.request.Request(API, json.dumps(body, ensure_ascii=False).encode(), headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"JEV {e.code}: {e.read().decode()[:300]}") from None
    try:
        HOME_DIR.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(json.dumps({"tag": tag, "project": str(PROJECT), "usage": d.get("usage"),
                                "model": d.get("model")}, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return d["answers"]


def image_asset(path):
    """JEV 只收長寬 280–1568 px 的 PNG/JPEG，不會自動縮放：用 ffmpeg 縮到長邊 1280 的 JPEG 再送。
    影片檔（mp4）也可以，取第一格。"""
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "img.jpg"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-frames:v", "1",
                        "-vf", "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'", "-q:v", "3", str(out)],
                       check=True)
        return {"type": "image", "format": "jpg", "data_base64": base64.b64encode(out.read_bytes()).decode()}


def pmap(fn, items, workers=8):
    with ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


# ---------- 路由（hook 用） ----------

ROUTE_TIERS = {
    "haiku": "簡單、機械性：找檔案、查某個值、改格式、跑一個已知指令、回答是非",
    "sonnet": "一般工作：照既有流程做某一步、寫或改一段程式、整理資料、操作網頁",
    "opus": "需要深度推理或創作：規劃與發想、寫作與企劃、設計新流程、除錯不明原因的問題、分析與策略",
}


def route_tiers():
    try:
        t = json.loads((PROJECT / ".claude" / "jev_tiers.json").read_text())
        return {k: t.get(k, v) for k, v in ROUTE_TIERS.items()}
    except (OSError, ValueError):
        return ROUTE_TIERS


def list_skills(extra_dirs=()):
    skills = {}
    for base in [PROJECT / ".claude/skills", Path.home() / ".claude/skills", *map(Path, extra_dirs)]:
        for f in sorted(base.glob("*/SKILL.md")):
            s = f.read_text()
            m = re.search(r"^description:\s*(.+)$", s, re.M)
            skills.setdefault(f.parent.name, (m.group(1).strip() if m else f.parent.name)[:200])
    return skills


def route(prompt, extra_skill_dirs=()):
    skills = list_skills(extra_skill_dirs)
    qs = {
        "tier": {"type": "choice", "instructions": "要處理 `request` 這個請求，需要哪個等級的模型？",
                 "criteria": route_tiers()},
        "judgment": {"type": "noul", "instructions": (
            "`request` 裡有某個步驟本質上是對一批項目做分類、打分、篩選或是非判斷（例如檢查標題有沒有爆雷、"
            "幫標題分類、挑出最有趣的發現、判斷縮圖是哪個畫面）")},
    }
    if skills:
        qs["skill"] = {"type": "choice", "instructions": "`request` 最需要載入哪個 skill？",
                       "criteria": {**skills, "none": "都不需要"}}
    a = call({"request": prompt[:4000]}, qs, timeout=8, tag="route")
    out = {"tier": a["tier"]["choice"], "tier_conf": a["tier"]["confidence"], "judgment": a["judgment"]["noul"]}
    if "skill" in a:
        out["skill"] = a["skill"]["choice"]
        out["skill_conf"] = a["skill"]["confidence"]
    return out


# ---------- 批次 ----------

def flatten(name, ans):
    """一題的答案攤成幾欄：noul → name；choice → name、name_conf；score → name。"""
    if "noul" in ans:
        return {name: round(ans["noul"], 3)}
    if "choice" in ans:
        return {name: ans["choice"], f"{name}_conf": round(ans["confidence"], 3)}
    if "score" in ans:
        return {name: round(ans["score"], 3)}
    return {name: json.dumps(ans, ensure_ascii=False)}


def batch(rows, questions, column=None, workers=8):
    def one(row):
        state = {column: row[column]} if column else row
        try:
            a = call(state, questions, tag="batch")
            out = {}
            for k, v in a.items():
                out.update(flatten(k, v))
            return out
        except RuntimeError as e:
            return {"jev_error": str(e)[:200]}
    return pmap(one, rows, workers)


# ---------- CLI ----------

def cmd_toggle(args):
    if args.cmd == "on":
        off_flag().unlink(missing_ok=True)
        legacy_off_flag().unlink(missing_ok=True)
    elif args.cmd == "off":
        off_flag().parent.mkdir(parents=True, exist_ok=True)
        off_flag().write_text(str(PROJECT) + "\n")
    print("JEV 開關：" + ("開" if is_on() else "關"))
    if args.cmd == "status" and LOG.exists():
        n_all = tok_all = n = tok = 0
        for l in LOG.read_text().splitlines():
            try:
                d = json.loads(l)
            except ValueError:
                continue
            t = (d.get("usage") or {}).get("input_tokens", 0)
            n_all += 1
            tok_all += t
            if d.get("project") == str(PROJECT):
                n += 1
                tok += t
        cost = lambda t: t * 0.042 / 1e6
        print(f"這個專案累計呼叫 {n} 次，輸入 {tok:,} token（約 ${cost(tok):.4f}）")
        print(f"全部專案累計呼叫 {n_all} 次，輸入 {tok_all:,} token（約 ${cost(tok_all):.4f}）")


def cmd_state(args):
    print("on" if is_on() else "off")


def cmd_ask(args):
    state = json.loads(args.state) if args.state.lstrip().startswith(("{", "[")) else args.state
    assets = None
    if args.image:
        assets = {"img-5c1d7e": image_asset(args.image)}
        if isinstance(state, dict):
            state = {**state, "image": "img-5c1d7e"}
        else:
            state = {"text": state, "image": "img-5c1d7e"}
    print(json.dumps(call(state, json.loads(args.q), assets=assets, timeout=60 if assets else 30),
                     ensure_ascii=False, indent=1))


def cmd_batch(args):
    with open(args.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if args.column and rows and args.column not in rows[0]:
        sys.exit(f"沒有欄位 {args.column}，可用：{', '.join(rows[0])}")
    res = batch(rows, json.loads(args.q), args.column, args.workers)
    merged = [{**r, **a} for r, a in zip(rows, res)]
    keys = list(dict.fromkeys(k for r in merged for k in r))
    out = open(args.out, "w", newline="", encoding="utf-8") if args.out else sys.stdout
    w = csv.DictWriter(out, keys)
    w.writeheader()
    w.writerows(merged)
    if args.out:
        out.close()
        errs = sum(1 for a in res if "jev_error" in a)
        print(f"{len(rows)} 筆寫到 {args.out}" + (f"（{errs} 筆失敗，看 jev_error 欄）" if errs else ""))


def cmd_route(args):
    print(json.dumps(route(args.prompt, args.skills_dir), ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", help="專案資料夾（預設目前資料夾）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for c in ["status", "on", "off"]:
        sub.add_parser(c).set_defaults(fn=cmd_toggle)
    sub.add_parser("state").set_defaults(fn=cmd_state)
    p = sub.add_parser("ask"); p.add_argument("--state", required=True); p.add_argument("--q", required=True)
    p.add_argument("--image"); p.set_defaults(fn=cmd_ask)
    p = sub.add_parser("batch"); p.add_argument("csv"); p.add_argument("--q", required=True)
    p.add_argument("--column"); p.add_argument("--out"); p.add_argument("--workers", type=int, default=8)
    p.set_defaults(fn=cmd_batch)
    p = sub.add_parser("route"); p.add_argument("prompt")
    p.add_argument("--skills-dir", action="append", default=[]); p.set_defaults(fn=cmd_route)
    args = ap.parse_args()
    if args.project:
        set_project(args.project)
    try:
        args.fn(args)
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()
