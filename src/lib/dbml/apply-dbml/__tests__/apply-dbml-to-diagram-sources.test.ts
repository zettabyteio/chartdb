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
