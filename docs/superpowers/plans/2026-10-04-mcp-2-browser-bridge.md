# MCP Plan 2 — Browser bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `src/mcp-bridge/`: a tool protocol (zod), 13 tool handlers, and a React hook `useMcpBridge` that connects the open ChartDB tab to a local WebSocket and executes tool calls against the real diagram state.

**Architecture:** Every write tool is a pure transform `Diagram → Diagram` followed by one `commit` through a small `DiagramGateway` interface. The gateway is implemented twice: an in-memory one for tests, and a live one that uses `ChartDBContext.updateDiagramData` for the open diagram and Dexie storage for other diagrams. A `bridge-client` receives `call` messages, validates args with the zod shapes in `protocol.ts`, runs handlers one at a time, and replies with `result` messages. The Node side (Plan 3) imports only `protocol.ts`.

**Tech Stack:** TypeScript, React 18, zod 3, Vitest + happy-dom, existing ChartDB libs (DBML, SQL import/export, area/table layout helpers).

**Spec:** `docs/superpowers/specs/2026-10-04-mcp-server-design.md`

**Depends on:** Plan 1 (`applyDBMLToDiagram`, `importContentToDiagram`, `getImportOffsetX`/`offsetTablesX`) merged on the `feat/mcp-server` branch.

## Global Constraints

- Node 24, branch `feat/mcp-server`, never commit to `main`.
- Prettier: 4 spaces, single quotes, `es5` trailing commas; lint `--max-warnings 0`; `import type` for type-only imports; no unused locals/params. Run `npx prettier --write <files>` before each commit.
- App code uses the `@/` alias, **except `src/mcp-bridge/protocol.ts`**, which is also bundled by Node in Plan 3 and therefore must use only relative imports and may import only `zod` and `../lib/domain/database-type`.
- The feature is off unless `VITE_MCP_BRIDGE_URL` is set. Docker builds never set it (the Dockerfile writes a fixed list of vars into `.env`), so default builds contain no bridge code path that connects anywhere.
- The bridge token is baked into the JS bundle (dev server and production builds alike): use only for builds served on this machine (`npm run dev` or `npm run build && npm run preview`). Never deploy a build with these vars to a public host.
- Tool names and arguments are exactly those in `protocol.ts` (Task 1). Do not invent additional tools.
- Tests import `describe/it/expect/vi` from `vitest` explicitly. Test helpers live in `__tests__/` and must NOT be named `*.test.ts`.
- Conventional commits; end every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Only this existing file may be modified: `src/pages/editor-page/editor-page.tsx` (Task 6, two lines).

## Known limitations (document in the README, do not try to fix here)

