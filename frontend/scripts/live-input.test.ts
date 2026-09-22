/**
 * Прокрутка в живой сессии (§8.3 спеки реле).
 *
 * Дефект, который эти проверки закрывают: на канвасе живой сессии не
 * было обработчика колеса вовсе — только `onPointerDown/Up/Move`. Реле
 * `mouseWheel` принимало и `deltaX/deltaY` в CDP пробрасывало, то есть
 * транспорт был готов, а отправлять было некому: прокрутить чужую
 * страницу (список стран в форме входа, длинное соглашение, любую
 * ленту) было нечем.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  keyMessages,
  scrollStepPixels,
  shouldCaptureKey,
  wheelToPixels,
} from '../src/features/projects/live-input';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('live-input: колесо мыши');

it('пиксельный режим проходит как есть', () => {
  assert.deepEqual(
    wheelToPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 800),
    { deltaX: 0, deltaY: 120 }
  );
});

it('строчный режим пересчитывается в пиксели', () => {
  // Firefox и часть настроек Windows шлют deltaY=3 (три строки). Без
  // пересчёта страница сдвинулась бы на три пикселя за щелчок колеса —
  // снаружи это неотличимо от «прокрутка не работает».
  assert.deepEqual(wheelToPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800), {
    deltaX: 0,
    deltaY: 120,
  });
});

it('постраничный режим считает страницей высоту канваса', () => {
  assert.deepEqual(wheelToPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 844), {
    deltaX: 0,
    deltaY: 844,
  });
});

it('нулевая высота не схлопывает страницу в ноль', () => {
  // Канвас может быть ещё не измерен (первый кадр не пришёл). Умножение
  // на ноль съело бы прокрутку молча.
  assert.deepEqual(wheelToPixels({ deltaX: 0, deltaY: 2, deltaMode: 2 }, 0), {
    deltaX: 0,
    deltaY: 2,
  });
});

it('горизонтальная дельта пересчитывается тем же множителем', () => {
  assert.deepEqual(
    wheelToPixels({ deltaX: 2, deltaY: -1, deltaMode: 1 }, 800),
    { deltaX: 80, deltaY: -40 }
  );
});

it('направление сохраняется — прокрутка вверх остаётся отрицательной', () => {
  assert.ok(
    wheelToPixels({ deltaX: 0, deltaY: -3, deltaMode: 1 }, 800).deltaY < 0
  );
});

console.log('live-input: клавиатура');

it('обычный символ уезжает парой keyDown+keyUp с текстом', () => {
  assert.deepEqual(keyMessages({ key: 'u', code: 'KeyU', keyCode: 85 }), [
    {
      type: 'key',
      event: 'keyDown',
      key: 'u',
      code: 'KeyU',
      keyCode: 85,
      text: 'u',
    },
    { type: 'key', event: 'keyUp', key: 'u', code: 'KeyU', keyCode: 85 },
  ]);
});

it('Enter несёт \\r — иначе форму входа не отправить с клавиатуры', () => {
  // `key` у Enter длиной пять, под правило «одиночный символ» он не
  // попадает, и без `text` страница не получает перевод строки.
  const [down] = keyMessages({ key: 'Enter', code: 'Enter', keyCode: 13 });
  assert.equal(down.text, '\r');
});

it('служебная клавиша идёт без текста', () => {
  const [down] = keyMessages({
    key: 'Backspace',
    code: 'Backspace',
    keyCode: 8,
  });
  assert.equal(down.text, undefined);
});

it('keyCode доносится обоими сообщениями', () => {
  // Без него страница видит `event.keyCode === 0`, и старый код —
  // виджет входа Telegram как раз такой — клавиатуру не замечает.
  const msgs = keyMessages({ key: 'a', code: 'KeyA', keyCode: 65 });
  assert.deepEqual(
    msgs.map((m) => m.keyCode),
    [65, 65]
  );
});

it('канвас перехватывает обычные клавиши', () => {
  for (const k of ['a', 'Enter', 'Backspace', 'ArrowDown', ' ']) {
    assert.equal(shouldCaptureKey(k), true, k);
  }
});

it('Tab уходит странице — на форме входа это переход к паролю', () => {
  // Сначала Tab был исключён вместе с Escape, «чтобы было чем выйти».
  // Ошибка: на форме входа Tab — основной способ перейти от логина к
  // паролю, то есть исключение выбивало его ровно там, где он нужен
  // постоянно.
  assert.equal(shouldCaptureKey('Tab'), true);
});

it('Escape не перехватывается — это выход из кадра', () => {
  assert.equal(shouldCaptureKey('Escape'), false);
});

it('канвас в разметке действительно принимает клавиатуру', () => {
  // Проверка по исходнику: функции выше можно оставить правильными и
  // при этом не подключить их к канвасу — ровно это и было дефектом
  // (ретрансляция жила только в поле под кадром, и в счётчиках сессии
  // стояло `key=0` при живой мыши). Рендер-раннера в проекте нет,
  // поэтому смотрим текст, как в client-site-wizard.test.ts.
  const src = readFileSync(
    new URL('../src/features/projects/LiveLoginSession.tsx', import.meta.url),
    'utf8'
  );
  // Именно открывающий тег с атрибутами на следующих строках: просто
  // '<canvas' встречается ещё и в доккомментарии в шапке файла.
  const start = src.indexOf('<canvas\n');
  assert.ok(start > 0, 'канвас не найден');
  const end = src.indexOf('/>', start);
  assert.ok(end > start, 'конец элемента не найден');
  const canvas = src.slice(start, end);

  assert.ok(canvas.includes('tabIndex={0}'), 'канвас не фокусируется');
  assert.ok(canvas.includes('onKeyDown'), 'нажатия не обрабатываются');
  assert.ok(
    canvas.includes('keyMessages'),
    'сообщения собираются мимо общей сборки'
  );
  assert.ok(
    canvas.includes('.focus()'),
    'щелчок не отдаёт канвасу фокус — печатать после клика будет некуда'
  );
});

console.log('live-input: экранная прокрутка');

it('шаг прокрутки — доля высоты кадра', () => {
  assert.equal(scrollStepPixels(800), 640);
});

it('на неизмеренном кадре шаг всё равно ненулевой', () => {
  // Высота нулевая, пока не пришёл первый кадр. Без нижнего предела
  // нажатие кнопки не делало бы ничего.
  assert.equal(scrollStepPixels(0), 120);
  assert.equal(scrollStepPixels(50), 120);
});

it('на высоком кадре шаг растёт вместе с ним', () => {
  assert.ok(scrollStepPixels(1600) > scrollStepPixels(800));
});

it('скрытое поле ввода осталось и спрятано правильно', () => {
  // Убрать его совсем нельзя: на телефоне экранную клавиатуру
  // поднимает только сфокусированный <input>, канвас её не вызывает.
  // А `display:none`/`hidden` не подошли бы — такой элемент не
  // фокусируется вовсе, то есть клавиатуры не будет.
  const src = readFileSync(
    new URL('../src/features/projects/LiveLoginSession.tsx', import.meta.url),
    'utf8'
  );
  const at = src.indexOf('ref={keyboardRef}');
  assert.ok(at > 0, 'скрытого поля нет');
  // Смотрим только сам элемент: в комментариях рядом `display:none`
  // упоминается как раз как способ, которым делать НЕЛЬЗЯ.
  const field = src.slice(src.lastIndexOf('<input', at), src.indexOf('/>', at));
  assert.ok(
    !field.includes('display') && !field.includes('hidden={'),
    'поле скрыто способом, при котором фокус невозможен'
  );
  assert.ok(field.includes('opacity-0'), 'поле скрыто не прозрачностью');
  assert.ok(field.includes('fontSize: 16'), 'iOS будет зумить при фокусе');
  assert.ok(
    src.includes('keyboardRef.current ?? e.currentTarget).focus()'),
    'касание кадра не уводит фокус в поле — клавиатуры на телефоне не будет'
  );
});

it('кнопки прокрутки есть и подписаны для скринридера', () => {
  const src = readFileSync(
    new URL('../src/features/projects/LiveLoginSession.tsx', import.meta.url),
    'utf8'
  );
  assert.ok(src.includes('scrollPage(-1)'), 'нет кнопки вверх');
  assert.ok(src.includes('scrollPage(1)'), 'нет кнопки вниз');
  assert.ok(src.includes('aria-label={t.liveScrollUp}'), 'кнопка без подписи');
  assert.ok(
    src.includes('aria-label={t.liveScrollDown}'),
    'кнопка без подписи'
  );
});

console.log(`live-input: ${passed} проверок пройдено`);
