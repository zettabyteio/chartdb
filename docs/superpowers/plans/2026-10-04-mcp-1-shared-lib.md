# MCP Plan 1 — Shared library extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move three pieces of logic that currently live inside React components (DBML merge, import-content parsing, import placement offset) into `src/lib`, so the UI and the upcoming MCP bridge share one code path. No user-visible behavior change.

**Architecture:** Add three small pure modules under `src/lib`, cover them with Vitest, then make the two existing UI files call them. Existing helpers (`importDBMLToDiagram`, `applyDBMLChanges`, `sqlImportToDiagram`, `loadFromDatabaseMetadata`) are reused, not rewritten.

**Tech Stack:** TypeScript (strict), Vitest + happy-dom, `fast-deep-equal` (already a dependency), existing ChartDB libs.

**Spec:** `docs/superpowers/specs/2026-10-04-mcp-server-design.md`

## Global Constraints

- Node 24 (`.nvmrc` = `v24`). On the owner's machine Node is NOT on PATH (checked 2026-10-04: no `node`/`npm`, empty `~/.local/share/fnm`, no `node_modules`) — Task 1 Step 1 installs it.
- Work on a feature branch `feat/mcp-server`, never on `main`.
- Prettier: 4 spaces, single quotes, `es5` trailing commas. Lint runs with `--max-warnings 0`.
- `@typescript-eslint/consistent-type-imports` is an error: use `import type` for type-only imports.
- TS `noUnusedLocals` / `noUnusedParameters` are on: remove imports that become unused.
- Use the `@/` alias (maps to `src/`) in app code.
- Tests live in `__tests__/` next to the code; Vitest globals are enabled but this repo's tests import `describe/it/expect` from `vitest` explicitly — do the same.
- Conventional commits (`feat:`, `refactor:`, `test:`). End every commit message with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not edit `CHANGELOG.md` or `package.json` version.
- Only these existing files may be modified by this plan: `src/pages/editor-page/side-panel/dbml-section/table-dbml/table-dbml.tsx`, `src/dialogs/import-database-dialog/import-database-dialog.tsx`.

## Known limitations (carry into Plan 2 docs)

- `generateDBMLFromDiagram` skips tables with no fields, duplicate tables and fields with an empty name (`dbml-export.ts` ~L1365–1395). A `get_diagram` → `apply_dbml` round trip therefore reports such tables as removed (blocked by the drop guard) and empty-named fields as removed.
- `src/dialogs/create-diagram-dialog/create-diagram-dialog.tsx` keeps its own copy of the import switch (it also names diagrams `Diagram N` and filters metadata by selected tables); it is intentionally NOT refactored here (two-file rule).
- The summary does not cover index, comment or check-constraint changes.

## Review Focus

- DBML with a syntax error → `applyDBMLToDiagram` rejects (it must not return a half-merged diagram); the UI still shows the error line (existing `parseDBMLError` path must keep working).
- DBML export → apply round trip with no edits → no tables added/removed, ids preserved, positions preserved.
- A renamed table is reported as removed + added (documented behavior), not silently as a change.
- Importing into an empty diagram → offset 0; into a diagram whose tables have no `width` → default width 250 is used (matches current dialog behavior).
- Diagram not built from DBML (e.g. from DDL): a no-op apply must report `tablesChanged: []` (no false changes from `undefined` optional keys).
- Dropped enums/custom types are reported (they are not covered by the table drop guard otherwise).
- Empty import content → helper returns a diagram with zero tables (dialog already skips it).

---

### Task 1: `applyDBMLToDiagram` (+ environment setup)

**Files:**
- Create: `src/lib/dbml/apply-dbml/apply-dbml-to-diagram.ts`
- Test: `src/lib/dbml/apply-dbml/__tests__/apply-dbml-to-diagram.test.ts`

