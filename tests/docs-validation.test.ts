import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const cases: { name: string; file?: string; change?: (text: string) => string; diagnostic?: RegExp }[] = [
  { name: 'accepts the checked-in examples and presentation' },
  { name: 'rejects invalid workflow examples', file: 'examples/team-pr/workflow.json',
    change: text => { const value = JSON.parse(text); value.schemaVersion = 999; return JSON.stringify(value); },
    diagnostic: /Workflow example/ },
  { name: 'rejects invalid result examples', file: 'examples/results/review.json',
    change: text => { const value = JSON.parse(text); value.headSha = 'invalid'; return JSON.stringify(value); },
    diagnostic: /review example/ },
  { name: 'rejects missing prompt files', file: 'examples/team-pr/workflow.json',
    change: text => text.replace('prompts/review.md', 'prompts/missing.md'), diagnostic: /ENOENT/ },
  { name: 'rejects broken documentation links', file: 'README.md',
    change: text => `${text}\n[Missing](missing.md)\n`, diagnostic: /Broken local link/ },
  { name: 'rejects duplicate presentation IDs', file: 'presentation.html',
    change: text => text.replace('</body>', '<div id="duplicate"></div><div id="duplicate"></div></body>'),
    diagnostic: /Duplicate HTML ID/ },
  { name: 'rejects stale embedded workflow data', file: 'presentation.html',
    change: text => text.replace(/(<script id="initial-workflow" type="application\/json">).*?(<\/script>)/s, '$1{}$2'),
    diagnostic: /Rebuild the presentation/ },
];

for (const scenario of cases) {
  test(`document validation ${scenario.name}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'repo-chap-docs-test-'));
    try {
      cpSync(resolve('docs'), join(directory, 'docs'), { recursive: true });
      cpSync(resolve('README.md'), join(directory, 'README.md'));
      symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
      writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n');
      if (scenario.file && scenario.change) {
        const path = join(directory, 'docs/pr-workflows', scenario.file);
        const before = readFileSync(path, 'utf8');
        const after = scenario.change(before);
        assert.notEqual(after, before, 'Fixture mutation must change the input');
        writeFileSync(path, after);
      }
      const result = spawnSync(process.execPath, [join(directory, 'docs/pr-workflows/validate.ts')], { encoding: 'utf8' });
      assert.equal(result.status, scenario.diagnostic ? 1 : 0, result.stderr);
      if (scenario.diagnostic) assert.match(result.stderr, scenario.diagnostic);
      else assert.match(result.stdout, /PASS document contracts/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
