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

        await expect(
            run(handlers, 'import_into_diagram', args)
        ).rejects.toThrow(/databaseType/);

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
            run(handlers, 'import_into_diagram', {
                kind: 'dbml',
                content: '// nothing',
            })
        ).rejects.toThrow(/Nothing to import/);
        expect(saves).toHaveLength(0);
    });
});

describe('apply_dbml', () => {
    const ONLY_USERS =
        'Table users {\n  id integer [pk]\n  email varchar(255) [not null]\n}';

    it('dryRun reports changes and saves nothing', async () => {
        const { handlers, saves } = await setup();
        const result = (await run(handlers, 'apply_dbml', {
            dbml: ONLY_USERS,
            dryRun: true,
        })) as {
            dryRun: boolean;
            wouldBlock: boolean;
            summary: { tablesRemoved: string[] };
        };

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
        await run(handlers, 'apply_dbml', {
            dbml: ONLY_USERS,
            allowDrops: true,
        });
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
        expect(
            store
                .get(d.id)
                ?.tables?.map((t) => t.id)
                .sort()
        ).toEqual(d.tables?.map((t) => t.id).sort());
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

    it('cascades to dependencies and to relationships where the table is the target', async () => {
        const d = await diagramFromDbml(`
Table users {
  id integer [pk]
}

Table posts {
  id integer [pk]
  user_id integer [not null]
}

Table tags {
  id integer [pk]
}

Table comments {
  id integer [pk]
  tag_id integer [not null]
}

Ref: posts.user_id > users.id
Ref: comments.tag_id > tags.id
`);
        const id = (name: string) =>
            d.tables?.find((t) => t.name === name)?.id as string;
        const withDeps = {
            ...d,
            dependencies: [
                // removed table is the dependent side
                {
                    id: 'dep-dependent',
                    tableId: id('posts'),
                    dependentTableId: id('users'),
                    createdAt: 1,
                },
                // removed table is the primary side
                {
                    id: 'dep-primary',
                    tableId: id('users'),
                    dependentTableId: id('comments'),
                    createdAt: 2,
                },
                // unrelated
                {
                    id: 'dep-unrelated',
                    tableId: id('comments'),
                    dependentTableId: id('tags'),
                    createdAt: 3,
                },
            ],
        };
        const { gateway, store } = createMemoryGateway({
            diagrams: [withDeps],
            currentId: d.id,
        });
        const handlers = createTableHandlers(gateway);
        expect(d.relationships).toHaveLength(2);

        // users is the TARGET of posts.user_id -> users.id
        const result = (await run(handlers, 'remove_tables', {
            tables: ['users'],
        })) as { removed: string[]; relationshipsRemoved: number };

        const saved = store.get(d.id);
        expect(result.relationshipsRemoved).toBe(1);
        expect(saved?.tables?.map((t) => t.name).sort()).toEqual([
            'comments',
            'posts',
            'tags',
        ]);
        expect(saved?.relationships).toHaveLength(1);
        expect(saved?.relationships?.[0].sourceTableId).toBe(id('comments'));
        expect(saved?.dependencies?.map((x) => x.id)).toEqual([
            'dep-unrelated',
        ]);
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
