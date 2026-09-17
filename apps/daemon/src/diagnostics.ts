import { constants } from 'node:fs';
import { access, stat, open, rm, statfs } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { GitHubReader, listOpenPullRequests, prepareCaptureDirectory } from '@repo-chap/github';
import { inspectStoredConfiguration } from '@repo-chap/runtime';
import { probeProvider, runProcess } from '@repo-chap/providers';
import { loadInstallation } from './config.js';

interface DiagnosticCheck { check: string; ok: boolean; message: string }
export async function diagnoseInstallation(directory: string, config: string) {
  const account = userInfo(), checks: DiagnosticCheck[] = [];
  const check = async (name: string, action: () => Promise<string | Omit<DiagnosticCheck, 'check'>>, failure: string) => {
    try { const result = await action(); checks.push({ check: name, ...(typeof result === 'string' ? { ok: true, message: result } : result) }); }
    catch { checks.push({ check: name, ok: false, message: failure }); }
  };
  await check('runtime', async () => {
    if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) !== 24 || process.getuid?.() === 0) throw new Error();
    return 'Linux, Node 24 and an unprivileged account are active.';
  }, 'Use Linux, Node 24 and the unprivileged service account. Run this command through sudo -u repo-chap -H when installed for that account.');
  await check('state', async () => {
    const root = await prepareCaptureDirectory(directory), probe = join(root, `.diagnostic-${randomUUID()}`);
    try { const file = await open(probe, 'wx', 0o600); try { await file.writeFile('storage probe'); await file.sync(); } finally { await file.close(); } }
    finally { await rm(probe, { force: true }); }
    const storage = await statfs(root), availableBytes = storage.bavail * storage.bsize;
    if (availableBytes < 512 * 1024 * 1024) throw new Error();
    return `Private state is writable and synced; ${availableBytes} bytes are available. Reserve additional space for source history, workers and backups.`;
  }, 'Use an account-owned 0700 state directory outside Git on writable local storage. Free at least 512 MiB, then allow extra space for the repository histories and backups.');
  let installation: Awaited<ReturnType<typeof loadInstallation>> | undefined;
  await check('configuration', async () => { installation = await loadInstallation(config, directory); return 'Private installation, App key, profile and policy files are readable by this account.'; },
    'Check the version-1 installation JSON, App key and profile/policy paths. Private files require mode 0600 under account-owned 0700 directories outside Git.');
  let stored: Awaited<ReturnType<typeof inspectStoredConfiguration>> | undefined;
  await check('database', async () => { stored = await inspectStoredConfiguration(directory); return stored.schema ? `SQLite schema ${stored.schema} is readable. Diagnostics did not upgrade it.` : 'No database exists yet. Starting the service will initialize private state.'; },
    'Check SQLite ownership and permissions, local storage and binary compatibility. Stop the service before repairing state. Diagnostics did not migrate the database.');
  await check('git', async () => {
    const result = await runProcess('git', ['--version'], { cwd: directory, timeoutMs: 5000, maxBytes: 16 * 1024 });
    if (result.status !== 'exited' || result.exitCode !== 0) throw new Error(); return 'Git is executable in the service account environment.';
  }, 'Install Git and include its executable in the service account PATH.');
  if (installation) {
    const { dependencies } = installation;
    await check('github-app', async () => { await dependencies.credentials.token(AbortSignal.timeout(15_000)); return 'The GitHub App installation issued a read token. Repository access is checked separately.'; },
      'The App installation could not issue a read token. Check App ID, installation ID, private key, outbound access and installation permissions. Retry after any GitHub rate limit.');
    const profiles = new Set([...installation.profileNames, ...stored?.repositories.map(repo => repo.profile) ?? []]);
    if (!profiles.size) checks.push({ check: 'provider', ok: false, message: 'Configure at least one named provider profile for the service account.' });
    for (const name of profiles) await check(`provider:${name}`, async () => {
      const profile = await dependencies.profile(name), result = await probeProvider(profile, directory);
      if (!result.ok) { checks.push({ check: `provider-detail:${name}`, ok: false, message: result.diagnostic }); throw new Error(); }
      return result.diagnostic;
    }, 'Check this provider profile and the service account login. Capability probes do not establish model entitlement.');
    for (const repository of new Set([...(stored?.repositories.map(repo => repo.name) ?? []), ...installation.policyRepositories])) {
      await check(`repository:${repository}`, async () => {
        const listing = await listOpenPullRequests(new GitHubReader(dependencies.credentials, { maxDurationMs: 15_000, maxRequests: 20 }), repository);
        if (!listing.repository || listing.coverage.status !== 'complete') throw new Error();
        return 'The App can read this repository and its paginated pull request list.';
      }, 'Check the GitHub App installation repository selection, read permissions, outbound access and rate limits.');
      await check(`tooling:${repository}`, async () => {
        const policy = await dependencies.applyPolicy?.(repository);
        const searchPath = (process.env.PATH ?? '/usr/bin:/bin').split(':'), checkoutChecks: string[] = [];
        for (const command of policy?.execution?.requiredChecks ?? []) {
          const absolute = isAbsolute(command.executable);
          if (!absolute && command.executable.includes('/')) { checkoutChecks.push(command.id); continue; }
          const candidates = absolute ? [command.executable] : searchPath.filter(path => isAbsolute(path)).map(path => join(path, command.executable));
          let found = false;
          for (const candidate of candidates) try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) { found = true; break; } } catch {}
          if (!found) {
            if (!absolute && searchPath.some(path => !isAbsolute(path))) checkoutChecks.push(command.id);
            else throw new Error();
          }
        }
        if (checkoutChecks.length) return { ok: false, message: `Tooling diagnostics are incomplete: checks ${checkoutChecks.join(', ')} depend on checkout-relative executable paths. Verify them inside the retained candidate workspace. Installation diagnostics do not execute repository checks.` };
        return 'Configured check executables are accessible. Repository dependencies and actual check results are verified when the retained candidate runs its checks.';
      }, 'Check executable permissions and the absolute paths or service account PATH named by this repository execution policy. Diagnostics do not execute repository checks.');
    }
    if (dependencies.slack) await check('slack-configuration', async () => { if (!await dependencies.slack!.token()) throw new Error(); return 'The private Slack token is readable. Workspace binding, delivery permissions and real rendering remain separate checks.'; },
      'Check the Slack token file ownership, mode 0600, nonempty contents and configured workspace. No Slack message was sent.');
  }
  return { schemaVersion: 1, ok: checks.every(check => check.ok), account: { username: account.username, uid: account.uid, home: account.homedir }, checks };
}
