import type { Diagram } from '@/lib/domain/diagram';
import { generateDiagramId } from '@/lib/utils/utils';
import type { DiagramGateway } from '../gateway';
import { assertWritable, commit, loadTarget } from '../gateway';
import { ToolError } from '../tool-error';
import { importOrThrow, toImportMethod } from './shared';
import type { ToolHandlers } from './types';

export const createDiagramHandlers = (
    gateway: DiagramGateway
): Pick<
    ToolHandlers,
    'create_diagram' | 'rename_diagram' | 'delete_diagram'
> => ({
    create_diagram: async (args) => {
        const now = new Date();
        const imported = args.source
            ? await importOrThrow({
                  method: toImportMethod(args.source.kind),
                  content: args.source.content,
                  databaseType: args.databaseType,
              })
            : undefined;

        const diagram: Diagram = {
            tables: [],
            relationships: [],
            dependencies: [],
            areas: [],
            customTypes: [],
            notes: [],
            ...imported,
            id: generateDiagramId(),
            name: args.name,
            databaseType: args.databaseType,
            createdAt: now,
            updatedAt: now,
        };

        await gateway.create(diagram);

        return {
            id: diagram.id,
            name: diagram.name,
            databaseType: diagram.databaseType,
            tables: diagram.tables?.length ?? 0,
            openUrl: `/diagrams/${diagram.id}`,
        };
    },

    rename_diagram: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        await commit(gateway, before, { ...before, name: args.name });
        return { id: before.id, name: args.name };
    },

    delete_diagram: async (args) => {
        const diagram = await loadTarget(gateway, args.diagramId);

        if (args.confirmName !== diagram.name) {
            throw new ToolError(
                `Refusing to delete: confirmName must exactly equal the diagram's name "${diagram.name}".`
            );
        }

        assertWritable(gateway, diagram.id);
        await gateway.remove(diagram.id);

        return { deleted: { id: diagram.id, name: diagram.name } };
    },
});
