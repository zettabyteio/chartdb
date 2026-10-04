import { describe, expect, it } from 'vitest';
import { isLoopbackUrl } from '../bridge-config';

describe('isLoopbackUrl', () => {
    it('accepts loopback hosts', () => {
        expect(isLoopbackUrl('ws://127.0.0.1:8765')).toBe(true);
        expect(isLoopbackUrl('ws://localhost:8765')).toBe(true);
        expect(isLoopbackUrl('ws://[::1]:8765')).toBe(true);
    });

    it('rejects everything else', () => {
        expect(isLoopbackUrl('ws://example.com:8765')).toBe(false);
        expect(isLoopbackUrl('ws://127.0.0.1.evil.test:8765')).toBe(false);
        expect(isLoopbackUrl('not a url')).toBe(false);
    });
});
