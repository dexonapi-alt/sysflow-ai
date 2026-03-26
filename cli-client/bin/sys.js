#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const tsxEsm = pathToFileURL(require.resolve('tsx/esm')).href;
const entry = resolve(__dirname, '../src/index.ts');

const child = spawn(
  process.execPath,
  ['--import', tsxEsm, entry, ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env }
);

child.on('exit', (code) => process.exit(code ?? 0));
