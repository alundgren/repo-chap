import { spawn } from 'node:child_process';

export class PilotError extends Error {
  constructor(message, status = 'unknown') {
    super(message);
    this.status = status;
  }
}

// Never include child output, HTTP bodies, arguments, or credentials in errors.
export function command(file, args, { cwd, input, env = {}, timeout = 30000, signal, interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd, env: { ...process.env, ...env }, detached: !interactive, stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let failure;
    const stop = () => {
      failure = new PilotError(`${file} interrupted or timed out`);
      try { process.kill(interactive ? child.pid : -child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) stop();
      else output += chunk;
    });
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => {});
    child.on('error', () => { failure = new PilotError(`${file} could not start`); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (failure || code !== 0) reject(failure ?? new PilotError(`${file} failed`));
      else resolve(output);
    });
    child.stdin?.end(input);
  });
}

export async function request(url, { method = 'GET', token, body, form, signal } = {}) {
  const timer = AbortSignal.timeout(20000);
  let response;
  try {
    response = await fetch(url, {
      method, signal: signal ? AbortSignal.any([signal, timer]) : timer,
      redirect: 'error',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    if (!response.ok) throw new PilotError(`API request failed (${response.status})`,
      [401, 403].includes(response.status) ? 'inaccessible' : response.status === 404 ? 'absent' : 'unknown');
    if (response.status === 204) return {};
    return await response.json();
  } catch (error) {
    if (error instanceof PilotError) throw error;
    throw new PilotError('API request failed or timed out');
  }
}

export class Accounts {
  constructor(io = { command, request }, env = process.env) {
    this.io = io;
    this.env = env;
  }
  async do(path, options = {}) {
    if (!this.env.DIGITALOCEAN_TOKEN) throw new PilotError('DIGITALOCEAN_TOKEN is required', 'inaccessible');
    return this.io.request(`https://api.digitalocean.com/v2/${path}`, { token: this.env.DIGITALOCEAN_TOKEN, ...options });
  }
  async list(path, key) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.do(`${path}${path.includes('?') ? '&' : '?'}per_page=200&page=${page}`);
      if (!Array.isArray(data[key])) throw new PilotError('Invalid DigitalOcean inventory');
      items.push(...data[key]);
      if (!data.links?.pages?.next) return items;
    }
    throw new PilotError('DigitalOcean inventory exceeded page limit');
  }
  async gh(path, method = 'GET') {
    const output = await this.io.command('gh', ['api', '--method', method, path]);
    if (!output.trim()) return {};
    try { return JSON.parse(output); } catch { throw new PilotError('Invalid GitHub response'); }
  }
  async runners(repo) {
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.gh(`repos/${repo}/actions/runners?per_page=100&page=${page}`);
      if (!Array.isArray(data.runners)) throw new PilotError('Invalid runner inventory');
      items.push(...data.runners);
      if (items.length >= data.total_count) return items;
    }
    throw new PilotError('Runner inventory exceeded page limit');
  }
  async ts(path, options = {}) {
    if (!this.access || this.accessUntil < Date.now()) {
      const { TAILSCALE_CLIENT_ID: id, TAILSCALE_CLIENT_SECRET: secret } = this.env;
      if (!id || !secret) throw new PilotError('Tailscale OAuth credentials are required', 'inaccessible');
      const data = await this.io.request('https://api.tailscale.com/api/v2/oauth/token', {
        method: 'POST', form: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials', scope: 'auth_keys devices:core', tags: 'tag:repo-chap-pilot' }),
      });
      if (typeof data.access_token !== 'string') throw new PilotError('Invalid OAuth response');
      this.access = data.access_token;
      this.accessUntil = Date.now() + 3000000;
    }
    return this.io.request(`https://api.tailscale.com/api/v2/${path}`, { token: this.access, ...options });
  }
}
