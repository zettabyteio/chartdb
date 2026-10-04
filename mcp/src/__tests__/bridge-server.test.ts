import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeServer } from '../bridge-server';

type Msg = Record<string, unknown>;

const TOKEN = 'test-token-0123456789';
const ORIGIN = 'http://localhost:5173';

class TestTab {
    readonly ws: WebSocket;
    readonly opened: Promise<void>;
    readonly closeCode: Promise<number>;
    private queue: Msg[] = [];
    private waiters: ((message: Msg) => void)[] = [];

    constructor(port: number, origin: string | null = ORIGIN) {
        this.ws = new WebSocket(
            `ws://127.0.0.1:${port}`,
            origin !== null ? { origin } : undefined
        );
        this.ws.on('message', (data) => {
            const message = JSON.parse(data.toString()) as Msg;
            const waiter = this.waiters.shift();
            if (waiter) waiter(message);
            else this.queue.push(message);
        });
        this.closeCode = new Promise((resolve) =>
            this.ws.on('close', (code) => resolve(code))
        );
        this.opened = new Promise((resolve, reject) => {
            this.ws.once('open', () => resolve());
            this.ws.once('error', reject);
        });
    }

    send(message: Msg | string) {
        this.ws.send(
            typeof message === 'string' ? message : JSON.stringify(message)
        );
    }

    next(): Promise<Msg> {
        const message = this.queue.shift();
        return message
            ? Promise.resolve(message)
            : new Promise((resolve) => this.waiters.push(resolve));
    }
}

let server: BridgeServer;
const tabs: TestTab[] = [];

const startServer = async (overrides = {}) => {
    server = new BridgeServer({
        port: 0,
        token: TOKEN,
        allowedOrigins: [ORIGIN],
        ...overrides,
    });
    await server.start();
};

const connect = async (token = TOKEN) => {
    const tab = new TestTab(server.port);
    tabs.push(tab);
    await tab.opened;
    tab.send({ type: 'hello', token });
    expect(await tab.next()).toEqual({ type: 'ready' });
    return tab;
};

beforeEach(async () => {
    await startServer();
});

afterEach(async () => {
    for (const tab of tabs.splice(0)) tab.ws.terminate();
    await server.stop();
});

describe('handshake', () => {
    it('rejects a disallowed Origin', async () => {
        const tab = new TestTab(server.port, 'http://evil.test');
        tabs.push(tab);
        expect(await tab.closeCode).toBe(1008);
    });

    it('rejects a missing Origin', async () => {
        const tab = new TestTab(server.port, null);
        tabs.push(tab);
        expect(await tab.closeCode).toBe(1008);
    });

    it('rejects a wrong token', async () => {
        const tab = new TestTab(server.port);
        tabs.push(tab);
        await tab.opened;
        tab.send({ type: 'hello', token: 'x'.repeat(TOKEN.length) });
        expect(await tab.closeCode).toBe(1008);
    });

    it('rejects a token of a different length', async () => {
        const tab = new TestTab(server.port);
        tabs.push(tab);
        await tab.opened;
        tab.send({ type: 'hello', token: 'short' });
        expect(await tab.closeCode).toBe(1008);
    });

    it('rejects a first message that is not hello', async () => {
        const tab = new TestTab(server.port);
        tabs.push(tab);
        await tab.opened;
        tab.send({ type: 'result', id: '1', ok: true });
        expect(await tab.closeCode).toBe(1008);
    });

    it('closes when no hello arrives in time', async () => {
        await server.stop();
        await startServer({ helloTimeoutMs: 50 });
        const tab = new TestTab(server.port);
        tabs.push(tab);
        expect(await tab.closeCode).toBe(1008);
    });

    it('closes on malformed JSON after authentication', async () => {
        const tab = await connect();
        tab.send('this is not json');
        expect(await tab.closeCode).toBe(1008);
    });

    it('does not let a rejected socket authenticate with a later valid hello', async () => {
        const tab = new TestTab(server.port);
        tabs.push(tab);
        const received: Msg[] = [];
        tab.ws.on('message', (data) =>
            received.push(JSON.parse(data.toString()) as Msg)
        );
        await tab.opened;
        // Back to back, same tick: the socket is CLOSING when the second
        // frame is processed.
        tab.send({ type: 'hello', token: 'x'.repeat(TOKEN.length) });
        tab.send({ type: 'hello', token: TOKEN });

        expect(await tab.closeCode).toBe(1008);
        expect(received).toEqual([]);
        await expect(server.call('list_diagrams', {})).rejects.toThrow(
            /No ChartDB tab is connected/
        );
    });

    it('does not kick the authenticated tab when a rejected socket then sends a valid hello', async () => {
        const first = await connect();
        let firstClosed = false;
        void first.closeCode.then(() => (firstClosed = true));

        const rejectedTab = new TestTab(server.port);
        tabs.push(rejectedTab);
        await rejectedTab.opened;
        rejectedTab.send({ type: 'hello', token: 'x'.repeat(TOKEN.length) });
        rejectedTab.send({ type: 'hello', token: TOKEN });
        expect(await rejectedTab.closeCode).toBe(1008);

        expect(firstClosed).toBe(false);
        const promise = server.call('list_diagrams', {});
        const call = await first.next();
        first.send({ type: 'result', id: call.id, ok: true, data: ['ok'] });
        await expect(promise).resolves.toEqual(['ok']);
    });

    it('never delivers calls to an unauthenticated socket', async () => {
        const tab = new TestTab(server.port);
        tabs.push(tab);
        await tab.opened;
        await expect(server.call('list_diagrams', {})).rejects.toThrow(
            /No ChartDB tab is connected/
        );
    });
});

