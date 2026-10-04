# MCP Plan 3 — MCP server, packaging and docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `mcp/`, a standalone Node MCP server (stdio) that exposes the 13 ChartDB tools and 2 resources to MCP clients and relays every call over a local, authenticated WebSocket to the open ChartDB tab (built in Plan 2). Ship docs and CI coverage.

**Architecture:** `mcp/src/bridge-server.ts` owns the WebSocket (127.0.0.1 only, Origin allowlist, shared-token handshake, most-recent-tab-wins, per-call timeout). `mcp/src/tools.ts` and `mcp/src/resources.ts` register tools/resources on an `McpServer` from `@modelcontextprotocol/sdk`; each handler just forwards to a `ToolBackend` (`call(tool, args)`), which the `BridgeServer` implements. Tool input schemas are imported from `src/mcp-bridge/protocol.ts` (single source of truth shared with the browser). The server is bundled with esbuild into `mcp/dist/index.js`.

**Tech Stack:** Node 24, TypeScript, `@modelcontextprotocol/sdk`, `ws`, esbuild, Vitest (own config, node environment).

**Spec:** `docs/superpowers/specs/2026-10-04-mcp-server-design.md`

**Depends on:** Plans 1 and 2 merged on `feat/mcp-server` (`src/mcp-bridge/protocol.ts` must exist).

## Global Constraints

