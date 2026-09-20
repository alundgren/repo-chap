import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { fixture } from './pilot-fixture.mjs';
import { writePrivate } from '../deploy/pilot/store.mjs';
import { PilotError } from '../deploy/pilot/io.mjs';
import { main } from '../deploy/pilot/pilot.mjs';

const digest = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');

export async function journey(t) {
  const f = await fixture(t);
  // Retain only unavoidable account inputs, not a prepared environment.
  await rm(f.store.directory(f.run.id), { recursive: true });
  const pilotConfig = { profile: 'pilot', workspaceId: 'TFOREST', channelId: 'CPAPERBOAT' };
  await writePrivate(join(f.root, 'operator.json'), JSON.stringify({ ...f.run, pilotConfig }));
  await writePrivate(join(f.run.configDirectory, 'installation.json'), JSON.stringify({ schemaVersion: 1,
    providerConfig: '/etc/repo-chap/providers.json', app: { appId: '41', installationId: 42, privateKeyFile: '/etc/repo-chap/app.pem' },
    slack: { enabled: true, workspaceId: pilotConfig.workspaceId, tokenFile: '/etc/repo-chap/slack-token' },
  }));
  await writePrivate(join(f.run.configDirectory, 'providers.json'), JSON.stringify({ schemaVersion: 1, profiles: { pilot: {
    provider: 'codex', executable: 'codex', model: 'fictional-model', timeoutMs: 120000, maxOutputBytes: 1048576, maxAttempts: 1, maximumCapabilities: [],
  } } }));
  await writePrivate(join(f.run.configDirectory, 'slack-token'), 'fictional-slack-secret');
  const initialTree = digest({ README: 'Dedicated fictional repository' });
  const initial = digest({ tree: initialTree, parents: [] });
  const remote = { refs: { main: initial }, commits: { [initial]: { sha: initial, tree: { sha: initialTree }, parents: [] } }, trees: { [initialTree]: {} },
    pulls: [], dispatches: [], repositories: [], runs: [], effects: [], messages: [], writes: [], interrupt: null, confirmations: [], rendering: true };
  const write = label => {
    remote.writes.push(label);
    if (remote.interrupt === remote.writes.length) { remote.interrupt = null; throw new PilotError('Simulated lost response'); }
  };
  f.accounts.io.pause = async () => {};
  const originalCommand = f.accounts.io.command;
  const originalRequest = f.accounts.io.request;
  f.accounts.io.request = async (url, options) => {
    if (url.startsWith('https://slack.com/')) return url.includes('auth.test') ? { ok: true, team_id: pilotConfig.workspaceId } : { ok: true, channel: { id: pilotConfig.channelId, is_member: true } };
    return originalRequest(url, options);
  };
  const prView = pr => ({ number: pr.number, state: pr.state.toUpperCase(), headRefOid: pr.head.sha, baseRefOid: pr.base.sha, mergeable: pr.mergeable ? 'MERGEABLE' : 'CONFLICTING' });
  const refresh = () => {
    for (const pr of remote.pulls) {
      if (remote.refs[pr.head.ref]) pr.head.sha = remote.refs[pr.head.ref];
      if (remote.refs[pr.base.ref]) pr.base.sha = remote.refs[pr.base.ref];
    }
  };
  function discover() {
    const repo = remote.repositories[0];
    if (!repo) return;
    for (const pr of remote.pulls) if (!remote.runs.some(run => run.number === pr.number)) {
      remote.runs.push({ id: `run-${pr.number}`, repositoryId: repo.id, number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, evidenceAvailable: true });
    }
  }
  function repair(item) {
    const pr = remote.pulls.find(pr => pr.number === item.number);
    if (remote.repositories[0].paused || pr.draft || item.details) return;
    const initialHead = pr.head.sha, baseSha = pr.base.sha;
    const isReview = pr.head.ref.endsWith('-review');
    const candidate = digest({ initialHead, baseSha, repair: true });
    remote.refs[pr.head.ref] = candidate;
    pr.head.sha = candidate;
    pr.mergeable = true;
    item.headSha = candidate;
    const effect = { id: `push-${item.id}`, kind: 'github.push_candidate', state: 'confirmed', expectedRevision: initialHead,
      receipt: { status: 'confirmed', repository: f.run.repository, expectedHeadSha: initialHead, candidateSha: candidate, observedSha: candidate } };
    remote.effects.push(effect);
    item.details = { run: { ...item }, inspection: { evidence: { repository: { name: f.run.repository } } }, results: [
      ...(isReview ? [{ result: { job: { actionId: 'review', headSha: initialHead, baseSha }, provider: { outcome: 'completed', payload: { coverage: 'complete', verdict: 'concerns', findings: [{ title: 'Percentage discount is incorrect' }] } } } }] : []),
      { result: { job: { actionId: isReview ? 'address' : 'resolve_conflict', headSha: initialHead, baseSha }, repair: { status: 'candidate', requiredChecksPassed: true,
        candidate: { sha: candidate, parents: [initialHead, baseSha] }, checks: [{ id: 'pilot-regression', status: 'passed', candidateSha: candidate }] } } },
    ], effects: [effect], slack: [] };
    write(`daemon push ${pr.number}`);
  }
  function deliver(item) {
    if (!item.details || item.details.slack.length) return;
    const message = { id: `message-${item.id}`, runId: item.id, status: 'open', packet: { repository: f.run.repository, prNumber: item.number, headSha: item.headSha },
      receipt: { workspaceId: pilotConfig.workspaceId, channelId: pilotConfig.channelId, timestamp: `123456.${String(item.number).padStart(6, '0')}` },
      deliveries: [{ operation: 'post', state: 'confirmed' }] };
    item.details.slack.push(message);
    remote.messages.push(message);
    write(`daemon Slack ${item.number}`);
  }
  f.accounts.io.command = async (file, args, options = {}) => {
    if (file === 'git') {
      const push = args.indexOf('push');
      if (push === -1) return '';
      const lease = args.find(arg => arg.startsWith('--force-with-lease=')).slice('--force-with-lease=refs/heads/'.length);
      const [name, before] = lease.split(':');
      assert.equal(remote.refs[name] ?? '', before, 'conditional Git update must use the exact current commit');
      const after = args.at(-1).split(':')[0];
      if (after) remote.refs[name] = after; else delete remote.refs[name];
      refresh();
      write(`git ${name} ${after ? 'set' : 'delete'}`);
      return '';
    }
    if (file === 'gh') {
      if (args[0] === 'pr') {
        const pr = remote.pulls.find(pr => pr.number === +args[2]);
        assert.ok(pr);
        if (args[1] === 'view') return JSON.stringify(prView(pr));
        assert.equal(args[1], 'ready');
        assert.equal(pr.draft, true, 'ready conversion must not be duplicated');
        pr.draft = false;
        write(`ready ${pr.number}`);
        return '';
      }
      const path = args.at(-1), method = args[args.indexOf('--method') + 1];
      const body = options.input ? JSON.parse(options.input) : undefined;
      const relative = path.replace(`repos/${f.run.repository}`, '');
      if (relative === '') return JSON.stringify({ id: 17, private: true, permissions: { admin: true }, default_branch: 'main' });
      if (relative === '/git/matching-refs/heads/') return JSON.stringify(Object.entries(remote.refs).map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha } })));
      if (relative.startsWith('/git/commits/')) return JSON.stringify(remote.commits[relative.split('/').at(-1)]);
      if (relative === '/git/trees') {
        const tree = { ...remote.trees[body.base_tree], ...Object.fromEntries(body.tree.map(entry => [entry.path, entry.content])) };
        const sha = digest(tree); remote.trees[sha] = tree; write(`tree ${sha}`); return JSON.stringify({ sha });
      }
      if (relative === '/git/commits') {
        const sha = digest(body); remote.commits[sha] = { ...body, sha, tree: { sha: body.tree } }; write(`commit ${sha}`); return JSON.stringify({ sha });
      }
      if (relative.startsWith('/pulls?')) {
        const params = new URLSearchParams(relative.split('?')[1]);
        return JSON.stringify(remote.pulls.filter(pr => (params.get('state') !== 'open' || pr.state === 'open') && (!params.has('head') || params.get('head').endsWith(':' + pr.head.ref))));
      }
      if (relative === '/pulls') {
        assert.equal(method, 'POST');
        assert.ok(!remote.pulls.some(pr => pr.head.ref === body.head), 'PR creation must not be duplicated');
        const pr = { number: remote.pulls.length + 1, title: body.title, body: body.body, draft: body.draft, state: 'open', merged: false,
          head: { ref: body.head, sha: remote.refs[body.head], repo: { id: 17 } }, base: { ref: body.base, sha: remote.refs[body.base], repo: { id: 17 } }, mergeable: !body.head.endsWith('-conflict') };
        remote.pulls.push(pr); write(`PR ${pr.number}`); return JSON.stringify(pr);
      }
      if (relative.startsWith('/pulls/')) {
        const pr = remote.pulls.find(pr => pr.number === +relative.split('/').at(-1));
        assert.ok(pr);
        if (method === 'PATCH') { pr.state = body.state; write(`close ${pr.number}`); }
        return JSON.stringify(pr);
      }
      if (relative.startsWith('/commits/')) return JSON.stringify({ sha: remote.refs[decodeURIComponent(relative.slice('/commits/'.length))] });
      if (relative.endsWith('/dispatches')) {
        assert.ok(!remote.dispatches.some(job => job.display_title === body.inputs.correlation));
        const job = { id: remote.dispatches.length + 101, display_title: body.inputs.correlation, head_sha: remote.refs[body.ref], run_attempt: 1, status: 'completed', branch: body.ref };
        remote.dispatches.push(job); write(`dispatch ${body.ref}`); return '';
      }
      if (relative.includes('/runs?')) {
        const branch = new URLSearchParams(relative.split('?')[1]).get('branch');
        return JSON.stringify({ workflow_runs: remote.dispatches.filter(job => job.branch === branch) });
      }
      if (/^\/actions\/runs\/\d+$/.test(relative) && method === 'DELETE') {
        const id = +relative.split('/').at(-1);
        remote.dispatches = remote.dispatches.filter(job => job.id !== id);
        write(`delete dispatch ${id}`);
        return '';
      }
      if (relative.includes('/jobs?')) {
        const job = remote.dispatches.find(job => relative.includes(`/runs/${job.id}/`));
        const runner = f.state.runners[0];
        return JSON.stringify({ total_count: 1, jobs: [{ id: job.id + 100, name: 'check', status: 'completed', conclusion: job.branch.endsWith('-failing') ? 'failure' : 'success', runner_id: runner.id, runner_name: runner.name, labels: [runner.name] }] });
      }
    }
    if (file === 'ssh') {
      const command = args.at(-1);
      if (command.includes(' daemon ') && !command.includes('diagnose')) {
        if (command.includes('register-source')) {
          assert.equal(remote.repositories.length, 0, 'registration must not be duplicated');
          const workflowPath = command.match(/register-source (\S+)/)[1], branch = command.match(/--branch (\S+)/)[1];
          remote.repositories.push({ id: '17', name: f.run.repository, paused: false, profile: 'pilot', source: { workflowPath, branch, status: 'valid', observedRevision: remote.refs[branch] } });
          discover(); write('register');
        } else if (command.includes(' pause ')) {
          assert.equal(remote.repositories[0].paused, false); remote.repositories[0].paused = true; write('pause');
        } else if (command.includes(' resume ')) {
          assert.equal(remote.repositories[0].paused, true); remote.repositories[0].paused = false; write('resume');
        } else if (command.includes(' inspect ')) {
          const item = remote.runs.find(item => command.includes(`inspect ${item.id} `));
          assert.ok(item); repair(item); deliver(item);
          const details = structuredClone(item.details);
          if (remote.unknownPush) details.effects[0].state = 'unknown';
          if (remote.deliveryState) details.slack[0].deliveries[0].state = remote.deliveryState;
          return JSON.stringify({ ok: true, result: details });
        } else assert.match(command, / status /);
        discover();
        return JSON.stringify({ ok: true, result: { mode: 'apply', slackEnabled: true, repositories: remote.repositories, runs: remote.runs.map(({ details, ...run }) => run) } });
      }
    }
    return originalCommand(file, args, options);
  };
  async function invoke(action) {
    return main([action, '--root', f.root], f.accounts, text => f.state.output.push(text), process.env, async () => true, undefined, async message => {
      remote.confirmations.push(message);
      return message.startsWith('Open both') ? remote.rendering : true;
    });
  }
  return { ...f, remote, initial, invoke };
}
