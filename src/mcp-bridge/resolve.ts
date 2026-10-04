import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import { ToolError } from './tool-error';

export const tableLabel = (table: DBTable): string =>
    table.schema ? `${table.schema}.${table.name}` : table.name;

export const resolveTable = (diagram: Diagram, ref: string): DBTable => {
    const tables = diagram.tables ?? [];
    const wanted = ref.toLowerCase();

    const byLabel = tables.filter(
        (t) => tableLabel(t).toLowerCase() === wanted
    );
    const matches =
        byLabel.length > 0
            ? byLabel
            : tables.filter((t) => t.name.toLowerCase() === wanted);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new ToolError(
            `Table '${ref}' is ambiguous. Use one of: ${matches.map(tableLabel).join(', ')}.`
        );
    }

    const hints = tables
        .filter((t) => {
            const name = t.name.toLowerCase();
            return name.includes(wanted) || wanted.includes(name);
        })
        .map(tableLabel)
        .slice(0, 5);

    throw new ToolError(
        hints.length > 0
            ? `Table '${ref}' not found. Did you mean: ${hints.join(', ')}?`
            : `Table '${ref}' not found. Existing tables: ${
                  tables.slice(0, 20).map(tableLabel).join(', ') || '(none)'
              }.`
    );
};
