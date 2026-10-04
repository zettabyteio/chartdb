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
