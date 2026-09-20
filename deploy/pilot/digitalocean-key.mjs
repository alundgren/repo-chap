import { chmod, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { command, PilotError } from './io.mjs';
import { privateDirectory, privateRead } from './store.mjs';

const fingerprintPattern = /^(?:[a-f0-9]{2}:){15}[a-f0-9]{2}$/i;

export function validDigitalOceanSshFingerprint(value) {
  return typeof value === 'string' && fingerprintPattern.test(value);
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function ensureDigitalOceanSshKey(root, io = { command }) {
  if (!isAbsolute(root)) throw new PilotError('The operator directory must be absolute');
  await privateDirectory(root, true);
  const privateKeyFile = join(root, 'digitalocean_ed25519');
  const publicKeyFile = `${privateKeyFile}.pub`;
  const privateExists = await exists(privateKeyFile);
  const publicExists = await exists(publicKeyFile);
  if (privateExists !== publicExists) throw new PilotError('The local DigitalOcean SSH keypair is incomplete');
  const created = !privateExists;
  if (created) {
    await io.command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'repo-chap-pilot', '-f', privateKeyFile]);
    await chmod(privateKeyFile, 0o600);
    await chmod(publicKeyFile, 0o600);
  }
  const privateKey = await privateRead(privateKeyFile);
  const publicKey = String(await privateRead(publicKeyFile)).trim();
  if (!privateKey.includes('PRIVATE KEY') || !/^ssh-ed25519 [A-Za-z0-9+/]+={0,3} repo-chap-pilot$/.test(publicKey))
    throw new PilotError('The local DigitalOcean SSH keypair is invalid');
  const derived = (await io.command('ssh-keygen', ['-y', '-f', privateKeyFile])).trim();
  if (derived.split(' ').slice(0, 2).join(' ') !== publicKey.split(' ').slice(0, 2).join(' ')) throw new PilotError('The local DigitalOcean SSH keypair does not match');
  const fingerprintOutput = await io.command('ssh-keygen', ['-E', 'md5', '-lf', publicKeyFile]);
  const fingerprint = /\bMD5:((?:[a-f0-9]{2}:){15}[a-f0-9]{2})\b/i.exec(fingerprintOutput)?.[1];
  if (!validDigitalOceanSshFingerprint(fingerprint)) throw new PilotError('Could not read the local DigitalOcean SSH key fingerprint');
  return { fingerprint, publicKeyFile, created };
}

async function cli() {
  const { values } = parseArgs({ options: { root: { type: 'string' } } });
  if (!values.root) throw new PilotError('Use --root PATH');
  const result = await ensureDigitalOceanSshKey(values.root);
  process.stdout.write(`${result.fingerprint}\n${result.publicKeyFile}\n${result.created ? 'created' : 'existing'}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await cli(); }
  catch (error) {
    console.error(error instanceof PilotError ? error.message : 'Could not prepare the local DigitalOcean SSH key');
    process.exitCode = 1;
  }
}
