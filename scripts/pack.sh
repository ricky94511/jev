#!/bin/bash
# 打包成 Cowork 可上傳的 zip，並把 TYPESAFE_API_KEY 放進 zip 裡的 jev.key。
# 金鑰只寫進 zip：不寫進 git、不留在資料夾裡（暫存資料夾打包完就刪）。在 Mac 上執行：
#   bash scripts/pack.sh [輸出路徑，預設 ~/Downloads/jev.zip]
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-$HOME/Downloads/jev.zip}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

# zip 不能放在 repo 裡，免得被 commit
case "$out" in "$PWD"/*) echo "輸出路徑不能在 jev 資料夾裡：$out" >&2; exit 1 ;; esac

key="${TYPESAFE_API_KEY:-}"
if [ -z "$key" ] && [ -f "$HOME/.claude/settings.json" ]; then
  key="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("env",{}).get("TYPESAFE_API_KEY",""))' "$HOME/.claude/settings.json")"
fi
[ -n "$key" ] || { echo "找不到 TYPESAFE_API_KEY（環境變數或 ~/.claude/settings.json 的 env）" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# 只打包 git 裡的檔案（HEAD），資料夾裡其他東西不會混進去
git archive --format=tar HEAD -- .claude-plugin hooks scripts skills types README.md | tar -x -C "$tmp"
( umask 077; printf '%s\n' "$key" > "$tmp/jev.key" )
rm -f "$out"
(cd "$tmp" && zip -qr "$out" .)
echo "已打包：$out（含金鑰，請勿分享這個檔案）"
