import { describe, it, expect } from 'vitest';
import { createHandlers } from '../handlers';
import { toolNames } from '../protocol';
import { createMemoryGateway } from './helpers';

describe('createHandlers', () => {
    it('has a handler for every protocol tool and nothing else', () => {
        const { gateway } = createMemoryGateway({ diagrams: [] });
        expect(Object.keys(createHandlers(gateway)).sort()).toEqual(
            [...toolNames].sort()
        );
    });
});
