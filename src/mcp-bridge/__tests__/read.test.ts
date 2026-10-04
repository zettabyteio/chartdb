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
        const { gateway } = createMemoryGateway({
            diagrams: [empty],
            currentId: 'e',
        });
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
