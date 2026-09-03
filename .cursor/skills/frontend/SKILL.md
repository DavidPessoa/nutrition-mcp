---
name: frontend
description: MCP Apps widget work for nutrition-mcp. Use when changing public/widgets, src/widgets.ts, widget tests under public/widgets/**, the harness, or STYLE_GUIDE.md. Assembled self-contained HTML, deny-all iframe CSP.
disable-model-invocation: true
paths:
    - public/widgets/**
    - src/widgets.ts
    - scripts/widget-harness.ts
---

# Frontend

In-chat UI is MCP Apps (2026-01-26). Hosts render one iframe. The document is assembled at boot from partials — nothing built is committed.

Read `CLAUDE.md` → Custom UI Widgets and `public/widgets/STYLE_GUIDE.md` before editing.

## Layout

| Path                                  | Role                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `public/widgets/src/shared/`          | Tokens, shell, macro strip, bridge — edit once, all widgets pick up                     |
| `public/widgets/src/templates/*.html` | One template per widget                                                                 |
| `src/widgets.ts`                      | `WIDGET_TEMPLATES` keys + assembler (`@include`, `@inlinets`)                           |
| `src/mcp.ts`                          | Resource `ui://` + tool `_meta` (backend owns this file unless the plan says otherwise) |
| `scripts/widget-harness.ts`           | Local host: `bun run harness`                                                           |

## Rules

- One compact card: header, widget-specific top matter, shared macro strip. Do not bring back a page chrome stack.
- Reuse shared partials. Never copy `tokens.css` / `macros.*` / `bridge.js` into a template.
- No network from the iframe. No CDN, no fonts, no `eval`. Hand-built SVG, `currentColor` / `var(--…)`.
- New nutrients follow `MACROS` `role` in `shared/macros.js` (`cal` / `macro` / `limit` / `bar`). Do not hardcode a key list in layout.
- Interactive range toggles slice client-side from a superset payload (see `trends.html`). Do not round-trip a tool call to change 7/14/30.
- Reuse a widget across tools only when `structuredContent` shapes match (`meal-logged` + `log_meal` / `update_meal`).

## Handshake (break these and the widget sits on "Loading…")

1. App → host `ui/initialize` with `appInfo` / `appCapabilities` (not `clientInfo` / `capabilities`).
2. Host response.
3. App → host `ui/notifications/initialized` (required).
4. Host `ui/notifications/tool-result` with `structuredContent`.

`initWidget({ name, loading, coerce, render, sample, onReady? })` in `shared/bridge.js`. Treat a message as our response only when it has no `method` and has `result`/`error`. Reject inbound unless `event.source === host`.

## Height

Report `ui/notifications/size-changed`. Measure with `height = "max-content"` then restore. `ResizeObserver` on `documentElement` + `body`. Do not set `body { min-height: 100vh }`.

## New widget checklist

1. Template in `public/widgets/src/templates/<key>.html`
2. Key in `WIDGET_TEMPLATES` (`src/widgets.ts`)
3. Backend registers `ui://` resource (`text/html;profile=mcp-app`) and tool `_meta` (unless you own `src/mcp.ts`)
4. Tool always returns `structuredContent`
5. `bun test src/widgets.test.ts` (no unresolved markers, valid inline JS; frontend runs this file, backend owns it)
6. Behavior tests next to the widget (`public/widgets/*.test.ts`) when logic is non-trivial
7. `bun run harness` for interactive work (`?serverTools=0`, `?delay=3000`, `?maxHeight=600` exist)

`component-gallery` is dev-only: assembled and tested, never linked from a tool.

`/*@inlinets src/....ts*/` only for modules with no runtime imports (type-strip, strip `export`). Prefer this over a hand-copied twin.

## Report

Widgets/partials changed, assembler key added (yes/no), tests and harness, handshake + height verified or why not.
