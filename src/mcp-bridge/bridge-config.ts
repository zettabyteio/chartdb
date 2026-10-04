// The bridge is off unless VITE_MCP_BRIDGE_URL is set at build/dev time.
// The token ends up in the JS bundle: use for local development only.
// Only loopback hosts are accepted, so the token can never be sent elsewhere.
export const isLoopbackUrl = (url: string): boolean => {
    try {
        const { hostname } = new URL(url);
        return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
    } catch {
        return false;
    }
};

const rawUrl: string | undefined =
    import.meta.env.VITE_MCP_BRIDGE_URL || undefined;

if (rawUrl && !isLoopbackUrl(rawUrl)) {
    console.error(
        `[mcp-bridge] ignoring VITE_MCP_BRIDGE_URL: only loopback hosts are allowed (got ${rawUrl}).`
    );
}

export const MCP_BRIDGE_URL: string | undefined =
    rawUrl && isLoopbackUrl(rawUrl) ? rawUrl : undefined;
export const MCP_BRIDGE_TOKEN: string =
    import.meta.env.VITE_MCP_BRIDGE_TOKEN ?? '';
