/**
 * Э6 (ТЗ §4.9, §4.12): протокол подсветки (iframe → загрузчик: элемент
 * карты; загрузчик → iframe: итог) и действия ответа `video`/`highlight`
 * в iframe — строгий разбор. Браузерная часть — e2e/highlight.spec.ts.
 */
import assert from 'node:assert/strict';
import {
  WIDGET_MESSAGE_NS,
  WIDGET_PROTOCOL_VERSION,
} from '../src/shared/brand';
import {
  cleanSelector,
  parseFrameMessage,
  parseParentMessage,
} from '../src/shared/protocol';
import { parseAction, parseVideoLink } from '../src/chat/api';

const env = (m: Record<string, unknown>) => ({
  ns: WIDGET_MESSAGE_NS,
  v: WIDGET_PROTOCOL_VERSION,
  ...m,
});
const hl = {
  type: 'highlight',
  elementId: 'u1a2b3c4d',
  selector: 'main > button:nth-of-type(2)',
  caption: 'Купить',
};

// iframe → загрузчик: только элемент карты правильной формы.
assert.deepEqual(parseFrameMessage(env(hl)), hl);
for (const bad of [
  { ...hl, elementId: '#cta' },
  { ...hl, selector: '<img src=x onerror=alert(1)>' },
  { ...hl, selector: 'a'.repeat(201) },
  { ...hl, selector: 'a\nb' },
  { ...hl, caption: '' },
  { ...hl, caption: 5 },
]) {
  assert.equal(parseFrameMessage(env(bad)), null, JSON.stringify(bad));
}
// Подпись — текст ≤ 80 (лишнее обрезается, управляющие — вон).
const long = parseFrameMessage(env({ ...hl, caption: 'x'.repeat(200) }));
assert.equal(long && long.type === 'highlight' && long.caption.length, 80);
assert.equal(cleanSelector('  #a  '), '#a');

// загрузчик → iframe: итог подсветки.
assert.deepEqual(
  parseParentMessage(
    env({ type: 'highlight-result', elementId: 'u1a2b3c4d', found: false })
  ),
  { type: 'highlight-result', elementId: 'u1a2b3c4d', found: false }
);
assert.equal(
  parseParentMessage(
    env({ type: 'highlight-result', elementId: 'u1a2b3c4d', found: 'no' })
  ),
  null
);
// Родитель не может прислать iframe «highlight» (команды подсветки у него нет).
assert.equal(parseParentMessage(env(hl)), null);
// И iframe не может прислать загрузчику «highlight-result».
assert.equal(
  parseFrameMessage(
    env({ type: 'highlight-result', elementId: 'u1a2b3c4d', found: true })
  ),
  null
);

// Действия ответа в iframe.
assert.deepEqual(
  parseAction({
    kind: 'video',
    label: 'Смотреть',
    videoId: 'ck_video1',
    title: 'Как купить',
    url: 'https://evil.example/v.mp4',
  }),
  {
    kind: 'video',
    label: 'Смотреть',
    videoId: 'ck_video1',
    title: 'Как купить',
  }
);
assert.equal(parseAction({ kind: 'video', label: 'x', videoId: '../x' }), null);
assert.deepEqual(
  parseAction({
    kind: 'highlight',
    label: 'Показать',
    elementId: 'u1a2b3c4d',
    selector: '#buy',
    caption: 'Купить',
  }),
  {
    kind: 'highlight',
    label: 'Показать',
    elementId: 'u1a2b3c4d',
    selector: '#buy',
    caption: 'Купить',
  }
);
assert.equal(
  parseAction({
    kind: 'highlight',
    label: 'x',
    elementId: 'u1',
    selector: '#a',
    caption: 'a',
  }),
  null
);

// Ссылка на ролик — только путь своего origin этого маршрута.
assert.equal(
  parseVideoLink({ url: '/widget/v1/video/v1.s.v.1.abc', title: 'T' }).url,
  '/widget/v1/video/v1.s.v.1.abc'
);
for (const url of [
  'https://evil.example/v.mp4',
  '//evil.example/widget/v1/video/v1.x',
  '/widget/v1/state',
  'javascript:alert(1)',
]) {
  assert.throws(() => parseVideoLink({ url }), url);
}

console.log('media: протокол подсветки, действия video/highlight — ок');
