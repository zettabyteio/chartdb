import { randomColor } from '@/lib/colors';
import type { Area } from '@/lib/domain/area';
import { adjustTablePositions } from '@/lib/domain/db-table';
import type { Note } from '@/lib/domain/note';
import { arrangeTablesForArea } from '@/lib/utils/area-utils';
import { getImportOffsetX } from '@/lib/utils/import-offset';
import { generateId } from '@/lib/utils/utils';
import type { DiagramGateway } from '../gateway';
import { commit, loadTarget } from '../gateway';
import { resolveTable, tableLabel } from '../resolve';
import { ToolError } from '../tool-error';
import type { ToolHandlers } from './types';

export const createCanvasHandlers = (
    gateway: DiagramGateway
): Pick<ToolHandlers, 'upsert_note' | 'upsert_area' | 'auto_arrange'> => ({
    upsert_note: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        const notes = before.notes ?? [];

        let note: Note;
        const created = !args.noteId;

        if (args.noteId) {
            const existing = notes.find((n) => n.id === args.noteId);
            if (!existing) {
                throw new ToolError(
                    `Note '${args.noteId}' not found. Existing note ids: ${notes.map((n) => n.id).join(', ') || '(none)'}.`
                );
            }
            note = {
                ...existing,
                ...(args.content !== undefined && { content: args.content }),
                ...(args.color !== undefined && { color: args.color }),
                ...(args.x !== undefined && { x: args.x }),
                ...(args.y !== undefined && { y: args.y }),
            };
        } else {
            if (args.content === undefined) {
                throw new ToolError(
                    'content is required when creating a note.'
                );
            }
            note = {
                id: generateId(),
                content: args.content,
                x: args.x ?? getImportOffsetX(before.tables ?? []),
                y: args.y ?? 0,
                width: 200,
                height: 150,
                color: args.color ?? '#ffe374',
            };
        }

        const noteId = note.id;
        await commit(gateway, before, {
            ...before,
            notes: created
                ? [...notes, note]
                : notes.map((n) => (n.id === noteId ? note : n)),
        });

        return { noteId, created };
    },

    upsert_area: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        const areas = before.areas ?? [];
        const created = !args.areaId;

        let area: Area;
        if (args.areaId) {
            const existing = areas.find((a) => a.id === args.areaId);
            if (!existing) {
                throw new ToolError(
                    `Area '${args.areaId}' not found. Existing area ids: ${areas.map((a) => a.id).join(', ') || '(none)'}.`
                );
            }
            area = {
                ...existing,
                ...(args.name !== undefined && { name: args.name }),
                ...(args.color !== undefined && { color: args.color }),
            };
        } else {
            if (!args.name) {
                throw new ToolError('name is required when creating an area.');
            }
            area = {
                id: generateId(),
                name: args.name,
                x: getImportOffsetX(before.tables ?? []),
                y: 0,
                width: 300,
                height: 200,
                color: args.color ?? randomColor(),
            };
        }

        const moving = (args.tables ?? []).map((ref) =>
            resolveTable(before, ref)
        );
        let tables = before.tables ?? [];

        if (moving.length > 0) {
            const areaId = area.id;
            const movingIds = new Set(moving.map((t) => t.id));
            const toArrange = [
                ...tables.filter(
                    (t) => t.parentAreaId === areaId && !movingIds.has(t.id)
                ),
                ...tables.filter((t) => movingIds.has(t.id)),
            ];

            const { positions, requiredWidth, requiredHeight } =
                arrangeTablesForArea(toArrange, before.relationships ?? [], {
                    x: area.x,
                    y: area.y,
                    width: area.width,
                    height: area.height,
                });

            area = {
                ...area,
                width: Math.max(area.width, requiredWidth),
                height: Math.max(area.height, requiredHeight),
            };

            tables = tables.map((t) => {
                const position = positions.find((p) => p.id === t.id);
                return position
                    ? {
                          ...t,
                          parentAreaId: areaId,
                          x: position.x,
                          y: position.y,
                      }
                    : t;
            });
        }

        const areaId = area.id;
        await commit(gateway, before, {
            ...before,
            tables,
            areas: created
                ? [...areas, area]
                : areas.map((a) => (a.id === areaId ? area : a)),
        });

        return { areaId, created, tablesMoved: moving.map(tableLabel) };
    },

    auto_arrange: async (args) => {
        const before = await loadTarget(gateway, args.diagramId);
        const tables = before.tables ?? [];

        const arranged = adjustTablePositions({
            tables,
            relationships: before.relationships ?? [],
            areas: before.areas ?? [],
            mode: 'all',
        });

        await commit(gateway, before, {
            ...before,
            tables: tables.map((table) => {
                const next = arranged.find((t) => t.id === table.id);
                return next ? { ...table, x: next.x, y: next.y } : table;
            }),
        });

        return { tablesArranged: tables.length };
    },
});
