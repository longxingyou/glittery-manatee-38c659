#!/usr/bin/env bash
# 在 Azure VM 上安装流量采集 agent（前置：已运行 install.sh 部署 sing-box）。
# 运行：sudo bash setup-traffic-agent.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行" >&2
  exit 1
fi

apt-get update -qq
apt-get install -y -qq vnstat
systemctl enable --now vnstat

if ! id -u sgtraffic >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin sgtraffic
fi
usermod -aG vnstat sgtraffic

if [ ! -s /etc/sg-traffic.key ]; then
  openssl rand -hex 32 > /etc/sg-traffic.key
fi
chown root:sgtraffic /etc/sg-traffic.key
chmod 0640 /etc/sg-traffic.key

install -m 0755 /tmp/sg-traffic-agent.py /usr/local/bin/sg-traffic-agent.py

cat > /etc/systemd/system/sg-traffic.service <<'EOF'
[Unit]
Description=Syntax Garden traffic agent
After=network-online.target vnstat.service
Wants=network-online.target

[Service]
Type=simple
User=sgtraffic
Group=sgtraffic
SupplementaryGroups=vnstat
ExecStart=/usr/bin/python3 /usr/local/bin/sg-traffic-agent.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=32M
TasksMax=32

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now sg-traffic
sleep 2
systemctl --no-pager --full status sg-traffic | head -15 || true

echo '--- sample response ---'
curl -s -H "X-Traffic-Key: $(cat /etc/sg-traffic.key)" http://127.0.0.1:9091/traffic | head -c 600
echo
echo '--- key ---'
cat /etc/sg-traffic.key
