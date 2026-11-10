#!/usr/bin/env node
/*
 * plan.mjs — open and re-seal the encrypted plan.
 *
 *   node tools/plan.mjs decrypt        -> index.html  ->  plan-offline.html
 *   node tools/plan.mjs preview        -> a browsable copy, no passphrase needed
 *   node tools/plan.mjs encrypt        -> plan-offline.html  ->  index.html
 *                                         (same passphrase as now; devices stay unlocked)
 *   node tools/plan.mjs encrypt --new  -> the same, under a NEW passphrase
 *                                         (every device asks once for the new one)
 *
 * Why plain `encrypt` keeps the salt: a device that has been unlocked once
 * remembers the KEY, not the passphrase, and the key is made from passphrase +
 * salt. Keep both the same and the key is the same, so every phone keeps
 * opening the plan through every update. A fresh salt on each seal - what this
 * tool used to do - silently logged every device out each time.
 *
 * Reusing the salt is safe. The salt only has to differ between DIFFERENT
 * passphrases' keys; it is the iv that must never repeat under one key, and the
 * iv is still brand new random bytes on every seal.
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
export function askSecret(promptText) {
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

async function cmdEncrypt(isNew) {
  if (!existsSync(PLAIN)) throw new Error(`${PLAIN} not found. Run 'decrypt' first.`);
  const html = readFileSync(PLAIN, 'utf8');
  const shell = readFileSync(SHELL, 'utf8');
  const current = shell.match(BLOB_LINE);
  if (!current) throw new Error(`No 'var BLOB="..."' line found in ${SHELL}`);

  let passphrase, salt;
  if (isNew) {
    passphrase = await askSecret('NEW passphrase: ');
    const confirm = await askSecret('Confirm:        ');
    if (passphrase !== confirm) {
      console.error('Passphrases do not match. Nothing was written.');
      process.exitCode = 1;
      return;
    }
    if (!passphrase) {
      console.error('An empty passphrase would lock nothing. Nothing was written.');
      process.exitCode = 1;
      return;
    }
    salt = crypto.getRandomValues(new Uint8Array(16));
  } else {
    /* Typed once, then proven: it has to open the plan that is published now.
       That doubles as the typo check, since a typo cannot open it. */
    passphrase = await askSecret('Passphrase: ');
    try {
      await decryptBlob(current[1], passphrase);
    } catch {
      console.error('That passphrase does not open the plan that is published now. Nothing was written.');
      console.error('To lock it under a different passphrase on purpose, run:  node tools/plan.mjs encrypt --new');
      process.exitCode = 1;
      return;
    }
    salt = new Uint8Array(Buffer.from(current[1], 'base64').subarray(0, 16));
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));   /* always fresh - see the top of this file */
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
  if (isNew) {
    console.log('NEW passphrase. Each device asks for it once, then remembers it.');
    console.log('Save it in your password manager now, before you forget it.');
  } else {
    console.log('Same passphrase and salt as before: devices that are already unlocked stay unlocked.');
  }
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
  const isNew = process.argv.includes('--new');
  const commands = {
    decrypt: cmdDecrypt, preview: cmdPreview, encrypt: () => cmdEncrypt(isNew),
  };
  if (!commands[cmd] || (isNew && cmd !== 'encrypt')) {
    console.error('Usage: node tools/plan.mjs <decrypt|preview|encrypt [--new]>');
    process.exit(1);
  }
  /* preview is synchronous, the other two are not — normalise before catching */
  Promise.resolve()
    .then(commands[cmd])
    .catch((err) => { console.error(err.message); process.exit(1); });
}
