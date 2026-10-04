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
