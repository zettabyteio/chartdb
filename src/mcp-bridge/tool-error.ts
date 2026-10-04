import { parseDBMLError } from '@/lib/dbml/dbml-import/dbml-import-error';

/** An error whose message is safe and useful to show to the AI client. */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ToolError';
    }
}

export const describeError = (error: unknown): string => {
    const dbmlError = parseDBMLError(error);
    if (dbmlError) {
        return `line ${dbmlError.line}, column ${dbmlError.column}: ${dbmlError.message}`;
    }
    return error instanceof Error ? error.message : String(error);
};