- Node 24; branch `feat/mcp-server`; never commit to `main`.
- **stdout belongs to the MCP protocol.** Never use `console.log` or write to stdout in `mcp/src`; log with `console.error` only.
- The WebSocket server binds to `127.0.0.1` only. Connections without an allowed `Origin` header, or whose first message is not a valid `hello` with the correct token, are closed with code 1008 and never receive a `call`.
- `mcp/` has its own `package.json` and `package-lock.json` (commit the lock file). Do not add anything to the root `package.json`.
- Do NOT add `zod` to `mcp/package.json` (the protocol file resolves the repo root's zod 3.25; the SDK declares its own zod dependency, so npm will place a second copy, zod 4, in `mcp/node_modules` anyway — two copies is expected). If the SDK rejects the root zod schemas at runtime, see Task 3 Step 6 for the fallback.
- Prettier: 4 spaces, single quotes, `es5` trailing commas; root `npm run lint` also lints `mcp/` and must pass with `--max-warnings 0` (no `any`; use `unknown`).
- Imports from the browser protocol are relative: `../../src/mcp-bridge/protocol` from `mcp/src/*.ts`, `../../../src/mcp-bridge/protocol` from `mcp/src/__tests__/*.ts`. Never import anything else from `src/`.
- Package versions: install with `npm install <pkg>` (latest compatible) — do not hand-write version numbers into `package.json`. Two deliberate pins: `vitest@^3` (root major) and `typescript@~5.9` (one compiler across the repo; the latest TypeScript major is not what the root uses).
- Conventional commits; end every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Existing files that may be modified: `vitest.config.ts` (exclude `mcp/**`), `.github/workflows/ci.yaml` (extra steps), `.dockerignore`, `README.md`, `CLAUDE.md`.

## Review Focus

- No tab connected → the tool returns an error that says to open the app with the bridge env vars (not a hang, not a stack trace).
- A second tab connects → the first is closed with code 4001 (the browser client must NOT reconnect on 4001 or 1008, otherwise two tabs replace each other every second), calls go to the second, and calls that were pending on the first reject instead of hanging.
- Wrong token, disallowed or missing Origin, non-`hello` first message, malformed JSON → connection closed with 1008, no `call` ever delivered.
- Anything on stdout other than MCP frames would corrupt the protocol: `grep -rn "console.log\|process.stdout" mcp/src` returns nothing.
- Missing/short `CHARTDB_MCP_TOKEN`, invalid port, or port already in use → process exits non-zero with a one-line explanation on stderr.

---

### Task 1: Package skeleton, config, root Vitest exclusion

**Files:**
- Create: `mcp/package.json`, `mcp/tsconfig.json`, `mcp/build.mjs`, `mcp/vitest.config.ts`
- Create: `mcp/src/config.ts`
- Test: `mcp/src/__tests__/config.test.ts`
- Modify: `vitest.config.ts` (root)

**Interfaces:**
- Produces:
  ```ts
  // mcp/src/config.ts
  export interface ServerConfig { port: number; token: string; allowedOrigins: string[] }
  export const loadConfig: (env: Record<string, string | undefined>) => ServerConfig; // throws Error with a one-line message
  ```

- [ ] **Step 1: Create the package and install dependencies**

```bash
mkdir -p mcp/src/__tests__
cat > mcp/package.json <<'EOF'
{
    "name": "chartdb-mcp",
    "private": true,
    "type": "module",
    "scripts": {
        "build": "node build.mjs",
        "typecheck": "tsc --noEmit",
        "test": "vitest run",
        "start": "node dist/index.js"
    }
}
EOF
cd mcp
npm install @modelcontextprotocol/sdk ws
npm install -D esbuild typescript@~5.9 vitest@^3 @types/node@^24 @types/ws
cd ..
```

Expected: `mcp/node_modules` and `mcp/package-lock.json` exist; `mcp/package.json` now lists dependencies. (`node_modules` and `dist` are already git-ignored at any depth.)

- [ ] **Step 2: Add config files**

`mcp/tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "lib": ["ES2022"],
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "types": ["node"],
        "strict": true,
        "noEmit": true,
        "skipLibCheck": true,
        "isolatedModules": true,
        "noUnusedLocals": true,
        "noUnusedParameters": true
    },
    "include": ["src", "../src/mcp-bridge/protocol.ts"]
}
```

`mcp/build.mjs`:

```js
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
    entryPoints: [path.join(here, 'src/index.ts')],
    outfile: path.join(here, 'dist/index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // Some bundled CommonJS dependencies (ws) call require() on Node built-ins.
    banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'info',
});
```

`mcp/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
});
```

Root `vitest.config.ts` — change the first import and add `exclude` (CI installs only root dependencies, so the root run must not pick up `mcp/` tests):

```ts
import { configDefaults, defineConfig } from 'vitest/config';
```

and inside `test: { ... }` add:

```ts
        exclude: [...configDefaults.exclude, 'mcp/**'],
```

- [ ] **Step 3: Write the failing config test**

`mcp/src/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

const TOKEN = 'a'.repeat(16);

describe('loadConfig', () => {
    it('applies defaults', () => {
        expect(loadConfig({ CHARTDB_MCP_TOKEN: TOKEN })).toEqual({
            port: 8765,
            token: TOKEN,
            allowedOrigins: [
                'http://localhost:5173',
                'http://127.0.0.1:5173',
                'http://localhost:4173',
                'http://127.0.0.1:4173',
            ],
        });
    });

    it('reads port and origins, trimming and dropping blanks', () => {
        const config = loadConfig({
            CHARTDB_MCP_TOKEN: TOKEN,
            CHARTDB_MCP_PORT: '9000',
            CHARTDB_MCP_ALLOWED_ORIGINS: ' http://localhost:3000 , ,http://a.test ',
        });
        expect(config.port).toBe(9000);
        expect(config.allowedOrigins).toEqual([
            'http://localhost:3000',
            'http://a.test',
        ]);
    });

    it('requires a token of at least 16 characters', () => {
        expect(() => loadConfig({})).toThrow(/CHARTDB_MCP_TOKEN/);
        expect(() => loadConfig({ CHARTDB_MCP_TOKEN: 'short' })).toThrow(
            /at least 16/
        );
    });

    it('rejects invalid ports', () => {
        for (const port of ['0', '70000', 'abc', '', '12.5']) {
            expect(() =>
                loadConfig({ CHARTDB_MCP_TOKEN: TOKEN, CHARTDB_MCP_PORT: port })
            ).toThrow(/CHARTDB_MCP_PORT/);
        }
    });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm --prefix mcp test`
Expected: FAIL — cannot resolve `../config`.

- [ ] **Step 5: Implement `mcp/src/config.ts`**

```ts
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
        throw new Error('CHARTDB_MCP_TOKEN must be at least 16 characters long.');
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
```

- [ ] **Step 6: Run to verify it passes, then check the root suite still ignores `mcp/`**

```bash
npm --prefix mcp test
npx vitest run --reporter=dot 2>&1 | tail -8     # root run: must not list any mcp/ test file
```

Expected: mcp tests PASS (4); root run passes and mentions no `mcp/` files.

- [ ] **Step 7: Format, lint, commit**

```bash
npx prettier --write mcp/src mcp/build.mjs mcp/vitest.config.ts mcp/tsconfig.json mcp/package.json vitest.config.ts
npm run lint
git add mcp vitest.config.ts
git commit -m "feat(mcp): add server package skeleton and config loader

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `BridgeServer` (WebSocket relay)

**Files:**
- Create: `mcp/src/bridge-server.ts`
- Test: `mcp/src/__tests__/bridge-server.test.ts`

**Interfaces:**
- Consumes: `clientMessageSchema`, `ToolName` from `../../src/mcp-bridge/protocol`.
- Produces (used by Tasks 3–4):
  ```ts
  export interface ToolBackend { call(tool: ToolName, args: unknown): Promise<unknown> }
  export interface BridgeServerOptions {
      port: number; token: string; allowedOrigins: string[];
      host?: string;           // default '127.0.0.1'
      callTimeoutMs?: number;  // default 30000
      helloTimeoutMs?: number; // default 5000
  }
  export class BridgeServer implements ToolBackend {
      constructor(options: BridgeServerOptions);
      start(): Promise<void>;
      get port(): number;      // actual port (useful when started with port 0)
      call(tool: ToolName, args: unknown): Promise<unknown>;
      stop(): Promise<void>;
  }
  ```
  Wire protocol (defined in `src/mcp-bridge/protocol.ts`): tab → server `{type:'hello',token}` / `{type:'result',id,ok,data?,error?}`; server → tab `{type:'ready'}` / `{type:'call',id,tool,args}`.

- [ ] **Step 1: Write the failing tests**

`mcp/src/__tests__/bridge-server.test.ts`:

```ts
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
        this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
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

        tab.send({ type: 'result', id: call.id, ok: true, data: 'Table t {}' });
        await expect(promise).resolves.toBe('Table t {}');
    });

    it('rejects with the tab error message', async () => {
        const tab = await connect();
        const promise = server.call('delete_diagram', {});
        const call = await tab.next();

        tab.send({ type: 'result', id: call.id, ok: false, error: 'not found' });
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix mcp test -- bridge-server`
Expected: FAIL — cannot resolve `../bridge-server`.

- [ ] **Step 3: Implement `mcp/src/bridge-server.ts`**

```ts
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
            call.reject(new Error(message.error ?? 'Unknown error from the ChartDB tab.'));
        }
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix mcp test -- bridge-server`
Expected: PASS (all tests above). Timing-sensitive tests (`closes when no hello arrives in time`, `times out`) use 50 ms thresholds; if they flake on a slow machine raise only the thresholds, not the assertions.

If "rejects calls that were pending on the replaced tab" hangs, `adopt` is not closing the old socket or the `close` event is not running `release(oldSocket)`.

- [ ] **Step 5: Type-check, format, lint, commit**

```bash
npm --prefix mcp run typecheck
npx prettier --write mcp/src
npm run lint
git add mcp
git commit -m "feat(mcp): add authenticated WebSocket bridge server

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Register tools and resources on the MCP server

**Files:**
- Create: `mcp/src/tools.ts`
- Create: `mcp/src/resources.ts`
- Test: `mcp/src/__tests__/tools.test.ts`
- Test: `mcp/src/__tests__/resources.test.ts`

**Interfaces:**
- Consumes: `ToolBackend` (Task 2); `toolInputShapes`, `toolNames`, `ToolName` (`src/mcp-bridge/protocol.ts`).
- Produces:
  ```ts
  export const formatResult: (data: unknown) => string;
  export const registerTools: (server: McpServer, backend: ToolBackend) => void;
  export const registerResources: (server: McpServer, backend: ToolBackend) => void;
  ```

- [ ] **Step 1: Write the failing tools test**

`mcp/src/__tests__/tools.test.ts`:

```ts
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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

        const result = await client.callTool({ name: 'list_diagrams', arguments: {} });

        expect(call).toHaveBeenCalledWith('list_diagrams', {});
        expect(textOf(result)).toContain('"id": "a"');
    });

    it('returns string results verbatim', async () => {
        const client = await setup({ call: vi.fn(async () => 'Table t {}') });
        const result = await client.callTool({ name: 'get_diagram', arguments: {} });
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

        const result = await client.callTool({ name: 'list_diagrams', arguments: {} });

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix mcp test -- tools`
Expected: FAIL — cannot resolve `../tools`.

- [ ] **Step 3: Implement `mcp/src/tools.ts`**

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toolInputShapes, toolNames } from '../../src/mcp-bridge/protocol';
import type { ToolName } from '../../src/mcp-bridge/protocol';
import type { ToolBackend } from './bridge-server';

