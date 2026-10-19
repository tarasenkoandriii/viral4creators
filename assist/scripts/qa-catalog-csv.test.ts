import assert from 'node:assert/strict';
import {
  exportQaCsv,
  parseQaCsv,
  requirementLinks,
} from '../src/lib/qa-catalog-csv';
import type { QaCasePayload } from '../src/lib/qa-catalog-api';
const payload: QaCasePayload = {
  title: '=HYPERLINK("https://example.invalid")',
  purpose: 'Line one\nLine two, quoted "text"',
  preconditions: 'demo only',
  steps: [{ action: 'Click, then submit', expected: 'Visible\nconfirmation' }],
  type: 'manual',
  priority: 'normal',
  tags: ['suite:onboarding'],
  requirementIds: ['REQ-LOGIN'],
  archived: false,
};
const rows = [{ caseKey: 'QA-CSV', payload }];
const csv = exportQaCsv(rows);
assert.ok(csv.includes("'=HYPERLINK"));
assert.deepEqual(parseQaCsv(csv), rows);
assert.deepEqual(requirementLinks(rows), [
  { requirement: 'REQ-LOGIN', manual: ['QA-CSV'], automated: [] },
]);
for (const bad of [
  'garbage',
  csv.replace('caseKey', 'unknown'),
  csv + '"unterminated',
  exportQaCsv([...rows, ...rows]),
  'x'.repeat(524289),
])
  assert.throws(() => parseQaCsv(bad));
console.log(
  'QA CSV: quoted/multiline roundtrip, formula defanging, limits and requirement links passed'
);
