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
