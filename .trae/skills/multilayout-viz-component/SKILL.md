---
name: multilayout-viz-component
description: Build multi-layout interactive visualisations like the periodic table — coordinate functions, CSS grid views, hydration-safe SSR, i18n and mobile sheets. Use when adding a new layout, visual table or data browser. Do not use for article or markdown edits.
---

# Multi-layout visual component

Reference implementation: `src/components/periodic-table.tsx` + `.ru-pt*` rules in `src/styles.css`.
It ships four layouts (standard 18-column, Janet left-step 32-column, Mendeleev short 8-group, polar spiral)
and is the template for any "same data, several arrangements" widget.

## 1. Model each layout as a pure coordinate function

```
function layoutFoo(z: number): [row: number, col: number]
```

- One function per arrangement, all in the component file, all returning integer 1-based cells.
- Never compute positions inside JSX; JSX only maps `[row, col]` to `gridRow` / `gridColumn`.
- Offset convention: if the grid reserves column 1 for period labels, add +1 when writing
  `gridColumn`. Do the offset in one place, not per element.
- Hairline layouts (short table, left-step) need an explicit constant table per block.
  Write the ranges out (`z >= 57 && z <= 71`) instead of deriving from periods — derivation
  silently overlaps when a block splits across rows.

**Prove the mapping before touching React.** Throwaway script in `%TEMP%`:
loop `z = 1..118`, push `"row,col"` into a `Set`, print duplicates and `Set.size`.
`Set.size === 118` is the gate; anything less means two elements share a cell.

## 2. Layout chrome is conditional, not absolute

Column heads, period markers and "lanthanides" placeholders differ per layout:

- standard → 18 group numbers, period 1-7, f-block placeholder rows
- left-step → block letters `f/d/p/s` with spans 14/10/6/2, no placeholder rows
- short table → `I…VIII` plus a `0` column, period numbers only on the first sub-row of a period

Render chrome from the same `layoutMode` switch that picks the layout function, and give each
layout its own grid class (`ru-pt-19` / `ru-pt-33` / `ru-pt-short`). Do not try to express all
widths with one `grid-template-columns`.

## 3. Right-aligned layouts and narrow screens

A 32-column staircase is wider than a laptop content area minus sidebar. If the wrap starts at
`scrollLeft = 0`, the first screen is blank rows and looks broken.

- Keep `min-width` as low as legibility allows (left-step ≈ 780px, short table ≈ 430px).
- On entering a right-aligned layout, set `el.scrollLeft = el.scrollWidth` in an effect keyed on
  the layout mode; reset to 0 for other layouts.
- Two-column 32-tile rows at 22px are the floor — below that, hide element names, not symbols.

## 4. SSR and hydration

- Never seed state from `localStorage` in `useState(() => …)`. Render the SSR default, restore in
  `useEffect`, and gate persistence writes behind a `prefsLoaded` ref.
- Keep formatters ICU-free. `toLocaleString` can differ between workerd and the browser and
  surfaces as React #418 with `args[]=text`. Group thousands by hand.
- Verify with a fresh browser context and check the console for `418` / `hydrat`. Browser tooling
  that injects attributes (for example `data-trae-ref`) produces false positives in dev —
  compare against `curl` output before chasing them.

## 5. i18n

- Global copy lives in `src/lib/i18n-messages.ts` for `zh` / `en` / `ru`. Add the same key to all
  three blocks, in the same relative position, or one language silently falls back.
- Self-contained widgets may keep their own `ver: 'ru' | 'cn'` toggle (see `PeriodicTable`).
  Do not mix that local toggle with the site language state.
- Column headers that are data (group numbers, block letters) belong in the component, not in the
  message file.

## 6. Mobile

Apply at `max-width: 720px`:

- `.ru-el { touch-action: manipulation }` and `-webkit-tap-highlight-color: transparent`.
- Control bar `flex-wrap: nowrap; overflow-x: auto` so buttons never stack into three rows.
- Detail panel becomes a bottom sheet: `position: fixed; left/right/bottom: 8px;
  max-height: 62vh; overflow-y: auto`, drag handle via `::before`, slide-up keyframe.
- Wrappers need `-webkit-overflow-scrolling: touch` and a visible thin scrollbar.

## 7. Data sources and licensing

- Element data merges CC BY 3.0 (Bowser/Periodic-Table-JSON) with MIT
  (periodic-table-data-complete). Keep the attribution block in the detail panel when the primary
  source is attribution-required.
- Regeneration lives in `scripts/extract-elements.mjs`; regenerate into
  `src/lib/elements.json` rather than hand-editing 118 records.

## 8. Standalone route, then remove the old entry

When a toolkit tab graduates to its own page:

1. Register a lazy route in `src/router.tsx` inside the `hasPath` guard.
2. Add the sidebar entry in `src/components/site-shell.tsx` with an active-state check.
3. Delete the old tab: its key in `ToolkitTab`, the tab-button tuple, the `{tab === …}` branch and
   the now-unused import. Leaving a dead import keeps the whole chunk in the toolkit bundle.

## 9. Deliver with proof

```
npm run typecheck
npm run build
node scripts/snapshot-pages.mjs
npx wrangler deploy
```

`npm run deploy` often dies with `The request to Cloudflare's API timed out` after a successful
build — rerunning `npx wrangler deploy` alone is enough. Do not claim a deploy landed until the
served asset hash contains the new symbol (`fetch` the chunk and grep for a layout function name);
cached HTML can otherwise show a stale build.

Then verify in a browser with observable criteria (element counts, cell coordinates, sticker
stacking direction), take screenshots, and read the console. Report PASS/FAIL per criterion.
