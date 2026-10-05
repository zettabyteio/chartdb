import { z } from 'zod';
// Relative import on purpose: this file is also bundled by Node (mcp/), where
// the '@/' alias does not exist. Keep imports here to zod + plain enums only.
import { DatabaseType } from '../lib/domain/database-type';

const diagramId = z
    .string()
    .min(1)
    .optional()
    .describe(
        'Diagram id (see list_diagrams). Defaults to the diagram open in the app tab.'
    );

const databaseType = z
    .nativeEnum(DatabaseType)
    .describe('Database dialect, e.g. postgresql, mysql, sqlite.');

const importKind = z
    .enum(['ddl', 'dbml', 'metadata'])
    .describe(
        "'ddl' = SQL CREATE statements, 'dbml' = DBML text, 'metadata' = JSON returned by ChartDB's per-database smart query."
    );

const tableRefs = z
    .array(z.string().min(1))
    .describe("Table names: 'table' or 'schema.table'.");

export const toolInputShapes = {
    list_diagrams: {},
    get_diagram: {
        diagramId,
        format: z.enum(['dbml', 'json']).default('dbml'),
    },
    create_diagram: {
        name: z.string().min(1),
        databaseType,
        source: z
            .object({ kind: importKind, content: z.string().min(1) })
            .optional()
            .describe('Optional content to seed the new diagram.'),
    },
    import_into_diagram: {
        diagramId,
        kind: importKind,
        content: z.string().min(1),
        databaseType: databaseType
            .optional()
            .describe(
                "Required only when the diagram's type is 'generic'; it then becomes the diagram's type."
            ),
    },
    apply_dbml: {
        diagramId,
        dbml: z.string().describe('The full desired DBML for the diagram.'),
        dryRun: z
            .boolean()
            .default(false)
            .describe('Only report what would change; save nothing.'),
        allowDrops: z
            .boolean()
            .default(false)
            .describe(
                'Allow the DBML to delete tables or enum/custom types that are not in it.'
            ),
    },
    export_sql: {
        diagramId,
        targetDatabaseType: databaseType.optional(),
    },
    remove_tables: {
        diagramId,
        tables: tableRefs.min(1),
    },
    rename_diagram: {
        diagramId,
        name: z.string().min(1),
    },
    delete_diagram: {
        diagramId: z.string().min(1),
        confirmName: z
            .string()
            .describe('Must exactly equal the name of the diagram to delete.'),
    },
    upsert_note: {
        diagramId,
        noteId: z.string().optional().describe('Omit to create a new note.'),
        content: z.string().optional(),
        color: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
    },
    upsert_area: {
        diagramId,
        areaId: z.string().optional().describe('Omit to create a new area.'),
        name: z.string().min(1).optional(),
        color: z.string().optional(),
        tables: tableRefs
            .optional()
            .describe('Tables to move into the area and arrange there.'),
    },
    auto_arrange: { diagramId },
    validate_dbml: {
        dbml: z.string(),
        databaseType,
    },
} satisfies Record<string, z.ZodRawShape>;

export type ToolName = keyof typeof toolInputShapes;

export const toolNames = Object.keys(toolInputShapes) as ToolName[];

export type ToolArgs<T extends ToolName> = z.infer<
    z.ZodObject<(typeof toolInputShapes)[T]>
>;

// Browser -> server
export const clientMessageSchema = z.union([
    z.object({ type: z.literal('hello'), token: z.string() }),
    z.object({
        type: z.literal('result'),
        id: z.string(),
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z.string().optional(),
    }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Server -> browser
export const serverMessageSchema = z.union([
    z.object({ type: z.literal('ready') }),
    z.object({
        type: z.literal('call'),
        id: z.string(),
        tool: z.string(),
        args: z.unknown().optional(),
    }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
