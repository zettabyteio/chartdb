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
                source: {
                    kind: 'dbml',
                    content: 'Table broken { id integer [',
                },
            })
        ).rejects.toThrow(/Could not import dbml content/);
        expect(store.size).toBe(0);
    });
});

describe('rename_diagram', () => {
    it('renames the open diagram', async () => {
        const d = await diagramFromDbml();
        const { gateway, store } = createMemoryGateway({
            diagrams: [d],
            currentId: d.id,
        });
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
        const result = await run(
            createDiagramHandlers(gateway),
            'delete_diagram',
            {
                diagramId: d.id,
                confirmName: d.name,
            }
        );
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
