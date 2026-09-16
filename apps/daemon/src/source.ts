import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPackage, limits, parseJson, referencePath, validateWorkflow, workflowReferences, WorkflowError, type Capability, type WorkflowPackage } from '@repo-chap/workflow';
import { prepareCaptureDirectory, validateTarget, type CredentialSource } from '@repo-chap/github';
import { runProcess } from '@repo-chap/providers';
import { RuntimeError } from '@repo-chap/runtime';

const gitEnvironment = (): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
function invalid(code: string, path: string, message: string): never { throw new WorkflowError([{ code, path, message }]); }

export async function readWorkflowCommit(repository: string, revision: string, workflowPath: string, maximumCapabilities: readonly Capability[], signal?: AbortSignal): Promise<WorkflowPackage> {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new RuntimeError('Workflow source requires a full Git commit revision.');
  const normalized = referencePath('workflow.json', workflowPath);
  if (normalized.fragment) invalid('invalid_path', workflowPath, 'Workflow path cannot contain a fragment.');
  workflowPath = normalized.path;
  const started = Date.now(), files: Record<string, string> = Object.create(null); let bytes = 0;
  const git = (args: string[], maxBytes: number) => runProcess('git', ['--no-replace-objects', '--literal-pathspecs', ...args],
    { cwd: repository, timeoutMs: 30_000 - (Date.now() - started), maxBytes, signal, env: gitEnvironment() });
  async function read(path: string): Promise<void> {
    if (Object.hasOwn(files, path)) return;
    const tree = await git(['ls-tree', '-lz', '--full-tree', revision, '--', path], 8192);
    if (tree.status !== 'exited' || tree.exitCode !== 0) throw new RuntimeError('Cannot read the pinned workflow commit within its deadline.');
    const entry = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t([^\0]+)\0$/.exec(tree.stdout.toString('utf8'));
    if (!tree.stdout.length) invalid('missing_file', path, 'Referenced file is missing from the source commit.');
    if (!entry || entry[4] !== path) invalid('invalid_file', path, 'Reference must name a regular file in the source commit.');
    if (Number(entry[3]) > limits.fileBytes) invalid('size_limit', path, 'File exceeds 1 MiB.');
    bytes += Number(entry[3]); if (bytes > limits.packageBytes) invalid('size_limit', workflowPath, 'Package exceeds 8 MiB.');
    const content = await git(['cat-file', 'blob', entry[2]!], limits.fileBytes);
    if (content.status !== 'exited' || content.exitCode !== 0) throw new RuntimeError('Cannot read a pinned workflow file within its deadline.');
    try { files[path] = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content.stdout); }
    catch { invalid('invalid_encoding', path, 'File must contain valid UTF-8.'); }
  }
  await read(workflowPath);
  const workflow = validateWorkflow(parseJson(files[workflowPath]!, workflowPath), maximumCapabilities);
  const paths = [...new Set([workflowPath, ...workflowReferences(workflow).map(ref => referencePath(workflowPath, ref).path)])];
  if (paths.length > limits.files) invalid('size_limit', workflowPath, 'Package exceeds 256 files.');
  for (const path of paths) await read(path);
  return buildPackage(workflowPath, files, { maximumCapabilities });
}

export async function fetchWorkflowCommit(directory: string, repository: string, revision: string, workflowPath: string, maximumCapabilities: readonly Capability[], credentials: CredentialSource, signal: AbortSignal, canFetch: () => boolean = () => true): Promise<WorkflowPackage> {
  validateTarget(repository, 1);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new RuntimeError('Workflow source requires a full Git commit revision.');
  const root = await prepareCaptureDirectory(directory), cache = await mkdtemp(join(root, 'workflow-'));
  const env = gitEnvironment();
  const git = async (args: string[], environment = env) => {
    const result = await runProcess('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: cache, timeoutMs: 30_000, maxBytes: 2_097_152, env: environment, signal });
    if (result.status !== 'exited' || result.exitCode !== 0) throw new RuntimeError('Cannot fetch the workflow commit. Check GitHub App contents access and retry.');
  };
  try {
    await git(['init', '--bare', '--quiet']);
    const token = await credentials.token(signal);
    if (!canFetch()) throw new RuntimeError('Workflow fetch is waiting for the installation cooldown.');
    await git(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', `https://github.com/${repository}.git`, revision], {
      ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    });
    return await readWorkflowCommit(cache, revision, workflowPath, maximumCapabilities, signal);
  } finally { await rm(cache, { recursive: true, force: true }); }
}
