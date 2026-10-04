import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeServer } from './bridge-server';
import { loadConfig } from './config';
import { registerResources } from './resources';
import { registerTools } from './tools';

// stdout is reserved for MCP protocol frames: log to stderr only.
const main = async () => {
    const config = loadConfig(process.env);

    const bridge = new BridgeServer(config);
    await bridge.start();

    const server = new McpServer({ name: 'chartdb', version: '0.1.0' });
    registerTools(server, bridge);
    registerResources(server, bridge);

    await server.connect(new StdioServerTransport());
    const shutdown = async () => {
        await bridge.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // The MCP client closed our stdin: stop the bridge and let the process end.
    process.stdin.on('end', () => {
        void bridge.stop();
    });

    // Logged last, after the handlers exist, so "ready" means signals are safe.
    console.error(
        `[chartdb-mcp] ready. Bridge listening on ws://127.0.0.1:${config.port}`
    );
};

main().catch((error: unknown) => {
    const code =
        error instanceof Error && 'code' in error
            ? (error as Error & { code?: string }).code
            : undefined;
    const message = error instanceof Error ? error.message : String(error);
    console.error(
        code === 'EADDRINUSE'
            ? `[chartdb-mcp] port already in use. Another chartdb-mcp is probably running; set CHARTDB_MCP_PORT (and VITE_MCP_BRIDGE_URL in the app) to a free port.`
            : `[chartdb-mcp] ${message}`
    );
    process.exit(1);
});
