# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ChartDB is a client-side, web-based database diagram editor (React 18 + Vite + TypeScript, AGPL-3.0). There is no backend: diagrams live in the browser's IndexedDB, and the only external call is the optional OpenAI-compatible LLM used for AI SQL export. Node 24 (see `.nvmrc`).

## Commands

```bash
npm install
npm run dev            # Vite dev server
npm run build          # runs lint, then `tsc -b`, then `vite build` (this is what CI runs)
npm run lint           # eslint, --max-warnings 0 (warnings fail the build)
npm run lint:fix
npm test               # vitest in watch mode
npm run test:ci        # vitest run, bail on first failure (CI)
npx vitest run path/to/file.test.ts          # single test file
npx vitest run -t "test name pattern"        # single test by name
```

- The husky pre-commit hook runs `npm run lint`; CI runs lint, build, then `test:ci`.
- Formatting is Prettier (4-space indent, single quotes, `es5` trailing commas), enforced through ESLint. `@typescript-eslint/consistent-type-imports` is an error, so use `import type` for type-only imports.
- Import via the `@/` alias (maps to `src/`). Tests live in `__tests__/` folders next to the code, use Vitest with `happy-dom` and globals enabled, and `src/test/setup.ts` wires up jest-dom.
- TS is strict with `noUnusedLocals` and `noUnusedParameters`.

### Environment / config

AI export is opt-in through `VITE_OPENAI_API_KEY`, or `VITE_OPENAI_API_ENDPOINT` + `VITE_LLM_MODEL_NAME`. Use one option, not both. Other flags: `VITE_HIDE_CHARTDB_CLOUD`, `VITE_DISABLE_ANALYTICS`. `src/lib/env.ts` is the single place these are read. `HIDE_CHARTDB_CLOUD` and `DISABLE_ANALYTICS` also read `window.env`, which the Docker image fills at runtime (`entrypoint.sh` runs `envsubst` on the nginx template). Vite bakes the `VITE_*` values in at build time, so the Dockerfile writes them to `.env` before `npm run build`.

## Architecture

### Domain model (`src/lib/domain`)
`Diagram` is the root aggregate: `tables` (with `fields`, `indexes`, check constraints), `relationships`, `dependencies`, `areas`, `customTypes`, `notes`. Each type has a TS interface plus a matching zod schema (e.g. `diagramSchema`), which is used to validate imported/exported diagram JSON. When you add a field to a domain type, update its schema too. `DatabaseType` (Postgres, MySQL, MariaDB, SQL Server, SQLite, CockroachDB, ClickHouse, Oracle, Generic) is threaded through nearly everything. `database-capabilities.ts` is the per-dialect feature matrix (arrays, custom types, schemas, comments, check constraints). Prefer extending it over adding `if (type === ...)` branches.

### State and persistence (`src/context`, `src/hooks`)
State is a stack of React context providers, composed in `src/pages/editor-page/editor-page.tsx`. A `use-*` hook in `src/hooks` wraps each context.
- `StorageProvider` owns the **Dexie (IndexedDB) schema**: one table per entity (`diagrams`, `db_tables`, `db_relationships`, `areas`, `notes`, ...), each row keyed by `diagramId`. Schema changes need a new `dexieDB.version(n)` with an upgrade step. Never edit an existing version.
- `ChartDBProvider` is the main in-memory diagram state and the CRUD API (`addTable`, `updateField`, ...). It persists through storage and records undo/redo actions. It goes read-only when `readonly` is passed or when a diff is active (`useDiff().hasDiff`). In read-only mode it swaps storage for a no-op (`storageInitialValue`).
- `HistoryProvider` / `RedoUndoStackProvider` implement undo/redo (`redo-undo-action.ts`). `DiffProvider` powers the schema-diff view (`src/lib/domain/diff`). `CanvasProvider`, `LayoutProvider`, `DialogProvider`, `DiagramFilterProvider` and the others cover UI concerns.