describe('call', () => {
    it('fails with guidance when no tab is connected', async () => {
        await expect(server.call('list_diagrams', {})).rejects.toThrow(
            /No ChartDB tab is connected.*VITE_MCP_BRIDGE_URL/
        );
    });

    it('relays a call and resolves with the tab result', async () => {
        const tab = await connect();
        const promise = server.call('get_diagram', { format: 'dbml' });

        const call = await tab.next();
        expect(call).toMatchObject({
            type: 'call',
            tool: 'get_diagram',
            args: { format: 'dbml' },
        });

        tab.send({
            type: 'result',
            id: call.id,
            ok: true,
            data: 'Table t {}',
        });
        await expect(promise).resolves.toBe('Table t {}');
    });

    it('rejects with the tab error message', async () => {
        const tab = await connect();
        const promise = server.call('delete_diagram', {});
        const call = await tab.next();

        tab.send({
            type: 'result',
            id: call.id,
            ok: false,
            error: 'not found',
        });
        await expect(promise).rejects.toThrow('not found');
    });

    it('times out when the tab never answers', async () => {
        await server.stop();
        await startServer({ callTimeoutMs: 50 });
        await connect();
        await expect(server.call('list_diagrams', {})).rejects.toThrow(
            /Timed out after 50ms/
        );
    });

    it('ignores results for unknown ids', async () => {
        const tab = await connect();
        tab.send({ type: 'result', id: 'nope', ok: true, data: 1 });
        const promise = server.call('list_diagrams', {});
        const call = await tab.next();
        tab.send({ type: 'result', id: call.id, ok: true, data: [] });
        await expect(promise).resolves.toEqual([]);
    });

    it('rejects pending calls when the tab disconnects', async () => {
        const tab = await connect();
        const promise = server.call('list_diagrams', {});
        await tab.next();

        tab.ws.close();
        await expect(promise).rejects.toThrow(/tab disconnected/);
    });

    it('rejects pending calls when the server stops', async () => {
        const tab = await connect();
        const promise = server.call('list_diagrams', {});
        await tab.next();

        const assertion = expect(promise).rejects.toThrow(/stopped/);
        await server.stop();
        await assertion;
    });
});

describe('multiple tabs', () => {
    it('the most recently connected tab wins; the old one is closed with 4001', async () => {
        const first = await connect();
        const second = await connect();

        expect(await first.closeCode).toBe(4001);

        const promise = server.call('list_diagrams', {});
        const call = await second.next();
        second.send({ type: 'result', id: call.id, ok: true, data: ['ok'] });
        await expect(promise).resolves.toEqual(['ok']);
    });

    it('rejects calls that were pending on the replaced tab', async () => {
        const first = await connect();
        const promise = server.call('list_diagrams', {});
        await first.next();

        const assertion = expect(promise).rejects.toThrow(/tab disconnected/);
        await connect();
        await assertion;
    });
});
