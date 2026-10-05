import assert from 'node:assert/strict';
import { listTutorialDemos } from '../src/lib/tutorial-demo-api';

async function main() {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url.pathname);
    const key = url.pathname.split('/').pop();
    if (key === '3') throw new Error('backend unavailable');
    if (key === '4') return new Response('unavailable', { status: 503 });
    if (key === '5') return new Response('invalid json');
    const data = {
      subjectKey: key, locale: key === '6' ? 'en' : 'ru', title: `Step ${key}`,
      videoUrl: key === '1' ? null : key === '7' ? 'javascript:alert(1)' :
        key === '8' ? 'https://user:secret@example.com/demo.mp4' : `https://example.com/${key}.mp4`,
    };
    return Response.json({ success: key !== '9', data });
  };
  try {
    const items = await listTutorialDemos('ads', 'ru');
    assert.deepEqual(items.map((item) => item.subjectKey), ['2', '10']);
    assert.equal(requested.length, 10);
    requested.length = 0;
    const greetings = await listTutorialDemos('greetings', 'ru');
    assert.equal(greetings.length, 5);
    assert.ok(requested.every((path) => path.includes('/greeting-')));
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await listTutorialDemos('ads', 'ru'), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('tutorial-demo-api: approved topic feeds, malformed responses and outages checked');
}
void main();
