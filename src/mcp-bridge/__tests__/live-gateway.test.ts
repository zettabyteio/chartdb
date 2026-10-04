import { describe, it, expect, vi } from 'vitest';
import type { Diagram } from '@/lib/domain/diagram';
import { createLiveGateway } from '../live-gateway';
import type { LiveGatewayDeps } from '../live-gateway';
import { diagramFromDbml } from './helpers';

const makeDeps = async (overrides: Partial<LiveGatewayDeps> = {}) => {
    const current = await diagramFromDbml(undefined, { id: 'open' });
    const other = await diagramFromDbml(undefined, { id: 'other' });
    const state = { diagram: current, readonly: false };
    const deps: LiveGatewayDeps = {
        getCurrent: () => state,
        storage: {
            listDiagrams: vi.fn(async () => [current, other]),
            getDiagram: vi.fn(async (id: string) =>
                id === 'other' ? other : undefined
            ),
            addDiagram: vi.fn(async () => {}),
            deleteDiagram: vi.fn(async () => {}),
        },
        updateDiagramData: vi.fn(async () => {}),
        deleteCurrentDiagram: vi.fn(async () => {}),
        onCurrentDeleted: vi.fn(),
        ...overrides,
    };
    return { deps, state, current, other, gateway: createLiveGateway(deps) };
};

describe('live gateway', () => {
    it('reports the open diagram id and read-only state', async () => {
        const { gateway, state } = await makeDeps();
        expect(gateway.currentDiagramId()).toBe('open');
        expect(gateway.isReadonly()).toBe(false);
        state.readonly = true;
        expect(gateway.isReadonly()).toBe(true);
    });

    it('treats an empty current id as "nothing open"', async () => {
        const { gateway, state, current } = await makeDeps();
        state.diagram = { ...current, id: '' };
        expect(gateway.currentDiagramId()).toBeUndefined();
    });

    it('loads the open diagram from live state and others from storage', async () => {
        const { gateway, current, other, deps } = await makeDeps();
        expect(await gateway.load('open')).toBe(current);
        expect(await gateway.load('other')).toBe(other);
        expect(deps.storage.getDiagram).toHaveBeenCalledTimes(1);
        // Storage defaults every include* flag to false; without these a write
        // tool on another diagram would delete + re-add it with no tables.
        expect(deps.storage.getDiagram).toHaveBeenCalledWith(
            'other',
            expect.objectContaining({
                includeTables: true,
                includeRelationships: true,
                includeDependencies: true,
                includeAreas: true,
                includeCustomTypes: true,
                includeNotes: true,
            })
        );
    });

    it('saves the open diagram through updateDiagramData with forceUpdateStorage', async () => {
        const { gateway, current, deps } = await makeDeps();
        const next: Diagram = { ...current, name: 'new' };
        await gateway.save(next);
        expect(deps.updateDiagramData).toHaveBeenCalledWith(next, {
            forceUpdateStorage: true,
        });
        expect(deps.storage.addDiagram).not.toHaveBeenCalled();
    });

    it('saves another diagram by replacing it in storage', async () => {
        const { gateway, other, deps } = await makeDeps();
        await gateway.save({ ...other, name: 'new' });
        expect(deps.storage.deleteDiagram).toHaveBeenCalledWith('other');
        expect(deps.storage.addDiagram).toHaveBeenCalledWith({
            diagram: expect.objectContaining({ id: 'other', name: 'new' }),
        });
        expect(deps.updateDiagramData).not.toHaveBeenCalled();
    });

    it('serves the just-saved diagram until React state catches up', async () => {
        const { gateway, current, state } = await makeDeps();
        const saved: Diagram = {
            ...current,
            name: 'saved',
            updatedAt: new Date(current.updatedAt.getTime() + 1000),
        };
        await gateway.save(saved);

        // React has not re-rendered yet: live state is still the old diagram.
        expect((await gateway.load('open'))?.name).toBe('saved');

        // Once state reflects the save (or a newer edit), live state wins again.
        state.diagram = {
            ...saved,
            name: 'edited in UI',
            updatedAt: new Date(saved.updatedAt.getTime() + 1000),
        };
        expect((await gateway.load('open'))?.name).toBe('edited in UI');
    });

    it('deletes the open diagram via the context and then navigates away', async () => {
        const { gateway, deps } = await makeDeps();
        await gateway.remove('open');
        expect(deps.deleteCurrentDiagram).toHaveBeenCalled();
        expect(deps.onCurrentDeleted).toHaveBeenCalled();
        expect(deps.storage.deleteDiagram).not.toHaveBeenCalled();
    });

    it('deletes another diagram from storage', async () => {
        const { gateway, deps } = await makeDeps();
        await gateway.remove('other');
        expect(deps.storage.deleteDiagram).toHaveBeenCalledWith('other');
        expect(deps.deleteCurrentDiagram).not.toHaveBeenCalled();
    });

    it('creates diagrams in storage', async () => {
        const { gateway, other, deps } = await makeDeps();
        await gateway.create(other);
        expect(deps.storage.addDiagram).toHaveBeenCalledWith({
            diagram: other,
        });
    });
});
