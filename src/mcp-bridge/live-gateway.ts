import type { ChartDBContext } from '@/context/chartdb-context/chartdb-context';
import type { StorageContext } from '@/context/storage-context/storage-context';
import type { Diagram } from '@/lib/domain/diagram';
import type { DiagramGateway } from './gateway';

export interface LiveGatewayDeps {
    getCurrent: () => { diagram: Diagram; readonly: boolean };
    storage: Pick<
        StorageContext,
        'listDiagrams' | 'getDiagram' | 'addDiagram' | 'deleteDiagram'
    >;
    updateDiagramData: ChartDBContext['updateDiagramData'];
    deleteCurrentDiagram: ChartDBContext['deleteDiagram'];
    onCurrentDeleted: () => void;
}

const FULL_DIAGRAM = {
    includeTables: true,
    includeRelationships: true,
    includeDependencies: true,
    includeAreas: true,
    includeCustomTypes: true,
    includeNotes: true,
} as const;

export const createLiveGateway = (deps: LiveGatewayDeps): DiagramGateway => {
    const currentId = (): string | undefined =>
        deps.getCurrent().diagram.id || undefined;

    // React state updates after our save are asynchronous. If the next tool call
    // arrives before the re-render, serve what we just saved instead of stale
    // state. A newer edit made in the UI (later updatedAt) takes over again.
    let lastSaved: Diagram | undefined;

    return {
        currentDiagramId: currentId,
        isReadonly: () => deps.getCurrent().readonly,
        list: () => deps.storage.listDiagrams(),

        load: async (id) => {
            if (id !== currentId()) {
                return deps.storage.getDiagram(id, FULL_DIAGRAM);
            }

            const { diagram } = deps.getCurrent();
            if (
                lastSaved?.id === id &&
                new Date(diagram.updatedAt).getTime() <
                    new Date(lastSaved.updatedAt).getTime()
            ) {
                return lastSaved;
            }
            return diagram;
        },

        save: async (diagram) => {
            if (diagram.id === currentId()) {
                await deps.updateDiagramData(diagram, {
                    forceUpdateStorage: true,
                });
                lastSaved = diagram;
                return;
            }

            await deps.storage.deleteDiagram(diagram.id);
            await deps.storage.addDiagram({ diagram });
        },

        create: (diagram) => deps.storage.addDiagram({ diagram }),

        remove: async (id) => {
            if (id === currentId()) {
                await deps.deleteCurrentDiagram();
                lastSaved = undefined;
                deps.onCurrentDeleted();
                return;
            }

            await deps.storage.deleteDiagram(id);
        },
    };
};
