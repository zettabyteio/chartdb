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
            CHARTDB_MCP_ALLOWED_ORIGINS:
                ' http://localhost:3000 , ,http://a.test ',
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
