import { describe, it, expect } from 'vitest';
import { createCanvasHandlers } from '../handlers/canvas';
import { createMemoryGateway, diagramFromDbml, run } from './helpers';

const setup = async () => {
    const d = await diagramFromDbml();
    const mem = createMemoryGateway({ diagrams: [d], currentId: d.id });
    return { d, ...mem, handlers: createCanvasHandlers(mem.gateway) };
};

describe('upsert_note', () => {
    it('creates a note with defaults', async () => {
        const { d, handlers, store } = await setup();
        const result = (await run(handlers, 'upsert_note', {
            content: 'Remember to index email',
        })) as { noteId: string; created: boolean };

        expect(result.created).toBe(true);
        const note = store
            .get(d.id)
            ?.notes?.find((n) => n.id === result.noteId);
        expect(note?.content).toBe('Remember to index email');
        expect(note?.color).toBe('#ffe374');
        expect(note?.width).toBe(200);
    });

    it('requires content when creating', async () => {
        const { handlers } = await setup();
        await expect(run(handlers, 'upsert_note', {})).rejects.toThrow(
            /content is required/
        );
    });

    it('updates only the given fields', async () => {
        const { d, handlers, store } = await setup();
        const { noteId } = (await run(handlers, 'upsert_note', {
            content: 'one',
            x: 10,
            y: 20,
        })) as { noteId: string };

        await run(handlers, 'upsert_note', { noteId, color: '#ff0000' });

        const note = store.get(d.id)?.notes?.find((n) => n.id === noteId);
        expect(note).toMatchObject({
            content: 'one',
            x: 10,
            y: 20,
            color: '#ff0000',
        });
    });

    it('fails for an unknown note id', async () => {
        const { handlers } = await setup();
        await expect(
            run(handlers, 'upsert_note', { noteId: 'nope', content: 'x' })
        ).rejects.toThrow(/Note 'nope' not found/);
    });
});

describe('upsert_area', () => {
    it('requires a name when creating', async () => {
        const { handlers } = await setup();
        await expect(run(handlers, 'upsert_area', {})).rejects.toThrow(
            /name is required/
        );
    });

    it('creates an area and moves the named tables into it', async () => {
        const { d, handlers, store } = await setup();
        const result = (await run(handlers, 'upsert_area', {
            name: 'Core',
            tables: ['users', 'posts'],
        })) as { areaId: string; created: boolean; tablesMoved: string[] };

        const saved = store.get(d.id);
        const area = saved?.areas?.find((a) => a.id === result.areaId);
        expect(result.created).toBe(true);
        expect(result.tablesMoved).toHaveLength(2);
        expect(area?.name).toBe('Core');
        expect(
            saved?.tables?.every((t) => t.parentAreaId === result.areaId)
        ).toBe(true);
        for (const table of saved?.tables ?? []) {
            expect(table.x).toBeGreaterThanOrEqual(area?.x ?? 0);
            expect(table.y).toBeGreaterThanOrEqual(area?.y ?? 0);
        }
    });

    it('renames an existing area without touching tables', async () => {
        const { d, handlers, store } = await setup();
        const { areaId } = (await run(handlers, 'upsert_area', {
            name: 'A',
        })) as {
            areaId: string;
        };
        const before = store.get(d.id)?.tables;

        await run(handlers, 'upsert_area', { areaId, name: 'B' });

        expect(store.get(d.id)?.areas?.find((a) => a.id === areaId)?.name).toBe(
            'B'
        );
        expect(store.get(d.id)?.tables).toEqual(before);
    });

    it('fails for an unknown area id', async () => {
        const { handlers } = await setup();
        await expect(
            run(handlers, 'upsert_area', { areaId: 'nope', name: 'x' })
        ).rejects.toThrow(/Area 'nope' not found/);
    });

    it('fails for an unknown table without saving', async () => {
        const { handlers, saves } = await setup();
        await expect(
            run(handlers, 'upsert_area', { name: 'X', tables: ['ghost'] })
        ).rejects.toThrow(/not found/);
        expect(saves).toHaveLength(0);
    });
});

describe('auto_arrange', () => {
    it('separates tables that were stacked on top of each other', async () => {
        const { d, handlers, store, gateway } = await setup();
        const stacked = {
            ...d,
            tables: (d.tables ?? []).map((t) => ({ ...t, x: 0, y: 0 })),
        };
        await gateway.save(stacked);

        const result = (await run(handlers, 'auto_arrange', {})) as {
            tablesArranged: number;
        };

        const positions = new Set(
            store.get(d.id)?.tables?.map((t) => `${t.x},${t.y}`)
        );
        expect(result.tablesArranged).toBe(2);
        expect(positions.size).toBe(2);
    });
});
