#!/usr/bin/env node
/*
 * check-pass.mjs — test passphrase guesses against the sealed plan.
 *
 *   node tools/check-pass.mjs
 *
 * Type a guess and press Enter: it says right or wrong. Press Enter on an
 * empty line to stop. What you type is not shown on screen, same as the
 * other commands.
 *
 * Why this exists instead of just using `decrypt`: decrypt writes the opened
 * plan over plan-offline.html when a guess works. If plan-offline.html has
 * edits that were never sealed, that throws them away. This tool only ever
 * reads index.html and never writes a file, so guessing here is always safe.
 *
 * Each guess takes a fraction of a second on purpose: the 250,000 rounds of
 * hashing that slow down a stranger guessing at the public file slow you down
 * the same amount.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { askSecret, decryptBlob } from './plan.mjs';

const SHELL = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const match = readFileSync(SHELL, 'utf8').match(/^var BLOB="([^"]*)";$/m);
if (!match) {
  console.error(`No 'var BLOB="..."' line found in ${SHELL}`);
  process.exit(1);
}

let tries = 0;
for (;;) {
  const guess = await askSecret(`Guess ${tries + 1} (empty line to stop): `);
  if (!guess) break;
  tries++;
  try {
    await decryptBlob(match[1], guess);
    console.log('RIGHT. That is the passphrase. Nothing was written anywhere.');
    process.exit(0);
  } catch {
    console.log('Wrong.');
  }
}
console.log(`Stopped after ${tries} ${tries === 1 ? 'guess' : 'guesses'}. None matched.`);
