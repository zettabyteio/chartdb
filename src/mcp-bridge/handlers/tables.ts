import { applyDBMLToDiagram } from '@/lib/dbml/apply-dbml/apply-dbml-to-diagram';
import { DatabaseType } from '@/lib/domain/database-type';
import { getImportOffsetX, offsetTablesX } from '@/lib/utils/import-offset';
import type { DiagramGateway } from '../gateway';
import { commit, loadTarget } from '../gateway';
import { resolveTable, tableLabel } from '../resolve';
import { ToolError, describeError } from '../tool-error';
import { importOrThrow, toImportMethod } from './shared';
import type { ToolHandlers } from './types';

export const createTableHandlers = (
    gateway: DiagramGateway
): Pick<
    ToolHandlers,
    'import_into_diagram' | 'apply_dbml' | 'remove_tables'
> => ({
    import_into_diagram: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);

        const databaseType =
            before.databaseType === DatabaseType.GENERIC
                ? args.databaseType
                : before.databaseType;

        if (!databaseType || databaseType === DatabaseType.GENERIC) {
            throw new ToolError(
                "This diagram's database type is 'generic'. Pass databaseType (for example 'postgresql') so the content can be parsed."
            );
        }

        const imported = await importOrThrow({
            method: toImportMethod(args.kind),
            content: args.content,
            databaseType,
        });

        const newTables = offsetTablesX(
            imported.tables ?? [],
            getImportOffsetX(before.tables ?? [])
        );
        const newRelationships = imported.relationships ?? [];

        if (newTables.length === 0 && newRelationships.length === 0) {
            throw new ToolError(
                'Nothing to import: the content produced no tables or relationships.'
            );
        }

        await commit(gateway, before, {
            ...before,
            databaseType,
            tables: [...(before.tables ?? []), ...newTables],
            relationships: [
                ...(before.relationships ?? []),
                ...newRelationships,
            ],
        });

        return {
            tablesAdded: newTables.map(tableLabel),
            relationshipsAdded: newRelationships.length,
        };
    },

    apply_dbml: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);

        let applied;
        try {
            applied = await applyDBMLToDiagram({
                diagram: before,
                dbml: args.dbml,
            });
        } catch (error) {
            throw new ToolError(`Invalid DBML — ${describeError(error)}`);
        }

        const { summary } = applied;
        const dropped = [
            ...summary.tablesRemoved,
            ...summary.customTypesRemoved.map((name) => `type ${name}`),
        ];
        const wouldDrop = dropped.length > 0;

        if (args.dryRun) {
            return {
                dryRun: true,
                wouldBlock: wouldDrop && !args.allowDrops,
                summary,
            };
        }

        if (wouldDrop && !args.allowDrops) {
            throw new ToolError(
                `This DBML would delete ${dropped.length} item(s): ${dropped.join(', ')}. ` +
                    'If that is intended, call again with allowDrops: true. ' +
                    'Note: renaming a table in DBML is applied as delete + create.'
            );
        }

        await commit(gateway, before, applied.diagram);

        return { applied: true, summary };
    },

    remove_tables: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);

        const resolved = new Map(
            args.tables.map((ref) => {
                const table = resolveTable(before, ref);
                return [table.id, table] as const;
            })
        );
        const ids = new Set(resolved.keys());

        const relationships = before.relationships ?? [];
        const keptRelationships = relationships.filter(
            (r) => !ids.has(r.sourceTableId) && !ids.has(r.targetTableId)
        );

        await commit(gateway, before, {
            ...before,
            tables: (before.tables ?? []).filter((t) => !ids.has(t.id)),
            relationships: keptRelationships,
            dependencies: (before.dependencies ?? []).filter(
                (d) => !ids.has(d.tableId) && !ids.has(d.dependentTableId)
            ),
        });

        return {
            removed: [...resolved.values()].map(tableLabel),
            relationshipsRemoved:
                relationships.length - keptRelationships.length,
        };
    },
});
