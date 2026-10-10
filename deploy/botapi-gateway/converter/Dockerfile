# Syntax Garden 附件预览转换服务：Office → PDF
# 与 gateway 同机，compose 限制 512MiB 内存 + 2GiB swap（压测见 lo-bench）
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      libreoffice-draw \
      libvisio-0.1-1 \
      fonts-noto-cjk \
      fonts-noto-cjk-extra \
      fonts-liberation2 \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY worker.mjs /app/worker.mjs

CMD ["node", "/app/worker.mjs"]
