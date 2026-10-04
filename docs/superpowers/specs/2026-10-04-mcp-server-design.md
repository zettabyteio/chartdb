# ChartDB MCP Server — Design

Status: decided by the fork owner on 2026-10-04 (brainstorm run by two Opus subagents; owner picked the options below). This is the spec the three plans in `docs/superpowers/plans/` implement.

## Goal

Let an AI client (Claude Code, Claude Desktop, any MCP client) perform the main actions of ChartDB through an MCP server. Keep it small. Keep the fork easy to merge from upstream.

## Why a bridge

ChartDB has no backend. Diagrams live in the browser's IndexedDB (Dexie) and in React state (`ChartDBProvider`). Only code running in the tab can edit the real state, so the MCP server relays tool calls to the open tab over a local WebSocket.

```
MCP client ──stdio──> mcp/ (Node)  ──ws://127.0.0.1:PORT──>  browser tab (useMcpBridge)
                      BridgeServer                              handlers → Dexie / React state
```

## Decisions

| Topic | Decision |
|---|---|
| Transport | Node MCP server over stdio (`@modelcontextprotocol/sdk`) + WebSocket bridge bound to `127.0.0.1` |
| Tab selection | The most recently connected tab wins |
| Tools | 13 (table below) + two resources |
| Destructive actions | Allowed with guards: `delete_diagram` needs `confirmName` equal to the diagram name; `apply_dbml` refuses to drop tables unless `allowDrops: true` |
| Diagram targeting | `diagramId` optional; defaults to the diagram open in the tab. Never hidden server-side state |
| Table references | By name: `table` or `schema.table`; ambiguous names are an error. Notes and areas by id |
| Auth | Shared token from env (`CHARTDB_MCP_TOKEN` on the server, `VITE_MCP_BRIDGE_TOKEN` in the app build) + `Origin` allowlist |
| Rollback | Before each write the previous diagram is kept in memory; if saving fails it is restored. There is no restore tool, no undo-stack integration, and a write to the open diagram clears the app's undo/redo history |
| Scope exclusions | AI SQL export, image export, templates, theme, i18n, undo/redo, filters |
| Serving | Local machine only: the dev server or a production build served with `vite preview` (the owner runs it in production mode). The default allowed origins cover ports 5173 and 4173. The bridge URL must be a loopback address and the Docker build never enables the bridge. Never deploy a build that contains the bridge token to a public host |

> The architecture agent suggested a random token printed at startup and pasted once into the app. The owner did not rule on that detail. The plans use a shared env token instead because it needs no UI. This is a deliberate simplification the owner should confirm when reviewing.

## Tools

| Tool | Purpose | R/W |
|---|---|---|
| `list_diagrams` | id, name, databaseType, updatedAt, whether it is open in the tab | R |
| `get_diagram` | diagram as DBML (default) or JSON | R |
| `create_diagram` | new diagram, empty or seeded from DDL / DBML / metadata JSON | W |
| `import_into_diagram` | add tables from DDL / DBML / metadata to an existing diagram, placed to the right of existing tables | W |
| `apply_dbml` | make the diagram's tables, relationships and enums match a DBML document, keeping ids/layout; `dryRun` returns the change summary only | W |
| `export_sql` | deterministic DDL (`exportBaseSQL`, never the LLM path) for the diagram's dialect or another | R |
| `remove_tables` | delete tables by name, with their relationships and dependencies | W |
| `rename_diagram` | rename | W |
| `delete_diagram` | delete a diagram (guarded) | W |
| `upsert_note` | create/update a sticky note | W |
| `upsert_area` | create/update an area, optionally moving named tables into it | W |
| `auto_arrange` | re-run the existing auto-layout | W |
| `validate_dbml` | parse DBML without saving, return line/column/message | R |

Resources: `chartdb://diagrams/{id}.dbml` and `chartdb://diagrams/{id}.json`.

## Code layout (fork-friendly)

New code only in `mcp/` (own `package.json`) and `src/mcp-bridge/`, plus `src/lib` helpers extracted from UI code. Upstream files that are modified, and why:

- `src/pages/editor-page/side-panel/dbml-section/table-dbml/table-dbml.tsx` — call the extracted `applyDBMLToDiagram`.
- `src/dialogs/import-database-dialog/import-database-dialog.tsx` — call the extracted import helpers.
- `src/pages/editor-page/editor-page.tsx` — mount `useMcpBridge()` (2 lines).
- `vitest.config.ts` — exclude `mcp/**` (CI installs only root dependencies).
- `CLAUDE.md`, `README.md` — docs.

## Known risks

1. `apply_dbml` can lose data DBML cannot express (check constraints, dialect options, positions of new objects). A rename is applied as delete + create. Mitigations: the change summary is always returned, the drop guard, and a round-trip test (export → apply gives no adds/removes).
2. MCP edits do not enter the app's undo history, and writing to the open diagram clears the existing undo/redo stacks (`loadDiagramFromData`). Saves are delete-then-add without a transaction, like the app's own.
3. Browsers may block `ws://127.0.0.1` from a page not served from localhost.
4. Upstream changes to `ChartDBContext` / `StorageContext` could break the bridge. The bridge uses only `updateDiagramData`, `deleteDiagram`, `currentDiagram`, `readonly` from `ChartDBContext` and `listDiagrams`, `getDiagram`, `addDiagram`, `deleteDiagram` from `StorageContext`.
