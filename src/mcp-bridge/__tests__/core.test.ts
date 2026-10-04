import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toolInputShapes, toolNames } from '../protocol';
import { ToolError } from '../tool-error';
import { resolveTable } from '../resolve';
import { assertWritable, commit, loadTarget } from '../gateway';
import { createMemoryGateway, diagramFromDbml } from './helpers';

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
        const { gateway } = createMemoryGateway({
            diagrams: [d],
            currentId: d.id,
        });
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
        const { gateway, saves } = createMemoryGateway({
            diagrams: [d],
            currentId: d.id,
        });
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
