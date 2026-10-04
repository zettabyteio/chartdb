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
