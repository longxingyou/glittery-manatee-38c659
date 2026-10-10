# Syntax Garden 附件网关：本地 Telegram Bot API Server（--local）+ 签名 HTTP 网关
# 宿主无关镜像：Zeabur / VPS / 其他 Docker 平台均可。
# 网关监听平台注入的 $PORT（默认 8080），需在平台将该端口暴露为 HTTP 服务。
FROM aiogram/telegram-bot-api:latest

USER root

# nodejs：网关进程；npm：安装 msedge-tts（神经语音）；tini：PID1 信号转发
RUN apk add --no-cache nodejs npm tini

COPY gateway /app/gateway
COPY start.sh /app/start.sh
# --ignore-scripts：msedge-tts 带 only-allow-pnpm 的 preinstall 钩子，npm 安装需绕过；
# 其运行时依赖 ws/axios 均无安装脚本需求
RUN cd /app/gateway && npm install --omit=dev --ignore-scripts --no-audit --no-fund \
  && chmod +x /app/start.sh && mkdir -p /data && chmod 777 /data

WORKDIR /app

# 平台（如 Zeabur）通过 $PORT 路由 HTTP 流量；网关默认监听 8080
EXPOSE 8080

# 容器级健康检查（平台也可配置 HTTP /healthz 检查）
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/start.sh"]