**Interfaces:**
- Consumes: `importDBMLToDiagram(dbmlContent: string, options: { databaseType: DatabaseType }): Promise<Diagram>` (`src/lib/dbml/dbml-import/dbml-import.ts`), `applyDBMLChanges({ sourceDiagram, targetDiagram }): Diagram` (`./apply-dbml.ts`).
- Produces (used by Task 4 and by MCP Plan 2):
  ```ts
  export interface ApplyDBMLSummary {
      tablesAdded: string[];      // 'schema.table' or 'table'
      tablesRemoved: string[];
      tablesChanged: {
          table: string;
          fieldsAdded: string[];
          fieldsRemoved: string[];
          fieldsChanged: string[];
      }[];
      relationshipsAdded: number;
      relationshipsRemoved: number;
      customTypesAdded: string[];   // enums / composite types, by name
      customTypesRemoved: string[];
  }
  export const applyDBMLToDiagram: (args: {
      diagram: Diagram;
      dbml: string;
      databaseType?: DatabaseType; // defaults to diagram.databaseType
  }) => Promise<{ diagram: Diagram; summary: ApplyDBMLSummary }>;
  ```

- [ ] **Step 1: Install Node and dependencies, record the baseline**

On the owner's machine (fish shell):

```bash
cd /home/tk421/Development/chartdb
git switch -c feat/mcp-server
fnm install            # reads .nvmrc (v24)
fnm use                # or open a new shell with fnm env enabled
node --version         # expect v24.x
npm ci
npm run test:ci 2>&1 | tail -15
npm run lint 2>&1 | tail -5
npx tsc -b 2>&1 | tail -5
```

Expected: tests, lint and tsc pass on a clean `main`. If anything already fails, write the exact failing test names in the PR description and do NOT fix them in this plan.

- [ ] **Step 2: Write the failing test**

Create `src/lib/dbml/apply-dbml/__tests__/apply-dbml-to-diagram.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import { importDBMLToDiagram } from '../../dbml-import/dbml-import';
import { generateDBMLFromDiagram } from '../../dbml-export/dbml-export';
import { applyDBMLToDiagram } from '../apply-dbml-to-diagram';

const DBML_V1 = `
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

const loadBase = async (): Promise<Diagram> => {
    const diagram = await importDBMLToDiagram(DBML_V1, {
        databaseType: DatabaseType.POSTGRESQL,
    });
    // Give tables recognisable positions so we can check layout is kept.
    diagram.tables = (diagram.tables ?? []).map((table, index) => ({
        ...table,
        x: 100 + index * 500,
        y: 40,
    }));
    return diagram;
};

