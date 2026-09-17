import { probeCodex } from './codex.js';
import { probeClaude } from './claude.js';
import { runProcess } from './process.js';
import { validateProfile } from './profile.js';
import type { ProviderProfile } from './types.js';

export async function probeProvider(profile: ProviderProfile, directory: string): Promise<{ ok: boolean; diagnostic: string; authenticated: boolean | null }> {
  validateProfile(profile);
  const deadline = Date.now() + 15_000;
  const invoke = (args: string[], maxBytes: number) => runProcess(profile.executable, args, { cwd: directory, timeoutMs: Math.max(0, deadline - Date.now()), maxBytes });
  const checked = await (profile.provider === 'codex' ? probeCodex : probeClaude)(profile, invoke);
  if ('outcome' in checked) return { ok: false, diagnostic: checked.diagnostic, authenticated: null };
  const auth = await invoke(profile.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'], 128 * 1024);
  const authenticated = auth.status === 'exited' && auth.exitCode === 0;
  return { ok: authenticated, authenticated, diagnostic: authenticated
    ? 'Required CLI capabilities and account login status passed. Model entitlement and a successful provider invocation still require the pilot.'
    : 'CLI capabilities passed, but account login status failed. Configure supported provider authentication for this service account and retry. No model request was made.' };
}
