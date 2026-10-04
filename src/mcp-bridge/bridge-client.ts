import { z } from 'zod';
import type { ToolHandlers } from './handlers/types';
import { serverMessageSchema, toolInputShapes } from './protocol';
import type { ToolName } from './protocol';
import { ToolError } from './tool-error';

const SOCKET_OPEN = 1;
const TAB_REPLACED = 4001;
const POLICY_VIOLATION = 1008;

export interface BridgeClientOptions {
    url: string;
    token: string;
    handlers: ToolHandlers;
    WebSocketImpl?: typeof WebSocket;
    reconnectDelaysMs?: number[];
}

/** Connects to the MCP bridge server and serves tool calls. Returns a disconnect function. */
export const connectBridge = ({
    url,
    token,
    handlers,
    WebSocketImpl = WebSocket,
    reconnectDelaysMs = [1000, 2000, 5000, 10000],
}: BridgeClientOptions): (() => void) => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;
    // Calls run strictly one at a time so read-modify-write cycles never overlap.
    let queue: Promise<void> = Promise.resolve();

    const runCall = async (
        connection: WebSocket,
        id: string,
        tool: string,
        args: unknown
    ) => {
        const reply = (payload: {
            ok: boolean;
            data?: unknown;
            error?: string;
        }) => {
            if (connection.readyState === SOCKET_OPEN) {
                connection.send(
                    JSON.stringify({ type: 'result', id, ...payload })
                );
            }
        };

        if (!Object.hasOwn(toolInputShapes, tool)) {
            reply({ ok: false, error: `Unknown tool '${tool}'` });
            return;
        }

        const name = tool as ToolName;
        const parsed = z.object(toolInputShapes[name]).safeParse(args ?? {});
        if (!parsed.success) {
            const issues = parsed.error.issues
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; ');
            reply({ ok: false, error: `Invalid arguments: ${issues}` });
            return;
        }

        try {
            const handler = handlers[name] as (a: unknown) => Promise<unknown>;
            reply({ ok: true, data: await handler(parsed.data) });
        } catch (error) {
            if (error instanceof ToolError) {
                reply({ ok: false, error: error.message });
                return;
            }
            console.error('[mcp-bridge] unexpected error', error);
            reply({
                ok: false,
                error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    };

    const open = () => {
        const connection = new WebSocketImpl(url);
        socket = connection;

        connection.onopen = () => {
            connection.send(JSON.stringify({ type: 'hello', token }));
        };

        connection.onmessage = (event) => {
            let message: z.infer<typeof serverMessageSchema>;
            try {
                const parsed = serverMessageSchema.safeParse(
                    JSON.parse(String(event.data))
                );
                if (!parsed.success) return;
                message = parsed.data;
            } catch {
                return;
            }

            if (message.type === 'ready') {
                attempt = 0;
                return;
            }

            const call = message;
            queue = queue.then(() =>
                runCall(connection, call.id, call.tool, call.args)
            );
        };

        connection.onclose = (event) => {
            if (stopped) return;
            // 4001: the server replaced this tab with a newer one. 1008: the
            // server rejected us (bad token / origin). Reconnecting would either
            // fight the other tab forever or hammer the server with bad credentials.
            if (
                event.code === TAB_REPLACED ||
                event.code === POLICY_VIOLATION
            ) {
                console.error(
                    `[mcp-bridge] disconnected (${event.code}${event.reason ? `: ${event.reason}` : ''}); not reconnecting. Reload the tab to reconnect.`
                );
                return;
            }
            const delay =
                reconnectDelaysMs[
                    Math.min(attempt, reconnectDelaysMs.length - 1)
                ];
            attempt += 1;
            timer = setTimeout(open, delay);
        };
    };

    open();

    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        socket?.close();
    };
};