- Every write to the **open** diagram goes through `updateDiagramData` → `loadDiagramFromData`, which also **clears the app's undo and redo stacks** (`chartdb-provider.tsx` ~L1901). MCP edits are not undoable and wipe the user's existing undo history.
- Saves are delete-then-add with no Dexie transaction (same as the app's own `updateDiagramData`): a UI edit in that window can be lost, and a crash mid-save can leave a diagram deleted. `commit()` rolls back only on a thrown error.
- While the app shows a DBML diff review (`readonly`), `currentDiagram.tables` already contains the unaccepted diff tables, so reads (`get_diagram`, `export_sql`) include them. Writes to the open diagram are refused.
- `import_into_diagram` drops imported enums/custom types (same as the import dialog), so imported fields may reference types that do not exist. It ignores `databaseType` for non-generic diagrams.
- `auto_arrange` arranges every table, including hidden views and tables excluded by the diagram filter (the UI's reorder skips those).
- `delete_diagram` / `remove_tables` leave stale `diagram_filters` rows (same as upstream).
- `get_diagram` JSON uses the real ids on purpose (not `diagramToJSONOutput`, which renumbers them).

## Review Focus

- No diagram open and no `diagramId` → an error that tells the caller to run `list_diagrams`.
- Two tables with the same name in different schemas → `ambiguous` error naming both; never silently picks one.
- Invalid DBML, or DBML that would drop tables without `allowDrops` → nothing is saved.
- `saveDiagram` throws → the previous diagram is restored and the error is reported.
- App in diff-review (`readonly`) mode → writes to the open diagram are refused with instructions.
- Two browser tabs open at once → the older one is closed with 4001 and must stay disconnected (no reconnect loop).
- Two tool calls sent back-to-back → run sequentially; the second sees the first one's result (no lost update from stale React state).

---

### Task 1: Protocol, errors, name resolution, gateway core, test helpers

**Files:**
- Create: `src/mcp-bridge/protocol.ts`
- Create: `src/mcp-bridge/tool-error.ts`
- Create: `src/mcp-bridge/resolve.ts`
- Create: `src/mcp-bridge/gateway.ts`
- Create: `src/mcp-bridge/handlers/types.ts`
- Create: `src/mcp-bridge/__tests__/helpers.ts`
- Test: `src/mcp-bridge/__tests__/core.test.ts`

**Interfaces:**
- Produces (used by every later task):
  ```ts
  // protocol.ts
  export const toolInputShapes;                       // Record<ToolName, ZodRawShape>
  export type ToolName = keyof typeof toolInputShapes;
  export const toolNames: ToolName[];
  export type ToolArgs<T extends ToolName>;           // z.infer of the tool's object
  export const clientMessageSchema; export const serverMessageSchema;
  // tool-error.ts
  export class ToolError extends Error {}
  export const describeError: (error: unknown) => string;
  // resolve.ts
  export const tableLabel: (table: DBTable) => string;           // 'schema.table' | 'table'
  export const resolveTable: (diagram: Diagram, ref: string) => DBTable; // throws ToolError
  // gateway.ts
  export interface DiagramGateway {
      currentDiagramId(): string | undefined;
      isReadonly(): boolean;
      list(): Promise<Diagram[]>;
      load(id: string): Promise<Diagram | undefined>;
      save(diagram: Diagram): Promise<void>;     // replace an existing diagram
      create(diagram: Diagram): Promise<void>;   // add a new diagram
      remove(id: string): Promise<void>;
  }
  export const loadTarget: (gateway: DiagramGateway, diagramId?: string) => Promise<Diagram>;
  export const assertWritable: (gateway: DiagramGateway, diagramId: string) => void;
  export const commit: (gateway: DiagramGateway, before: Diagram, after: Diagram) => Promise<void>;
  // handlers/types.ts
  export type ToolHandlers = { [K in ToolName]: (args: ToolArgs<K>) => Promise<unknown> };
  // __tests__/helpers.ts
  export const createMemoryGateway; export const diagramFromDbml; export const USERS_POSTS_DBML; export const run;
  ```

- [ ] **Step 1: Write `protocol.ts`**

```ts
import { z } from 'zod';
// Relative import on purpose: this file is also bundled by Node (mcp/), where
// the '@/' alias does not exist. Keep imports here to zod + plain enums only.
import { DatabaseType } from '../lib/domain/database-type';

const diagramId = z
    .string()
    .min(1)
    .optional()
    .describe(
        'Diagram id (see list_diagrams). Defaults to the diagram open in the app tab.'
    );

const databaseType = z
    .nativeEnum(DatabaseType)
    .describe('Database dialect, e.g. postgresql, mysql, sqlite.');

const importKind = z
    .enum(['ddl', 'dbml', 'metadata'])
    .describe(
        "'ddl' = SQL CREATE statements, 'dbml' = DBML text, 'metadata' = JSON returned by ChartDB's per-database smart query."
    );

const tableRefs = z
    .array(z.string().min(1))
    .describe("Table names: 'table' or 'schema.table'.");

export const toolInputShapes = {
    list_diagrams: {},
    get_diagram: {
        diagramId,
        format: z.enum(['dbml', 'json']).default('dbml'),
    },
    create_diagram: {
        name: z.string().min(1),
        databaseType,
        source: z
            .object({ kind: importKind, content: z.string().min(1) })
            .optional()
            .describe('Optional content to seed the new diagram.'),
    },
    import_into_diagram: {
        diagramId,
        kind: importKind,
        content: z.string().min(1),
        databaseType: databaseType
            .optional()
            .describe(
                "Required only when the diagram's type is 'generic'; it then becomes the diagram's type."
            ),
    },
    apply_dbml: {
        diagramId,
        dbml: z.string().describe('The full desired DBML for the diagram.'),
        dryRun: z
            .boolean()
            .default(false)
            .describe('Only report what would change; save nothing.'),
        allowDrops: z
            .boolean()
            .default(false)
            .describe('Allow the DBML to delete tables that are not in it.'),
    },
    export_sql: {
        diagramId,
        targetDatabaseType: databaseType.optional(),
    },
    remove_tables: {
        diagramId,
        tables: tableRefs.min(1),
    },
    rename_diagram: {
        diagramId,
        name: z.string().min(1),
    },
    delete_diagram: {
        diagramId: z.string().min(1),
        confirmName: z
            .string()
            .describe('Must exactly equal the name of the diagram to delete.'),
    },
    upsert_note: {
        diagramId,
        noteId: z.string().optional().describe('Omit to create a new note.'),
        content: z.string().optional(),
        color: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
    },
    upsert_area: {
        diagramId,
        areaId: z.string().optional().describe('Omit to create a new area.'),
        name: z.string().min(1).optional(),
        color: z.string().optional(),
        tables: tableRefs
            .optional()
            .describe('Tables to move into the area and arrange there.'),
    },
    auto_arrange: { diagramId },
    validate_dbml: {
        dbml: z.string(),
        databaseType,
    },
} satisfies Record<string, z.ZodRawShape>;

export type ToolName = keyof typeof toolInputShapes;

export const toolNames = Object.keys(toolInputShapes) as ToolName[];

export type ToolArgs<T extends ToolName> = z.infer<
    z.ZodObject<(typeof toolInputShapes)[T]>
>;

// Browser -> server
export const clientMessageSchema = z.union([
    z.object({ type: z.literal('hello'), token: z.string() }),
    z.object({
        type: z.literal('result'),
        id: z.string(),
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().optional(),
    }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server -> browser
export const serverMessageSchema = z.union([
    z.object({ type: z.literal('ready') }),
    z.object({
        type: z.literal('call'),
        id: z.string(),
        tool: z.string(),
        args: z.unknown().optional(),
    }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
```

- [ ] **Step 2: Write `tool-error.ts`**

```ts
import { parseDBMLError } from '@/lib/dbml/dbml-import/dbml-import-error';

/** An error whose message is safe and useful to show to the AI client. */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolError';
    }
}

export const describeError = (error: unknown): string => {
    const dbmlError = parseDBMLError(error);
    if (dbmlError) {
        return `line ${dbmlError.line}, column ${dbmlError.column}: ${dbmlError.message}`;
    }
    return error instanceof Error ? error.message : String(error);
};
```

- [ ] **Step 3: Write `resolve.ts`**

```ts
import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import { ToolError } from './tool-error';

export const tableLabel = (table: DBTable): string =>
    table.schema ? `${table.schema}.${table.name}` : table.name;

export const resolveTable = (diagram: Diagram, ref: string): DBTable => {
    const tables = diagram.tables ?? [];
    const wanted = ref.toLowerCase();

    const byLabel = tables.filter((t) => tableLabel(t).toLowerCase() === wanted);
    const matches =
        byLabel.length > 0
            ? byLabel
            : tables.filter((t) => t.name.toLowerCase() === wanted);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new ToolError(
            `Table '${ref}' is ambiguous. Use one of: ${matches.map(tableLabel).join(', ')}.`
        );
    }

    const hints = tables
        .filter((t) => {
            const name = t.name.toLowerCase();
            return name.includes(wanted) || wanted.includes(name);
        })
        .map(tableLabel)
        .slice(0, 5);

    throw new ToolError(
        hints.length > 0
            ? `Table '${ref}' not found. Did you mean: ${hints.join(', ')}?`
            : `Table '${ref}' not found. Existing tables: ${
                  tables
                      .slice(0, 20)
                      .map(tableLabel)
                      .join(', ') || '(none)'
              }.`
    );
};
```

- [ ] **Step 4: Write `gateway.ts`**

```ts
import type { Diagram } from '@/lib/domain/diagram';
import { ToolError, describeError } from './tool-error';

export interface DiagramGateway {
    currentDiagramId(): string | undefined;
    isReadonly(): boolean;
    list(): Promise<Diagram[]>;
    load(id: string): Promise<Diagram | undefined>;
    /** Replace an existing diagram (tables, relationships, areas, notes...). */
    save(diagram: Diagram): Promise<void>;
    /** Add a brand-new diagram. */
    create(diagram: Diagram): Promise<void>;
    remove(id: string): Promise<void>;
}

export const loadTarget = async (
    gateway: DiagramGateway,
    diagramId?: string
): Promise<Diagram> => {
    const id = diagramId ?? gateway.currentDiagramId();

    if (!id) {
        throw new ToolError(
            'No diagram is open in the app and no diagramId was given. Call list_diagrams, then pass diagramId.'
        );
    }

    const diagram = await gateway.load(id);

    if (!diagram) {
        throw new ToolError(
            `Diagram '${id}' not found. Call list_diagrams to see valid ids.`
        );
    }

    return diagram;
};

export const assertWritable = (
    gateway: DiagramGateway,
    diagramId: string
): void => {
    if (gateway.isReadonly() && diagramId === gateway.currentDiagramId()) {
        throw new ToolError(
            'The open diagram is in read-only diff-review mode. Accept or cancel the pending DBML changes in the app, then retry.'
        );
    }
};

/** Save `after`; if saving fails, restore `before` and report the failure. */
export const commit = async (
    gateway: DiagramGateway,
    before: Diagram,
    after: Diagram
): Promise<void> => {
    assertWritable(gateway, before.id);

    try {
        await gateway.save({ ...after, updatedAt: new Date() });
    } catch (error) {
        try {
            await gateway.save(before);
        } catch {
            // Best effort: the original failure is the one worth reporting.
        }
        throw new ToolError(
            `Saving failed and the previous state was restored. Cause: ${describeError(error)}`
        );
    }
};
```

- [ ] **Step 5: Write `handlers/types.ts`**

```ts
import type { ToolArgs, ToolName } from '../protocol';

export type ToolHandlers = {
    [K in ToolName]: (args: ToolArgs<K>) => Promise<unknown>;
};
```

- [ ] **Step 6: Write the test helpers `__tests__/helpers.ts`**

```ts
import { z } from 'zod';
import { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import type { DiagramGateway } from '../gateway';
import type { ToolHandlers } from '../handlers/types';
import { toolInputShapes } from '../protocol';
import type { ToolName } from '../protocol';

export const USERS_POSTS_DBML = `
Table users {
  id integer [pk]
  email varchar(255) [not null]
}

Table posts {
  id integer [pk]
  user_id integer [not null]
  title varchar(200)
}

Ref: posts.user_id > users.id
`;

export const diagramFromDbml = async (
    dbml: string = USERS_POSTS_DBML,
    { id = 'd1', name = 'Test diagram' } = {}
): Promise<Diagram> => {
    const diagram = await importDBMLToDiagram(dbml, {
        databaseType: DatabaseType.POSTGRESQL,
    });
    return { ...diagram, id, name };
};

export const createMemoryGateway = ({
    diagrams,
    currentId,
    readonly = false,
    failSaves = 0,
}: {
    diagrams: Diagram[];
    currentId?: string;
    readonly?: boolean;
    failSaves?: number;
}) => {
    const store = new Map<string, Diagram>(
        diagrams.map((d) => [d.id, structuredClone(d)] as const)
    );
    const saves: Diagram[] = [];
    let remainingFailures = failSaves;

    const gateway: DiagramGateway = {
        currentDiagramId: () => currentId,
        isReadonly: () => readonly,
        list: async () => [...store.values()],
        load: async (id) => store.get(id),
        save: async (diagram) => {
            if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw new Error('disk full');
            }
            saves.push(diagram);
            store.set(diagram.id, diagram);
        },
        create: async (diagram) => {
            store.set(diagram.id, diagram);
        },
        remove: async (id) => {
            store.delete(id);
        },
    };

    return { gateway, store, saves };
};

/** Run a tool exactly like the bridge client does: parse args, then call. */
export const run = async <K extends ToolName>(
    handlers: Partial<ToolHandlers>,
    tool: K,
    args: z.input<z.ZodObject<(typeof toolInputShapes)[K]>>
): Promise<unknown> => {
    const handler = handlers[tool] as ((a: unknown) => Promise<unknown>) | undefined;
    if (!handler) {
        throw new Error(`No handler registered for ${tool}`);
    }
    return handler(z.object(toolInputShapes[tool]).parse(args));
};
```

- [ ] **Step 7: Write the failing tests `__tests__/core.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toolInputShapes, toolNames } from '../protocol';
import { ToolError } from '../tool-error';
import { resolveTable } from '../resolve';
import { assertWritable, commit, loadTarget } from '../gateway';
import {
    createMemoryGateway,
    diagramFromDbml,
} from './helpers';

describe('protocol', () => {
    it('defines exactly the 13 agreed tools', () => {
        expect([...toolNames].sort()).toEqual(
            [
                'apply_dbml',
                'auto_arrange',
                'create_diagram',
                'delete_diagram',
                'export_sql',
                'get_diagram',
                'import_into_diagram',
                'list_diagrams',
                'remove_tables',
                'rename_diagram',
                'upsert_area',
                'upsert_note',
                'validate_dbml',
            ].sort()
        );
    });

    it('applies safe defaults', () => {
        const args = z.object(toolInputShapes.apply_dbml).parse({ dbml: 'x' });
        expect(args.dryRun).toBe(false);
        expect(args.allowDrops).toBe(false);
        expect(z.object(toolInputShapes.get_diagram).parse({}).format).toBe(
            'dbml'
        );
    });

    it('rejects an empty tables list for remove_tables', () => {
        expect(
            z.object(toolInputShapes.remove_tables).safeParse({ tables: [] })
                .success
        ).toBe(false);
    });
});

describe('resolveTable', () => {
    it('finds by bare name and by schema.table', async () => {
        const diagram = await diagramFromDbml();
        const byName = resolveTable(diagram, 'users');
        expect(byName.name).toBe('users');
        const label = byName.schema ? `${byName.schema}.users` : 'users';
        expect(resolveTable(diagram, label).id).toBe(byName.id);
        expect(resolveTable(diagram, 'USERS').id).toBe(byName.id);
    });

    it('is ambiguous when two schemas share a table name', async () => {
        const diagram = await diagramFromDbml(
            'Table a.users {\n  id integer [pk]\n}\nTable b.users {\n  id integer [pk]\n}'
        );
        expect(() => resolveTable(diagram, 'users')).toThrow(/ambiguous/);
        expect(() => resolveTable(diagram, 'users')).toThrow(/a\.users/);
        expect(resolveTable(diagram, 'b.users').schema).toBe('b');
    });

    it('suggests close names when not found', async () => {
        const diagram = await diagramFromDbml();
        expect(() => resolveTable(diagram, 'user')).toThrow(/Did you mean/);
        expect(() => resolveTable(diagram, 'zzz')).toThrow(
            /Existing tables: .*users/
        );
    });
});

describe('loadTarget', () => {
    it('uses the open diagram by default', async () => {
        const d = await diagramFromDbml();
        const { gateway } = createMemoryGateway({ diagrams: [d], currentId: d.id });
        expect((await loadTarget(gateway)).id).toBe(d.id);
    });

    it('tells the caller to list diagrams when nothing is open', async () => {
        const { gateway } = createMemoryGateway({ diagrams: [] });
        await expect(loadTarget(gateway)).rejects.toThrow(/list_diagrams/);
    });

    it('reports an unknown id', async () => {
        const { gateway } = createMemoryGateway({ diagrams: [] });
        await expect(loadTarget(gateway, 'nope')).rejects.toThrow(
            /'nope' not found/
        );
    });
});

describe('commit / assertWritable', () => {
    it('saves and bumps updatedAt', async () => {
        const d = await diagramFromDbml();
        const { gateway, saves } = createMemoryGateway({ diagrams: [d], currentId: d.id });
        await commit(gateway, d, { ...d, name: 'renamed' });
        expect(saves).toHaveLength(1);
        expect(saves[0].name).toBe('renamed');
        expect(saves[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
            d.updatedAt.getTime()
        );
    });

    it('restores the previous diagram when saving fails', async () => {
        const d = await diagramFromDbml();
        const { gateway, store } = createMemoryGateway({
            diagrams: [d],
            currentId: d.id,
            failSaves: 1,
        });
        await expect(
            commit(gateway, d, { ...d, name: 'renamed' })
        ).rejects.toThrow(/previous state was restored/);
        expect(store.get(d.id)?.name).toBe(d.name);
    });

    it('refuses writes to the open diagram while read-only', async () => {
        const d = await diagramFromDbml();
        const { gateway, saves } = createMemoryGateway({
            diagrams: [d],
            currentId: d.id,
            readonly: true,
        });
        expect(() => assertWritable(gateway, d.id)).toThrow(ToolError);
        await expect(commit(gateway, d, d)).rejects.toThrow(/diff-review/);
        expect(saves).toHaveLength(0);
    });

    it('allows writes to a non-open diagram while the open one is read-only', async () => {
        const open = await diagramFromDbml(undefined, { id: 'open' });
        const other = await diagramFromDbml(undefined, { id: 'other' });
        const { gateway, saves } = createMemoryGateway({
            diagrams: [open, other],
            currentId: 'open',
            readonly: true,
        });
        await commit(gateway, other, { ...other, name: 'x' });
        expect(saves).toHaveLength(1);
    });
});
```

- [ ] **Step 8: Run the tests and make sure they pass**

Run: `npx vitest run src/mcp-bridge/__tests__/core.test.ts`
Expected: PASS. (The code in Steps 1–6 already exists, so this is a "tests written after the helpers" check; if any assertion fails, fix the code, not the assertion — except `endsWith`/regex tolerance for schema labels.)

- [ ] **Step 9: Format, type-check, commit**

```bash
npx prettier --write src/mcp-bridge
npx tsc -b
npm run lint
git add src/mcp-bridge
git commit -m "feat(mcp-bridge): add protocol, gateway core and name resolution

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read tools — `list_diagrams`, `get_diagram`, `export_sql`, `validate_dbml`

**Files:**
- Create: `src/mcp-bridge/handlers/read.ts`
- Test: `src/mcp-bridge/__tests__/read.test.ts`

**Interfaces:**
- Consumes: `DiagramGateway`, `loadTarget` (Task 1); `generateDBMLFromDiagram(diagram): { standardDbml; error? }` (`src/lib/dbml/dbml-export/dbml-export.ts`); `diagramToJSONOutput(diagram): string` (`src/lib/export-import-utils.ts`); `exportBaseSQL({ diagram, targetDatabaseType }): string` (`src/lib/data/sql-export/export-sql-script.ts`); `verifyDBML(content, { databaseType })` (`src/lib/dbml/dbml-import/verify-dbml.ts`).
- Produces: `createReadHandlers(gateway: DiagramGateway): Pick<ToolHandlers, 'list_diagrams' | 'get_diagram' | 'export_sql' | 'validate_dbml'>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { createReadHandlers } from '../handlers/read';
import { createMemoryGateway, diagramFromDbml, run } from './helpers';

const setup = async () => {
    const older = {
        ...(await diagramFromDbml(undefined, { id: 'a', name: 'Older' })),
        updatedAt: new Date('2025-01-01T00:00:00Z'),
    };
    const newer = {
        ...(await diagramFromDbml(undefined, { id: 'b', name: 'Newer' })),
        updatedAt: new Date('2025-06-01T00:00:00Z'),
    };
    const { gateway } = createMemoryGateway({
        diagrams: [older, newer],
        currentId: 'a',
    });
    return createReadHandlers(gateway);
};

describe('list_diagrams', () => {
    it('lists newest first and flags the open diagram', async () => {
        const handlers = await setup();
        const result = (await run(handlers, 'list_diagrams', {})) as {
            id: string;
            name: string;
            openInApp: boolean;
            updatedAt: string;
        }[];

        expect(result.map((d) => d.id)).toEqual(['b', 'a']);
        expect(result.find((d) => d.id === 'a')?.openInApp).toBe(true);
        expect(result.find((d) => d.id === 'b')?.openInApp).toBe(false);
        expect(result[0].updatedAt).toBe('2025-06-01T00:00:00.000Z');
    });
});

describe('get_diagram', () => {
    it('returns DBML by default for the open diagram', async () => {
        const handlers = await setup();
        const dbml = (await run(handlers, 'get_diagram', {})) as string;
        expect(dbml).toContain('users');
        expect(dbml).toContain('posts');
    });

    it('returns JSON for another diagram', async () => {
        const handlers = await setup();
        const json = (await run(handlers, 'get_diagram', {
            diagramId: 'b',
            format: 'json',
        })) as string;
        expect(JSON.parse(json).name).toBe('Newer');
        // Real ids, not the renumbered '0', '1', ... of diagramToJSONOutput.
        expect(JSON.parse(json).id).toBe('b');
    });

    it('fails clearly for an unknown diagram', async () => {
        const handlers = await setup();
        await expect(
            run(handlers, 'get_diagram', { diagramId: 'zzz' })
        ).rejects.toThrow(/not found/);
    });
});

describe('export_sql', () => {
    it('exports DDL in the diagram dialect', async () => {
        const handlers = await setup();
        const sql = (await run(handlers, 'export_sql', {})) as string;
        expect(sql.toUpperCase()).toContain('CREATE TABLE');
    });

    it('can target another dialect', async () => {
        const handlers = await setup();
        const sql = (await run(handlers, 'export_sql', {
            targetDatabaseType: DatabaseType.MYSQL,
        })) as string;
        expect(sql.toUpperCase()).toContain('CREATE TABLE');
    });

    it('rejects a target dialect without a deterministic path', async () => {
        const handlers = await setup();
        await expect(
            run(handlers, 'export_sql', {
                targetDatabaseType: DatabaseType.ORACLE,
            })
        ).rejects.toThrow(/No deterministic SQL export/);
    });

    it('refuses to export a diagram with no tables', async () => {
        const empty = await diagramFromDbml('', { id: 'e', name: 'Empty' });
        const { gateway } = createMemoryGateway({ diagrams: [empty], currentId: 'e' });
        await expect(
            run(createReadHandlers(gateway), 'export_sql', {})
        ).rejects.toThrow(/no tables/);
    });
});

describe('validate_dbml', () => {
    it('accepts valid DBML', async () => {
        const handlers = await setup();
        expect(
            await run(handlers, 'validate_dbml', {
                dbml: 'Table t {\n  id integer\n}',
                databaseType: DatabaseType.POSTGRESQL,
            })
        ).toEqual({ valid: true });
    });

    it('reports line and message for invalid DBML', async () => {
        const handlers = await setup();
        const result = (await run(handlers, 'validate_dbml', {
            dbml: 'Table broken { id integer [',
            databaseType: DatabaseType.POSTGRESQL,
        })) as { valid: boolean; message: string; line?: number };

        expect(result.valid).toBe(false);
        expect(result.message.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp-bridge/__tests__/read.test.ts`
Expected: FAIL — cannot resolve `../handlers/read`.

- [ ] **Step 3: Implement `handlers/read.ts`**

```ts
import { hasCrossDialectSupport } from '@/lib/data/sql-export/cross-dialect';
import { exportBaseSQL } from '@/lib/data/sql-export/export-sql-script';
import { generateDBMLFromDiagram } from '@/lib/dbml/dbml-export/dbml-export';
import { verifyDBML } from '@/lib/dbml/dbml-import/verify-dbml';
import { DatabaseType } from '@/lib/domain/database-type';
import type { DiagramGateway } from '../gateway';
import { loadTarget } from '../gateway';
import type { ToolHandlers } from './types';
import { ToolError } from '../tool-error';

export const createReadHandlers = (
    gateway: DiagramGateway
): Pick<
    ToolHandlers,
    'list_diagrams' | 'get_diagram' | 'export_sql' | 'validate_dbml'
> => ({
    list_diagrams: async () => {
        const diagrams = await gateway.list();
        const openId = gateway.currentDiagramId();

        return [...diagrams]
            .map((d) => ({ ...d, updatedAt: new Date(d.updatedAt) }))
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .map((d) => ({
                id: d.id,
                name: d.name,
                databaseType: d.databaseType,
                updatedAt: d.updatedAt.toISOString(),
                openInApp: d.id === openId,
            }));
    },

    get_diagram: async (args) => {
        const diagram = await loadTarget(gateway, args.diagramId);

        if (args.format === 'json') {
            // Do NOT use diagramToJSONOutput: it renumbers every id ('0', '1', ...),
            // and callers need the real diagram/note/area ids.
            return JSON.stringify(diagram, null, 2);
        }

        const result = generateDBMLFromDiagram(diagram);
        if (result.error) {
            throw new ToolError(`DBML export failed: ${result.error}`);
        }
        return result.standardDbml;
    },

    export_sql: async (args) => {
        const diagram = await loadTarget(gateway, args.diagramId);

        if (!diagram.tables || diagram.tables.length === 0) {
            throw new ToolError('The diagram has no tables to export.');
        }

        const target = args.targetDatabaseType ?? diagram.databaseType;

        // Same condition the export dialog uses for its deterministic path.
        // Anything else would fall through to the pre-LLM generic script.
        if (
            !(
                target === diagram.databaseType ||
                target === DatabaseType.GENERIC ||
                hasCrossDialectSupport(diagram.databaseType, target)
            )
        ) {
            throw new ToolError(
                `No deterministic SQL export from ${diagram.databaseType} to ${target}. Export in the diagram's own dialect, or to a supported target.`
            );
        }

        // exportBaseSQL can rewrite field types in place; never hand it live state.
        return exportBaseSQL({
            diagram: structuredClone(diagram),
            targetDatabaseType: target,
        });
    },

    validate_dbml: async (args) => {
        const result = verifyDBML(args.dbml, {
            databaseType: args.databaseType,
        });

        if (!result.hasError) {
            return { valid: true };
        }

        return {
            valid: false,
            message: result.errorText,
            line: result.parsedError?.line,
            column: result.parsedError?.column,
        };
    },
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/mcp-bridge/__tests__/read.test.ts`
Expected: PASS. If `generateDBMLFromDiagram` returns an `error` for the fixture, read `result.error` and fix the fixture DBML, not the handler.

- [ ] **Step 5: Format, type-check, commit**

```bash
npx prettier --write src/mcp-bridge
npx tsc -b && npm run lint
git add src/mcp-bridge
git commit -m "feat(mcp-bridge): add read tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Diagram lifecycle tools — `create_diagram`, `rename_diagram`, `delete_diagram`

**Files:**
- Create: `src/mcp-bridge/handlers/shared.ts`
- Create: `src/mcp-bridge/handlers/diagram.ts`
- Test: `src/mcp-bridge/__tests__/diagram.test.ts`

**Interfaces:**
- Consumes: Task 1 items; `importContentToDiagram` (Plan 1); `generateDiagramId()` from `@/lib/utils/utils`.
- Produces:
  ```ts
  // shared.ts
  export const toImportMethod: (kind: 'ddl' | 'dbml' | 'metadata') => ImportMethod;
  export const importOrThrow: (args: Parameters<typeof importContentToDiagram>[0]) => Promise<Diagram>;
  // diagram.ts
  export const createDiagramHandlers: (gateway: DiagramGateway) =>
      Pick<ToolHandlers, 'create_diagram' | 'rename_diagram' | 'delete_diagram'>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { createDiagramHandlers } from '../handlers/diagram';
import { createMemoryGateway, diagramFromDbml, run } from './helpers';

describe('create_diagram', () => {
    it('creates an empty diagram', async () => {
        const { gateway, store } = createMemoryGateway({ diagrams: [] });
        const handlers = createDiagramHandlers(gateway);

        const result = (await run(handlers, 'create_diagram', {
            name: 'Blank',
            databaseType: DatabaseType.POSTGRESQL,
        })) as { id: string; tables: number };

        expect(result.tables).toBe(0);
        expect(store.get(result.id)?.name).toBe('Blank');
        expect(store.get(result.id)?.databaseType).toBe(
            DatabaseType.POSTGRESQL
        );
    });

    it('seeds from DBML', async () => {
        const { gateway, store } = createMemoryGateway({ diagrams: [] });
        const handlers = createDiagramHandlers(gateway);

        const result = (await run(handlers, 'create_diagram', {
            name: 'Seeded',
            databaseType: DatabaseType.POSTGRESQL,
            source: {
                kind: 'dbml',
                content: 'Table users {\n  id integer [pk]\n}',
            },
        })) as { id: string; tables: number };

        expect(result.tables).toBe(1);
        expect(store.get(result.id)?.name).toBe('Seeded');
    });

    it('rejects metadata JSON with the wrong shape and creates nothing', async () => {
        const { gateway, store } = createMemoryGateway({ diagrams: [] });
        const handlers = createDiagramHandlers(gateway);

        await expect(
            run(handlers, 'create_diagram', {
                name: 'Bad',
                databaseType: DatabaseType.POSTGRESQL,
                source: { kind: 'metadata', content: '{"a":1}' },
            })
        ).rejects.toThrow(/does not match the format/);
        expect(store.size).toBe(0);
    });

    it('reports invalid seed content and creates nothing', async () => {
        const { gateway, store } = createMemoryGateway({ diagrams: [] });
        const handlers = createDiagramHandlers(gateway);

        await expect(
            run(handlers, 'create_diagram', {
                name: 'Bad',
                databaseType: DatabaseType.POSTGRESQL,
                source: { kind: 'dbml', content: 'Table broken { id integer [' },
            })
        ).rejects.toThrow(/Could not import dbml content/);
        expect(store.size).toBe(0);
    });
});

describe('rename_diagram', () => {
    it('renames the open diagram', async () => {
        const d = await diagramFromDbml();
        const { gateway, store } = createMemoryGateway({ diagrams: [d], currentId: d.id });
        await run(createDiagramHandlers(gateway), 'rename_diagram', {
            name: 'Shop',
        });
        expect(store.get(d.id)?.name).toBe('Shop');
    });
});

describe('delete_diagram', () => {
    it('refuses when confirmName does not match', async () => {
        const d = await diagramFromDbml();
        const { gateway, store } = createMemoryGateway({ diagrams: [d] });
        await expect(
            run(createDiagramHandlers(gateway), 'delete_diagram', {
                diagramId: d.id,
                confirmName: 'wrong',
            })
        ).rejects.toThrow(/confirmName must exactly equal/);
        expect(store.has(d.id)).toBe(true);
    });

    it('deletes when confirmName matches', async () => {
        const d = await diagramFromDbml();
        const { gateway, store } = createMemoryGateway({ diagrams: [d] });
        const result = await run(createDiagramHandlers(gateway), 'delete_diagram', {
            diagramId: d.id,
            confirmName: d.name,
        });
        expect(result).toEqual({ deleted: { id: d.id, name: d.name } });
        expect(store.has(d.id)).toBe(false);
    });

    it('refuses to delete the open diagram while in diff-review mode', async () => {
        const d = await diagramFromDbml();
        const { gateway, store } = createMemoryGateway({
            diagrams: [d],
            currentId: d.id,
            readonly: true,
        });
        await expect(
            run(createDiagramHandlers(gateway), 'delete_diagram', {
                diagramId: d.id,
                confirmName: d.name,
            })
        ).rejects.toThrow(/diff-review/);
        expect(store.has(d.id)).toBe(true);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp-bridge/__tests__/diagram.test.ts`
Expected: FAIL — cannot resolve `../handlers/diagram`.

- [ ] **Step 3: Implement `handlers/shared.ts`**

```ts
import type { Diagram } from '@/lib/domain/diagram';
import type { ImportMethod } from '@/lib/import-method/import-method';
import { isDatabaseMetadata } from '@/lib/data/import-metadata/metadata-types/database-metadata';
import { importContentToDiagram } from '@/lib/import-method/import-content';
import { ToolError, describeError } from '../tool-error';

export const toImportMethod = (
    kind: 'ddl' | 'dbml' | 'metadata'
): ImportMethod => (kind === 'metadata' ? 'query' : kind);

export const importOrThrow = async (
    args: Parameters<typeof importContentToDiagram>[0]
): Promise<Diagram> => {
    // The tool calls smart-query JSON 'metadata'; internally the method is 'query'.
    const label = args.method === 'query' ? 'metadata' : args.method;

    if (args.method === 'query') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(args.content);
        } catch {
            throw new ToolError(
                'Could not import metadata content — the text is not valid JSON.'
            );
        }
        if (!isDatabaseMetadata(parsed)) {
            throw new ToolError(
                "Could not import metadata content — the JSON does not match the format returned by ChartDB's per-database smart query."
            );
        }
    }

    try {
        return await importContentToDiagram(args);
    } catch (error) {
        throw new ToolError(
            `Could not import ${label} content — ${describeError(error)}`
        );
    }
};
```

The error text for DBML is `Could not import dbml content — …`; for smart-query JSON it says `metadata` (the word the tool argument uses), and the JSON shape is validated first with `isDatabaseMetadata`.

- [ ] **Step 4: Implement `handlers/diagram.ts`**

```ts
import type { Diagram } from '@/lib/domain/diagram';
import { generateDiagramId } from '@/lib/utils/utils';
import type { DiagramGateway } from '../gateway';
import { assertWritable, commit, loadTarget } from '../gateway';
import { ToolError } from '../tool-error';
import { importOrThrow, toImportMethod } from './shared';
import type { ToolHandlers } from './types';

export const createDiagramHandlers = (
    gateway: DiagramGateway
): Pick<ToolHandlers, 'create_diagram' | 'rename_diagram' | 'delete_diagram'> => ({
    create_diagram: async (args) => {
        const now = new Date();
        const imported = args.source
            ? await importOrThrow({
                  method: toImportMethod(args.source.kind),
                  content: args.source.content,
                  databaseType: args.databaseType,
              })
            : undefined;

        const diagram: Diagram = {
            tables: [],
            relationships: [],
            dependencies: [],
            areas: [],
            customTypes: [],
            notes: [],
            ...imported,
            id: generateDiagramId(),
            name: args.name,
            databaseType: args.databaseType,
            createdAt: now,
            updatedAt: now,
        };

        await gateway.create(diagram);

        return {
            id: diagram.id,
            name: diagram.name,
            databaseType: diagram.databaseType,
            tables: diagram.tables?.length ?? 0,
            openUrl: `/diagrams/${diagram.id}`,
        };
    },

    rename_diagram: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        await commit(gateway, before, { ...before, name: args.name });
        return { id: before.id, name: args.name };
    },

    delete_diagram: async (args) => {
        const diagram = await loadTarget(gateway, args.diagramId);

        if (args.confirmName !== diagram.name) {
            throw new ToolError(
                `Refusing to delete: confirmName must exactly equal the diagram's name "${diagram.name}".`
            );
        }

        assertWritable(gateway, diagram.id);
        await gateway.remove(diagram.id);

        return { deleted: { id: diagram.id, name: diagram.name } };
    },
});
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/mcp-bridge/__tests__/diagram.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Format, type-check, commit**

```bash
npx prettier --write src/mcp-bridge
npx tsc -b && npm run lint
git add src/mcp-bridge
git commit -m "feat(mcp-bridge): add diagram create, rename and guarded delete tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Table tools — `import_into_diagram`, `apply_dbml`, `remove_tables`

**Files:**
- Create: `src/mcp-bridge/handlers/tables.ts`
- Test: `src/mcp-bridge/__tests__/tables.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 3 items; `applyDBMLToDiagram`, `ApplyDBMLSummary` (Plan 1); `getImportOffsetX`, `offsetTablesX` (Plan 1).
- Produces: `createTableHandlers(gateway): Pick<ToolHandlers, 'import_into_diagram' | 'apply_dbml' | 'remove_tables'>`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { getImportOffsetX } from '@/lib/utils/import-offset';
import { createTableHandlers } from '../handlers/tables';
import {
    USERS_POSTS_DBML,
    createMemoryGateway,
    diagramFromDbml,
    run,
} from './helpers';

const setup = async (opts: { failSaves?: number } = {}) => {
    const d = await diagramFromDbml();
    const mem = createMemoryGateway({
        diagrams: [d],
        currentId: d.id,
        failSaves: opts.failSaves,
    });
    return { d, ...mem, handlers: createTableHandlers(mem.gateway) };
};

describe('import_into_diagram', () => {
    it('adds tables to the right of the existing ones', async () => {
        const { d, handlers, store } = await setup();
        const minX = getImportOffsetX(d.tables ?? []);

        const result = (await run(handlers, 'import_into_diagram', {
            kind: 'dbml',
            content: 'Table comments {\n  id integer [pk]\n}',
        })) as { tablesAdded: string[] };

        const saved = store.get(d.id);
        expect(result.tablesAdded).toHaveLength(1);
        expect(saved?.tables).toHaveLength(3);
        const added = saved?.tables?.find((t) => t.name === 'comments');
        expect(added?.x).toBeGreaterThanOrEqual(minX);
    });

    it('requires databaseType for generic diagrams, then adopts it', async () => {
        const generic = {
            ...(await diagramFromDbml('', { id: 'g', name: 'Generic' })),
            databaseType: DatabaseType.GENERIC,
        };
        const { gateway, store } = createMemoryGateway({
            diagrams: [generic],
            currentId: 'g',
        });
        const handlers = createTableHandlers(gateway);
        const args = {
            kind: 'dbml' as const,
            content: 'Table t {\n  id integer [pk]\n}',
        };

        await expect(run(handlers, 'import_into_diagram', args)).rejects.toThrow(
            /databaseType/
        );

        await run(handlers, 'import_into_diagram', {
            ...args,
            databaseType: DatabaseType.POSTGRESQL,
        });
        expect(store.get('g')?.databaseType).toBe(DatabaseType.POSTGRESQL);
        expect(store.get('g')?.tables).toHaveLength(1);
    });

    it('fails without saving when the content has no tables', async () => {
        const { handlers, saves } = await setup();
        await expect(
            run(handlers, 'import_into_diagram', { kind: 'dbml', content: '// nothing' })
        ).rejects.toThrow(/Nothing to import/);
        expect(saves).toHaveLength(0);
    });
});

describe('apply_dbml', () => {
    const ONLY_USERS = 'Table users {\n  id integer [pk]\n  email varchar(255) [not null]\n}';

    it('dryRun reports changes and saves nothing', async () => {
        const { handlers, saves } = await setup();
        const result = (await run(handlers, 'apply_dbml', {
            dbml: ONLY_USERS,
            dryRun: true,
        })) as { dryRun: boolean; wouldBlock: boolean; summary: { tablesRemoved: string[] } };

        expect(result.dryRun).toBe(true);
        expect(result.wouldBlock).toBe(true);
        expect(result.summary.tablesRemoved).toHaveLength(1);
        expect(saves).toHaveLength(0);
    });

    it('refuses to drop tables without allowDrops and saves nothing', async () => {
        const { handlers, saves } = await setup();
        await expect(
            run(handlers, 'apply_dbml', { dbml: ONLY_USERS })
        ).rejects.toThrow(/allowDrops: true/);
        expect(saves).toHaveLength(0);
    });

    it('refuses to drop an enum without allowDrops', async () => {
        const withEnum = await diagramFromDbml(
            'Enum status {\n  active\n  inactive\n}\n\nTable users {\n  id integer [pk]\n  state status\n}'
        );
        const { gateway, saves } = createMemoryGateway({
            diagrams: [withEnum],
            currentId: withEnum.id,
        });
        const handlers = createTableHandlers(gateway);

        await expect(
            run(handlers, 'apply_dbml', {
                dbml: 'Table users {\n  id integer [pk]\n  state varchar(20)\n}',
            })
        ).rejects.toThrow(/type .*status/);
        expect(saves).toHaveLength(0);
    });

    it('drops tables when allowDrops is true', async () => {
        const { d, handlers, store } = await setup();
        await run(handlers, 'apply_dbml', { dbml: ONLY_USERS, allowDrops: true });
        expect(store.get(d.id)?.tables).toHaveLength(1);
    });

    it('applies an added field and keeps table ids', async () => {
        const { d, handlers, store } = await setup();
        const dbml = USERS_POSTS_DBML.replace(
            'email varchar(255) [not null]',
            'email varchar(255) [not null]\n  bio text'
        );

        const result = (await run(handlers, 'apply_dbml', { dbml })) as {
            applied: boolean;
            summary: { tablesChanged: { fieldsAdded: string[] }[] };
        };

        expect(result.applied).toBe(true);
        expect(result.summary.tablesChanged[0].fieldsAdded).toEqual(['bio']);
        expect(store.get(d.id)?.tables?.map((t) => t.id).sort()).toEqual(
            d.tables?.map((t) => t.id).sort()
        );
    });

    it('reports invalid DBML with a clear prefix and saves nothing', async () => {
        const { handlers, saves } = await setup();
        await expect(
            run(handlers, 'apply_dbml', { dbml: 'Table broken { id integer [' })
        ).rejects.toThrow(/Invalid DBML/);
        expect(saves).toHaveLength(0);
    });

    it('restores the diagram when saving fails', async () => {
        const { d, handlers, store } = await setup({ failSaves: 1 });
        await expect(
            run(handlers, 'apply_dbml', {
                dbml: ONLY_USERS,
                allowDrops: true,
            })
        ).rejects.toThrow(/previous state was restored/);
        expect(store.get(d.id)?.tables).toHaveLength(2);
    });
});

describe('remove_tables', () => {
    it('removes tables and their relationships', async () => {
        const { d, handlers, store } = await setup();
        expect(d.relationships).toHaveLength(1);

        const result = (await run(handlers, 'remove_tables', {
            tables: ['posts'],
        })) as { removed: string[]; relationshipsRemoved: number };

        expect(result.removed).toHaveLength(1);
        expect(result.relationshipsRemoved).toBe(1);
        expect(store.get(d.id)?.tables?.map((t) => t.name)).toEqual(['users']);
        expect(store.get(d.id)?.relationships).toHaveLength(0);
    });

    it('fails on an unknown table without saving', async () => {
        const { handlers, saves } = await setup();
        await expect(
            run(handlers, 'remove_tables', { tables: ['nope'] })
        ).rejects.toThrow(/not found/);
        expect(saves).toHaveLength(0);
    });

    it('counts the same table once when named twice', async () => {
        const { handlers } = await setup();
        const result = (await run(handlers, 'remove_tables', {
            tables: ['posts', 'posts'],
        })) as { removed: string[] };
        expect(result.removed).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp-bridge/__tests__/tables.test.ts`
Expected: FAIL — cannot resolve `../handlers/tables`.

- [ ] **Step 3: Implement `handlers/tables.ts`**

```ts
import { applyDBMLToDiagram } from '@/lib/dbml/apply-dbml/apply-dbml-to-diagram';
import { DatabaseType } from '@/lib/domain/database-type';
import { getImportOffsetX, offsetTablesX } from '@/lib/utils/import-offset';
import type { DiagramGateway } from '../gateway';
import { commit, loadTarget } from '../gateway';
import { resolveTable, tableLabel } from '../resolve';
import { ToolError, describeError } from '../tool-error';
import { importOrThrow, toImportMethod } from './shared';
import type { ToolHandlers } from './types';

export const createTableHandlers = (
    gateway: DiagramGateway
): Pick<ToolHandlers, 'import_into_diagram' | 'apply_dbml' | 'remove_tables'> => ({
    import_into_diagram: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);

        const databaseType =
            before.databaseType === DatabaseType.GENERIC
                ? args.databaseType
                : before.databaseType;

        if (!databaseType || databaseType === DatabaseType.GENERIC) {
            throw new ToolError(
                "This diagram's database type is 'generic'. Pass databaseType (for example 'postgresql') so the content can be parsed."
            );
        }

        const imported = await importOrThrow({
            method: toImportMethod(args.kind),
            content: args.content,
            databaseType,
        });

        const newTables = offsetTablesX(
            imported.tables ?? [],
            getImportOffsetX(before.tables ?? [])
        );
        const newRelationships = imported.relationships ?? [];

        if (newTables.length === 0 && newRelationships.length === 0) {
            throw new ToolError(
                'Nothing to import: the content produced no tables or relationships.'
            );
        }

        await commit(gateway, before, {
            ...before,
            databaseType,
            tables: [...(before.tables ?? []), ...newTables],
            relationships: [...(before.relationships ?? []), ...newRelationships],
        });

        return {
            tablesAdded: newTables.map(tableLabel),
            relationshipsAdded: newRelationships.length,
        };
    },

    apply_dbml: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);

        let applied;
        try {
            applied = await applyDBMLToDiagram({
                diagram: before,
                dbml: args.dbml,
            });
        } catch (error) {
            throw new ToolError(`Invalid DBML — ${describeError(error)}`);
        }

        const { summary } = applied;
        const dropped = [
            ...summary.tablesRemoved,
            ...summary.customTypesRemoved.map((name) => `type ${name}`),
        ];
        const wouldDrop = dropped.length > 0;

        if (args.dryRun) {
            return {
                dryRun: true,
                wouldBlock: wouldDrop && !args.allowDrops,
                summary,
            };
        }

        if (wouldDrop && !args.allowDrops) {
            throw new ToolError(
                `This DBML would delete ${dropped.length} item(s): ${dropped.join(', ')}. ` +
                    'If that is intended, call again with allowDrops: true. ' +
                    'Note: renaming a table in DBML is applied as delete + create.'
            );
        }

        await commit(gateway, before, applied.diagram);

        return { applied: true, summary };
    },

    remove_tables: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);

        const resolved = new Map(
            args.tables.map((ref) => {
                const table = resolveTable(before, ref);
                return [table.id, table] as const;
            })
        );
        const ids = new Set(resolved.keys());

        const relationships = before.relationships ?? [];
        const keptRelationships = relationships.filter(
            (r) => !ids.has(r.sourceTableId) && !ids.has(r.targetTableId)
        );

        await commit(gateway, before, {
            ...before,
            tables: (before.tables ?? []).filter((t) => !ids.has(t.id)),
            relationships: keptRelationships,
            dependencies: (before.dependencies ?? []).filter(
                (d) => !ids.has(d.tableId) && !ids.has(d.dependentTableId)
            ),
        });

        return {
            removed: [...resolved.values()].map(tableLabel),
            relationshipsRemoved: relationships.length - keptRelationships.length,
        };
    },
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/mcp-bridge/__tests__/tables.test.ts`
Expected: PASS. If the "added field" test fails with `tablesChanged[0]` undefined or `fieldsAdded` different, that is the Plan 1 risk (round-trip fidelity) — investigate `applyDBMLToDiagram` output rather than editing this test.

- [ ] **Step 5: Format, type-check, commit**

```bash
npx prettier --write src/mcp-bridge
npx tsc -b && npm run lint
git add src/mcp-bridge
git commit -m "feat(mcp-bridge): add import, apply_dbml and remove_tables tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Canvas tools — `upsert_note`, `upsert_area`, `auto_arrange` + `createHandlers`

**Files:**
- Create: `src/mcp-bridge/handlers/canvas.ts`
- Create: `src/mcp-bridge/handlers/index.ts`
- Test: `src/mcp-bridge/__tests__/canvas.test.ts`
- Test: `src/mcp-bridge/__tests__/handlers-index.test.ts`

**Interfaces:**
- Consumes: Task 1/3/4 items; `adjustTablePositions({ tables, relationships, areas, mode })` (`src/lib/domain/db-table.ts`); `arrangeTablesForArea(tables, relationships, rect)` (`src/lib/utils/area-utils.ts`); `randomColor()` (`src/lib/colors.ts`); `generateId()` (`src/lib/utils/utils.ts`); `Note`, `Area` types.
- Produces:
  ```ts
  export const createCanvasHandlers: (gateway: DiagramGateway) =>
      Pick<ToolHandlers, 'upsert_note' | 'upsert_area' | 'auto_arrange'>;
  export const createHandlers: (gateway: DiagramGateway) => ToolHandlers; // all 13
  ```

- [ ] **Step 1: Write the failing tests `canvas.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createCanvasHandlers } from '../handlers/canvas';
import { createMemoryGateway, diagramFromDbml, run } from './helpers';

const setup = async () => {
    const d = await diagramFromDbml();
    const mem = createMemoryGateway({ diagrams: [d], currentId: d.id });
    return { d, ...mem, handlers: createCanvasHandlers(mem.gateway) };
};

describe('upsert_note', () => {
    it('creates a note with defaults', async () => {
        const { d, handlers, store } = await setup();
        const result = (await run(handlers, 'upsert_note', {
            content: 'Remember to index email',
        })) as { noteId: string; created: boolean };

        expect(result.created).toBe(true);
        const note = store.get(d.id)?.notes?.find((n) => n.id === result.noteId);
        expect(note?.content).toBe('Remember to index email');
        expect(note?.color).toBe('#ffe374');
        expect(note?.width).toBe(200);
    });

    it('requires content when creating', async () => {
        const { handlers } = await setup();
        await expect(run(handlers, 'upsert_note', {})).rejects.toThrow(
            /content is required/
        );
    });

    it('updates only the given fields', async () => {
        const { d, handlers, store } = await setup();
        const { noteId } = (await run(handlers, 'upsert_note', {
            content: 'one',
            x: 10,
            y: 20,
        })) as { noteId: string };

        await run(handlers, 'upsert_note', { noteId, color: '#ff0000' });

        const note = store.get(d.id)?.notes?.find((n) => n.id === noteId);
        expect(note).toMatchObject({ content: 'one', x: 10, y: 20, color: '#ff0000' });
    });

    it('fails for an unknown note id', async () => {
        const { handlers } = await setup();
        await expect(
            run(handlers, 'upsert_note', { noteId: 'nope', content: 'x' })
        ).rejects.toThrow(/Note 'nope' not found/);
    });
});

describe('upsert_area', () => {
    it('requires a name when creating', async () => {
        const { handlers } = await setup();
        await expect(run(handlers, 'upsert_area', {})).rejects.toThrow(
            /name is required/
        );
    });

    it('creates an area and moves the named tables into it', async () => {
        const { d, handlers, store } = await setup();
        const result = (await run(handlers, 'upsert_area', {
            name: 'Core',
            tables: ['users', 'posts'],
        })) as { areaId: string; created: boolean; tablesMoved: string[] };

        const saved = store.get(d.id);
        const area = saved?.areas?.find((a) => a.id === result.areaId);
        expect(result.created).toBe(true);
        expect(result.tablesMoved).toHaveLength(2);
        expect(area?.name).toBe('Core');
        expect(saved?.tables?.every((t) => t.parentAreaId === result.areaId)).toBe(true);
        for (const table of saved?.tables ?? []) {
            expect(table.x).toBeGreaterThanOrEqual(area?.x ?? 0);
            expect(table.y).toBeGreaterThanOrEqual(area?.y ?? 0);
        }
    });

    it('renames an existing area without touching tables', async () => {
        const { d, handlers, store } = await setup();
        const { areaId } = (await run(handlers, 'upsert_area', { name: 'A' })) as {
            areaId: string;
        };
        const before = store.get(d.id)?.tables;

        await run(handlers, 'upsert_area', { areaId, name: 'B' });

        expect(store.get(d.id)?.areas?.find((a) => a.id === areaId)?.name).toBe('B');
        expect(store.get(d.id)?.tables).toEqual(before);
    });

    it('fails for an unknown area id', async () => {
        const { handlers } = await setup();
        await expect(
            run(handlers, 'upsert_area', { areaId: 'nope', name: 'x' })
        ).rejects.toThrow(/Area 'nope' not found/);
    });

    it('fails for an unknown table without saving', async () => {
        const { handlers, saves } = await setup();
        await expect(
            run(handlers, 'upsert_area', { name: 'X', tables: ['ghost'] })
        ).rejects.toThrow(/not found/);
        expect(saves).toHaveLength(0);
    });
});

describe('auto_arrange', () => {
    it('separates tables that were stacked on top of each other', async () => {
        const { d, handlers, store, gateway } = await setup();
        const stacked = {
            ...d,
            tables: (d.tables ?? []).map((t) => ({ ...t, x: 0, y: 0 })),
        };
        await gateway.save(stacked);

        const result = (await run(handlers, 'auto_arrange', {})) as {
            tablesArranged: number;
        };

        const positions = new Set(
            store.get(d.id)?.tables?.map((t) => `${t.x},${t.y}`)
        );
        expect(result.tablesArranged).toBe(2);
        expect(positions.size).toBe(2);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp-bridge/__tests__/canvas.test.ts`
Expected: FAIL — cannot resolve `../handlers/canvas`.

- [ ] **Step 3: Implement `handlers/canvas.ts`**

```ts
import { randomColor } from '@/lib/colors';
import type { Area } from '@/lib/domain/area';
import { adjustTablePositions } from '@/lib/domain/db-table';
import type { Note } from '@/lib/domain/note';
import { arrangeTablesForArea } from '@/lib/utils/area-utils';
import { getImportOffsetX } from '@/lib/utils/import-offset';
import { generateId } from '@/lib/utils/utils';
import type { DiagramGateway } from '../gateway';
import { commit, loadTarget } from '../gateway';
import { resolveTable, tableLabel } from '../resolve';
import { ToolError } from '../tool-error';
import type { ToolHandlers } from './types';

export const createCanvasHandlers = (
    gateway: DiagramGateway
): Pick<ToolHandlers, 'upsert_note' | 'upsert_area' | 'auto_arrange'> => ({
    upsert_note: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        const notes = before.notes ?? [];

        let note: Note;
        const created = !args.noteId;

        if (args.noteId) {
            const existing = notes.find((n) => n.id === args.noteId);
            if (!existing) {
                throw new ToolError(
                    `Note '${args.noteId}' not found. Existing note ids: ${notes.map((n) => n.id).join(', ') || '(none)'}.`
                );
            }
            note = {
                ...existing,
                ...(args.content !== undefined && { content: args.content }),
                ...(args.color !== undefined && { color: args.color }),
                ...(args.x !== undefined && { x: args.x }),
                ...(args.y !== undefined && { y: args.y }),
            };
        } else {
            if (args.content === undefined) {
                throw new ToolError('content is required when creating a note.');
            }
            note = {
                id: generateId(),
                content: args.content,
                x: args.x ?? getImportOffsetX(before.tables ?? []),
                y: args.y ?? 0,
                width: 200,
                height: 150,
                color: args.color ?? '#ffe374',
            };
        }

        const noteId = note.id;
        await commit(gateway, before, {
            ...before,
            notes: created
                ? [...notes, note]
                : notes.map((n) => (n.id === noteId ? note : n)),
        });

        return { noteId, created };
    },

    upsert_area: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        const areas = before.areas ?? [];
        const created = !args.areaId;

        let area: Area;
        if (args.areaId) {
            const existing = areas.find((a) => a.id === args.areaId);
            if (!existing) {
                throw new ToolError(
                    `Area '${args.areaId}' not found. Existing area ids: ${areas.map((a) => a.id).join(', ') || '(none)'}.`
                );
            }
            area = {
                ...existing,
                ...(args.name !== undefined && { name: args.name }),
                ...(args.color !== undefined && { color: args.color }),
            };
        } else {
            if (!args.name) {
                throw new ToolError('name is required when creating an area.');
            }
            area = {
                id: generateId(),
                name: args.name,
                x: getImportOffsetX(before.tables ?? []),
                y: 0,
                width: 300,
                height: 200,
                color: args.color ?? randomColor(),
            };
        }

        const moving = (args.tables ?? []).map((ref) => resolveTable(before, ref));
        let tables = before.tables ?? [];

        if (moving.length > 0) {
            const areaId = area.id;
            const movingIds = new Set(moving.map((t) => t.id));
            const toArrange = [
                ...tables.filter(
                    (t) => t.parentAreaId === areaId && !movingIds.has(t.id)
                ),
                ...tables.filter((t) => movingIds.has(t.id)),
            ];

            const { positions, requiredWidth, requiredHeight } =
                arrangeTablesForArea(toArrange, before.relationships ?? [], {
                    x: area.x,
                    y: area.y,
                    width: area.width,
                    height: area.height,
                });

            area = {
                ...area,
                width: Math.max(area.width, requiredWidth),
                height: Math.max(area.height, requiredHeight),
            };

            tables = tables.map((t) => {
                const position = positions.find((p) => p.id === t.id);
                return position
                    ? { ...t, parentAreaId: areaId, x: position.x, y: position.y }
                    : t;
            });
        }

        const areaId = area.id;
        await commit(gateway, before, {
            ...before,
            tables,
            areas: created
                ? [...areas, area]
                : areas.map((a) => (a.id === areaId ? area : a)),
        });

        return { areaId, created, tablesMoved: moving.map(tableLabel) };
    },

    auto_arrange: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        const tables = before.tables ?? [];

        const arranged = adjustTablePositions({
            tables,
            relationships: before.relationships ?? [],
            areas: before.areas ?? [],
            mode: 'all',
        });

        await commit(gateway, before, {
            ...before,
            tables: tables.map((table) => {
                const next = arranged.find((t) => t.id === table.id);
                return next ? { ...table, x: next.x, y: next.y } : table;
            }),
        });

        return { tablesArranged: tables.length };
    },
});
```

Note: `const areaId` is declared twice in different block scopes (inside `if (moving.length > 0)` and after it) — that is legal; if lint complains about shadowing, rename the inner one to `targetAreaId`.

- [ ] **Step 4: Write `handlers/index.ts` and its test**

`handlers/index.ts`:

```ts
import type { DiagramGateway } from '../gateway';
import { createCanvasHandlers } from './canvas';
import { createDiagramHandlers } from './diagram';
import { createReadHandlers } from './read';
import { createTableHandlers } from './tables';
import type { ToolHandlers } from './types';

export type { ToolHandlers } from './types';

export const createHandlers = (gateway: DiagramGateway): ToolHandlers => ({
    ...createReadHandlers(gateway),
    ...createDiagramHandlers(gateway),
    ...createTableHandlers(gateway),
    ...createCanvasHandlers(gateway),
});
```

`__tests__/handlers-index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHandlers } from '../handlers';
import { toolNames } from '../protocol';
import { createMemoryGateway } from './helpers';

describe('createHandlers', () => {
    it('has a handler for every protocol tool and nothing else', () => {
        const { gateway } = createMemoryGateway({ diagrams: [] });
        expect(Object.keys(createHandlers(gateway)).sort()).toEqual(
            [...toolNames].sort()
        );
    });
});
```

- [ ] **Step 5: Run the whole bridge suite**

Run: `npx vitest run src/mcp-bridge`
Expected: PASS. If the `auto_arrange` test shows 1 distinct position, `adjustTablePositions` kept the stacked positions — read `src/lib/domain/db-table.ts:66-190` to see whether it requires `width`/`fields`, and fix the fixture (never the assertion).

- [ ] **Step 6: Format, type-check, commit**

```bash
npx prettier --write src/mcp-bridge
npx tsc -b && npm run lint
git add src/mcp-bridge
git commit -m "feat(mcp-bridge): add note, area and auto-arrange tools

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Live gateway, bridge client, React hook, mount

**Files:**
- Create: `src/mcp-bridge/bridge-config.ts`
- Create: `src/mcp-bridge/live-gateway.ts`
- Create: `src/mcp-bridge/bridge-client.ts`
- Create: `src/mcp-bridge/use-mcp-bridge.ts`
- Modify: `src/pages/editor-page/editor-page.tsx` (add import + one call inside `EditorPageComponent`)
- Test: `src/mcp-bridge/__tests__/live-gateway.test.ts`
- Test: `src/mcp-bridge/__tests__/bridge-client.test.ts`
- Test: `src/mcp-bridge/__tests__/bridge-config.test.ts`

**Interfaces:**
- Consumes: `ToolHandlers`, `createHandlers` (Task 5); `serverMessageSchema`, `toolInputShapes`, `ToolName` (Task 1); `ChartDBContext['updateDiagramData']`, `ChartDBContext['deleteDiagram']`, `StorageContext` subset.
- Produces:
  ```ts
  // live-gateway.ts
  export interface LiveGatewayDeps {
      getCurrent: () => { diagram: Diagram; readonly: boolean };
      storage: Pick<StorageContext, 'listDiagrams' | 'getDiagram' | 'addDiagram' | 'deleteDiagram'>;
      updateDiagramData: ChartDBContext['updateDiagramData'];
      deleteCurrentDiagram: ChartDBContext['deleteDiagram'];
      onCurrentDeleted: () => void;
  }
  export const createLiveGateway: (deps: LiveGatewayDeps) => DiagramGateway;
  // bridge-client.ts
  export const connectBridge: (options: {
      url: string; token: string; handlers: ToolHandlers;
      WebSocketImpl?: typeof WebSocket; reconnectDelaysMs?: number[];
  }) => () => void;   // returns a disconnect function
  // use-mcp-bridge.ts
  export const useMcpBridge: () => void;
  ```

- [ ] **Step 1: Write the failing live-gateway tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Diagram } from '@/lib/domain/diagram';
import { createLiveGateway } from '../live-gateway';
import type { LiveGatewayDeps } from '../live-gateway';
import { diagramFromDbml } from './helpers';

const makeDeps = async (overrides: Partial<LiveGatewayDeps> = {}) => {
    const current = await diagramFromDbml(undefined, { id: 'open' });
    const other = await diagramFromDbml(undefined, { id: 'other' });
    const state = { diagram: current, readonly: false };
    const deps: LiveGatewayDeps = {
        getCurrent: () => state,
        storage: {
            listDiagrams: vi.fn(async () => [current, other]),
            getDiagram: vi.fn(async (id: string) => (id === 'other' ? other : undefined)),
            addDiagram: vi.fn(async () => {}),
            deleteDiagram: vi.fn(async () => {}),
        },
        updateDiagramData: vi.fn(async () => {}),
        deleteCurrentDiagram: vi.fn(async () => {}),
        onCurrentDeleted: vi.fn(),
        ...overrides,
    };
    return { deps, state, current, other, gateway: createLiveGateway(deps) };
};

describe('live gateway', () => {
    it('reports the open diagram id and read-only state', async () => {
        const { gateway, state } = await makeDeps();
        expect(gateway.currentDiagramId()).toBe('open');
        expect(gateway.isReadonly()).toBe(false);
        state.readonly = true;
        expect(gateway.isReadonly()).toBe(true);
    });

    it('treats an empty current id as "nothing open"', async () => {
        const { gateway, state, current } = await makeDeps();
        state.diagram = { ...current, id: '' };
        expect(gateway.currentDiagramId()).toBeUndefined();
    });

    it('loads the open diagram from live state and others from storage', async () => {
        const { gateway, current, other, deps } = await makeDeps();
        expect(await gateway.load('open')).toBe(current);
        expect(await gateway.load('other')).toBe(other);
        expect(deps.storage.getDiagram).toHaveBeenCalledTimes(1);
    });

    it('saves the open diagram through updateDiagramData with forceUpdateStorage', async () => {
        const { gateway, current, deps } = await makeDeps();
        const next: Diagram = { ...current, name: 'new' };
        await gateway.save(next);
        expect(deps.updateDiagramData).toHaveBeenCalledWith(next, {
            forceUpdateStorage: true,
        });
        expect(deps.storage.addDiagram).not.toHaveBeenCalled();
    });

    it('saves another diagram by replacing it in storage', async () => {
        const { gateway, other, deps } = await makeDeps();
        await gateway.save({ ...other, name: 'new' });
        expect(deps.storage.deleteDiagram).toHaveBeenCalledWith('other');
        expect(deps.storage.addDiagram).toHaveBeenCalledWith({
            diagram: expect.objectContaining({ id: 'other', name: 'new' }),
        });
        expect(deps.updateDiagramData).not.toHaveBeenCalled();
    });

    it('serves the just-saved diagram until React state catches up', async () => {
        const { gateway, current, state } = await makeDeps();
        const saved: Diagram = {
            ...current,
            name: 'saved',
            updatedAt: new Date(current.updatedAt.getTime() + 1000),
        };
        await gateway.save(saved);

        // React has not re-rendered yet: live state is still the old diagram.
        expect((await gateway.load('open'))?.name).toBe('saved');

        // Once state reflects the save (or a newer edit), live state wins again.
        state.diagram = { ...saved, name: 'edited in UI', updatedAt: new Date(saved.updatedAt.getTime() + 1000) };
        expect((await gateway.load('open'))?.name).toBe('edited in UI');
    });

    it('deletes the open diagram via the context and then navigates away', async () => {
        const { gateway, deps } = await makeDeps();
        await gateway.remove('open');
        expect(deps.deleteCurrentDiagram).toHaveBeenCalled();
        expect(deps.onCurrentDeleted).toHaveBeenCalled();
        expect(deps.storage.deleteDiagram).not.toHaveBeenCalled();
    });

    it('deletes another diagram from storage', async () => {
        const { gateway, deps } = await makeDeps();
        await gateway.remove('other');
        expect(deps.storage.deleteDiagram).toHaveBeenCalledWith('other');
        expect(deps.deleteCurrentDiagram).not.toHaveBeenCalled();
    });

    it('creates diagrams in storage', async () => {
        const { gateway, other, deps } = await makeDeps();
        await gateway.create(other);
        expect(deps.storage.addDiagram).toHaveBeenCalledWith({ diagram: other });
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/mcp-bridge/__tests__/live-gateway.test.ts`
Expected: FAIL — cannot resolve `../live-gateway`.

- [ ] **Step 3: Implement `live-gateway.ts`**

```ts
import type { ChartDBContext } from '@/context/chartdb-context/chartdb-context';
import type { StorageContext } from '@/context/storage-context/storage-context';
import type { Diagram } from '@/lib/domain/diagram';
import type { DiagramGateway } from './gateway';

export interface LiveGatewayDeps {
    getCurrent: () => { diagram: Diagram; readonly: boolean };
    storage: Pick<
        StorageContext,
        'listDiagrams' | 'getDiagram' | 'addDiagram' | 'deleteDiagram'
    >;
    updateDiagramData: ChartDBContext['updateDiagramData'];
    deleteCurrentDiagram: ChartDBContext['deleteDiagram'];
    onCurrentDeleted: () => void;
}

const FULL_DIAGRAM = {
    includeTables: true,
    includeRelationships: true,
    includeDependencies: true,
    includeAreas: true,
    includeCustomTypes: true,
    includeNotes: true,
} as const;

export const createLiveGateway = (deps: LiveGatewayDeps): DiagramGateway => {
    const currentId = (): string | undefined =>
        deps.getCurrent().diagram.id || undefined;

    // React state updates after our save are asynchronous. If the next tool call
    // arrives before the re-render, serve what we just saved instead of stale
    // state. A newer edit made in the UI (later updatedAt) takes over again.
    let lastSaved: Diagram | undefined;

    return {
        currentDiagramId: currentId,
        isReadonly: () => deps.getCurrent().readonly,
        list: () => deps.storage.listDiagrams(),

        load: async (id) => {
            if (id !== currentId()) {
                return deps.storage.getDiagram(id, FULL_DIAGRAM);
            }

            const { diagram } = deps.getCurrent();
            if (
                lastSaved?.id === id &&
                new Date(diagram.updatedAt).getTime() <
                    new Date(lastSaved.updatedAt).getTime()
            ) {
                return lastSaved;
            }
            return diagram;
        },

        save: async (diagram) => {
            if (diagram.id === currentId()) {
                await deps.updateDiagramData(diagram, {
                    forceUpdateStorage: true,
                });
                lastSaved = diagram;
                return;
            }

            await deps.storage.deleteDiagram(diagram.id);
            await deps.storage.addDiagram({ diagram });
        },

        create: (diagram) => deps.storage.addDiagram({ diagram }),

        remove: async (id) => {
            if (id === currentId()) {
                await deps.deleteCurrentDiagram();
                lastSaved = undefined;
                deps.onCurrentDeleted();
                return;
            }

            await deps.storage.deleteDiagram(id);
        },
    };
};
```

- [ ] **Step 4: Run to verify the live-gateway tests pass**

Run: `npx vitest run src/mcp-bridge/__tests__/live-gateway.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing bridge-client tests**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBridge } from '../bridge-client';
import type { ToolHandlers } from '../handlers/types';
import { ToolError } from '../tool-error';

class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason?: string }) => void;
    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    send(data: string) {
        this.sent.push(data);
    }
    close(code = 1000) {
        this.onclose?.({ code });
    }
    receive(message: object) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
    sentMessages() {
        return this.sent.map((s) => JSON.parse(s));
    }
}

const WS = FakeSocket as unknown as typeof WebSocket;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    FakeSocket.instances = [];
});
afterEach(() => {
    vi.useRealTimers();
});

const connect = (handlers: Partial<ToolHandlers>, extra = {}) =>
    connectBridge({
        url: 'ws://127.0.0.1:8765',
        token: 'secret-token',
        handlers: handlers as ToolHandlers,
        WebSocketImpl: WS,
        ...extra,
    });

describe('bridge client', () => {
    it('sends hello with the token when the socket opens', () => {
        connect({});
        const socket = FakeSocket.instances[0];
        socket.onopen?.();
        expect(socket.sentMessages()).toEqual([
            { type: 'hello', token: 'secret-token' },
        ]);
    });

    it('runs a call and replies with the result', async () => {
        const list_diagrams = vi.fn(async () => [{ id: 'a' }]);
        connect({ list_diagrams });
        const socket = FakeSocket.instances[0];

        socket.receive({ type: 'call', id: '1', tool: 'list_diagrams', args: {} });
        await flush();

        expect(list_diagrams).toHaveBeenCalled();
        expect(socket.sentMessages()).toEqual([
            { type: 'result', id: '1', ok: true, data: [{ id: 'a' }] },
        ]);
    });

    it('validates arguments and applies defaults before calling', async () => {
        const apply_dbml = vi.fn(async () => ({ applied: true }));
        connect({ apply_dbml });
        const socket = FakeSocket.instances[0];

        socket.receive({ type: 'call', id: '1', tool: 'apply_dbml', args: { dbml: 'x' } });
        await flush();
        expect(apply_dbml).toHaveBeenCalledWith({
            dbml: 'x',
            dryRun: false,
            allowDrops: false,
        });

        socket.receive({ type: 'call', id: '2', tool: 'apply_dbml', args: {} });
        await flush();
        const reply = socket.sentMessages().find((m) => m.id === '2');
        expect(reply.ok).toBe(false);
        expect(reply.error).toMatch(/Invalid arguments: dbml/);
    });

    it('reports unknown tools', async () => {
        connect({});
        const socket = FakeSocket.instances[0];
        socket.receive({ type: 'call', id: '1', tool: 'drop_everything', args: {} });
        socket.receive({ type: 'call', id: '2', tool: 'constructor', args: {} });
        await flush();
        await flush();
        expect(socket.sentMessages()[0]).toMatchObject({
            ok: false,
            error: "Unknown tool 'drop_everything'",
        });
        expect(socket.sentMessages()[1]).toMatchObject({
            ok: false,
            error: "Unknown tool 'constructor'",
        });
    });

    it('passes ToolError messages through and hides stack traces of other errors', async () => {
        const rename_diagram = vi
            .fn()
            .mockRejectedValueOnce(new ToolError('Diagram not found'))
            .mockRejectedValueOnce(new Error('boom'));
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        connect({ rename_diagram });
        const socket = FakeSocket.instances[0];

        socket.receive({ type: 'call', id: '1', tool: 'rename_diagram', args: { name: 'x' } });
        socket.receive({ type: 'call', id: '2', tool: 'rename_diagram', args: { name: 'x' } });
        await flush();
        await flush();

        const [first, second] = socket.sentMessages();
        expect(first.error).toBe('Diagram not found');
        expect(second.error).toBe('Unexpected error: boom');
        spy.mockRestore();
    });

    it('runs calls one at a time, in order', async () => {
        const order: string[] = [];
        const list_diagrams = vi.fn(async () => {
            order.push('start');
            await new Promise((r) => setTimeout(r, 10));
            order.push('end');
            return [];
        });
        connect({ list_diagrams });
        const socket = FakeSocket.instances[0];

        socket.receive({ type: 'call', id: '1', tool: 'list_diagrams', args: {} });
        socket.receive({ type: 'call', id: '2', tool: 'list_diagrams', args: {} });
        await new Promise((r) => setTimeout(r, 50));

        expect(order).toEqual(['start', 'end', 'start', 'end']);
        expect(socket.sentMessages().map((m) => m.id)).toEqual(['1', '2']);
    });

    it('ignores malformed messages', async () => {
        connect({});
        const socket = FakeSocket.instances[0];
        socket.onmessage?.({ data: 'not json' });
        socket.receive({ type: 'nonsense' });
        await flush();
        expect(socket.sent).toEqual([]);
    });

    it('reconnects with backoff after the socket closes, and stops on disconnect', () => {
        vi.useFakeTimers();
        const disconnect = connect({}, { reconnectDelaysMs: [100, 200] });
        expect(FakeSocket.instances).toHaveLength(1);

        FakeSocket.instances[0].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(99);
        expect(FakeSocket.instances).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(2);

        FakeSocket.instances[1].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(200);
        expect(FakeSocket.instances).toHaveLength(3);

        disconnect();
        vi.advanceTimersByTime(10_000);
        expect(FakeSocket.instances).toHaveLength(3);
    });

    it('does not reconnect after being replaced (4001) or rejected (1008)', () => {
        vi.useFakeTimers();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        connect({}, { reconnectDelaysMs: [100] });

        FakeSocket.instances[0].onclose?.({ code: 4001, reason: 'replaced by a newer tab' });
        vi.advanceTimersByTime(10_000);
        expect(FakeSocket.instances).toHaveLength(1);

        connect({}, { reconnectDelaysMs: [100] });
        FakeSocket.instances[1].onclose?.({ code: 1008, reason: 'authentication failed' });
        vi.advanceTimersByTime(10_000);
        expect(FakeSocket.instances).toHaveLength(2);
        spy.mockRestore();
    });

    it('resets the backoff after a ready message', () => {
        vi.useFakeTimers();
        connect({}, { reconnectDelaysMs: [100, 5000] });

        FakeSocket.instances[0].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(100);
        FakeSocket.instances[1].receive({ type: 'ready' });
        FakeSocket.instances[1].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(100);

        expect(FakeSocket.instances).toHaveLength(3);
    });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/mcp-bridge/__tests__/bridge-client.test.ts`
Expected: FAIL — cannot resolve `../bridge-client`.

- [ ] **Step 7: Implement `bridge-client.ts`**

```ts
import { z } from 'zod';
import type { ToolHandlers } from './handlers/types';
import { serverMessageSchema, toolInputShapes } from './protocol';
import type { ToolName } from './protocol';
import { ToolError } from './tool-error';

const SOCKET_OPEN = 1;
const TAB_REPLACED = 4001;
const POLICY_VIOLATION = 1008;

export interface BridgeClientOptions {
    url: string;
    token: string;
    handlers: ToolHandlers;
    WebSocketImpl?: typeof WebSocket;
    reconnectDelaysMs?: number[];
}

/** Connects to the MCP bridge server and serves tool calls. Returns a disconnect function. */
export const connectBridge = ({
    url,
    token,
    handlers,
    WebSocketImpl = WebSocket,
    reconnectDelaysMs = [1000, 2000, 5000, 10000],
}: BridgeClientOptions): (() => void) => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    // Calls run strictly one at a time so read-modify-write cycles never overlap.
    let queue: Promise<void> = Promise.resolve();

    const runCall = async (
        connection: WebSocket,
        id: string,
        tool: string,
        args: unknown
    ) => {
        const reply = (payload: { ok: boolean; data?: unknown; error?: string }) => {
            if (connection.readyState === SOCKET_OPEN) {
                connection.send(JSON.stringify({ type: 'result', id, ...payload }));
            }
        };

        if (!Object.hasOwn(toolInputShapes, tool)) {
            reply({ ok: false, error: `Unknown tool '${tool}'` });
            return;
        }

        const name = tool as ToolName;
        const parsed = z.object(toolInputShapes[name]).safeParse(args ?? {});
        if (!parsed.success) {
            const issues = parsed.error.issues
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; ');
            reply({ ok: false, error: `Invalid arguments: ${issues}` });
            return;
        }

        try {
            const handler = handlers[name] as (a: unknown) => Promise<unknown>;
            reply({ ok: true, data: await handler(parsed.data) });
        } catch (error) {
            if (error instanceof ToolError) {
                reply({ ok: false, error: error.message });
                return;
            }
            console.error('[mcp-bridge] unexpected error', error);
            reply({
                ok: false,
                error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    };

    const open = () => {
        const connection = new WebSocketImpl(url);
        socket = connection;

        connection.onopen = () => {
            connection.send(JSON.stringify({ type: 'hello', token }));
        };

        connection.onmessage = (event) => {
            let message: z.infer<typeof serverMessageSchema>;
            try {
                const parsed = serverMessageSchema.safeParse(
                    JSON.parse(String(event.data))
                );
                if (!parsed.success) return;
                message = parsed.data;
            } catch {
                return;
            }

            if (message.type === 'ready') {
                attempt = 0;
                return;
            }

            const call = message;
            queue = queue.then(() =>
                runCall(connection, call.id, call.tool, call.args)
            );
        };

        connection.onclose = (event) => {
            if (stopped) return;
            // 4001: the server replaced this tab with a newer one. 1008: the
            // server rejected us (bad token / origin). Reconnecting would either
            // fight the other tab forever or hammer the server with bad credentials.
            if (event.code === TAB_REPLACED || event.code === POLICY_VIOLATION) {
                console.error(
                    `[mcp-bridge] disconnected (${event.code}${event.reason ? `: ${event.reason}` : ''}); not reconnecting. Reload the tab to reconnect.`
                );
                return;
            }
            const delay =
                reconnectDelaysMs[Math.min(attempt, reconnectDelaysMs.length - 1)];
            attempt += 1;
            timer = setTimeout(open, delay);
        };
    };

    open();

    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        socket?.close();
    };
};
```

- [ ] **Step 8: Run to verify the bridge-client tests pass**

Run: `npx vitest run src/mcp-bridge/__tests__/bridge-client.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8a: Test the loopback check**

Create `src/mcp-bridge/__tests__/bridge-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isLoopbackUrl } from '../bridge-config';

describe('isLoopbackUrl', () => {
    it('accepts loopback hosts', () => {
        expect(isLoopbackUrl('ws://127.0.0.1:8765')).toBe(true);
        expect(isLoopbackUrl('ws://localhost:8765')).toBe(true);
        expect(isLoopbackUrl('ws://[::1]:8765')).toBe(true);
    });

    it('rejects everything else', () => {
        expect(isLoopbackUrl('ws://example.com:8765')).toBe(false);
        expect(isLoopbackUrl('ws://127.0.0.1.evil.test:8765')).toBe(false);
        expect(isLoopbackUrl('not a url')).toBe(false);
    });
});
```

(It will fail until Step 9 creates `bridge-config.ts`; run it after Step 9.)

- [ ] **Step 9: Write `bridge-config.ts` and `use-mcp-bridge.ts`**

`bridge-config.ts`:

```ts
// The bridge is off unless VITE_MCP_BRIDGE_URL is set at build/dev time.
// The token ends up in the JS bundle: use for local development only.
// Only loopback hosts are accepted, so the token can never be sent elsewhere.
export const isLoopbackUrl = (url: string): boolean => {
    try {
        const { hostname } = new URL(url);
        return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
    } catch {
        return false;
    }
};

const rawUrl: string | undefined =
    import.meta.env.VITE_MCP_BRIDGE_URL || undefined;

if (rawUrl && !isLoopbackUrl(rawUrl)) {
    console.error(
        `[mcp-bridge] ignoring VITE_MCP_BRIDGE_URL: only loopback hosts are allowed (got ${rawUrl}).`
    );
}

export const MCP_BRIDGE_URL: string | undefined =
    rawUrl && isLoopbackUrl(rawUrl) ? rawUrl : undefined;
export const MCP_BRIDGE_TOKEN: string =
    import.meta.env.VITE_MCP_BRIDGE_TOKEN ?? '';
```

`use-mcp-bridge.ts`:

```ts
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChartDB } from '@/hooks/use-chartdb';
import { useStorage } from '@/hooks/use-storage';
import { connectBridge } from './bridge-client';
import { MCP_BRIDGE_TOKEN, MCP_BRIDGE_URL } from './bridge-config';
import { createHandlers } from './handlers';
import { createLiveGateway } from './live-gateway';

/** Connects this tab to the local MCP bridge server (dev only; see bridge-config). */
export const useMcpBridge = (): void => {
    const chartdb = useChartDB();
    const storage = useStorage();
    const navigate = useNavigate();

    // Context values change identity on every render; the connection must not.
    const latest = useRef({ chartdb, storage, navigate });
    latest.current = { chartdb, storage, navigate };

    useEffect(() => {
        if (!MCP_BRIDGE_URL) {
            return;
        }

        const gateway = createLiveGateway({
            getCurrent: () => ({
                diagram: latest.current.chartdb.currentDiagram,
                readonly: !!latest.current.chartdb.readonly,
            }),
            storage: {
                listDiagrams: (options) =>
                    latest.current.storage.listDiagrams(options),
                getDiagram: (id, options) =>
                    latest.current.storage.getDiagram(id, options),
                addDiagram: (params) => latest.current.storage.addDiagram(params),
                deleteDiagram: (id) => latest.current.storage.deleteDiagram(id),
            },
            updateDiagramData: (diagram, options) =>
                latest.current.chartdb.updateDiagramData(diagram, options),
            deleteCurrentDiagram: () => latest.current.chartdb.deleteDiagram(),
            // Leave the route only after the reply has been sent: navigating
            // remounts the page, whose cleanup closes the socket.
            onCurrentDeleted: () => {
                setTimeout(() => latest.current.navigate('/'), 250);
            },
        });

        return connectBridge({
            url: MCP_BRIDGE_URL,
            token: MCP_BRIDGE_TOKEN,
            handlers: createHandlers(gateway),
        });
    }, []);
};
```

- [ ] **Step 10: Mount the hook (the only upstream edit)**

In `src/pages/editor-page/editor-page.tsx`:

1. Add near the other imports: `import { useMcpBridge } from '@/mcp-bridge/use-mcp-bridge';`
2. Inside `EditorPageComponent`, directly after `const { initialDiagram } = useDiagramLoader();` add: `useMcpBridge();`

- [ ] **Step 10b: Run the config test**

Run: `npx vitest run src/mcp-bridge/__tests__/bridge-config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 11: Full verification**

```bash
npx prettier --write src/mcp-bridge src/pages/editor-page/editor-page.tsx
npm run build          # lint + tsc -b + vite build
npm run test:ci 2>&1 | tail -15
```

Expected: build succeeds, all tests pass. Then confirm the feature is inert by default:

```bash
npm run dev     # open the app; DevTools Network > WS shows NO websocket connection
```

- [ ] **Step 12: Commit**

```bash
git add src/mcp-bridge src/pages/editor-page/editor-page.tsx
git commit -m "feat(mcp-bridge): add live gateway, WebSocket client and useMcpBridge hook

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