describe('applyDBMLToDiagram', () => {
    it('keeps ids and positions when the DBML is unchanged (round trip)', async () => {
        const base = await loadBase();
        const dbml = generateDBMLFromDiagram(base).standardDbml;

        const { diagram, summary } = await applyDBMLToDiagram({
            diagram: base,
            dbml,
        });

        expect(summary.tablesAdded).toEqual([]);
        expect(summary.tablesRemoved).toEqual([]);
        expect(summary.tablesChanged).toEqual([]);
        expect(summary.relationshipsAdded).toBe(0);
        expect(summary.relationshipsRemoved).toBe(0);
        expect(summary.customTypesAdded).toEqual([]);
        expect(summary.customTypesRemoved).toEqual([]);
        expect(diagram.tables?.map((t) => t.id).sort()).toEqual(
            base.tables?.map((t) => t.id).sort()
        );
        for (const table of base.tables ?? []) {
            const after = diagram.tables?.find((t) => t.id === table.id);
            expect(after?.x).toBe(table.x);
            expect(after?.y).toBe(table.y);
        }
    });

    it('reports an added field', async () => {
        const base = await loadBase();
        const dbml = DBML_V1.replace(
            'email varchar(255) [not null]',
            'email varchar(255) [not null]\n  bio text'
        );

        const { summary } = await applyDBMLToDiagram({ diagram: base, dbml });

        expect(summary.tablesAdded).toEqual([]);
        expect(summary.tablesRemoved).toEqual([]);
        expect(summary.tablesChanged).toHaveLength(1);
        expect(summary.tablesChanged[0].table.endsWith('users')).toBe(true);
        expect(summary.tablesChanged[0].fieldsAdded).toEqual(['bio']);
    });

    it('reports a dropped table', async () => {
        const base = await loadBase();
        const dbml = `
Table users {
  id integer [pk]
  email varchar(255) [not null]
}
`;

        const { summary } = await applyDBMLToDiagram({ diagram: base, dbml });

        expect(summary.tablesRemoved).toHaveLength(1);
        expect(summary.tablesRemoved[0].endsWith('posts')).toBe(true);
        expect(summary.relationshipsRemoved).toBe(1);
    });

    it('reports a renamed table as removed + added', async () => {
        const base = await loadBase();
        const dbml = DBML_V1.replace('Table posts', 'Table articles').replace(
            'Ref: posts.user_id',
            'Ref: articles.user_id'
        );

        const { summary } = await applyDBMLToDiagram({ diagram: base, dbml });

        expect(summary.tablesRemoved.some((n) => n.endsWith('posts'))).toBe(
            true
        );
        expect(summary.tablesAdded.some((n) => n.endsWith('articles'))).toBe(
            true
        );
    });

    it('rejects invalid DBML without returning a diagram', async () => {
        const base = await loadBase();

        await expect(
            applyDBMLToDiagram({
                diagram: base,
                dbml: 'Table broken { id integer [',
            })
        ).rejects.toThrow();
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/dbml/apply-dbml/__tests__/apply-dbml-to-diagram.test.ts`
Expected: FAIL — cannot resolve `../apply-dbml-to-diagram`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/dbml/apply-dbml/apply-dbml-to-diagram.ts`:

```ts
import equal from 'fast-deep-equal';
import type { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { DBField } from '@/lib/domain/db-field';
import type { DBTable } from '@/lib/domain/db-table';
import { importDBMLToDiagram } from '../dbml-import/dbml-import';
import { applyDBMLChanges } from './apply-dbml';

export interface ApplyDBMLSummary {
    tablesAdded: string[];
    tablesRemoved: string[];
    tablesChanged: {
        table: string;
        fieldsAdded: string[];
        fieldsRemoved: string[];
        fieldsChanged: string[];
    }[];
    relationshipsAdded: number;
    relationshipsRemoved: number;
    customTypesAdded: string[];
    customTypesRemoved: string[];
}

const tableLabel = (table: DBTable): string =>
    table.schema ? `${table.schema}.${table.name}` : table.name;

// Fields are compared on their meaningful attributes only. DBML import adds
// optional keys as `undefined` while diagrams built elsewhere omit them, and a
// plain deep-equal would treat those as different, so normalise first.
const comparableField = (field: DBField) => ({
    name: field.name,
    type: field.type.id,
    nullable: field.nullable,
    primaryKey: field.primaryKey,
    unique: field.unique,
    increment: field.increment ?? false,
    isArray: field.isArray ?? false,
    characterMaximumLength: field.characterMaximumLength ?? null,
    precision: field.precision ?? null,
    scale: field.scale ?? null,
    default: field.default ?? null,
    comments: field.comments ?? null,
});

const customTypeLabel = (customType: DBCustomType): string =>
    customType.schema ? `${customType.schema}.${customType.name}` : customType.name;

const summarizeDBMLChanges = (
    before: Diagram,
    after: Diagram
): ApplyDBMLSummary => {
    const beforeTables = before.tables ?? [];
    const afterTables = after.tables ?? [];
    const beforeTableById = new Map(beforeTables.map((t) => [t.id, t]));
    const afterTableIds = new Set(afterTables.map((t) => t.id));

    const tablesChanged: ApplyDBMLSummary['tablesChanged'] = [];
    for (const afterTable of afterTables) {
        const beforeTable = beforeTableById.get(afterTable.id);
        if (!beforeTable) continue;

        const beforeFieldById = new Map(beforeTable.fields.map((f) => [f.id, f]));
        const afterFieldIds = new Set(afterTable.fields.map((f) => f.id));

        const fieldsAdded = afterTable.fields
            .filter((f) => !beforeFieldById.has(f.id))
            .map((f) => f.name);
        const fieldsRemoved = beforeTable.fields
            .filter((f) => !afterFieldIds.has(f.id))
            .map((f) => f.name);
        const fieldsChanged = afterTable.fields
            .filter((f) => {
                const previous = beforeFieldById.get(f.id);
                return (
                    !!previous &&
                    !equal(comparableField(previous), comparableField(f))
                );
            })
            .map((f) => f.name);

        if (
            fieldsAdded.length > 0 ||
            fieldsRemoved.length > 0 ||
            fieldsChanged.length > 0
        ) {
            tablesChanged.push({
                table: tableLabel(afterTable),
                fieldsAdded,
                fieldsRemoved,
                fieldsChanged,
            });
        }
    }

    const beforeCustomTypes = before.customTypes ?? [];
    const afterCustomTypes = after.customTypes ?? [];
    const beforeCustomTypeIds = new Set(beforeCustomTypes.map((c) => c.id));
    const afterCustomTypeIds = new Set(afterCustomTypes.map((c) => c.id));

    const beforeRelationshipIds = new Set(
        (before.relationships ?? []).map((r) => r.id)
    );
    const afterRelationshipIds = new Set(
        (after.relationships ?? []).map((r) => r.id)
    );

    return {
        tablesAdded: afterTables
            .filter((t) => !beforeTableById.has(t.id))
            .map(tableLabel),
        tablesRemoved: beforeTables
            .filter((t) => !afterTableIds.has(t.id))
            .map(tableLabel),
        tablesChanged,
        relationshipsAdded: [...afterRelationshipIds].filter(
            (id) => !beforeRelationshipIds.has(id)
        ).length,
        relationshipsRemoved: [...beforeRelationshipIds].filter(
            (id) => !afterRelationshipIds.has(id)
        ).length,
        customTypesAdded: afterCustomTypes
            .filter((c) => !beforeCustomTypeIds.has(c.id))
            .map(customTypeLabel),
        customTypesRemoved: beforeCustomTypes
            .filter((c) => !afterCustomTypeIds.has(c.id))
            .map(customTypeLabel),
    };
};

/**
 * Parse `dbml` and merge it onto `diagram`, keeping ids, positions, colors,
 * areas and notes of everything that still exists. Throws (like
 * `importDBMLToDiagram`) when the DBML is invalid.
 */
export const applyDBMLToDiagram = async ({
    diagram,
    dbml,
    databaseType = diagram.databaseType,
}: {
    diagram: Diagram;
    dbml: string;
    databaseType?: DatabaseType;
}): Promise<{ diagram: Diagram; summary: ApplyDBMLSummary }> => {
    const diagramFromDBML = await importDBMLToDiagram(dbml, { databaseType });

    const targetDiagram: Diagram = {
        ...diagram,
        tables: diagramFromDBML.tables,
        relationships: diagramFromDBML.relationships,
        customTypes: diagramFromDBML.customTypes,
    };

    const newDiagram = applyDBMLChanges({
        sourceDiagram: diagram,
        targetDiagram,
    });

    return { diagram: newDiagram, summary: summarizeDBMLChanges(diagram, newDiagram) };
};
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run src/lib/dbml/apply-dbml/__tests__/apply-dbml-to-diagram.test.ts`
Expected: PASS (5 tests).

If the round-trip test fails because `tablesChanged`/ids differ, that is the "DBML cannot round-trip everything" risk from the spec. Do NOT loosen the assertions silently: print `summary` and the two DBML strings, find which attribute is lost, and report it in the PR description. Adjusting an assertion is only acceptable for the schema label (`endsWith(...)` is already used for that).

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/lib/dbml/apply-dbml/apply-dbml-to-diagram.ts src/lib/dbml/apply-dbml/__tests__/apply-dbml-to-diagram.test.ts
npm run lint
git add src/lib/dbml/apply-dbml
git commit -m "feat: add applyDBMLToDiagram helper with change summary

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Import placement offset helper

**Files:**
- Create: `src/lib/utils/import-offset.ts`
- Test: `src/lib/utils/__tests__/import-offset.test.ts`

**Interfaces:**
- Consumes: `DBTable` (`src/lib/domain/db-table.ts`).
- Produces:
  ```ts
  export const getImportOffsetX: (existingTables: DBTable[]) => number;
  export const offsetTablesX: (tables: DBTable[], offsetX: number) => DBTable[];
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/utils/__tests__/import-offset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { DBTable } from '@/lib/domain/db-table';
import { getImportOffsetX, offsetTablesX } from '../import-offset';

const table = (x: number, width?: number) => ({ x, width }) as DBTable;

describe('getImportOffsetX', () => {
    it('returns 0 for an empty diagram', () => {
        expect(getImportOffsetX([])).toBe(0);
    });

    it('places new tables 150px right of the rightmost table edge', () => {
        expect(getImportOffsetX([table(0, 300), table(500, 224)])).toBe(
            500 + 224 + 150
        );
    });

    it('uses width 250 when a table has no width', () => {
        expect(getImportOffsetX([table(100)])).toBe(100 + 250 + 150);
    });

    it('picks the table with the largest right edge, not the largest x', () => {
        expect(getImportOffsetX([table(0, 1000), table(200, 100)])).toBe(
            1000 + 150
        );
    });
});

describe('offsetTablesX', () => {
    it('shifts x and leaves other attributes untouched', () => {
        const [moved] = offsetTablesX(
            [{ x: 10, y: 5, name: 't' } as DBTable],
            100
        );
        expect(moved.x).toBe(110);
        expect(moved.y).toBe(5);
        expect(moved.name).toBe('t');
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/utils/__tests__/import-offset.test.ts`
Expected: FAIL — cannot resolve `../import-offset`.

- [ ] **Step 3: Implement**

Create `src/lib/utils/import-offset.ts`:

```ts
import type { DBTable } from '@/lib/domain/db-table';

const DEFAULT_TABLE_WIDTH = 250;
const IMPORT_GAP = 150;

/** X offset that puts imported tables to the right of the existing ones. */
export const getImportOffsetX = (existingTables: DBTable[]): number => {
    if (existingTables.length === 0) {
        return 0;
    }

    const rightEdge = existingTables.reduce(
        (max, table) =>
            Math.max(max, table.x + (table.width ?? DEFAULT_TABLE_WIDTH)),
        -Infinity
    );

    return rightEdge + IMPORT_GAP;
};

export const offsetTablesX = (tables: DBTable[], offsetX: number): DBTable[] =>
    tables.map((table) => ({ ...table, x: table.x + offsetX }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/utils/__tests__/import-offset.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write src/lib/utils/import-offset.ts src/lib/utils/__tests__/import-offset.test.ts
npm run lint
git add src/lib/utils
git commit -m "feat: extract import placement offset helper

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `importContentToDiagram`

**Files:**
- Create: `src/lib/import-method/import-content.ts`
- Test: `src/lib/import-method/__tests__/import-content.test.ts`

**Interfaces:**
- Consumes: `sqlImportToDiagram({ sqlContent, sourceDatabaseType, targetDatabaseType })`, `importDBMLToDiagram`, `loadDatabaseMetadata(json: string): DatabaseMetadata`, `loadFromDatabaseMetadata({ databaseType, databaseMetadata, databaseEdition? }): Promise<Diagram>`, `ImportMethod = 'query' | 'ddl' | 'dbml'` (`'query'` means metadata JSON produced by the smart query).
- Produces (used by Task 4 and MCP Plan 2):
  ```ts
  export const importContentToDiagram: (args: {
      method: ImportMethod;
      content: string;
      databaseType: DatabaseType;
      databaseEdition?: DatabaseEdition;
  }) => Promise<Diagram>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/lib/import-method/__tests__/import-content.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { importContentToDiagram } from '../import-content';

describe('importContentToDiagram', () => {
    it('imports DBML', async () => {
        const diagram = await importContentToDiagram({
            method: 'dbml',
            content: 'Table users {\n  id integer [pk]\n}',
            databaseType: DatabaseType.POSTGRESQL,
        });

        expect(diagram.tables).toHaveLength(1);
        expect(diagram.tables?.[0].name).toBe('users');
    });

    it('imports DDL', async () => {
        const diagram = await importContentToDiagram({
            method: 'ddl',
            content:
                'CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL);',
            databaseType: DatabaseType.POSTGRESQL,
        });

        expect(diagram.tables).toHaveLength(1);
        expect(diagram.tables?.[0].name).toBe('users');
    });

    it('returns an empty diagram for empty DBML', async () => {
        const diagram = await importContentToDiagram({
            method: 'dbml',
            content: '   ',
            databaseType: DatabaseType.POSTGRESQL,
        });

        expect(diagram.tables ?? []).toHaveLength(0);
    });

    it('rejects invalid metadata JSON', async () => {
        await expect(
            importContentToDiagram({
                method: 'query',
                content: 'not json',
                databaseType: DatabaseType.POSTGRESQL,
            })
        ).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/import-method/__tests__/import-content.test.ts`
Expected: FAIL — cannot resolve `../import-content`.

- [ ] **Step 3: Implement**

Create `src/lib/import-method/import-content.ts`:

```ts
import type { DatabaseEdition } from '@/lib/domain/database-edition';
import type { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import { sqlImportToDiagram } from '@/lib/data/sql-import';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import { loadFromDatabaseMetadata } from '@/lib/data/import-metadata/import';
import { loadDatabaseMetadata } from '@/lib/data/import-metadata/metadata-types/database-metadata';
import type { ImportMethod } from './import-method';

/**
 * Turn user-supplied content (DDL, DBML or the JSON returned by the
 * per-dialect "smart query") into a Diagram. Throws on invalid content.
 */
export const importContentToDiagram = async ({
    method,
    content,
    databaseType,
    databaseEdition,
}: {
    method: ImportMethod;
    content: string;
    databaseType: DatabaseType;
    databaseEdition?: DatabaseEdition;
}): Promise<Diagram> => {
    if (method === 'ddl') {
        return sqlImportToDiagram({
            sqlContent: content,
            sourceDatabaseType: databaseType,
            targetDatabaseType: databaseType,
        });
    }

    if (method === 'dbml') {
        return importDBMLToDiagram(content, { databaseType });
    }

    return loadFromDatabaseMetadata({
        databaseType,
        databaseMetadata: loadDatabaseMetadata(content),
        databaseEdition:
            databaseEdition?.trim().length === 0 ? undefined : databaseEdition,
    });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/import-method/__tests__/import-content.test.ts`
Expected: PASS (4 tests). If the DDL case fails because the parser returns a different table name casing/schema, assert on `.toLowerCase()` or `.endsWith('users')` — do not change the SQL.

- [ ] **Step 5: Add the cross-helper regression tests for `applyDBMLToDiagram`**

These need `importContentToDiagram`, so they live in a separate file created now. Create `src/lib/dbml/apply-dbml/__tests__/apply-dbml-to-diagram-sources.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseType } from '@/lib/domain/database-type';
import { importContentToDiagram } from '@/lib/import-method/import-content';
import { importDBMLToDiagram } from '../../dbml-import/dbml-import';
import { generateDBMLFromDiagram } from '../../dbml-export/dbml-export';
import { applyDBMLToDiagram } from '../apply-dbml-to-diagram';

describe('applyDBMLToDiagram with diagrams not built from DBML', () => {
    it('round-trips a diagram that was NOT built from DBML (no false changes)', async () => {
        const base = await importContentToDiagram({
            method: 'ddl',
            content:
                'CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255) NOT NULL);\n' +
                'CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title VARCHAR(200));',
            databaseType: DatabaseType.POSTGRESQL,
        });
        const dbml = generateDBMLFromDiagram(base).standardDbml;

        const { summary } = await applyDBMLToDiagram({ diagram: base, dbml });

        expect(summary.tablesAdded).toEqual([]);
        expect(summary.tablesRemoved).toEqual([]);
        expect(summary.tablesChanged).toEqual([]);
    });

    it('reports a dropped enum', async () => {
        const withEnum = `
Enum status {
  active
  inactive
}

Table users {
  id integer [pk]
  state status
}
`;
        const base = await importDBMLToDiagram(withEnum, {
            databaseType: DatabaseType.POSTGRESQL,
        });
        const dbml = 'Table users {\n  id integer [pk]\n  state varchar(20)\n}';

        const { summary } = await applyDBMLToDiagram({ diagram: base, dbml });

        expect(summary.customTypesRemoved).toHaveLength(1);
        expect(summary.customTypesRemoved[0].endsWith('status')).toBe(true);
    });

});
```

Run: `npx vitest run src/lib/dbml/apply-dbml`
Expected: PASS. If the DDL round-trip test reports `tablesChanged` entries, print `summary.tablesChanged` and the exported DBML to see which attribute is lost; record the finding in the PR description rather than weakening the assertion. If the enum fixture is rejected by the DBML parser, fix the fixture (the assertion is about `customTypesRemoved`).

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/lib/import-method src/lib/dbml/apply-dbml
npm run lint
git add src/lib/import-method src/lib/dbml/apply-dbml
git commit -m "feat: add importContentToDiagram helper and round-trip tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Make the UI use the shared helpers

**Files:**
- Modify: `src/pages/editor-page/side-panel/dbml-section/table-dbml/table-dbml.tsx` (the `showDiff` callback, ~lines 209–262, and its imports)
- Modify: `src/dialogs/import-database-dialog/import-database-dialog.tsx` (the `importDatabase` callback, ~lines 60–135, and its imports)

**Interfaces:**
- Consumes: `applyDBMLToDiagram` (Task 1), `getImportOffsetX` / `offsetTablesX` (Task 2), `importContentToDiagram` (Task 3).
- Produces: nothing new; behavior must be identical.

- [ ] **Step 1: Refactor `showDiff` in `table-dbml.tsx`**

Replace this block inside `showDiff`:

```ts
const diagramFromDBML: Diagram = await importDBMLToDiagram(
    dbmlContent,
    { databaseType }
);

const sourceDiagram: Diagram =
    originalDiagramRef.current ?? currentDiagramRef.current;

const targetDiagram: Diagram = {
    ...sourceDiagram,
    tables: diagramFromDBML.tables,
    relationships: diagramFromDBML.relationships,
    customTypes: diagramFromDBML.customTypes,
};

const newDiagram = applyDBMLChanges({
    sourceDiagram,
    targetDiagram,
});
```

with:

```ts
const sourceDiagram: Diagram =
    originalDiagramRef.current ?? currentDiagramRef.current;

const { diagram: newDiagram } = await applyDBMLToDiagram({
    diagram: sourceDiagram,
    dbml: dbmlContent,
    databaseType,
});
```

Add `import { applyDBMLToDiagram } from '@/lib/dbml/apply-dbml/apply-dbml-to-diagram';`. Then check whether `importDBMLToDiagram` and `applyDBMLChanges` are still used elsewhere in the file:

```bash
grep -n "importDBMLToDiagram\|applyDBMLChanges" src/pages/editor-page/side-panel/dbml-section/table-dbml/table-dbml.tsx
```

Remove each import that now only appears in its import line. Leave the `catch` block (which uses `parseDBMLError`) untouched.

- [ ] **Step 2: Refactor `importDatabase` in `import-database-dialog.tsx`**

Replace the `let diagram … if (importMethod === 'ddl') … else …` block (from `let diagram: Diagram | undefined;` through the closing `}` of the final `else`) with:

```ts
const diagram = await importContentToDiagram({
    method: importMethod,
    content: scriptResult,
    databaseType,
    databaseEdition,
});
```

Replace the offset block (from `// Calculate position offset…` through the `positionedTables` declaration) with:

```ts
const positionedTables = offsetTablesX(
    diagram.tables ?? [],
    getImportOffsetX(existingTables)
);
```

Add imports:

```ts
import { getImportOffsetX, offsetTablesX } from '@/lib/utils/import-offset';
```

Remove now-unused imports: `Diagram` (type), `DatabaseMetadata` (type), `loadDatabaseMetadata`, `loadFromDatabaseMetadata`, `sqlImportToDiagram`, `importDBMLToDiagram`. Keep `DatabaseEdition` (still used for state typing) and `DatabaseType`.

- [ ] **Step 3: Type-check, lint, run the whole suite**

```bash
npx prettier --write src/pages/editor-page/side-panel/dbml-section/table-dbml/table-dbml.tsx src/dialogs/import-database-dialog/import-database-dialog.tsx
npx tsc -b
npm run lint
npm run test:ci 2>&1 | tail -15
```

Expected: no type errors (an unused import would fail `tsc`), lint clean, all tests pass.

- [ ] **Step 4: Manual smoke test in the browser**

```bash
npm run dev
```

In the app: (a) create a diagram, open the DBML side panel, edit mode, add a column, confirm the diff preview shows it and "Accept" applies it; (b) type invalid DBML and confirm the red error line still appears; (c) Import → DDL on a diagram that already has tables, confirm the new tables land to the right of the existing ones. Record the result in the PR description.

- [ ] **Step 5: Commit**

```bash
git add src/pages/editor-page/side-panel/dbml-section/table-dbml/table-dbml.tsx src/dialogs/import-database-dialog/import-database-dialog.tsx
git commit -m "refactor: use shared DBML-apply and import helpers in the UI

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
