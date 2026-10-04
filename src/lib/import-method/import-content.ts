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
