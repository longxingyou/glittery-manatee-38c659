# Syntax Garden 附件网关：本地 Telegram Bot API Server（--local）+ 签名 HTTP 网关
# 目标宿主：Koyeb 免费 Web Service（Dockerfile 构建，监听 $PORT 默认 8080）。
# 也可在任意支持 Docker 的主机（HF Spaces/VPS）上运行：同一镜像，注入环境变量即可。
FROM aiogram/telegram-bot-api:latest

USER root

# nodejs：网关进程（零依赖，仅用内置模块）；tini：PID1 信号转发
RUN apk add --no-cache nodejs tini

COPY gateway /app/gateway
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh && mkdir -p /data && chmod 777 /data

WORKDIR /app

# Koyeb 默认把 HTTP 流量路由到 8080；网关监听 $PORT（默认 8080）
EXPOSE 8080

# 容器级健康检查（Koyeb 控制台也可单独配置 HTTP /healthz 检查）
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/start.sh"]