const DESCRIPTIONS: Record<ToolName, string> = {
    list_diagrams:
        'List the ChartDB diagrams stored in the browser, newest first, and which one is open in the app.',
    get_diagram:
        "Return a diagram as DBML (default) or JSON. Defaults to the diagram open in the app.",
    create_diagram:
        'Create a new diagram, empty or seeded from SQL DDL, DBML or the JSON of the database smart query.',
    import_into_diagram:
        'Add tables from SQL DDL, DBML or smart-query JSON to an existing diagram, placed to the right of the current tables.',
    apply_dbml:
        'Make the diagram match a full DBML document (tables, relationships, enums), keeping ids and layout of what remains. Use dryRun first to see the change summary. Deleting tables requires allowDrops: true; a rename is applied as delete + create.',
    export_sql:
        "Generate deterministic SQL DDL for the diagram, in its own dialect or another one. Does not use AI.",
    remove_tables:
        "Delete tables by name ('table' or 'schema.table') together with their relationships and dependencies.",
    rename_diagram: 'Rename a diagram.',
    delete_diagram:
        "Permanently delete a diagram. confirmName must exactly equal the diagram's name.",
    upsert_note:
        'Create a sticky note (omit noteId) or update one (pass noteId). Content is required when creating.',
    upsert_area:
        'Create an area (omit areaId) or update one, optionally moving the named tables into it and arranging them. Name is required when creating.',
    auto_arrange:
        "Re-run ChartDB's automatic layout so tables do not overlap and related tables sit together.",
    validate_dbml:
        'Check DBML syntax without saving anything; returns line, column and message on error.',
};

