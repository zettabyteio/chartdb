export interface ServerConfig {
    port: number;
    token: string;
    allowedOrigins: string[];
}

const DEFAULT_PORT = '8765';
// 5173 = `npm run dev`, 4173 = `npm run preview` (production build served locally).
const DEFAULT_ORIGINS =
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173';

export const loadConfig = (
    env: Record<string, string | undefined>
): ServerConfig => {
    const token = env.CHARTDB_MCP_TOKEN ?? '';
    if (token.length === 0) {
        throw new Error(
            'CHARTDB_MCP_TOKEN is not set. Generate one with `openssl rand -hex 16` and set it for both this server and the app (VITE_MCP_BRIDGE_TOKEN).'
        );
    }
    if (token.length < 16) {
        throw new Error(
            'CHARTDB_MCP_TOKEN must be at least 16 characters long.'
        );
    }

    const rawPort = env.CHARTDB_MCP_PORT ?? DEFAULT_PORT;
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`CHARTDB_MCP_PORT is not a valid port: '${rawPort}'.`);
    }

    const allowedOrigins = (env.CHARTDB_MCP_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS)
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);

    return { port, token, allowedOrigins };
};
