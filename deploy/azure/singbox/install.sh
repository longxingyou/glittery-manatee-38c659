#!/usr/bin/env bash
# 在 Azure VM 上部署 sing-box（VLESS + Reality），仅个人自用。
# 运行：sudo bash install.sh
# 可用环境变量覆盖：SINGBOX_PORT（默认 8443）、MASQUERADE_SERVER（默认 www.microsoft.com）
set -euo pipefail

SINGBOX_PORT="${SINGBOX_PORT:-8443}"
MASQUERADE_SERVER="${MASQUERADE_SERVER:-www.microsoft.com}"
MASQUERADE_PORT="${MASQUERADE_PORT:-443}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行" >&2
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) SB_ARCH=amd64 ;;
  aarch64) SB_ARCH=arm64 ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

VER=$(curl -fsSL https://api.github.com/repos/SagerNet/sing-box/releases/latest \
  | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
if [ -z "$VER" ]; then
  echo "无法获取 sing-box 最新版本" >&2
  exit 1
fi
echo "sing-box 版本: $VER"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${VER}/sing-box-${VER}-linux-${SB_ARCH}.tar.gz" \
  -o "$TMP/sing-box.tar.gz"
tar -xzf "$TMP/sing-box.tar.gz" -C "$TMP"
install -m 0755 "$TMP/sing-box-${VER}-linux-${SB_ARCH}/sing-box" /usr/local/bin/sing-box

if ! id -u singbox >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin singbox
fi

KEYPAIR=$(sing-box generate reality-keypair)
PRIVATE_KEY=$(printf '%s\n' "$KEYPAIR" | awk '/PrivateKey/ {print $2}')
PUBLIC_KEY=$(printf '%s\n' "$KEYPAIR" | awk '/PublicKey/ {print $2}')
UUID=$(sing-box generate uuid)
SHORT_ID=$(openssl rand -hex 8)

if [ -z "$PRIVATE_KEY" ] || [ -z "$PUBLIC_KEY" ] || [ -z "$UUID" ]; then
  echo "密钥/ID 生成失败" >&2
  exit 1
fi

mkdir -p /etc/sing-box
cat > /etc/sing-box/config.json <<EOF
{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "vless",
      "tag": "vless-in",
      "listen": "::",
      "listen_port": ${SINGBOX_PORT},
      "users": [
        { "uuid": "${UUID}", "flow": "xtls-rprx-vision" }
      ],
      "tls": {
        "enabled": true,
        "server_name": "${MASQUERADE_SERVER}",
        "reality": {
          "enabled": true,
          "handshake": {
            "server": "${MASQUERADE_SERVER}",
            "server_port": ${MASQUERADE_PORT}
          },
          "private_key": "${PRIVATE_KEY}",
          "short_id": ["${SHORT_ID}"]
        }
      }
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ]
}
EOF
chmod 0644 /etc/sing-box/config.json

cat > /etc/systemd/system/sing-box.service <<'EOF'
[Unit]
Description=sing-box (VLESS + Reality)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=singbox
Group=singbox
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=128M
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF

sing-box check -c /etc/sing-box/config.json
systemctl daemon-reload
systemctl enable --now sing-box
sleep 2
systemctl --no-pager --full status sing-box | head -20 || true
ss -ltnp | grep ":${SINGBOX_PORT}" || true

cat <<EOF
=== CLIENT PARAMS ===
PORT=${SINGBOX_PORT}
UUID=${UUID}
PUBLIC_KEY=${PUBLIC_KEY}
SHORT_ID=${SHORT_ID}
SERVER_NAME=${MASQUERADE_SERVER}
EOF
