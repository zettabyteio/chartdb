import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { toolNames } from '../../../src/mcp-bridge/protocol';
import type { ToolBackend } from '../bridge-server';
import { formatResult, registerTools } from '../tools';

const setup = async (backend: ToolBackend) => {
    const server = new McpServer({ name: 'chartdb-test', version: '0.0.0' });
    registerTools(server, backend);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    return client;
};

const textOf = (result: unknown): string =>
    (result as { content: { text: string }[] }).content[0].text;

describe('formatResult', () => {
    it('passes strings through and pretty-prints everything else', () => {
        expect(formatResult('Table t {}')).toBe('Table t {}');
        expect(formatResult({ a: 1 })).toBe('{\n  "a": 1\n}');
        expect(formatResult(undefined)).toBe('ok');
    });
});

describe('registerTools', () => {
    it('exposes all 13 tools with safety annotations', async () => {
        const client = await setup({ call: vi.fn() });
        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name).sort()).toEqual([...toolNames].sort());
        const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
        expect(byName.get_diagram.annotations?.readOnlyHint).toBe(true);
        expect(byName.delete_diagram.annotations?.destructiveHint).toBe(true);
        expect(byName.upsert_note.annotations?.readOnlyHint).toBe(false);
        for (const tool of tools) {
            expect(tool.description?.length ?? 0).toBeGreaterThan(10);
        }
    });

    it('forwards the call and returns pretty JSON', async () => {
        const call = vi.fn(async () => [{ id: 'a' }]);
        const client = await setup({ call });

        const result = await client.callTool({
            name: 'list_diagrams',
            arguments: {},
        });

        expect(call).toHaveBeenCalledWith('list_diagrams', {});
        expect(textOf(result)).toContain('"id": "a"');
    });

    it('returns string results verbatim', async () => {
        const client = await setup({ call: vi.fn(async () => 'Table t {}') });
        const result = await client.callTool({
            name: 'get_diagram',
            arguments: {},
        });
        expect(textOf(result)).toBe('Table t {}');
    });

    it('applies schema defaults before forwarding', async () => {
        const call = vi.fn(async () => ({ applied: true }));
        const client = await setup({ call });

        await client.callTool({ name: 'apply_dbml', arguments: { dbml: 'x' } });

        expect(call).toHaveBeenCalledWith('apply_dbml', {
            dbml: 'x',
            dryRun: false,
            allowDrops: false,
        });
    });

    it('turns backend failures into tool errors the model can read', async () => {
        const client = await setup({
            call: vi.fn(async () => {
                throw new Error('No ChartDB tab is connected.');
            }),
        });

        const result = await client.callTool({
            name: 'list_diagrams',
            arguments: {},
        });

        expect((result as { isError?: boolean }).isError).toBe(true);
        expect(textOf(result)).toBe('No ChartDB tab is connected.');
    });

    it('rejects invalid arguments without calling the backend', async () => {
        const call = vi.fn();
        const client = await setup({ call });

        const outcome = await client
            .callTool({ name: 'rename_diagram', arguments: {} })
            .catch((error: unknown) => error);

        const failed =
            outcome instanceof Error ||
            (outcome as { isError?: boolean }).isError === true;
        expect(failed).toBe(true);
        expect(call).not.toHaveBeenCalled();
    });
});