### Canvas (`src/pages/editor-page/canvas`)
The diagram canvas is built on `@xyflow/react` (React Flow). Tables, areas and notes are custom nodes. Relationships and dependencies are custom edges. `canvas.tsx` converts domain objects into nodes/edges and syncs drag/resize back into the ChartDB context. `canvas-utils.ts` has the shared helpers. Edge/handle registration timing has been a source of bugs, so be careful when touching edge creation.

### Import / export pipelines (`src/lib/data`, `src/lib/dbml`)
- **Metadata import** (`import-metadata`): the user runs a per-dialect "smart query" (`scripts/*.ts`, selected via `importMetadataScripts[DatabaseType]`) against their DB and pastes the resulting JSON. `import/*.ts` turns it into domain objects. Metadata schemas are in `metadata-types`.
- **SQL import** (`sql-import`): `dialect-importers/<dialect>` parse DDL (using `node-sql-parser`, with custom parsing for pg_dump and others). `common.ts` converts the parser result to a `Diagram`.
- **SQL export** (`sql-export`): deterministic exporters in `export-per-type/`, and `cross-dialect/` converts between dialects (type mappings, unsupported-feature reporting). If the exporters can't handle a case, the AI export (LLM) is the fallback. Results are cached in `export-sql-cache.ts`.
- **DBML** (`dbml`): import and export use `@dbml/core` / `@dbml/parse`, and `apply-dbml` applies an edited DBML document back onto an existing diagram.
- `data-types` holds the per-dialect type catalogs. `default-schemas.ts` holds each dialect's default schema.

### Routing and pages
`src/router.tsx` uses react-router with lazy route modules. The editor is served at `/` and `/diagrams/:diagramId`. There are also `/examples` and the `/templates*` pages. Template data is in `src/templates-data`, and its assets are emitted with stable (un-hashed) filenames (see `vite.config.ts`).

### UI conventions
- `src/components/*` are shadcn/ui-style wrappers around Radix primitives, configured by `components.json`. Styling is Tailwind (`eslint-plugin-tailwindcss` enforces class ordering).
- Modal dialogs live in `src/dialogs` and are opened via `DialogProvider` / `useDialog`.
- i18n uses i18next with ~22 locale files in `src/i18n/locales`. `en.ts` is the source of truth. `LanguageTranslation` is typed from it, so a new key must be added to every locale file or `tsc` fails.
- `src/polyfills.ts` is imported first in `main.tsx`, and `safari-compat.ts` exists for Safari. Keep the import order.

### MCP bridge (fork-only)
`src/mcp-bridge/` + `mcp/` let an MCP client drive the app (spec: `docs/superpowers/specs/2026-10-04-mcp-server-design.md`).
- `mcp/` is a separate Node package (own `package.json`, built with esbuild, tested with `npm --prefix mcp test`; excluded from the root Vitest run). It speaks MCP over stdio and relays calls over a `127.0.0.1` WebSocket (`mcp/src/bridge-server.ts`). **Never write to stdout in `mcp/src`** — stdout is the protocol channel.
- `src/mcp-bridge/protocol.ts` is the single source of truth for tool names and zod input schemas, imported by both sides. It must use relative imports only (Node bundles it).
- Browser side: `use-mcp-bridge.ts` (mounted in `editor-page.tsx`, inert unless `VITE_MCP_BRIDGE_URL` is set) → `bridge-client.ts` (runs calls one at a time) → `handlers/*` → a `DiagramGateway` (`gateway.ts`; `live-gateway.ts` in the app, in-memory in tests). Write tools are pure `Diagram → Diagram` transforms followed by `commit()`, which rolls back if saving fails.
- Shared logic extracted from UI code lives in `src/lib` (`applyDBMLToDiagram`, `importContentToDiagram`, `getImportOffsetX`); the DBML side panel and import dialog use the same functions.

## Conventions

- Commits and PRs follow conventional commits (`feat:`, `fix:`, ...). Releases are automated through release-please, so don't hand-edit `CHANGELOG.md` or the version in `package.json`.
- PRs target `main`, and contributors must sign the CLA (`cla.yaml` workflow).
