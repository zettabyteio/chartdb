import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { clientMessageSchema } from '../../src/mcp-bridge/protocol';
import type { ClientMessage, ToolName } from '../../src/mcp-bridge/protocol';

export interface ToolBackend {
    call(tool: ToolName, args: unknown): Promise<unknown>;
}

export interface BridgeServerOptions {
    port: number;
    token: string;
    allowedOrigins: string[];
    host?: string;
    callTimeoutMs?: number;
    helloTimeoutMs?: number;
}

interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    socket: WebSocket;
}

const POLICY_VIOLATION = 1008;
// Custom close code: the tab must NOT reconnect after being replaced.
const REPLACED_BY_NEWER_TAB = 4001;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

const tokensMatch = (given: string, expected: string): boolean => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};

export class BridgeServer implements ToolBackend {
    private wss?: WebSocketServer;
    private tab?: WebSocket;
    private readonly pending = new Map<string, PendingCall>();

    constructor(private readonly options: BridgeServerOptions) {}

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            const wss = new WebSocketServer({
                host: this.options.host ?? '127.0.0.1',
                port: this.options.port,
                maxPayload: MAX_PAYLOAD_BYTES,
            });
            this.wss = wss;

            let listening = false;
            wss.on('listening', () => {
                listening = true;
                resolve();
            });
            wss.on('error', (error) => {
                if (listening) {
                    console.error('[chartdb-mcp] bridge error:', error.message);
                } else {
                    reject(error);
                }
            });
            wss.on('connection', (socket, request) =>
                this.onConnection(socket, request.headers.origin)
            );
        });
    }

    get port(): number {
        const address = this.wss?.address();
        if (!address || typeof address === 'string') {
            throw new Error('Bridge server is not listening.');
        }
        return (address as AddressInfo).port;
    }

    call(tool: ToolName, args: unknown): Promise<unknown> {
        const tab = this.tab;
        if (!tab) {
            return Promise.reject(
                new Error(
                    'No ChartDB tab is connected. Open the app in a browser with VITE_MCP_BRIDGE_URL and VITE_MCP_BRIDGE_TOKEN set (npm run dev), then retry.'
                )
            );
        }

        const timeoutMs = this.options.callTimeoutMs ?? 30_000;
        const id = randomUUID();

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new Error(
                        `Timed out after ${timeoutMs}ms waiting for the ChartDB tab to answer.`
                    )
                );
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer, socket: tab });
            tab.send(JSON.stringify({ type: 'call', id, tool, args }));
        });
    }

    async stop(): Promise<void> {
        for (const [id, call] of this.pending) {
            clearTimeout(call.timer);
            this.pending.delete(id);
            call.reject(new Error('The MCP bridge server stopped.'));
        }

        const wss = this.wss;
        this.wss = undefined;
        this.tab = undefined;
        if (!wss) return;

        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
    }

    private onConnection(socket: WebSocket, origin: string | undefined) {
        if (!origin || !this.options.allowedOrigins.includes(origin)) {
            socket.close(POLICY_VIOLATION, 'origin not allowed');
            return;
        }

        let authenticated = false;
        const helloTimer = setTimeout(
            () => socket.close(POLICY_VIOLATION, 'hello timeout'),
            this.options.helloTimeoutMs ?? 5_000
        );

        socket.on('message', (raw) => {
            let message: ClientMessage;
            try {
                const parsed = clientMessageSchema.safeParse(
                    JSON.parse(raw.toString())
                );
                if (!parsed.success) throw new Error('invalid');
                message = parsed.data;
            } catch {
                socket.close(POLICY_VIOLATION, 'invalid message');
                return;
            }

            if (!authenticated) {
                if (
                    message.type === 'hello' &&
                    tokensMatch(message.token, this.options.token)
                ) {
                    authenticated = true;
                    clearTimeout(helloTimer);
                    this.adopt(socket);
                    socket.send(JSON.stringify({ type: 'ready' }));
                } else {
                    socket.close(POLICY_VIOLATION, 'authentication failed');
                }
                return;
            }

            if (message.type === 'result') {
                this.settle(socket, message);
            }
        });

        socket.on('close', () => {
            clearTimeout(helloTimer);
            this.release(socket);
        });

        // A socket error is always followed by 'close'; nothing else to do.
        socket.on('error', () => {});
    }

    private adopt(socket: WebSocket) {
        if (this.tab && this.tab !== socket) {
            this.tab.close(REPLACED_BY_NEWER_TAB, 'replaced by a newer tab');
        }
        this.tab = socket;
    }

    private release(socket: WebSocket) {
        if (this.tab === socket) {
            this.tab = undefined;
        }

        for (const [id, call] of this.pending) {
            if (call.socket === socket) {
                clearTimeout(call.timer);
                this.pending.delete(id);
                call.reject(
                    new Error(
                        'The ChartDB tab disconnected before answering. Reload the tab and retry.'
                    )
                );
            }
        }
    }

    private settle(
        from: WebSocket,
        message: Extract<ClientMessage, { type: 'result' }>
    ) {
        const call = this.pending.get(message.id);
        if (!call || call.socket !== from) return;

        clearTimeout(call.timer);
        this.pending.delete(message.id);

        if (message.ok) {
            call.resolve(message.data);
        } else {
            call.reject(
                new Error(
                    message.error ?? 'Unknown error from the ChartDB tab.'
                )
            );
        }
    }
}
