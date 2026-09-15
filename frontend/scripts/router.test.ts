// Plain assertions runnable with `npx tsx scripts/router.test.ts` — the
// frontend has no test runner configured; this keeps the parser honest.
import { parseRoute } from '../src/lib/router';

const cases: Array<[string, unknown]> = [
  ['', { name: 'projects' }],
  ['#/', { name: 'projects' }],
  ['#/projects', { name: 'projects' }],
  ['#/projects/', { name: 'projects' }],
  ['#/projects/new', { name: 'project-new' }],
  ['#/projects/p1', { name: 'project', projectId: 'p1' }],
  [
    '#/projects/p1/items/i1',
    { name: 'item', projectId: 'p1', itemId: 'i1', step: undefined },
  ],
  [
    '#/projects/p1/items/i1/voice',
    { name: 'item', projectId: 'p1', itemId: 'i1', step: 'voice' },
  ],
  [
    '#/projects/p1/catalog-batch/start/sess1',
    {
      name: 'catalog-batch-start',
      projectId: 'p1',
      sourceSessionId: 'sess1',
    },
  ],
  [
    '#/projects/p1/catalog-batch/batch1',
    { name: 'catalog-batch', projectId: 'p1', batchId: 'batch1' },
  ],
  [
    '#/projects/p1/ab-test/run1',
    { name: 'ab-test', projectId: 'p1', runId: 'run1' },
  ],
  ['#/generate', { name: 'generate' }],
  // Этап 88: /postprod (список готовых роликов) и /postprod/:sessionId
  // (переозвучка/экспорт/публикация/шаринг одного ролика).
  ['#/postprod', { name: 'postprod' }],
  ['#/postprod/', { name: 'postprod' }],
  ['#/postprod/sess1', { name: 'postprod-video', sessionId: 'sess1' }],
  ['#/plan', { name: 'plan' }],
  ['#/channels', { name: 'channels' }],
  ['#/credits', { name: 'credits' }],
  ['#/brand-manifests', { name: 'manifests' }],
  ['#/brand-manifests/new', { name: 'manifest-new' }],
  ['#/brand-manifests/bm1', { name: 'manifest', manifestId: 'bm1' }],
  [
    '#/brand-manifests/bm1/extra',
    { name: 'not-found', path: 'brand-manifests/bm1/extra' },
  ],
  ['#/nope/x', { name: 'not-found', path: 'nope/x' }],
];
let failed = 0;
for (const [hash, expected] of cases) {
  const got = parseRoute(hash);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    ok ? 'ok  ' : 'FAIL',
    JSON.stringify(hash),
    '→',
    JSON.stringify(got)
  );
}
if (failed) process.exit(1);
console.log('router: all cases pass');