const READ_ONLY = new Set<ToolName>([
    'list_diagrams',
    'get_diagram',
    'export_sql',
    'validate_dbml',
]);
const DESTRUCTIVE = new Set<ToolName>([
    'delete_diagram',
    'remove_tables',
    'apply_dbml',
]);

export const formatResult = (data: unknown): string =>
    typeof data === 'string' ? data : (JSON.stringify(data, null, 2) ?? 'ok');

export const registerTools = (server: McpServer, backend: ToolBackend): void => {
    for (const name of toolNames) {
        server.registerTool(
            name,
            {
                description: DESCRIPTIONS[name],
                inputSchema: toolInputShapes[name] as unknown as ZodRawShapeCompat,
                annotations: {
                    readOnlyHint: READ_ONLY.has(name),
                    destructiveHint: DESTRUCTIVE.has(name),
                    openWorldHint: false,
                },
            },
            async (args: Record<string, unknown>) => {
                try {
                    const data = await backend.call(name, args);
                    return { content: [{ type: 'text' as const, text: formatResult(data) }] };
                } catch (error) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text' as const,
                                text:
                                    error instanceof Error
                                        ? error.message
                                        : String(error),
                            },
                        ],
                    };
                }
            }
        );
    }
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --prefix mcp test -- tools`
Expected: PASS (7 tests).

If `tsc`/vitest complains about the callback or `inputSchema` types for `registerTool`, check the installed SDK's `registerTool` signature (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts`). Adapt only the call shape (for example the older `server.tool(name, description, shape, annotations, callback)` form) — keep the same behavior and tests.

