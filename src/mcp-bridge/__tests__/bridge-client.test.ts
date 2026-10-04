import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBridge } from '../bridge-client';
import type { ToolHandlers } from '../handlers/types';
import { ToolError } from '../tool-error';

class FakeSocket {
    static instances: FakeSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason?: string }) => void;
    constructor(public url: string) {
        FakeSocket.instances.push(this);
    }
    send(data: string) {
        this.sent.push(data);
    }
    close(code = 1000) {
        this.onclose?.({ code });
    }
    receive(message: object) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
    sentMessages() {
        return this.sent.map((s) => JSON.parse(s));
    }
}

const WS = FakeSocket as unknown as typeof WebSocket;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    FakeSocket.instances = [];
});
afterEach(() => {
    vi.useRealTimers();
});

const connect = (handlers: Partial<ToolHandlers>, extra = {}) =>
    connectBridge({
        url: 'ws://127.0.0.1:8765',
        token: 'secret-token',
        handlers: handlers as ToolHandlers,
        WebSocketImpl: WS,
        ...extra,
    });

describe('bridge client', () => {
    it('sends hello with the token when the socket opens', () => {
        connect({});
        const socket = FakeSocket.instances[0];
        socket.onopen?.();
        expect(socket.sentMessages()).toEqual([
            { type: 'hello', token: 'secret-token' },
        ]);
    });

    it('runs a call and replies with the result', async () => {
        const list_diagrams = vi.fn(async () => [{ id: 'a' }]);
        connect({ list_diagrams });
        const socket = FakeSocket.instances[0];

        socket.receive({
            type: 'call',
            id: '1',
            tool: 'list_diagrams',
            args: {},
        });
        await flush();

        expect(list_diagrams).toHaveBeenCalled();
        expect(socket.sentMessages()).toEqual([
            { type: 'result', id: '1', ok: true, data: [{ id: 'a' }] },
        ]);
    });

    it('validates arguments and applies defaults before calling', async () => {
        const apply_dbml = vi.fn(async () => ({ applied: true }));
        connect({ apply_dbml });
        const socket = FakeSocket.instances[0];

        socket.receive({
            type: 'call',
            id: '1',
            tool: 'apply_dbml',
            args: { dbml: 'x' },
        });
        await flush();
        expect(apply_dbml).toHaveBeenCalledWith({
            dbml: 'x',
            dryRun: false,
            allowDrops: false,
        });

        socket.receive({
            type: 'call',
            id: '2',
            tool: 'apply_dbml',
            args: {},
        });
        await flush();
        const reply = socket.sentMessages().find((m) => m.id === '2');
        expect(reply.ok).toBe(false);
        expect(reply.error).toMatch(/Invalid arguments: dbml/);
    });

    it('reports unknown tools', async () => {
        connect({});
        const socket = FakeSocket.instances[0];
        socket.receive({
            type: 'call',
            id: '1',
            tool: 'drop_everything',
            args: {},
        });
        socket.receive({
            type: 'call',
            id: '2',
            tool: 'constructor',
            args: {},
        });
        await flush();
        await flush();
        expect(socket.sentMessages()[0]).toMatchObject({
            ok: false,
            error: "Unknown tool 'drop_everything'",
        });
        expect(socket.sentMessages()[1]).toMatchObject({
            ok: false,
            error: "Unknown tool 'constructor'",
        });
    });

    it('passes ToolError messages through and hides stack traces of other errors', async () => {
        const rename_diagram = vi
            .fn()
            .mockRejectedValueOnce(new ToolError('Diagram not found'))
            .mockRejectedValueOnce(new Error('boom'));
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        connect({ rename_diagram });
        const socket = FakeSocket.instances[0];

        socket.receive({
            type: 'call',
            id: '1',
            tool: 'rename_diagram',
            args: { name: 'x' },
        });
        socket.receive({
            type: 'call',
            id: '2',
            tool: 'rename_diagram',
            args: { name: 'x' },
        });
        await flush();
        await flush();

        const [first, second] = socket.sentMessages();
        expect(first.error).toBe('Diagram not found');
        expect(second.error).toBe('Unexpected error: boom');
        spy.mockRestore();
    });

    it('runs calls one at a time, in order', async () => {
        const order: string[] = [];
        const list_diagrams = vi.fn(async () => {
            order.push('start');
            await new Promise((r) => setTimeout(r, 10));
            order.push('end');
            return [];
        });
        connect({ list_diagrams });
        const socket = FakeSocket.instances[0];

        socket.receive({
            type: 'call',
            id: '1',
            tool: 'list_diagrams',
            args: {},
        });
        socket.receive({
            type: 'call',
            id: '2',
            tool: 'list_diagrams',
            args: {},
        });
        await new Promise((r) => setTimeout(r, 50));

        expect(order).toEqual(['start', 'end', 'start', 'end']);
        expect(socket.sentMessages().map((m) => m.id)).toEqual(['1', '2']);
    });

    it('ignores malformed messages', async () => {
        connect({});
        const socket = FakeSocket.instances[0];
        socket.onmessage?.({ data: 'not json' });
        socket.receive({ type: 'nonsense' });
        await flush();
        expect(socket.sent).toEqual([]);
    });

    it('reconnects with backoff after the socket closes, and stops on disconnect', () => {
        vi.useFakeTimers();
        const disconnect = connect({}, { reconnectDelaysMs: [100, 200] });
        expect(FakeSocket.instances).toHaveLength(1);

        FakeSocket.instances[0].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(99);
        expect(FakeSocket.instances).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(FakeSocket.instances).toHaveLength(2);

        FakeSocket.instances[1].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(200);
        expect(FakeSocket.instances).toHaveLength(3);

        disconnect();
        vi.advanceTimersByTime(10_000);
        expect(FakeSocket.instances).toHaveLength(3);
    });

    it('does not reconnect after being replaced (4001) or rejected (1008)', () => {
        vi.useFakeTimers();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        connect({}, { reconnectDelaysMs: [100] });

        FakeSocket.instances[0].onclose?.({
            code: 4001,
            reason: 'replaced by a newer tab',
        });
        vi.advanceTimersByTime(10_000);
        expect(FakeSocket.instances).toHaveLength(1);

        connect({}, { reconnectDelaysMs: [100] });
        FakeSocket.instances[1].onclose?.({
            code: 1008,
            reason: 'authentication failed',
        });
        vi.advanceTimersByTime(10_000);
        expect(FakeSocket.instances).toHaveLength(2);
        spy.mockRestore();
    });

    it('resets the backoff after a ready message', () => {
        vi.useFakeTimers();
        connect({}, { reconnectDelaysMs: [100, 5000] });

        FakeSocket.instances[0].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(100);
        FakeSocket.instances[1].receive({ type: 'ready' });
        FakeSocket.instances[1].onclose?.({ code: 1006 });
        vi.advanceTimersByTime(100);

        expect(FakeSocket.instances).toHaveLength(3);
    });
});
