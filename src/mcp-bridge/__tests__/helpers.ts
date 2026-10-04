import { z } from 'zod';
import { DatabaseType } from '@/lib/domain/database-type';
import type { Diagram } from '@/lib/domain/diagram';
import { importDBMLToDiagram } from '@/lib/dbml/dbml-import/dbml-import';
import type { DiagramGateway } from '../gateway';
import type { ToolHandlers } from '../handlers/types';
import { toolInputShapes } from '../protocol';
import type { ToolName } from '../protocol';

export const USERS_POSTS_DBML = `
Table users {
  id integer [pk]
  email varchar(255) [not null]
}

Table posts {
  id integer [pk]
  user_id integer [not null]
  title varchar(200)
}

Ref: posts.user_id > users.id
`;

export const diagramFromDbml = async (
    dbml: string = USERS_POSTS_DBML,
    { id = 'd1', name = 'Test diagram' } = {}
): Promise<Diagram> => {
    const diagram = await importDBMLToDiagram(dbml, {
        databaseType: DatabaseType.POSTGRESQL,
    });
    return { ...diagram, id, name };
};

export const createMemoryGateway = ({
    diagrams,
    currentId,
    readonly = false,
    failSaves = 0,
}: {
    diagrams: Diagram[];
    currentId?: string;
    readonly?: boolean;
    failSaves?: number;
}) => {
    const store = new Map<string, Diagram>(
        diagrams.map((d) => [d.id, structuredClone(d)] as const)
    );
    const saves: Diagram[] = [];
    let remainingFailures = failSaves;

    const gateway: DiagramGateway = {
        currentDiagramId: () => currentId,
        isReadonly: () => readonly,
        list: async () => [...store.values()],
        load: async (id) => store.get(id),
        save: async (diagram) => {
            if (remainingFailures > 0) {
                remainingFailures -= 1;
                throw new Error('disk full');
            }
            saves.push(diagram);
            store.set(diagram.id, diagram);
        },
        create: async (diagram) => {
            store.set(diagram.id, diagram);
        },
        remove: async (id) => {
            store.delete(id);
        },
    };

    return { gateway, store, saves };
};

/** Run a tool exactly like the bridge client does: parse args, then call. */
export const run = async <K extends ToolName>(
    handlers: Partial<ToolHandlers>,
    tool: K,
    args: z.input<z.ZodObject<(typeof toolInputShapes)[K]>>
): Promise<unknown> => {
    const handler = handlers[tool] as
        | ((a: unknown) => Promise<unknown>)
        | undefined;
    if (!handler) {
        throw new Error(`No handler registered for ${tool}`);
    }
    return handler(z.object(toolInputShapes[tool]).parse(args));
};
