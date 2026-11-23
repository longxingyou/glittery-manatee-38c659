#!/usr/bin/env python3
"""极简流量采集 agent：只读 /proc 与 vnstat，返回 JSON 给站点后台。

- 仅监听 9091，要求 X-Traffic-Key；
- 不写数据库、不落盘，单次响应 <1KB；
- vnstat 提供月度/日度累计，/proc/net/dev 提供实时累计计数（前端算速率）。
"""
import hmac
import json
import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY_FILE = "/etc/sg-traffic.key"
PORT = int(os.environ.get("SG_TRAFFIC_PORT", "9091"))
IFACE = os.environ.get("SG_TRAFFIC_IFACE", "eth0")
STARTED = time.time()


def read_key() -> str:
    with open(KEY_FILE, "r", encoding="utf-8") as f:
        return f.read().strip()


KEY = read_key()


def net_counters() -> tuple[int, int]:
    rx = tx = 0
    with open("/proc/net/dev", "r", encoding="utf-8") as f:
        for line in f:
            if ":" not in line:
                continue
            name, rest = line.split(":", 1)
            name = name.strip()
            if name == "lo" or name.startswith(("docker", "br-", "veth")):
                continue
            parts = rest.split()
            if len(parts) < 9:
                continue
            rx += int(parts[0])
            tx += int(parts[8])
    return rx, tx


def pick_interface(interfaces: list) -> dict | None:
    """vnstat 2.x 的 JSON 把每个网卡放在顶层 interfaces 数组里。

    优先取 eth0（Azure 主网卡），避免把 docker0 / veth / br- 的容器流量
    重复计入；找不到时退回第一块非虚拟网卡。
    """
    for item in interfaces:
        if item.get("name") == IFACE:
            return item
    for item in interfaces:
        name = item.get("name", "")
        if name == "lo" or name.startswith(("docker", "br-", "veth")):
            continue
        return item
    return interfaces[0] if interfaces else None


def vnstat_traffic() -> dict | None:
    try:
        out = subprocess.check_output(["vnstat", "--json"], timeout=3, text=True)
        iface = pick_interface(json.loads(out).get("interfaces") or [])
        if not iface:
            return None
        traffic = iface.get("traffic") or {}
        month = (traffic.get("month") or [{}])[-1]
        day = (traffic.get("day") or [{}])[-1]
        mdate = month.get("date", {})
        ddate = day.get("date", {})
        # vnstat 刚安装、数据库尚无记录时 date 全为 0，直接返回 None 让前端显示「初始化中」
        if not mdate.get("year"):
            return None
        return {
            "month": {
                "label": f"{mdate['year']}-{int(mdate.get('month', 0)):02d}",
                "rx": int(month.get("rx", 0)),
                "tx": int(month.get("tx", 0)),
            },
            "day": {
                "label": f"{ddate.get('year', 0)}-{int(ddate.get('month', 0)):02d}-{int(ddate.get('day', 0)):02d}",
                "rx": int(day.get("rx", 0)),
                "tx": int(day.get("tx", 0)),
            },
        }
    except Exception:
        return None


def meminfo() -> dict:
    info: dict[str, int] = {}
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                key, _, rest = line.partition(":")
                if key in ("MemTotal", "MemAvailable"):
                    info[key] = int(rest.split()[0]) * 1024
    except Exception:
        pass
    return {
        "total": info.get("MemTotal", 0),
        "available": info.get("MemAvailable", 0),
    }


def service_state(name: str) -> str:
    try:
        return subprocess.run(
            ["systemctl", "is-active", name],
            capture_output=True, text=True, timeout=2,
        ).stdout.strip() or "unknown"
    except Exception:
        return "unknown"


class Handler(BaseHTTPRequestHandler):
    server_version = "sg-traffic/1"

    def log_message(self, *_args) -> None:  # 不写访问日志
        return

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] not in ("/traffic", "/traffic/"):
            self.send_error(404)
            return
        provided = self.headers.get("X-Traffic-Key", "")
        if not hmac.compare_digest(provided, KEY):
            self.send_error(403)
            return

        rx, tx = net_counters()
        payload = {
            "ok": True,
            "now": int(time.time() * 1000),
            "uptimeSec": int(time.time() - STARTED),
            "rxBytes": rx,
            "txBytes": tx,
            "vnstat": vnstat_traffic(),
            "load": list(os.getloadavg()),
            "mem": meminfo(),
            "services": {"singbox": service_state("sing-box")},
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
