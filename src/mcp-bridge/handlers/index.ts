import type { DiagramGateway } from '../gateway';
import { createCanvasHandlers } from './canvas';
import { createDiagramHandlers } from './diagram';
import { createReadHandlers } from './read';
import { createTableHandlers } from './tables';
import type { ToolHandlers } from './types';

export type { ToolHandlers } from './types';

export const createHandlers = (gateway: DiagramGateway): ToolHandlers => ({
    ...createReadHandlers(gateway),
    ...createDiagramHandlers(gateway),
    ...createTableHandlers(gateway),
    ...createCanvasHandlers(gateway),
});
