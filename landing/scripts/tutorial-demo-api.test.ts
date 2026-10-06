import assert from 'node:assert/strict';
import { demoSize, listTutorialDemos, loadTutorialDemos, safeMediaUrl } from '../src/lib/tutorial-demo-api';
import { DEFAULT_DEMO_SIZE, demoStageSize, demoStageStyle, measuredDemoSize } from '../src/lib/demo-stage';

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
    // Partial outage with videos present is not a failure: show what came.
    assert.equal((await loadTutorialDemos('ads', 'ru')).failed, false);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await listTutorialDemos('ads', 'ru'), []);
    // Outage/timeout: the page must not claim "no video in this language".
    assert.deepEqual(await loadTutorialDemos('ads', 'ru'), { items: [], failed: true });
    // Healthy API, nothing approved for the locale: an honest "no video yet".
    globalThis.fetch = async (input) => {
      const key = new URL(String(input)).pathname.split('/').pop();
      return Response.json({ success: true, data: { subjectKey: key, locale: 'ru', title: 'T', videoUrl: null } });
    };
    assert.deepEqual(await loadTutorialDemos('ads', 'ru'), { items: [], failed: false });

    // Метаданные ролика: размер, постер, тема.
    const meta: Record<string, Record<string, unknown>> = {
      '1': { width: 720, height: 1560, posterUrl: 'https://blob.example/p1.png', theme: 'light' },
      '2': { width: 1920, height: 1080, posterUrl: null, theme: 'dark' },
      '3': { width: 1080, height: 1080 },
      // Негодные размеры — оба null, ролик остаётся.
      '4': { width: 720, height: null },
      '5': { width: 15, height: 1560 },
      '6': { width: 7681, height: 1080 },
      '7': { width: 720.5, height: 1560 },
      '8': { width: '720', height: '1560' },
      // Негодные постеры — null, ролик остаётся.
      '9': { width: 16, height: 7680, posterUrl: 'http://blob.example/p.png' },
      '10': { posterUrl: 'https://user:pw@blob.example/p.png', theme: 'purple' },
    };
    globalThis.fetch = async (input) => {
      const key = new URL(String(input)).pathname.split('/').pop() as string;
      return Response.json({
        success: true,
        data: { subjectKey: key, locale: 'ru', title: `T${key}`, videoUrl: `https://example.com/${key}.mp4`, ...meta[key] },
      });
    };
    const withMeta = await listTutorialDemos('ads', 'ru');
    const byKey = Object.fromEntries(withMeta.map((item) => [item.subjectKey, item]));
    assert.equal(withMeta.length, 10);
    assert.deepEqual(byKey['1'], {
      subjectKey: '1', title: 'T1', videoUrl: 'https://example.com/1.mp4',
      width: 720, height: 1560, posterUrl: 'https://blob.example/p1.png', theme: 'light',
    });
    assert.deepEqual([byKey['2'].width, byKey['2'].height, byKey['2'].posterUrl, byKey['2'].theme], [1920, 1080, null, 'dark']);
    assert.deepEqual([byKey['3'].width, byKey['3'].height, byKey['3'].theme], [1080, 1080, null]);
    for (const key of ['4', '5', '6', '7', '8', '10']) {
      assert.deepEqual([byKey[key].width, byKey[key].height], [null, null], `size of ${key}`);
    }
    // Границы включительно.
    assert.deepEqual([byKey['9'].width, byKey['9'].height], [16, 7680]);
    assert.equal(byKey['9'].posterUrl, null);
    assert.equal(byKey['10'].posterUrl, null);
    assert.equal(byKey['10'].theme, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // Чистые помощники.
  assert.equal(safeMediaUrl('https://a.example/x.png'), 'https://a.example/x.png');
  assert.equal(safeMediaUrl('javascript:alert(1)'), null);
  assert.equal(safeMediaUrl('//a.example/x.png'), null);
  assert.equal(safeMediaUrl(42), null);
  assert.deepEqual(demoSize(1920, 1080), { width: 1920, height: 1080 });
  assert.equal(demoSize(0, 1080), null);
  assert.equal(demoSize(1920, Number.NaN), null);

  // Пропорция сцены: измеренное > из API > прежняя вертикаль.
  assert.deepEqual(demoStageSize(null, { width: null, height: null }), DEFAULT_DEMO_SIZE);
  assert.deepEqual(demoStageSize(null, { width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.deepEqual(demoStageSize({ width: 1280, height: 720 }, { width: 720, height: 1560 }), { width: 1280, height: 720 });
  assert.equal(measuredDemoSize(0, 0), null);
  assert.deepEqual(measuredDemoSize(1080, 1080), { width: 1080, height: 1080 });
  assert.deepEqual(demoStageStyle({ width: 1920, height: 1080 }), { '--demo-ar': '1920 / 1080', '--demo-ratio': '1.777778' });
  assert.deepEqual(demoStageStyle(DEFAULT_DEMO_SIZE), { '--demo-ar': '720 / 1560', '--demo-ratio': '0.461538' });

  console.log('tutorial-demo-api: approved topic feeds, malformed responses, outages, empty-vs-failed, size/poster/theme metadata and stage ratio checked');
}
void main();
