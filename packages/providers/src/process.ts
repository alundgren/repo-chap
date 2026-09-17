import { spawn } from 'node:child_process';

export type ProcessStatus = 'exited' | 'provider_error' | 'timeout' | 'cancelled' | 'superseded' | 'output_limit';
export interface ProcessResult { status: ProcessStatus; exitCode: number | null; stdout: Buffer; stderr: Buffer }
export interface ProcessOptions {
  cwd: string; input?: string; timeoutMs: number; maxBytes: number; signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** A separate process group lets a deadline also stop tools started by the provider. */
export async function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return { status: options.signal.reason === 'superseded' ? 'superseded' : 'cancelled', exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  if (options.timeoutMs <= 0) return { status: 'timeout', exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  return new Promise(resolve => {
    let status: ProcessStatus = 'exited', bytes = 0, settled = false, exitCode: number | null = null;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal); }
    };
    const finish = () => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(killTimer); options.signal?.removeEventListener('abort', cancel);
      kill('SIGKILL'); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      resolve({ status, exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const stop = (next: ProcessStatus) => {
      if (status !== 'exited' || settled) return;
      status = next; kill('SIGTERM');
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(); }, 200);
    };
    const cancel = () => stop(options.signal?.reason === 'superseded' ? 'superseded' : 'cancelled');
    const deadline = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const collect = (target: Buffer[], data: Buffer) => {
      const available = Math.max(0, options.maxBytes - bytes);
      if (available) target.push(data.subarray(0, available)); bytes += data.length;
      if (bytes > options.maxBytes) stop('output_limit');
    };
    child.stdout.on('data', data => collect(stdout, data)); child.stderr.on('data', data => collect(stderr, data));
    child.once('error', () => { status = 'provider_error'; finish(); });
    child.once('exit', code => { exitCode = code; kill('SIGKILL'); });
    child.once('close', code => { exitCode = code; finish(); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}
