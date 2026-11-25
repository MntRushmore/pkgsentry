#!/usr/bin/env node
// Writes package.json's version into src/version.ts. Wired to the npm "version" lifecycle.
import { readFileSync, writeFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const file = 'src/version.ts';
writeFileSync(file, readFileSync(file, 'utf8').replace(/VERSION = '[^']*'/, `VERSION = '${version}'`));
console.log(`src/version.ts -> ${version}`);
