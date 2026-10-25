#!/bin/zsh
# 启动本地助手（前台运行，Ctrl+C 退出）
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，先装一个（brew install node）" >&2
  exit 1
fi
exec node server.mjs "$@"
