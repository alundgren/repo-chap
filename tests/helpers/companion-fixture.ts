import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson, digest, loadWorkflow, parseFixture } from '@repo-chap/workflow';
import { saveCapture, type Inspection } from '@repo-chap/github';

export async function companionFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'repo-chap-companion-'));
  const repository = join(temporary, 'willow-project');
  const pkg = await loadWorkflow(resolve('docs/pr-workflows/examples/team-pr/workflow.json'));
  for (const file of pkg.files) { await mkdir(dirname(join(repository, file.path)), { recursive: true }); await writeFile(join(repository, file.path), file.text); }
  const head = 'a'.repeat(40), base = 'b'.repeat(40);
  const collection = () => ({ items: [], coverage: { status: 'complete' as const, pages: 1 } });
  const evidence: Inspection['evidence'] = { schemaVersion: 1, requested: { repository: 'willow-labs/sample-project', pr: 42 },
    repository: { id: 'R_sample', name: 'willow-labs/sample-project', private: true },
    pullRequest: { id: 'PR_42', number: 42, url: 'https://github.com/willow-labs/sample-project/pull/42', title: 'Update the fictional sample', body: '', author: 'river', lifecycle: 'open', draft: false,
      headSha: head, baseSha: base, headRef: 'sample-update', baseRef: 'main', headRepository: { id: 'R_sample', name: 'willow-labs/sample-project' },
      createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T11:00:00.000Z', mergeability: 'mergeable', reviewDecision: null },
    metadata: { status: 'complete', pages: 1 }, labels: collection(), checks: collection(), reviews: collection(), threads: collection(), reviewerActivity: collection(),
    configuredReviewers: [], revision: { status: 'stable', headSha: head, baseSha: base } };
  const evidenceDigest = digest(canonicalJson(evidence));
  const fixture = parseFixture({ schemaVersion: 1, now: '2026-05-01T12:00:00.000Z', observations: [{ headSha: head, baseSha: base, evidenceDigest,
    facts: { lifecycle: 'open', draft: false, evidenceComplete: true, young: false, headDebouncing: false, conflict: false, unaddressedReview: false, externalReviewPending: true },
    externalReviewStartedAt: '2026-05-01T11:55:00.000Z' }],
    control: { memory: { classificationCurrent: true, reviewCurrent: true }, review: { verdict: 'acceptable', coverage: 'complete' } } });
  const inspection: Inspection = { schemaVersion: 1, status: 'complete', packageDigest: pkg.digest, evidenceDigest, evidence, fixture };
  const capture = await saveCapture(join(temporary, 'captures'), inspection);
  const fixturePath = join(repository, 'review-wait.fixture.json');
  await writeFile(fixturePath, JSON.stringify({ ...fixture, expected: { status: 'waiting', selectedRuleIds: ['reviewer_active'], proposedEffects: [] } }));
  return { temporary, repository, pkg, workflow: join(repository, pkg.workflowPath), fixturePath, inspection, capture,
    control: join(temporary, 'control'), data: join(temporary, 'desktop-data'), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}
