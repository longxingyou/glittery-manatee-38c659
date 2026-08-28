# Project Guide

## Architecture

Syntax Garden is a TanStack Start application deployed on Netlify. Markdown posts are compiled at build time through Content Collections, while visitor comments are stored in Netlify Database and protected by Netlify Identity.

## Key Directories

- `content/posts/`: Markdown source files and frontmatter.
- `src/routes/`: Page routes and the `/api/comments` server route.
- `src/components/`: Workbench shell, masonry feed, authentication, and comments UI.
- `src/lib/markdown.ts`: Safe Markdown and KaTeX rendering shared by posts and comments.
- `db/`: Drizzle schema and Netlify Database client.
- `netlify/database/migrations/`: Generated database migrations; never edit an applied migration.

## Conventions

- Use TypeScript and functional React components.
- Keep route files focused; reusable UI belongs in `src/components/`.
- Add persistent structured data only through Netlify Database.
- Use semantic CSS variables from `src/styles.css` for both themes.
- Preserve the VS Code-inspired workbench language and compact editor chrome.
- Validate all API input with Zod and require Netlify Identity for comment mutations.

## Non-obvious Decisions

The blog content remains static for fast builds and straightforward editorial workflows, while comments use server-side persistence. Authentication mutations happen in the browser through `@netlify/identity`; the comments API reads the authenticated Netlify cookie server-side. Raw HTML in Markdown is escaped, while KaTeX output is inserted only from locally rendered formula expressions.
