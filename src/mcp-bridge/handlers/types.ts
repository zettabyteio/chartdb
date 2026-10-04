import type { ToolArgs, ToolName } from '../protocol';

export type ToolHandlers = {
    [K in ToolName]: (args: ToolArgs<K>) => Promise<unknown>;
};
