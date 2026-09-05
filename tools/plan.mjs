#!/usr/bin/env node
/*
 * plan.mjs — open and re-seal the encrypted plan.
 *
 *   node tools/plan.mjs decrypt   -> index.html  ->  plan-offline.html
 *   node tools/plan.mjs preview   -> a browsable copy, no passphrase needed
 *   node tools/plan.mjs encrypt   -> plan-offline.html  ->  index.html
 *
 * The passphrase is typed at the prompt and never written to disk, never
 * passed as an argument (arguments show up in shell history), and never
 * stored in an env var. The plaintext file is covered by .gitignore.
 *
 * Crypto matches the unlock() routine inside index.html exactly:
 *   payload = salt(16 bytes) || iv(12 bytes) || AES-256-GCM ciphertext
 *   key     = PBKDF2(passphrase, salt, 250000 iterations, SHA-256)
 * Change one of those numbers here and the app can no longer open the file.
 */

import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const ITER = 250000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'index.html');
const PLAIN = join(ROOT, 'plan-offline.html');
/* named to match the *-offline.html rule in .gitignore, since it is plaintext too */
const PREVIEW = join(ROOT, 'preview-offline.html');

/* The blob sits on its own line as:  var BLOB="....";  */
const BLOB_LINE = /^var BLOB="([^"]*)";$/m;

/* Read a passphrase without echoing it to the terminal. */
function askSecret(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout, terminal: true,
    });
    process.stdout.write(promptText);
    rl._writeToOutput = () => {};          // swallow the echo of every keystroke
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

export async function deriveKey(passphrase, salt, usage) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), { name: 'PBKDF2' }, false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, usage,
  );
}

export async function decryptBlob(b64, passphrase) {
  const raw = Buffer.from(b64, 'base64');
  const key = await deriveKey(passphrase, raw.subarray(0, 16), ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(16, 28) }, key, raw.subarray(28),
  );
  return new TextDecoder().decode(plain);
}

async function cmdDecrypt() {
  const shell = readFileSync(SHELL, 'utf8');
  const match = shell.match(BLOB_LINE);
  if (!match) throw new Error(`No 'var BLOB="..."' line found in ${SHELL}`);

  if (existsSync(PLAIN)) {
    const answer = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${PLAIN} already exists. Overwrite it? [y/N] `, (a) => { rl.close(); resolve(a); });
    });
    if (answer.trim().toLowerCase() !== 'y') { console.log('Cancelled.'); return; }
  }

  const passphrase = await askSecret('Passphrase: ');
  let html;
  try {
    html = await decryptBlob(match[1], passphrase);
  } catch {
    console.error('Wrong passphrase (decryption failed).');
    process.exitCode = 1;
    return;
  }

  writeFileSync(PLAIN, html, 'utf8');
  console.log(`Wrote ${PLAIN} (${html.length.toLocaleString()} chars).`);
  console.log('This file is plaintext and gitignored. Edit it, then run: node tools/plan.mjs encrypt');
}

async function cmdEncrypt() {
  if (!existsSync(PLAIN)) throw new Error(`${PLAIN} not found. Run 'decrypt' first.`);
  const html = readFileSync(PLAIN, 'utf8');
  const shell = readFileSync(SHELL, 'utf8');
  if (!BLOB_LINE.test(shell)) throw new Error(`No 'var BLOB="..."' line found in ${SHELL}`);

  const passphrase = await askSecret('Passphrase: ');
  const confirm = await askSecret('Confirm:    ');
  if (passphrase !== confirm) {
    console.error('Passphrases do not match. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ['encrypt', 'decrypt']);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(html),
  );
  const b64 = Buffer.concat([
    Buffer.from(salt), Buffer.from(iv), Buffer.from(cipher),
  ]).toString('base64');

  /* Prove the blob opens again before we overwrite the only shipped copy. */
  const roundTrip = await decryptBlob(b64, passphrase);
  if (roundTrip !== html) throw new Error('Round-trip check failed. Nothing was written.');

  copyFileSync(SHELL, `${SHELL}.bak`);
  writeFileSync(SHELL, shell.replace(BLOB_LINE, `var BLOB="${b64}";`), 'utf8');
  console.log(`Sealed ${html.length.toLocaleString()} chars into ${SHELL}.`);
  console.log(`Previous version saved as ${SHELL}.bak`);
}

/* Build a browsable copy of the plaintext, without touching the passphrase.
   The shell normally supplies the <head> and a block of mobile CSS at unlock
   time, so this reassembles the page the same way boot() does — otherwise the
   preview would be missing the viewport tag and the touch-sized inputs, and
   would not match what the phone actually shows. */
function cmdPreview() {
  if (!existsSync(PLAIN)) throw new Error(`${PLAIN} not found. Run 'decrypt' first.`);
  const html = readFileSync(PLAIN, 'utf8');
  const shell = readFileSync(SHELL, 'utf8');

  const end = html.indexOf('</' + 'style>');
  if (end < 0) throw new Error('No </style> found in the plaintext; cannot split head from body.');
  let head = html.slice(0, end + 8);
  const body = html.slice(end + 8);

  /* label the tab so a preview is never mistaken for the real thing */
  head = head.replace(/<title>([\s\S]*?)<\/title>/, '<title>PREVIEW · $1</title>');

  /* lift the mobile overrides out of the shell so this cannot drift from it */
  const m = shell.match(/'<style>@media \(max-width:760px\)\{[\s\S]*?<\/style>'\);/);
  const mobile = m
    ? m[0].replace(/^'/, '').replace(/'\);$/, '').replace(/' \+\s*'/g, '')
    : '';
  if (!m) console.warn('Warning: could not find the mobile CSS in index.html; preview omits it.');

  writeFileSync(PREVIEW, [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="light dark">',
    head,
    mobile,
    /* mirrors the pre-paint theme step in the shell's boot(), so a preview
       does not flash the system theme before switching to the saved one */
    '<script>try{var t=localStorage.getItem("ui.theme");'
      + 'if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t);}catch(e){}<\/script>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n'), 'utf8');

  console.log('Wrote ' + PREVIEW);
  console.log('Open it in your browser:');
  console.log('  file:///' + PREVIEW.replace(/\\/g, '/'));
  console.log('This is plaintext and gitignored. Delete it when you are done.');
}

/* Only run the CLI when invoked directly, so tests can import the helpers. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  const commands = { decrypt: cmdDecrypt, preview: cmdPreview, encrypt: cmdEncrypt };
  if (!commands[cmd]) {
    console.error('Usage: node tools/plan.mjs <decrypt|preview|encrypt>');
    process.exit(1);
  }
  /* preview is synchronous, the other two are not — normalise before catching */
  Promise.resolve()
    .then(commands[cmd])
    .catch((err) => { console.error(err.message); process.exit(1); });
}
