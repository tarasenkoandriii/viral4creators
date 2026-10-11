import assert from 'node:assert/strict';
import { emptyQaFinding, findingComment } from '../src/lib/qa-finding';
const f = {
  ...emptyQaFinding(),
  url: 'https://example.com/login',
  context: 'viewer 390x844 dark uk',
  steps: 'Open login',
  expected: 'Button visible per specification',
  actual: 'Button overlaps input',
  impact: 'Cannot login',
};
assert.equal(findingComment(emptyQaFinding()), null);
assert.ok(findingComment(f)?.includes('needs_confirmation'));
assert.ok(findingComment(f)?.includes('не приложены'));
for (const url of [
  'javascript:alert(1)',
  'https://u:p@example.com',
  'https://example.com/?token=x',
  'https://example.com/#token',
])
  assert.equal(findingComment({ ...f, url }), null);
assert.equal(findingComment({ ...f, deployedSha: 'unknown' }), null);
assert.equal(findingComment({ ...f, actual: '' }), null);
assert.equal(findingComment({ ...f, actual: 'a'.repeat(4000) }), null);
assert.ok(
  findingComment({
    ...f,
    deployedSha: 'a'.repeat(40),
    evidence: 'Screenshot of overlapping login button',
    confidence: 'confirmed',
  })?.includes('указаны автором')
);
console.log(
  'Finding evidence requirements, URL credential rejection and size bounds passed'
);

assert.equal(findingComment({ ...f, confidence: 'confirmed' }), null);