- [ ] **Step 5: Write the failing resources test**

`mcp/src/__tests__/resources.test.ts`:

```ts
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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
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

        const result = await client.readResource({ uri: 'chartdb://diagrams/abc.dbml' });

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

        const result = await client.readResource({ uri: 'chartdb://diagrams/abc.json' });

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
```

- [ ] **Step 6: Run to verify it fails, then implement `mcp/src/resources.ts`**

Run: `npm --prefix mcp test -- resources` → FAIL (cannot resolve `../resources`). Then create:

```ts
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

export const registerResources = (server: McpServer, backend: ToolBackend): void => {
    registerDiagramResource(server, backend, 'dbml', 'text/plain');
    registerDiagramResource(server, backend, 'json', 'application/json');
};
```

Run again: `npm --prefix mcp test -- resources`
Expected: PASS (4 tests).

Fallbacks (use only if a test proves the need):
- If the SDK cannot match the `{id}.dbml` suffix, change both templates to `chartdb://diagrams/{id}/dbml` and `chartdb://diagrams/{id}/json` and update the URIs in the tests and in the spec's resource list.
- If the SDK rejects the repo root's zod 3 schemas at runtime (error mentioning `_zod`, `safeParse` or `zod/v4`), add `alias: { zod: path.join(here, '../node_modules/zod') }` to `mcp/build.mjs` AND `resolve: { alias: { zod: path.resolve(__dirname, '../node_modules/zod') } }` to `mcp/vitest.config.ts` so both use one copy, and note it in the PR.

- [ ] **Step 7: Type-check, format, lint, commit**

```bash
npm --prefix mcp run typecheck
npx prettier --write mcp/src
npm run lint
git add mcp
git commit -m "feat(mcp): register the 13 tools and diagram resources

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Entry point, bundle, and smoke test

**Files:**
- Create: `mcp/src/index.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `BridgeServer` (Task 2), `registerTools`, `registerResources` (Task 3).
- Produces: the executable bundle `mcp/dist/index.js`.

- [ ] **Step 1: Write `mcp/src/index.ts`**

```ts
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
    console.error(
        `[chartdb-mcp] ready. Bridge listening on ws://127.0.0.1:${config.port}`
    );

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
```

- [ ] **Step 2: Type-check and build**

```bash
npm --prefix mcp run typecheck
npm --prefix mcp run build
ls -la mcp/dist/index.js
```

Expected: no type errors; esbuild reports a successful bundle (a few MB is normal because the SDK is bundled).

- [ ] **Step 3: Smoke-test the real bundle over stdio**

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | CHARTDB_MCP_TOKEN=smoke-token-1234567890 CHARTDB_MCP_PORT=18765 timeout 5 node mcp/dist/index.js 2>/tmp/chartdb-mcp-smoke.err | head -1
cat /tmp/chartdb-mcp-smoke.err
```

Expected: stdout is a single JSON-RPC line containing `"serverInfo":{"name":"chartdb"`; stderr contains `[chartdb-mcp] ready`.

- [ ] **Step 4: Check failure modes and stdout hygiene**

```bash
CHARTDB_MCP_TOKEN=short node mcp/dist/index.js; echo "exit=$?"       # expect: stderr "at least 16 characters", exit=1
node mcp/dist/index.js; echo "exit=$?"                               # expect: stderr mentions CHARTDB_MCP_TOKEN, exit=1
grep -rn "console.log\|process.stdout" mcp/src || echo "stdout clean"   # expect: stdout clean
```

Port-in-use check: start one server in the background (`CHARTDB_MCP_TOKEN=smoke-token-1234567890 CHARTDB_MCP_PORT=18766 node mcp/dist/index.js < /dev/null &` would exit on stdin end, so instead run `sleep 30 | CHARTDB_MCP_TOKEN=smoke-token-1234567890 CHARTDB_MCP_PORT=18766 node mcp/dist/index.js &`), then start a second with the same port and expect the "port already in use" message and exit code 1. Kill the background job afterwards.

