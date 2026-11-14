# Project Guide

## Architecture

Syntax Garden is a TanStack Start application deployed on Cloudflare Workers (`worker.ts` + `@cloudflare/vite-plugin`, `nodejs_compat`). Markdown posts are compiled at build time through Content Collections. Visitor comments and accounts are stored in Neon Postgres via `@neondatabase/serverless` + Drizzle ORM. Authentication is self-hosted: PBKDF2 password hashing, HMAC JWT in the httpOnly `sg_auth` cookie, and Resend for verification/password-reset emails.

## Key Directories

- `content/posts/`: Markdown source files and frontmatter.
- `src/routes/`: Page routes plus `/api/comments` and `/api/auth` server routes.
- `src/components/`: Workbench shell, masonry feed, authentication, and comments UI.
- `src/lib/auth-client.ts`: Browser auth client (login/signup/reset/logout, `onAuthChange`).
- `src/lib/server-env.ts`: Worker env bridge — read secrets through `getEnv()`, never `process.env` directly.
- `src/lib/markdown.ts`: Safe Markdown and KaTeX rendering shared by posts and comments.
- `db/`: Drizzle schema (`users` + 10 content tables) and the Neon serverless client; tables are auto-created with idempotent SQL on first use.
- `wrangler.jsonc` / `worker.ts`: Worker config, security headers and CSP (iframe game hosts must be added to `frame-src`).

## Conventions

- Use TypeScript and functional React components.
- Keep route files focused; reusable UI belongs in `src/components/`.
- Add persistent structured data only through Neon Postgres (`db/index.ts`).
- Secrets are Worker secrets / `.dev.vars` (`DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `ADMIN_EMAILS`); never commit them.
- Use semantic CSS variables from `src/styles.css` for both themes.
- Preserve the VS Code-inspired workbench language and compact editor chrome.
- Validate all API input with Zod and require an authenticated `sg_auth` session for comment mutations.

## Non-obvious Decisions

The blog content remains static for fast builds and straightforward editorial workflows, while comments use server-side persistence. Auth is fully self-hosted (no third-party identity widget): `/api/auth` issues signed JWTs, stores only token hashes for verification/reset links, and sets cookies directly on the returned `Response`. Without `RESEND_API_KEY` configured, new accounts are auto-confirmed (local development only). Raw HTML in Markdown is escaped, while KaTeX output is inserted only from locally rendered formula expressions.

## Resource Consumption & Quota Register

This register tracks all free-tier quotas and mitigations. Check monthly; treat any threshold breach as a deployment blocker until resolved.

| Service | Quota / Limit | Current Mitigation | Risk Level | Action if Exceeded |
|---------|--------------|-------------------|------------|-------------------|
| **Neon Compute** | 100 CU-h/month (free plan, 0.25 CU default; ~400 wall-hours) | Cron `0 * * * *` ≈ 15 CU-h/month. Converter 5-second idle polling is gated by the `preview:pending` KV marker so idle polls no longer query Neon. Console settings: set "Suspend after" to 1 min and cap autoscaling max at 0.25 CU. | Medium | If usage again approaches 80 %, raise cron to 2 h (KV TTL 3 h) or migrate comments/auth to D1. |
| **Neon Storage** | 500 MB | Static posts + comments only. Monitor via Neon dashboard. | Low | Prune old comments / migrate to D1 if >400 MB. |
| **Cloudflare Workers** | 100,000 req/day | `wenyuan-sync` batched at ≤12 PUT + ≤10 DELETE per hourly tick. Scanner probes (`/sql`, `*.php`, `/.env`) short-circuit to plain 404 before SSR. | Low | Increase tick interval or add request sampling. |
| **CF KV Writes (SG_CACHE)** | 1,000/day | `wenyuan-sync` only writes state when `updated > 0`. Cache writes minimized. | Low | Batch more aggressively or switch to D1 for sync state. |
| **CF D1 (XDNMB_DB)** | 100,000 writes/day | Read-only for main site; crawler writes controlled. | Low | Reduce crawl frequency or shard index. |
| **Resend** | Free tier (domain not verified) | Registration/reset emails only. | Medium | Verify domain or switch to SMTP relay if volume grows. |
| **OSCA Storage** | 1 TB | Daily Wenyuan backup adds ~70 MB/day (~2.1 GB/month). | Very Low | N/A for foreseeable future. |
| **Azure VPS Bandwidth** | ~100 GB/month (student) | Daily SCP pull of ~70 MB for backup = ~2.1 GB/month. | Low | Monitor Azure Cost Management; reduce backup frequency if needed. |

**Monitoring procedure** (monthly, first week):
1. Neon Dashboard → Usage → Compute hours.
2. Cloudflare Dashboard → Workers → Analytics (requests) + KV → SG_CACHE (writes).
3. Azure Portal → Cost Management → Bandwidth.
4. OSCA Dashboard → Storage usage.

If any metric exceeds 70 % of quota, open an issue and adjust before the 90 % mark.
