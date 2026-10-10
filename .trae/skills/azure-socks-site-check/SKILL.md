---
name: azure-socks-site-check
description: Verify the live site with Playwright through an Azure SSH SOCKS5 tunnel when the local network cannot reach Cloudflare. Use for production E2E or mobile checks during timeouts against wow.xn--fpr224a.mom. Do not use when the site is directly reachable.
---

# Azure SOCKS Tunnel Site Verification

When this machine (China network) cannot fetch the Cloudflare-hosted production site, route browser traffic through the Azure jump host instead of abandoning verification. The Azure VM reaches Cloudflare in ~0.3s.

## Fixed facts

- Production origin: `https://wow.xn--fpr224a.mom`
- Jump host: `azureuser@20.89.88.138`
- SSH key: `C:\Projects\keys\sg-gateway_key.pem`
- Local SOCKS5 endpoint: `127.0.0.1:1080`
- The VM has no Node/Chromium — use it purely as a network egress, do not attempt to run browsers there.

## 1. Confirm the failure is network, not code

Time-box this to one attempt each; do not keep retrying direct fetches:

1. DNS resolves (`Resolve-DnsName wow.xn--fpr224a.mom`) and `Test-NetConnection ... -Port 443` succeeds, but an HTTP(S) GET hangs to the 100s cancellation — that is GFW throttling of the specific edge IP, not a site outage.
2. Rule out a broken local dev server before blaming the network: `GET http://localhost:3000/@vite/client` must return JS. A 404 with the app's CSP means Vite middleware is bypassed and the page never hydrates — switch to production verification; do not report button bugs from that server.
3. If unsure the site itself is up, check from Azure:
   `ssh -i "C:\Projects\keys\sg-gateway_key.pem" azureuser@20.89.88.138 "curl -s -o /dev/null -w '%{http_code}' https://wow.xn--fpr224a.mom/"`

## 2. Start the tunnel

Run as a background job (the `-N` flag means no remote shell, it only forwards):

```powershell
ssh -i "C:\Projects\keys\sg-gateway_key.pem" -o StrictHostKeyChecking=no -D 127.0.0.1:1080 -N azureuser@20.89.88.138
```

Verify with `netstat -ano | findstr "1080"` before running checks.

## 3. Point Playwright at the tunnel

- Launch flag: `--proxy-server=socks5://127.0.0.1:1080` (Chromium resolves DNS through SOCKS, no local host rules needed).
- `scripts/mobile-check.mjs` in the mobile-responsive-check skill accepts `"launchArgs"` in config plus `"navTimeout"` and `"waitUntil": "domcontentloaded"`. Prefer `domcontentloaded` — `load`/`networkidle` may time out on long-polling pages.
- Standalone scripts: `chromium.launch({ args: ['--proxy-server=socks5://127.0.0.1:1080'] })`.
- Plain requests, if ever needed: a tool with SOCKS5 support; do not waste time on system-proxy settings.

## 4. Known test-only race — do not misreport it

With bottom sheets, Playwright's synthetic event sequence can render the sheet (and its full-screen `.ru-share-scrim`) between `pointerup` and `click`, so the trailing `click` lands on the scrim and closes the sheet. Real touch input dispatches in one task and never hits this. Evidence pattern: a 100ms-interval presence trace of the dialog shows it continuously mounted, and Playwright reports `scrim intercepts pointer events`. Handle in scripts by clicking with `force: true` then retrying while the dialog is missing — do not "fix" application code for it.

Hydration confirmation after navigation (both direct and tunneled): wait for
`Object.keys(document.body).some((k) => k.startsWith('__reactFiber'))` before interacting.

## 5. Cleanup

Stop the SSH background job when checks finish. Verify any state-changing E2E flow leaves the system in its expected state (e.g. sharing toggled back off).
