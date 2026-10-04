import equal from 'fast-deep-equal';
import type { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { DBField } from '@/lib/domain/db-field';
import type { DBTable } from '@/lib/domain/db-table';
import { importDBMLToDiagram } from '../dbml-import/dbml-import';
import { applyDBMLChanges } from './apply-dbml';

export interface ApplyDBMLSummary {
    tablesAdded: string[];
    tablesRemoved: string[];
    tablesChanged: {
        table: string;
        fieldsAdded: string[];
        fieldsRemoved: string[];
        fieldsChanged: string[];
    }[];
    relationshipsAdded: number;
    relationshipsRemoved: number;
    customTypesAdded: string[];
    customTypesRemoved: string[];
}

const tableLabel = (table: DBTable): string =>
    table.schema ? `${table.schema}.${table.name}` : table.name;

// Fields are compared on their meaningful attributes only. DBML import adds
// optional keys as `undefined` while diagrams built elsewhere omit them, and a
// plain deep-equal would treat those as different, so normalise first.
const comparableField = (field: DBField) => ({
    name: field.name,
    type: field.type.id,
    nullable: field.nullable,
    primaryKey: field.primaryKey,
    unique: field.unique,
    increment: field.increment ?? false,
    isArray: field.isArray ?? false,
    characterMaximumLength: field.characterMaximumLength ?? null,
    precision: field.precision ?? null,
    scale: field.scale ?? null,
    default: field.default ?? null,
    comments: field.comments ?? null,
});

const customTypeLabel = (customType: DBCustomType): string =>
    customType.schema
        ? `${customType.schema}.${customType.name}`
        : customType.name;

const summarizeDBMLChanges = (
    before: Diagram,
    after: Diagram
): ApplyDBMLSummary => {
    const beforeTables = before.tables ?? [];
    const afterTables = after.tables ?? [];
    const beforeTableById = new Map(beforeTables.map((t) => [t.id, t]));
    const afterTableIds = new Set(afterTables.map((t) => t.id));

    const tablesChanged: ApplyDBMLSummary['tablesChanged'] = [];
    for (const afterTable of afterTables) {
        const beforeTable = beforeTableById.get(afterTable.id);
        if (!beforeTable) continue;

        const beforeFieldById = new Map(
            beforeTable.fields.map((f) => [f.id, f])
        );
        const afterFieldIds = new Set(afterTable.fields.map((f) => f.id));

        const fieldsAdded = afterTable.fields
            .filter((f) => !beforeFieldById.has(f.id))
            .map((f) => f.name);
        const fieldsRemoved = beforeTable.fields
            .filter((f) => !afterFieldIds.has(f.id))
            .map((f) => f.name);
        const fieldsChanged = afterTable.fields
            .filter((f) => {
                const previous = beforeFieldById.get(f.id);
                return (
                    !!previous &&
                    !equal(comparableField(previous), comparableField(f))
                );
            })
            .map((f) => f.name);

        if (
            fieldsAdded.length > 0 ||
            fieldsRemoved.length > 0 ||
            fieldsChanged.length > 0
        ) {
            tablesChanged.push({
                table: tableLabel(afterTable),
                fieldsAdded,
                fieldsRemoved,
                fieldsChanged,
            });
        }
    }

    const beforeCustomTypes = before.customTypes ?? [];
    const afterCustomTypes = after.customTypes ?? [];
    const beforeCustomTypeIds = new Set(beforeCustomTypes.map((c) => c.id));
    const afterCustomTypeIds = new Set(afterCustomTypes.map((c) => c.id));

    const beforeRelationshipIds = new Set(
        (before.relationships ?? []).map((r) => r.id)
    );
    const afterRelationshipIds = new Set(
        (after.relationships ?? []).map((r) => r.id)
    );

    return {
        tablesAdded: afterTables
            .filter((t) => !beforeTableById.has(t.id))
            .map(tableLabel),
        tablesRemoved: beforeTables
            .filter((t) => !afterTableIds.has(t.id))
            .map(tableLabel),
        tablesChanged,
        relationshipsAdded: [...afterRelationshipIds].filter(
            (id) => !beforeRelationshipIds.has(id)
        ).length,
        relationshipsRemoved: [...beforeRelationshipIds].filter(
            (id) => !afterRelationshipIds.has(id)
        ).length,
        customTypesAdded: afterCustomTypes
            .filter((c) => !beforeCustomTypeIds.has(c.id))
            .map(customTypeLabel),
        customTypesRemoved: beforeCustomTypes
            .filter((c) => !afterCustomTypeIds.has(c.id))
            .map(customTypeLabel),
    };
};

/**
 * Parse `dbml` and merge it onto `diagram`, keeping ids, positions, colors,
 * areas and notes of everything that still exists. Throws (like
 * `importDBMLToDiagram`) when the DBML is invalid.
 */
export const applyDBMLToDiagram = async ({
    diagram,
    dbml,
    databaseType = diagram.databaseType,
}: {
    diagram: Diagram;
    dbml: string;
    databaseType?: DatabaseType;
}): Promise<{ diagram: Diagram; summary: ApplyDBMLSummary }> => {
    const diagramFromDBML = await importDBMLToDiagram(dbml, { databaseType });

    const targetDiagram: Diagram = {
        ...diagram,
        tables: diagramFromDBML.tables,
        relationships: diagramFromDBML.relationships,
        customTypes: diagramFromDBML.customTypes,
    };

    const newDiagram = applyDBMLChanges({
        sourceDiagram: diagram,
        targetDiagram,
    });

    return {
        diagram: newDiagram,
        summary: summarizeDBMLChanges(diagram, newDiagram),
    };
};
