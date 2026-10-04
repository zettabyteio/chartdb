import type { Diagram } from '@/lib/domain/diagram';
import { ToolError, describeError } from './tool-error';

export interface DiagramGateway {
    currentDiagramId(): string | undefined;
    isReadonly(): boolean;
    list(): Promise<Diagram[]>;
    load(id: string): Promise<Diagram | undefined>;
    /** Replace an existing diagram (tables, relationships, areas, notes...). */
    save(diagram: Diagram): Promise<void>;
    /** Add a brand-new diagram. */
    create(diagram: Diagram): Promise<void>;
    remove(id: string): Promise<void>;
}

export const loadTarget = async (
    gateway: DiagramGateway,
    diagramId?: string
): Promise<Diagram> => {
    const id = diagramId ?? gateway.currentDiagramId();

    if (!id) {
        throw new ToolError(
            'No diagram is open in the app and no diagramId was given. Call list_diagrams, then pass diagramId.'
        );
    }

    const diagram = await gateway.load(id);

    if (!diagram) {
        throw new ToolError(
            `Diagram '${id}' not found. Call list_diagrams to see valid ids.`
        );
    }

    return diagram;
};

export const assertWritable = (
    gateway: DiagramGateway,
    diagramId: string
): void => {
    if (gateway.isReadonly() && diagramId === gateway.currentDiagramId()) {
        throw new ToolError(
            'The open diagram is in read-only diff-review mode. Accept or cancel the pending DBML changes in the app, then retry.'
        );
    }
};

/** Save `after`; if saving fails, restore `before` and report the failure. */
export const commit = async (
    gateway: DiagramGateway,
    before: Diagram,
    after: Diagram
): Promise<void> => {
    assertWritable(gateway, before.id);

    try {
        await gateway.save({ ...after, updatedAt: new Date() });
    } catch (error) {
        try {
            await gateway.save(before);
        } catch {
            // Best effort: the original failure is the one worth reporting.
        }
        throw new ToolError(
            `Saving failed and the previous state was restored. Cause: ${describeError(error)}`
        );
    }
};
