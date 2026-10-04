import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { ToolBackend } from '../bridge-server';
import { registerResources } from '../resources';

const setup = async (backend: ToolBackend) => {
    const server = new McpServer({ name: 'chartdb-test', version: '0.0.0' });
    registerResources(server, backend);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    return client;
};

describe('registerResources', () => {
    it('lists a DBML and a JSON resource per diagram', async () => {
        const call = vi.fn(async () => [{ id: 'abc', name: 'Shop' }]);
        const client = await setup({ call });

        const { resources } = await client.listResources();

        expect(call).toHaveBeenCalledWith('list_diagrams', {});
        expect(resources.map((r) => r.uri).sort()).toEqual([
            'chartdb://diagrams/abc.dbml',
            'chartdb://diagrams/abc.json',
        ]);
    });

    it('lists nothing (instead of failing) when no tab is connected', async () => {
        const client = await setup({
            call: vi.fn(async () => {
                throw new Error('No ChartDB tab is connected.');
            }),
        });
        expect((await client.listResources()).resources).toEqual([]);
    });

    it('reads DBML through get_diagram', async () => {
        const call = vi.fn(async () => 'Table t {}');
        const client = await setup({ call });

        const result = await client.readResource({
            uri: 'chartdb://diagrams/abc.dbml',
        });

        expect(call).toHaveBeenCalledWith('get_diagram', {
            diagramId: 'abc',
            format: 'dbml',
        });
        expect(result.contents[0]).toMatchObject({
            uri: 'chartdb://diagrams/abc.dbml',
            text: 'Table t {}',
        });
    });

    it('reads JSON through get_diagram', async () => {
        const call = vi.fn(async () => '{"name":"Shop"}');
        const client = await setup({ call });

        const result = await client.readResource({
            uri: 'chartdb://diagrams/abc.json',
        });

        expect(call).toHaveBeenCalledWith('get_diagram', {
            diagramId: 'abc',
            format: 'json',
        });
        expect(result.contents[0]).toMatchObject({
            mimeType: 'application/json',
            text: '{"name":"Shop"}',
        });
    });
});
