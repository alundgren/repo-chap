import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildPackage, canonicalJson, digest, loadWorkflow, parseFixture, supportedCapabilities } from '@repo-chap/workflow';
import { saveCapture, type Inspection } from '@repo-chap/github';
import { type ProviderProfile } from '@repo-chap/providers';

const root = resolve('.'), cli = join(root, 'apps/cli/dist/cli.js');
const example = join(root, 'docs/pr-workflows/examples/team-pr/workflow.json');
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
export async function setup(mode = 'valid', extra: Partial<ProviderProfile> = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-provider-'));
  const repository = join(temporary, 'repo'); await mkdir(repository);
  git(repository, 'init', '-q'); git(repository, 'config', 'user.email', 'river@example.invalid'); git(repository, 'config', 'user.name', 'River');
  await mkdir(join(repository, 'src')); await writeFile(join(repository, 'src/value.js'), 'export const value = 1;\n');
  git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'Base'); const base = git(repository, 'rev-parse', 'HEAD');
  await writeFile(join(repository, 'src/value.js'), 'export const value = 2;\n');
  git(repository, 'commit', '-qam', 'Head'); const head = git(repository, 'rev-parse', 'HEAD');
  const pkg = await loadWorkflow(example);
  const evidence: Inspection['evidence'] = { schemaVersion: 1, requested: { repository: 'reef-labs/paperboat', pr: 42 },
    repository: { id: 'R_paperboat', name: 'reef-labs/paperboat', private: true },
    pullRequest: { id: 'PR_42', number: 42, url: 'https://github.com/reef-labs/paperboat/pull/42', title: 'Update value', body: '', author: 'river', lifecycle: 'open', draft: false,
      headSha: head, baseSha: base, headRef: 'update', baseRef: 'main', headRepository: { id: 'R_paperboat', name: 'reef-labs/paperboat' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z', mergeability: 'mergeable', reviewDecision: null },
    metadata: { status: 'complete', pages: 1 }, labels: { items: [], coverage: { status: 'complete', pages: 1 } },
    checks: { items: [], coverage: { status: 'complete', pages: 1 } }, reviews: { items: [], coverage: { status: 'complete', pages: 1 } },
    threads: { items: [], coverage: { status: 'complete', pages: 1 } }, reviewerActivity: { items: [], coverage: { status: 'complete', pages: 0 } }, configuredReviewers: [], revision: { status: 'stable', headSha: head, baseSha: base } };
  const evidenceDigest = digest(canonicalJson(evidence));
  const fixture = parseFixture({ schemaVersion: 1, now: '2026-01-01T01:00:00.000Z', observations: [{ headSha: head, baseSha: base, evidenceDigest,
    facts: { lifecycle: 'open', draft: false, evidenceComplete: true, conflict: false, unaddressedReview: false, externalReviewPending: false, young: false, headDebouncing: false } }] });
  const inspection: Inspection = { schemaVersion: 1, status: 'complete', packageDigest: pkg.digest, evidenceDigest, evidence, fixture };
  const capture = await saveCapture(join(temporary, 'captures'), inspection);
  const executable = join(temporary, 'fake-codex'), log = join(temporary, 'argv.jsonl'), marker = join(temporary, 'started'), childPid = join(temporary, 'child.pid');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(); }
if (args.includes('--help')) { console.log(mode === 'unsupported' ? '--json' : '--json --output-schema --model --config --sandbox --ignore-user-config --skip-git-repo-check --strict-config --ask-for-approval'); process.exit(); }
if (args.includes('--bundled')) { console.log(JSON.stringify({models:[{slug:'fictional-model',default_reasoning_level:'medium',supported_reasoning_levels:[{effort:'medium'},{effort:'high'}]}]})); process.exit(); }
let input=''; process.stdin.on('data', bytes=>input+=bytes); process.stdin.on('end', ()=>{
fs.writeFileSync(${JSON.stringify(marker)}, input.startsWith('Perform agent.review')?'review':'classify');
if (mode === 'hang' || mode === 'cancel' || mode === 'hang_review' && input.startsWith('Perform agent.review')) {
 const child = cp.spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'ignore'});
 fs.writeFileSync(${JSON.stringify(childPid)}, String(child.pid)); process.on('SIGTERM',()=>{});setInterval(()=>{},1000);return;
}
if (mode === 'flood') { process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);return; }
if (mode === 'lost' && args.includes('resume')) { process.exitCode=1;return; }
if (mode === 'error') { console.error('credential-example-must-not-leak');process.exitCode=1;return; }
const data=JSON.parse(input.split('\\n\\n').find(line=>line.startsWith('{')).split('\\n')[0]);
const classify=input.startsWith('Perform agent.classify');
const missing=data.missingEvidence;
let result=classify?{schemaVersion:1,headSha:data.sources.headSha,labels:[{name:data.allowedLabels.includes('other')?'other':data.allowedLabels[0],reason:'The value changed.',evidence:[{path:'src/value.js',side:'head',startLine:1,endLine:1,explanation:'Updates the exported value.'}]}],uncertain:missing.length>0}:{schemaVersion:1,headSha:data.sources.headSha,baseSha:data.sources.baseSha,summary:'Reviewed the pinned value change.',verdict:missing.length?'inconclusive':'acceptable',coverage:missing.length?'partial':'complete',missingEvidence:missing,findings:[]};
if(classify && !data.allowedLabels.length)result.labels=[];
if(mode==='findings' && !classify){result.verdict='concerns';result.findings=[{id:'value-boundary',kind:'reliability',severity:'medium',confidence:0.9,title:'The changed value needs a boundary test',reason:'The fictional change alters the exported value without a matching boundary test.',evidence:[{path:'src/value.js',side:'head',startLine:1,endLine:1,explanation:'The exported value is now two.'}]}];}
if(mode==='invalid')result={};
if(mode==='citation' && classify)result.labels[0].evidence[0].endLine=99;
if(mode==='wrong_side' && classify)result.labels[0].evidence[0].side='absent';
if(mode==='wrong_head')result.headSha='a'.repeat(40);
if(mode==='false_clear' && !classify){result.coverage='complete';result.verdict='acceptable';result.missingEvidence=[];}
if(input.startsWith('Perform agent.resolve_conflict'))result={schemaVersion:1,outcome:'blocked',expectedHeadSha:data.sources.headSha,reason:'Human decision needed.',threads:[],notesMarkdown:'No candidate was created.'};
console.log(JSON.stringify({type:'thread.started',thread_id:'session_fictional'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({resultJson:JSON.stringify(result)})}}));
console.log(JSON.stringify({type:'turn.completed',...(mode==='no_usage'?{}:{usage:{input_tokens:100,cached_input_tokens:20,output_tokens:30}})}));
});
`, { mode: 0o700 });
  if (extra.provider === 'claude') await writeFile(executable, `#!${process.execPath}\nglobal.fixture=${JSON.stringify({mode, log, marker, childPid})};\nrequire(${JSON.stringify(join(root, 'tests/helpers/fake-claude.cjs'))});\n`, { mode: 0o700 });
  const profile: ProviderProfile = { name: 'pilot', provider: 'codex', executable, model: 'fictional-model', effort: 'medium', timeoutMs: 10_000, maxOutputBytes: 256 * 1024, maxAttempts: 1, maximumCapabilities: [...supportedCapabilities], ...extra };
  const settings = join(temporary, 'providers.json'); const { name: _name, ...value } = profile;
  await writeFile(settings, JSON.stringify({ schemaVersion: 1, profiles: { pilot: value } }), { mode: 0o600 });
  const output = join(temporary, 'output');
  const args = ['analyze', example, '--capture', capture.directory, '--source-repo', repository, '--output-dir', output, '--provider-config', settings, '--profile', 'pilot', '--json'];
  const run = (...extra: string[]) => {
    const result = spawnSync(process.execPath, [cli, ...args, ...extra], { encoding: 'utf8', timeout: 30_000 });
    return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
  };
  return { temporary, repository, head, base, pkg, inspection, capture, executable, log, marker, childPid, profile, settings, output, args, run,
    cleanup: () => rm(temporary, { recursive: true, force: true }) };
}
