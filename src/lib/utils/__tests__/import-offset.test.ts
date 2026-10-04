import { describe, it, expect } from 'vitest';
import type { DBTable } from '@/lib/domain/db-table';
import { getImportOffsetX, offsetTablesX } from '../import-offset';

const table = (x: number, width?: number) => ({ x, width }) as DBTable;

describe('getImportOffsetX', () => {
    it('returns 0 for an empty diagram', () => {
        expect(getImportOffsetX([])).toBe(0);
    });

    it('places new tables 150px right of the rightmost table edge', () => {
        expect(getImportOffsetX([table(0, 300), table(500, 224)])).toBe(
            500 + 224 + 150
        );
    });

    it('uses width 250 when a table has no width', () => {
        expect(getImportOffsetX([table(100)])).toBe(100 + 250 + 150);
    });

    it('picks the table with the largest right edge, not the largest x', () => {
        expect(getImportOffsetX([table(0, 1000), table(200, 100)])).toBe(
            1000 + 150
        );
    });
});

describe('offsetTablesX', () => {
    it('shifts x and leaves other attributes untouched', () => {
        const [moved] = offsetTablesX(
            [{ x: 10, y: 5, name: 't' } as DBTable],
            100
        );
        expect(moved.x).toBe(110);
        expect(moved.y).toBe(5);
        expect(moved.name).toBe('t');
    });
});
