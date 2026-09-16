const fs = require('node:fs');
const cp = require('node:child_process');
const { mode, log, marker, childPid } = global.fixture;
const args = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify(args) + '\n');
if (args.includes('--version')) { console.log('2.1.236 (Claude Code)'); process.exit(); }
if (args.includes('--help')) {
  console.log(mode === 'unsupported' ? '--print --output-format json' : [
    '--print --output-format json --json-schema --model --settings --setting-sources --safe-mode --tools --allowedTools --permission-mode dontAsk --strict-mcp-config --mcp-config --resume',
    '--effort <level> Effort level (low, medium, high, xhigh, max)',
  ].join('\n'));
  process.exit();
}
let input = '';
process.stdin.on('data', bytes => input += bytes);
process.stdin.on('end', () => {
  fs.writeFileSync(marker, input.startsWith('Perform agent.review') ? 'review' : 'classify');
  if (['hang', 'cancel'].includes(mode) || mode === 'invalid_then_hang' && fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('--print')).length > 1) {
    const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(childPid, String(child.pid));
    process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return;
  }
  if (mode === 'flood' || mode === 'stderr_flood') {
    process[mode === 'flood' ? 'stdout' : 'stderr'].write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000); return;
  }
  if (mode === 'lost' && args.includes('--resume')) { process.exitCode = 1; return; }
  if (mode === 'error') { console.error('credential-example-must-not-leak'); process.exitCode = 1; return; }
  if (mode === 'malformed') { console.log('{not JSON}'); return; }
  const data = JSON.parse(input.split('\n\n').find(line => line.startsWith('{')).split('\n')[0]);
  const classify = input.startsWith('Perform agent.classify');
  const missing = data.missingEvidence;
  let result = classify ? { schemaVersion: 1, headSha: data.sources.headSha,
    labels: data.allowedLabels.length ? [{ name: data.allowedLabels[0], reason: 'The value changed.', evidence: [{ path: 'src/value.js', side: 'head', startLine: 1, endLine: 1, explanation: 'Updated value.' }] }] : [],
    uncertain: missing.length > 0 } : { schemaVersion: 1, headSha: data.sources.headSha, baseSha: data.sources.baseSha,
    summary: 'Reviewed the pinned value change.', verdict: missing.length ? 'inconclusive' : 'acceptable', coverage: missing.length ? 'partial' : 'complete', missingEvidence: missing, findings: [] };
  if (mode === 'invalid' || mode === 'invalid_then_hang') result = {};
  if (mode === 'citation' && classify) result.labels[0].evidence[0].endLine = 99;
  if (mode === 'wrong_head') result.headSha = 'a'.repeat(40);
  if (mode === 'wrong_base' && !classify) result.baseSha = 'a'.repeat(40);
  if (mode === 'false_clear' && !classify) { result.coverage = 'complete'; result.verdict = 'acceptable'; result.missingEvidence = []; }
  if (input.startsWith('Perform agent.resolve_conflict')) result = { schemaVersion: 1, outcome: 'blocked', expectedHeadSha: data.sources.headSha, reason: 'Human decision needed.', threads: [], notesMarkdown: 'No candidate was created.' };
  if (mode === 'schema_error') process.exitCode = 1;
  console.log(JSON.stringify({ type: 'result', subtype: mode === 'schema_error' ? 'error_max_structured_output_retries' : mode === 'reported_error' ? 'error_during_execution' : 'success', is_error: ['reported_error', 'schema_error'].includes(mode),
    structured_output: mode === 'no_result' ? undefined : result, session_id: mode === 'bad_session' ? '../../transcript.jsonl' : '11111111-2222-3333-4444-555555555555',
    ...(mode === 'no_usage' ? {} : { usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 30 }, total_cost_usd: 0.012 }) }));
});
