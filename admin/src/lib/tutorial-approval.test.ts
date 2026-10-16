import assert from 'node:assert/strict';
import { confirmTutorialApproval } from './tutorial-approval';

async function main() {
  let writes = 0;
  let reads = 0;
  const failedReply = new TypeError('Connection lost after server accepted');
  const result = await confirmTutorialApproval(
    async () => { writes++; throw failedReply; },
    async () => { reads++; return { status: 'APPROVED' }; },
  );
  assert.equal(result.status, 'APPROVED');
  assert.equal(writes, 1, 'Never repeat paid submission');
  assert.equal(reads, 1);
  await assert.rejects(confirmTutorialApproval(
    async () => { throw failedReply; },
    async () => ({ status: 'PENDING_REVIEW' }),
  ), (error) => error === failedReply);
  await assert.rejects(confirmTutorialApproval(
    async () => { throw failedReply; },
    async () => { throw new Error('Read unavailable'); },
  ), (error) => error === failedReply);
  await confirmTutorialApproval(
    async () => ({ status: 'APPROVED' }),
    async () => { throw new Error('No extra read on success'); },
  );
  console.log('tutorial approval: accepted response loss reconciled without duplicate; failures preserved');
}
void main();
