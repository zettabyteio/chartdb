import { hasCrossDialectSupport } from '@/lib/data/sql-export/cross-dialect';
import { exportBaseSQL } from '@/lib/data/sql-export/export-sql-script';
import { generateDBMLFromDiagram } from '@/lib/dbml/dbml-export/dbml-export';
import { verifyDBML } from '@/lib/dbml/dbml-import/verify-dbml';
import { DatabaseType } from '@/lib/domain/database-type';
import type { DiagramGateway } from '../gateway';
import { loadTarget } from '../gateway';
import type { ToolHandlers } from './types';
import { ToolError } from '../tool-error';

export const createReadHandlers = (
    gateway: DiagramGateway
): Pick<
    ToolHandlers,
    'list_diagrams' | 'get_diagram' | 'export_sql' | 'validate_dbml'
> => ({
    list_diagrams: async () => {
        const diagrams = await gateway.list();
        const openId = gateway.currentDiagramId();

        return [...diagrams]
            .map((d) => ({ ...d, updatedAt: new Date(d.updatedAt) }))
            .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
            .map((d) => ({
                id: d.id,
                name: d.name,
                databaseType: d.databaseType,
                updatedAt: d.updatedAt.toISOString(),
                openInApp: d.id === openId,
            }));
    },

    get_diagram: async (args) => {
        const diagram = await loadTarget(gateway, args.diagramId);

        if (args.format === 'json') {
            // Do NOT use diagramToJSONOutput: it renumbers every id ('0', '1', ...),
            // and callers need the real diagram/note/area ids.
            return JSON.stringify(diagram, null, 2);
        }

        const result = generateDBMLFromDiagram(diagram);
        if (result.error) {
            throw new ToolError(`DBML export failed: ${result.error}`);
        }
        return result.standardDbml;
    },

    export_sql: async (args) => {
        const diagram = await loadTarget(gateway, args.diagramId);

        if (!diagram.tables || diagram.tables.length === 0) {
            throw new ToolError('The diagram has no tables to export.');
        }

        const target = args.targetDatabaseType ?? diagram.databaseType;

        // Same condition the export dialog uses for its deterministic path.
        // Anything else would fall through to the pre-LLM generic script.
        if (
            !(
                target === diagram.databaseType ||
                target === DatabaseType.GENERIC ||
                hasCrossDialectSupport(diagram.databaseType, target)
            )
        ) {
            throw new ToolError(
                `No deterministic SQL export from ${diagram.databaseType} to ${target}. Export in the diagram's own dialect, or to a supported target.`
            );
        }

        // exportBaseSQL can rewrite field types in place; never hand it live state.
        return exportBaseSQL({
            diagram: structuredClone(diagram),
            targetDatabaseType: target,
        });
    },

    validate_dbml: async (args) => {
        const result = verifyDBML(args.dbml, {
            databaseType: args.databaseType,
        });

        if (!result.hasError) {
            return { valid: true };
        }

        return {
            valid: false,
            message: result.errorText,
            line: result.parsedError?.line,
            column: result.parsedError?.column,
        };
    },
});
