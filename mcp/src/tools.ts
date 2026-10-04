import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toolInputShapes, toolNames } from '../../src/mcp-bridge/protocol';
import type { ToolName } from '../../src/mcp-bridge/protocol';
import type { ToolBackend } from './bridge-server';

const DESCRIPTIONS: Record<ToolName, string> = {
    list_diagrams:
        'List the ChartDB diagrams stored in the browser, newest first, and which one is open in the app.',
    get_diagram:
        'Return a diagram as DBML (default) or JSON. Defaults to the diagram open in the app.',
    create_diagram:
        'Create a new diagram, empty or seeded from SQL DDL, DBML or the JSON of the database smart query.',
    import_into_diagram:
        'Add tables from SQL DDL, DBML or smart-query JSON to an existing diagram, placed to the right of the current tables.',
    apply_dbml:
        'Make the diagram match a full DBML document (tables, relationships, enums), keeping ids and layout of what remains. Use dryRun first to see the change summary. Deleting tables requires allowDrops: true; a rename is applied as delete + create.',
    export_sql:
        'Generate deterministic SQL DDL for the diagram, in its own dialect or another one. Does not use AI.',
    remove_tables:
        "Delete tables by name ('table' or 'schema.table') together with their relationships and dependencies.",
    rename_diagram: 'Rename a diagram.',
    delete_diagram:
        "Permanently delete a diagram. confirmName must exactly equal the diagram's name.",
    upsert_note:
        'Create a sticky note (omit noteId) or update one (pass noteId). Content is required when creating.',
    upsert_area:
        'Create an area (omit areaId) or update one, optionally moving the named tables into it and arranging them. Name is required when creating.',
    auto_arrange:
        "Re-run ChartDB's automatic layout so tables do not overlap and related tables sit together.",
    validate_dbml:
        'Check DBML syntax without saving anything; returns line, column and message on error.',
};

const READ_ONLY = new Set<ToolName>([
    'list_diagrams',
    'get_diagram',
    'export_sql',
    'validate_dbml',
]);
const DESTRUCTIVE = new Set<ToolName>([
    'delete_diagram',
    'remove_tables',
    'apply_dbml',
]);

export const formatResult = (data: unknown): string =>
    typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? 'ok');

export const registerTools = (
    server: McpServer,
    backend: ToolBackend
): void => {
    for (const name of toolNames) {
        server.registerTool(
            name,
            {
                description: DESCRIPTIONS[name],
                inputSchema: toolInputShapes[
                    name
                ] as unknown as ZodRawShapeCompat,
                annotations: {
                    readOnlyHint: READ_ONLY.has(name),
                    destructiveHint: DESTRUCTIVE.has(name),
                    openWorldHint: false,
                },
            },
            async (args: Record<string, unknown>) => {
                try {
                    const data = await backend.call(name, args);
                    return {
                        content: [
                            { type: 'text' as const, text: formatResult(data) },
                        ],
                    };
                } catch (error) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text' as const,
                                text:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            },
                        ],
                    };
                }
            }
        );
    }
};