- [ ] **Step 5: Format, lint, commit**

```bash
npx prettier --write mcp/src
npm run lint
git add mcp
git commit -m "feat(mcp): add stdio entry point and esbuild bundle

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, CI, and end-to-end verification

**Files:**
- Modify: `README.md` (new section)
- Modify: `CLAUDE.md` (new section)
- Modify: `.github/workflows/ci.yaml` (extra steps)
- Modify: `.dockerignore`

**Interfaces:** none.

- [ ] **Step 1: Add the README section**

Append before the `## Contributing` heading of `README.md`:

````markdown
## MCP server (fork feature)

This fork can be driven by an MCP client (Claude Code, Claude Desktop, …). A small Node server (`mcp/`) talks MCP over stdio and relays each call over a local WebSocket to the ChartDB tab you have open, so edits appear live and are saved to the browser's IndexedDB like any other edit.

Local use only: the shared token is compiled into the app bundle (in dev and in production builds alike), so never deploy a build that sets `VITE_MCP_BRIDGE_*` to a public host, and never run `vite preview --host`. The official Docker image does not enable the bridge.

1. Pick a secret: `openssl rand -hex 16`
2. App: create `.env.local` in the repo root (Vite reads it in every mode, so it is baked into production builds too), then build and serve the production bundle locally

   ```bash
   VITE_MCP_BRIDGE_URL=ws://127.0.0.1:8765
   VITE_MCP_BRIDGE_TOKEN=<your secret>
   ```

   ```bash
   npm run build && npm run preview     # open http://localhost:4173
   ```

   (`npm run dev` also works, on http://localhost:5173. If you serve the build on another port, add its origin to `CHARTDB_MCP_ALLOWED_ORIGINS`. Rebuild after changing the token or URL: they are fixed at build time.)

3. Server: build it and register it with Claude Code (run the root `npm install` first: the server bundle reuses the repo's `zod`)

   ```bash
   npm --prefix mcp ci && npm --prefix mcp run build
   claude mcp add --transport stdio --env CHARTDB_MCP_TOKEN=<your secret> chartdb -- node "$(pwd)/mcp/dist/index.js"
   ```

Optional server settings: `CHARTDB_MCP_PORT` (default `8765`, must match `VITE_MCP_BRIDGE_URL`) and `CHARTDB_MCP_ALLOWED_ORIGINS` (comma-separated, default: localhost and 127.0.0.1 on ports 5173 and 4173).

Tools: `list_diagrams`, `get_diagram`, `create_diagram`, `import_into_diagram`, `apply_dbml`, `export_sql`, `remove_tables`, `rename_diagram`, `delete_diagram`, `upsert_note`, `upsert_area`, `auto_arrange`, `validate_dbml`. Deleting a diagram needs `confirmName`; `apply_dbml` refuses to drop tables unless `allowDrops: true` (use `dryRun` first). Edits to the open diagram clear the app's undo/redo history and cannot be undone from the app. If the most recent tab is closed, calls fail until a tab reconnects. Only one server can listen on a port, so a second Claude session needs its own `CHARTDB_MCP_PORT` (and a tab built with the matching `VITE_MCP_BRIDGE_URL`). Tool results larger than 16 MB cannot be returned. `get_diagram` omits tables with no fields, duplicate tables and fields with an empty name, so feeding that DBML back into `apply_dbml` reports them as removed (tables are blocked by the drop guard).
````

- [ ] **Step 2: Add the CLAUDE.md section**

Insert this subsection at the end of the `## Architecture` section of `CLAUDE.md`, i.e. directly before the `## Conventions` heading (keep it short; it links to the spec):

````markdown
### MCP bridge (fork-only)
`src/mcp-bridge/` + `mcp/` let an MCP client drive the app (spec: `docs/superpowers/specs/2026-10-04-mcp-server-design.md`).
- `mcp/` is a separate Node package (own `package.json`, built with esbuild, tested with `npm --prefix mcp test`; excluded from the root Vitest run). It speaks MCP over stdio and relays calls over a `127.0.0.1` WebSocket (`mcp/src/bridge-server.ts`). **Never write to stdout in `mcp/src`** — stdout is the protocol channel.
- `src/mcp-bridge/protocol.ts` is the single source of truth for tool names and zod input schemas, imported by both sides. It must use relative imports only (Node bundles it).
- Browser side: `use-mcp-bridge.ts` (mounted in `editor-page.tsx`, inert unless `VITE_MCP_BRIDGE_URL` is set) → `bridge-client.ts` (runs calls one at a time) → `handlers/*` → a `DiagramGateway` (`gateway.ts`; `live-gateway.ts` in the app, in-memory in tests). Write tools are pure `Diagram → Diagram` transforms followed by `commit()`, which rolls back if saving fails.
- Shared logic extracted from UI code lives in `src/lib` (`applyDBMLToDiagram`, `importContentToDiagram`, `getImportOffsetX`); the DBML side panel and import dialog use the same functions.
````

- [ ] **Step 3: Add CI steps**

In `.github/workflows/ci.yaml`, after the `Run tests` step add:

```yaml

      - name: MCP server (install, typecheck, test, build)
        run: |
          npm --prefix mcp ci
          npm --prefix mcp run typecheck
          npm --prefix mcp test
          npm --prefix mcp run build
```

- [ ] **Step 4a: Keep `mcp/` out of the Docker build context**

`.dockerignore` only lists root-level `node_modules` and `dist`. Change those entries to `**/node_modules` and `**/dist` so a local `mcp/node_modules` and `mcp/dist` are never copied into the image build. Also add `.env.production` (the file already excludes `.env`, `.env.local` and `.env.*.local`), so bridge variables placed there can never be baked into an image.

- [ ] **Step 4: Run everything the way CI does**

```bash
npm ci
npm run lint
npm run build
npm run test:ci
npm --prefix mcp ci
npm --prefix mcp run typecheck
npm --prefix mcp test
npm --prefix mcp run build
```

Expected: every command exits 0.

- [ ] **Step 5: End-to-end manual verification (record results in the PR description)**

Prepare: follow the README steps 1–3 (secret, `.env.local`, `npm run build && npm run preview`, build the server + `claude mcp add`). Open http://localhost:4173 in a browser, create a blank PostgreSQL diagram. Run the whole table against this production build (not only against `npm run dev`). Start a NEW Claude Code session in any directory, then check each row:

| # | Ask Claude to… | Expected |
|---|---|---|
| 1 | "List my ChartDB diagrams" | Lists the diagram with `openInApp: true` |
| 2 | "Create a users and posts schema with a foreign key via apply_dbml" | Tables appear on the canvas live; summary lists 2 tables added |
| 3 | "Run apply_dbml with only the users table, dryRun" | Summary shows posts removed, `wouldBlock: true`; canvas unchanged |
| 4 | "Now apply it for real" | Error mentioning `allowDrops: true`; canvas unchanged |
| 5 | "Export it as MySQL" | `CREATE TABLE` statements in MySQL syntax |
| 6 | "Add a note saying 'check indexes' and group users into an area called Core" | Note and area visible on canvas, users inside the area |
| 7 | "Auto arrange" | Tables re-laid out |
| 8 | "Delete this diagram" (without naming it) | Error: `confirmName must exactly equal…`; diagram still exists |
| 9 | Close the browser tab, then "list diagrams" | Error: "No ChartDB tab is connected…" |
| 10 | Reopen the tab, then "list diagrams" | Works again without restarting Claude (client reconnects) |
| 11 | In the app, open the DBML side panel, edit mode, make a change (diff preview showing), then ask Claude to rename the diagram | Error mentioning read-only diff-review mode |
| 12 | Open the app on a second tab | First tab stops receiving calls; second tab serves them |

If any row fails, fix the cause and add a regression test in the right layer (`src/mcp-bridge/__tests__` or `mcp/src/__tests__`) before re-running the row.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md .github/workflows/ci.yaml .dockerignore
git commit -m "docs: document the MCP server and run it in CI

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
