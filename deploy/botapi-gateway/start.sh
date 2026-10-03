#!/bin/sh
# 启动本地 Telegram Bot API Server（--local 模式：上传 2000MB / 下载无大小限制），
# 再启动签名网关（监听 7860，HF Spaces 要求端口）。
set -e

: "${TELEGRAM_API_ID:?需要设置 TELEGRAM_API_ID（my.telegram.org 申请）}"
: "${TELEGRAM_API_HASH:?需要设置 TELEGRAM_API_HASH}"

WORK_DIR=/data/tg
TEMP_DIR=/tmp/tg
mkdir -p "$WORK_DIR" "$TEMP_DIR"

# botapi 降权到镜像内置用户 telegram-bot-api(101:101)；非 root 运行时直接以
# 当前用户跑，不做降权。
DROP_PRIVS=""
if [ "$(id -u)" = "0" ]; then
  chown -R 101:101 "$WORK_DIR" "$TEMP_DIR" 2>/dev/null || true
  DROP_PRIVS="--username=telegram-bot-api --groupname=telegram-bot-api"
else
  chmod -R 777 "$WORK_DIR" "$TEMP_DIR" 2>/dev/null || true
fi

/usr/local/bin/telegram-bot-api \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --local \
  --dir="$WORK_DIR" \
  --temp-dir="$TEMP_DIR" \
  --http-port=8081 \
  --verbosity=2 \
  $DROP_PRIVS &

# 网关在前台运行（PID1 由 tini 守护）；botapi 为后台进程，容器停止时一并销毁。
exec node /app/gateway/server.mjs
