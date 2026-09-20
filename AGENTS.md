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
