import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolBackend } from './bridge-server';

type DiagramFormat = 'dbml' | 'json';

const registerDiagramResource = (
    server: McpServer,
    backend: ToolBackend,
    format: DiagramFormat,
    mimeType: string
) => {
    server.registerResource(
        `diagram-${format}`,
        new ResourceTemplate(`chartdb://diagrams/{id}.${format}`, {
            list: async () => {
                try {
                    const diagrams = (await backend.call(
                        'list_diagrams',
                        {}
                    )) as { id: string; name: string }[];

                    return {
                        resources: diagrams.map((diagram) => ({
                            uri: `chartdb://diagrams/${diagram.id}.${format}`,
                            name: `${diagram.name} (${format.toUpperCase()})`,
                            mimeType,
                        })),
                    };
                } catch {
                    // No tab connected yet: advertise nothing rather than fail the listing.
                    return { resources: [] };
                }
            },
        }),
        {
            title: `ChartDB diagram as ${format.toUpperCase()}`,
            description: `The current content of a ChartDB diagram as ${format.toUpperCase()}.`,
            mimeType,
        },
        async (uri, variables) => {
            const text = await backend.call('get_diagram', {
                diagramId: String(variables.id),
                format,
            });
            return {
                contents: [{ uri: uri.href, mimeType, text: String(text) }],
            };
        }
    );
};

export const registerResources = (
    server: McpServer,
    backend: ToolBackend
): void => {
    registerDiagramResource(server, backend, 'dbml', 'text/plain');
    registerDiagramResource(server, backend, 'json', 'application/json');
};
