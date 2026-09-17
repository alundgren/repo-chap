import { GitHubReader, validateTarget } from '@repo-chap/github';
import { RuntimeError, RuntimeStore } from '@repo-chap/runtime';
import type { WorkflowPackage } from '@repo-chap/workflow';
import { DaemonService, type DaemonDependencies } from './service.js';
import { handleControl } from './control.js';
import { reconcilePendingPushes } from './push.js';
import { reconcilePendingThreads } from './threads.js';
import { reconcilePendingPublications } from './publication.js';

export interface LocalApplyOptions {
  directory: string; repository: string; number: number; package: WorkflowPackage; profile: string;
  reviewers?: string[]; planOnly?: boolean; retry?: boolean; signal?: AbortSignal;
}
/** Execute immediately due work for one explicitly selected PR using the daemon's durable handlers. */
export async function runLocalApply(options: LocalApplyOptions, dependencies: Omit<DaemonDependencies, 'directory' | 'target' | 'planOnly'>): Promise<unknown> {
  validateTarget(options.repository, options.number);
  const store = await RuntimeStore.open(options.directory); let ownership: string | undefined, service: DaemonService | undefined;
  const stop = () => { void service?.stop(); };
  try {
    ownership = store.claimDaemon();
    service = new DaemonService(store, { ...dependencies, directory: options.directory, target: { repository: options.repository, number: options.number }, planOnly: options.planOnly });
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) throw new RuntimeError('Local apply was cancelled.');
    const repository = await service.register({ name: options.repository, package: options.package, profile: options.profile, reviewers: options.reviewers ?? [] });
    const prior = store.runs(repository.id).find(run => run.number === options.number);
    if (options.retry) {
      if (!prior) throw new RuntimeError('There is no retained run to retry. Start apply without --retry first.');
      store.retry(prior.id, service.now());
    }
    store.pollFinished(repository.id, service.now(), null);
    for (let step = 0; step < store.limits.maxImmediateSteps && !options.signal?.aborted; step++) {
      await service.tick(); await service.idle();
      const run = store.runs(repository.id).find(value => value.number === options.number);
      if (!run) throw new RuntimeError('Cannot inspect this PR. Check the repository, PR number and local GitHub access.');
      const effects = store.effects(run.id);
      if (options.planOnly && effects.some(effect => effect.state === 'planned') || effects.some(effect => ['sending', 'unknown'].includes(effect.state)) ||
        ['blocked', 'closed', 'cancelled'].includes(run.status)) break;
      const slackDue = !options.planOnly && dependencies.slack && store.slack.pending(service.now()).some(delivery => delivery.runId === run.id);
      if (run.status === 'waiting' && (run.dueAt ?? Infinity) > service.now() && store.repository(repository.id).nextPollAt > service.now() && !slackDue) break;
    }
    const run = store.runs(repository.id).find(value => value.number === options.number);
    if (!run) throw new RuntimeError('Local apply stopped before PR evidence was retained.');
    return await handleControl(service, { method: 'inspect', runId: run.id });
  } finally {
    options.signal?.removeEventListener('abort', stop); await service?.stop();
    if (ownership) store.releaseDaemon(ownership); store.close();
  }
}

/** Inspect without credentials, or reconcile one run using read-only credentials without dispatch. */
export async function inspectLocalApply(directory: string, runId: string, dependencies?: Omit<DaemonDependencies, 'directory' | 'target'>, signal?: AbortSignal): Promise<unknown> {
  const store = await RuntimeStore.open(directory); let ownership: string | undefined, service: DaemonService | undefined;
  try {
    ownership = store.claimDaemon();
    const run = store.run(runId), repository = store.repository(run.repositoryId);
    const access = dependencies ?? { credentials: { token: async () => { throw new RuntimeError('Inspect does not request credentials.'); }, redact: (value: string) => value }, profile: async () => { throw new RuntimeError('Inspect does not start a provider.'); } };
    const scoped = { ...access, directory, target: { repository: repository.name, number: run.number } };
    service = new DaemonService(store, scoped);
    if (dependencies) {
      store.recover(service.now());
      const readSignal = signal ?? new AbortController().signal;
      await reconcilePendingPushes(store, scoped, service.now, readSignal);
      await reconcilePendingPublications(store, scoped, service.now, readSignal);
      await reconcilePendingThreads(store, scoped, () => new GitHubReader(scoped.credentials, { ...scoped.readOptions, signal, now: service!.now,
        cooldown: { read: () => store.cooldown(), extend: until => { store.cooldown(until); } } }), service.now);
    }
    return await handleControl(service, { method: 'inspect', runId });
  } finally {
    await service?.stop(); if (ownership) store.releaseDaemon(ownership); store.close();
  }
}
