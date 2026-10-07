/**
 * Плеер справки (i) в мини-аппе (TODO L6171): постер и пропорции ролика
 * из ответа `GET /tutorial-help/:key`, вертикальный ролик не режется и
 * не вытягивает лист за край экрана. Плюс шов: `HelpSheet` реально
 * передаёт постер и стиль в `<video>`, а поля есть в типе ответа.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  HELP_VIDEO_MAX_VH,
  tutorialHelpVideoFrame,
} from '../src/lib/tutorial-help-video';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const at = (rel: string) => new URL(`../${rel}`, import.meta.url);
const POSTER = 'https://blob.example/tutorial/poster-1.jpg';

it('горизонтальный ролик — во всю ширину, высота по пропорции', () => {
  const f = tutorialHelpVideoFrame({
    width: 1280,
    height: 720,
    posterUrl: POSTER,
  });
  assert.equal(f.portrait, false);
  assert.equal(f.poster, POSTER);
  assert.equal(f.style.aspectRatio, '1280 / 720');
  assert.equal(f.style.width, '100%');
  assert.equal(f.style.height, undefined);
  assert.equal(f.style.objectFit, 'contain');
});

it('вертикальный ролик — по высоте, ширина из пропорции, без обрезки', () => {
  const f = tutorialHelpVideoFrame({
    width: 720,
    height: 1560,
    posterUrl: POSTER,
  });
  assert.equal(f.portrait, true);
  assert.equal(f.style.aspectRatio, '720 / 1560');
  assert.equal(f.style.height, `${HELP_VIDEO_MAX_VH}vh`);
  assert.equal(f.style.width, 'auto');
  assert.equal(f.style.maxWidth, '100%');
  assert.equal(f.style.maxHeight, `${HELP_VIDEO_MAX_VH}vh`);
  // `cover` срезал бы края экрана — а с ними кнопку, ради которой ролик.
  assert.equal(f.style.objectFit, 'contain');
  assert.ok(HELP_VIDEO_MAX_VH > 0 && HELP_VIDEO_MAX_VH <= 75);
});

it('квадрат — не вертикальный', () => {
  assert.equal(
    tutorialHelpVideoFrame({ width: 800, height: 800 }).portrait,
    false
  );
});

it('размера нет, пол-пары или мусор — без aspect-ratio, как раньше', () => {
  for (const bad of [
    {},
    { width: null, height: null },
    { width: 720, height: null },
    { width: null, height: 1280 },
    { width: 0, height: 1280 },
    { width: 720.5, height: 1280 },
    { width: -720, height: 1280 },
    { width: '720' as unknown as number, height: 1280 },
  ]) {
    const f = tutorialHelpVideoFrame(bad);
    assert.equal(f.style.aspectRatio, undefined, JSON.stringify(bad));
    assert.equal(f.portrait, false);
    assert.equal(f.style.width, '100%');
    assert.equal(f.style.objectFit, 'contain');
  }
});

it('постер — только http(s)-адрес, иначе без постера', () => {
  assert.equal(tutorialHelpVideoFrame({ posterUrl: null }).poster, undefined);
  assert.equal(tutorialHelpVideoFrame({}).poster, undefined);
  assert.equal(tutorialHelpVideoFrame({ posterUrl: '' }).poster, undefined);
  assert.equal(
    tutorialHelpVideoFrame({ posterUrl: 'not a url' }).poster,
    undefined
  );
  assert.equal(
    tutorialHelpVideoFrame({ posterUrl: 'javascript:alert(1)' }).poster,
    undefined
  );
  assert.equal(
    tutorialHelpVideoFrame({ posterUrl: 'data:image/png;base64,AAAA' }).poster,
    undefined
  );
  assert.equal(
    tutorialHelpVideoFrame({ posterUrl: 'http://localhost:3000/p.jpg' }).poster,
    'http://localhost:3000/p.jpg'
  );
});

it('HelpSheet передаёт постер и стиль в <video>, ролик не режется', () => {
  const sheet = readFileSync(at('src/features/projects/HelpSheet.tsx'), 'utf8');
  const video = /<video[\s\S]*?\/>/.exec(sheet)?.[0] ?? '';
  assert.ok(video, 'шов ослеп: <video> в HelpSheet не найден');
  assert.ok(/poster=\{frame\.poster\}/.test(video));
  assert.ok(/style=\{frame\.style\}/.test(video));
  assert.ok(/playsInline/.test(video));
  assert.ok(
    !/object-cover/.test(video),
    'object-cover обрезал бы вертикальный ролик'
  );
  assert.ok(/tutorialHelpVideoFrame\(view \?\? \{\}\)/.test(sheet));
});

it('тип ответа знает width/height/posterUrl (их отдаёт бэкенд)', () => {
  const api = readFileSync(at('src/services/tutorial-help-api.ts'), 'utf8');
  const view =
    /export interface TutorialHelpView \{[\s\S]*?\n\}/.exec(api)?.[0] ?? '';
  for (const field of ['width', 'height', 'posterUrl']) {
    assert.ok(new RegExp(`\\b${field}\\?: `).test(view), field);
  }
  const backend = readFileSync(
    at('../backend/src/modules/tutorial-help/tutorial-help.service.ts'),
    'utf8'
  );
  const backendView =
    /export interface TutorialHelpView \{[\s\S]*?\n\}/.exec(backend)?.[0] ?? '';
  for (const field of ['width', 'height', 'posterUrl']) {
    assert.ok(
      new RegExp(`\\b${field}: `).test(backendView),
      `бэкенд: ${field}`
    );
  }
});

console.log(`  ${passed} проверок`);
