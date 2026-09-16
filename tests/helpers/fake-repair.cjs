const fs = require('node:fs');
const cp = require('node:child_process');
const { provider, mode, log, marker, childPid } = global.fixture;
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\n');
if (args.includes('--version')) { console.log(provider === 'claude' ? '2.1.236 (Claude Code)' : 'codex-cli 0.154.0'); process.exit(); }
if (args.includes('--help')) {
  console.log(provider === 'claude' ? '--print --output-format json --json-schema --model --settings --setting-sources --safe-mode --tools --allowedTools --permission-mode dontAsk --strict-mcp-config --mcp-config --resume\n--effort <level> Effort level (low, medium, high, xhigh, max)' : '--json --output-schema --model --config --sandbox --ignore-user-config --skip-git-repo-check --strict-config --ask-for-approval');
  process.exit();
}
if (args.includes('--bundled')) { console.log(JSON.stringify({ models: [{ slug: 'fictional-model', default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] }] })); process.exit(); }
let input = '';
process.stdin.on('data', bytes => input += bytes);
process.stdin.on('end', () => {
  const data = JSON.parse(input.split('\n\n').find(line => line.startsWith('{')).split('\n')[0]);
  fs.writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), remotes: cp.execFileSync('git', ['remote']).toString(), input: data }));
  if (['hang', 'cancel'].includes(mode)) {
    const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(childPid, String(child.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return;
  }
  if (!fs.readFileSync('AGENTS.md','utf8').includes('numeric')) throw new Error('Missing pinned instructions');
  const threads = data.evidence.threads.items.filter(thread => !thread.resolved).map(thread => ({ threadId: thread.id,
    disposition: mode === 'blocked' || mode === 'blocked_thread' ? 'blocked' : mode === 'no_change' || mode === 'declined' || mode === 'mixed_threads' && thread.id === 'THREAD_declined' ? 'declined' : 'addressed',
    response: mode === 'blocked' ? 'Should the public value be three or four? Product intent is unknown.' : 'Changed the value as requested.', evidenceRefs: [`thread:${thread.id}`] }));
  let result;
  if (['blocked', 'no_change'].includes(mode)) result = { schemaVersion: 1, outcome: mode, expectedHeadSha: data.sources.headSha,
    reason: mode === 'blocked' ? 'The product value is unknown; choose three or four.' : 'The requested behavior already exists.', threads, notesMarkdown: 'No candidate was prepared.' };
  else {
    const incremented = Number(/value = (\d+)/.exec(fs.readFileSync('src/value.js', 'utf8'))?.[1]) + 1;
    fs.writeFileSync('src/value.js', mode === 'increment' ? `export const value = ${incremented};\n` : mode === 'leftover_conflict' ? '<<<<<<< HEAD\nexport const value = 3;\n=======\nexport const value = 4;\n>>>>>>> base\n' : mode === 'keep_head' ? 'export const value = 2;\n' : 'export const value = 3;\n');
    let paths = mode === 'keep_head' ? [] : ['src/value.js'];
    if (mode === 'outside_policy') { fs.mkdirSync('src-extra'); fs.writeFileSync('src-extra/unrelated.js', 'changed\n'); paths.push('src-extra/unrelated.js'); }
    if (mode === 'symlink') { fs.symlinkSync('/tmp/unrelated-example', 'src/link'); paths.push('src/link'); }
    if (mode === 'changed_head') { cp.execFileSync('git', ['-c', 'user.name=River', '-c', 'user.email=river@example.invalid', 'commit', '-am', 'Unexpected provider commit']); }
    if (mode === 'missing_thread') threads.pop();
    if (mode === 'foreign_thread') threads.push({ threadId: 'THREAD_other_pr', disposition: 'addressed', response: 'Done.', evidenceRefs: ['thread:THREAD_other_pr'] });
    if (mode === 'bad_ref' && threads.length) threads[0].evidenceRefs = ['invented-proof'];
    result = { schemaVersion: 1, outcome: 'candidate', expectedHeadSha: data.sources.headSha, baseSha: data.sources.baseSha, candidateSha: data.sources.headSha,
      summary: 'Apply the requested value.', changedPaths: mode === 'wrong_paths' ? [] : paths, threads, suggestedChecks: ['suggested-but-not-required'], notesMarkdown: 'The value follows the supplied repository instructions.' };
  }
  if (mode === 'invalid_payload') result = {};
  if (provider === 'claude') console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: result, session_id: '11111111-2222-3333-4444-555555555555', usage: { input_tokens: 100, output_tokens: 20 } }));
  else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'session_repair' }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ resultJson: JSON.stringify(result) }) } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } }));
  }
});
