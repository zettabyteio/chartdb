import type { Diagram } from '@/lib/domain/diagram';
import type { ImportMethod } from '@/lib/import-method/import-method';
import { isDatabaseMetadata } from '@/lib/data/import-metadata/metadata-types/database-metadata';
import { importContentToDiagram } from '@/lib/import-method/import-content';
import { ToolError, describeError } from '../tool-error';

export const toImportMethod = (
    kind: 'ddl' | 'dbml' | 'metadata'
): ImportMethod => (kind === 'metadata' ? 'query' : kind);

export const importOrThrow = async (
    args: Parameters<typeof importContentToDiagram>[0]
): Promise<Diagram> => {
    // The tool calls smart-query JSON 'metadata'; internally the method is 'query'.
    const label = args.method === 'query' ? 'metadata' : args.method;

    if (args.method === 'query') {
        let parsed: unknown;
        try {
            parsed = JSON.parse(args.content);
        } catch {
            throw new ToolError(
                'Could not import metadata content — the text is not valid JSON.'
            );
        }
        if (!isDatabaseMetadata(parsed)) {
            throw new ToolError(
                "Could not import metadata content — the JSON does not match the format returned by ChartDB's per-database smart query."
            );
        }
    }

    try {
        return await importContentToDiagram(args);
    } catch (error) {
        throw new ToolError(
            `Could not import ${label} content — ${describeError(error)}`
        );
    }
};
