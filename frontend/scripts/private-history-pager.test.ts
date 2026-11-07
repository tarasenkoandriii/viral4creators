import assert from 'node:assert/strict';
import {
  createPrivateHistoryPager,
  type HistoryPage,
} from '../src/lib/private-history-pager';

type Item = { id: string };
function deferred() {
  let resolve!: (page: HistoryPage<Item>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<HistoryPage<Item>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function main() {
  const a = deferred(),
    b = deferred();
  let calls = 0;
  const pager = createPrivateHistoryPager(() =>
    ++calls === 1 ? a.promise : b.promise
  );
  const old = pager.reload();
  pager.reset();
  const fresh = pager.reload();
  b.resolve({ items: [{ id: 'B' }], nextCursor: null });
  await fresh;
  a.resolve({ items: [{ id: 'A' }], nextCursor: null });
  await old;
  assert.deepEqual(pager.snapshot.items, [{ id: 'B' }]);
  console.log('PASS account reset discards old account response');

  let requested = 0;
  const more = deferred();
  const pages = createPrivateHistoryPager(async (before) => {
    requested++;
    return before
      ? more.promise
      : { items: [{ id: 'one' }], nextCursor: 'one' };
  });
  await pages.reload();
  const first = pages.more();
  await pages.more();
  assert.equal(requested, 2);
  more.resolve({ items: [{ id: 'one' }, { id: 'two' }], nextCursor: 'one' });
  await first;
  assert.deepEqual(pages.snapshot.items, [{ id: 'one' }, { id: 'two' }]);
  assert.equal(pages.snapshot.nextCursor, null);
  console.log(
    'PASS pagination deduplicates rows, ignores double-click and stops repeated cursor'
  );

  const pending = deferred();
  const closed = createPrivateHistoryPager(() => pending.promise);
  let notifications = 0;
  closed.subscribe(() => {
    notifications++;
  });
  const request = closed.reload();
  closed.dispose();
  const count = notifications;
  pending.resolve({ items: [{ id: 'private' }], nextCursor: null });
  await request;
  assert.deepEqual(closed.snapshot.items, []);
  assert.equal(notifications, count);
  console.log('PASS unmount drops private data and suppresses late callback');

  let auth = false;
  const protectedPage = createPrivateHistoryPager(async (before) => {
    if (auth) throw { response: { status: 401 } };
    return { items: [{ id: before ?? 'secret' }], nextCursor: 'secret' };
  });
  await protectedPage.reload();
  auth = true;
  await protectedPage.more();
  assert.deepEqual(protectedPage.snapshot.items, []);
  assert.equal(protectedPage.snapshot.error, 'auth');
  console.log('PASS authentication refusal clears previously loaded rows');

  const fail = createPrivateHistoryPager(async () => {
    throw Error('private internal provider detail');
  });
  await fail.reload();
  assert.equal(fail.snapshot.error, 'load');
  assert.equal(JSON.stringify(fail.snapshot).includes('provider'), false);
  console.log('PASS safe loading error does not expose backend detail');
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
