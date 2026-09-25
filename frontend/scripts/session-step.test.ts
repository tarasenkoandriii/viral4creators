/**
 * Восстановление шага мастера (§7, этап 39) — регрессия на находку, из-за
 * которой готовый оплаченный ролик становился недостижим после
 * сворачивания приложения.
 */
import assert from 'node:assert/strict';
import {
  STEPPER_IDS,
  TEMPLATE_STEPPER_IDS,
  isRenderInFlight,
  onSceneTemplate,
  stepFromSession,
  stepperIdsFor,
  stepperLabels,
  usesSceneTemplate,
} from '../src/lib/session-step';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

console.log('session-step (ТЗ §7)');

it('готовый ролик возвращает на экран результата', () => {
  // Ровно это и терялось: ролик жив, лежит в хранилище, сессия про него
  // знает — а мастер начинал с шага «Видео».
  assert.equal(
    stepFromSession({
      status: 'video_complete',
      generatedVideo: { status: 'complete' },
    }),
    'complete'
  );
});

it('готовый ролик сильнее статуса сессии', () => {
  // Постобработка могла оставить сессию в generating_video, а ролик у
  // пользователя уже есть.
  assert.equal(
    stepFromSession({
      status: 'generating_video',
      generatedVideo: { status: 'complete' },
    }),
    'complete'
  );
});

it('идущий рендер не отправляет на экран с кнопкой «Сгенерировать»', () => {
  // Кнопка на идущем рендере — прямое приглашение заплатить дважды.
  for (const status of ['pending', 'processing'] as const) {
    const session = { status: 'generating_video', generatedVideo: { status } };
    assert.equal(stepFromSession(session), 'video-generation');
    assert.equal(isRenderInFlight(session), true, status);
  }
});

it('готовый и упавший рендер идущими не считаются', () => {
  assert.equal(
    isRenderInFlight({ generatedVideo: { status: 'complete' } }),
    false
  );
  assert.equal(
    isRenderInFlight({ generatedVideo: { status: 'failed' } }),
    false
  );
  assert.equal(isRenderInFlight({}), false);
  assert.equal(isRenderInFlight(null), false);
});

it('утверждённый промпт ведёт на генерацию, неутверждённый — на промпт', () => {
  assert.equal(
    stepFromSession({
      status: 'prompt_generated',
      generationPrompt: { approvedAt: '2026-09-06T00:00:00Z' },
    }),
    'video-generation'
  );
  assert.equal(
    stepFromSession({ status: 'prompt_generated', generationPrompt: {} }),
    'prompt-generation'
  );
});

it('остальные шаги восстанавливаются по статусу сессии', () => {
  const cases: Array<[string, string]> = [
    ['product_info_added', 'prompt-generation'],
    ['analysis_complete', 'analysis-complete'],
    ['analyzing', 'analyzing'],
    ['video_uploaded', 'upload'],
    ['created', 'upload'],
  ];
  for (const [status, step] of cases) {
    assert.equal(stepFromSession({ status }), step, status);
  }
});

it('сбой разбора возвращает к выбору референса, а не в пустой экран', () => {
  assert.equal(stepFromSession({ status: 'error' }), 'upload');
});

it('сбой рендера оставляет на шаге генерации, а не отправляет на шаг 1', () => {
  // Б-2.5: `markFailed` ставит тот же `status: 'error'`, что и сбой
  // разбора. Пользователь оказывался на выборе референса, хотя разбор и
  // утверждённый промпт живы, — а новый референс их сбрасывал и
  // запускал новый платный разбор.
  assert.equal(
    stepFromSession({ status: 'error', generatedVideo: { status: 'failed' } }),
    'video-generation'
  );
  assert.equal(
    stepFromSession({
      status: 'generating_video',
      generatedVideo: { status: 'failed' },
    }),
    'video-generation'
  );
});

it('«готово» без ролика ведёт туда, откуда есть выход', () => {
  // Данные разошлись; экран результата, где нечего показать, — худший
  // из вариантов.
  assert.equal(
    stepFromSession({ status: 'video_complete', generatedVideo: null }),
    'video-generation'
  );
});

it('М-7.5: пересобранный непринятый промпт сильнее старого готового ролика', () => {
  assert.equal(
    stepFromSession({
      status: 'prompt_generated',
      generatedVideo: { status: 'complete' },
      generationPrompt: { approvedAt: undefined },
    }),
    'prompt-generation'
  );
  // Одобренный промпт при готовом ролике — по-прежнему экран результата.
  assert.equal(
    stepFromSession({
      status: 'prompt_generated',
      generatedVideo: { status: 'complete' },
      generationPrompt: { approvedAt: '2026-09-14T00:00:00Z' },
    }),
    'complete'
  );
});

it('пустая сессия — первый шаг', () => {
  assert.equal(stepFromSession(null), 'upload');
  assert.equal(stepFromSession({}), 'upload');
});

it('приём сцены вместо референса — сразу товар (этап 150)', () => {
  // Шага «Анализ» у такой сессии не существует вовсе: разбирать нечего.
  // Отправлять человека на выбор референса значило бы прятать от него
  // уже сделанный выбор.
  const onTemplate = { sceneTemplate: { templateId: 'unboxing' } };
  assert.equal(stepFromSession(onTemplate), 'product-input');
  assert.equal(
    stepFromSession({ ...onTemplate, status: 'created' }),
    'product-input'
  );
  // Упавший разбор приём не отменяет — ровно наоборот (А-5 этапа 149).
  assert.equal(
    stepFromSession({
      ...onTemplate,
      status: 'error',
      videoAnalysis: { status: 'failed' },
    }),
    'product-input'
  );
  // Без приёма всё как было.
  assert.equal(stepFromSession({ status: 'error' }), 'upload');
});

it('завершённый разбор сильнее приёма и на экране тоже', () => {
  // Экран обязан говорить то же, что сервер: там приоритет у разбора.
  assert.equal(
    onSceneTemplate({
      sceneTemplate: { templateId: 'unboxing' },
      videoAnalysis: { status: 'complete' },
    }),
    false
  );
  assert.equal(
    onSceneTemplate({
      sceneTemplate: { templateId: 'unboxing' },
      videoAnalysis: { status: 'failed' },
    }),
    true
  );
  assert.equal(onSceneTemplate({ sceneTemplate: { templateId: '' } }), false);
  assert.equal(onSceneTemplate({}), false);
  assert.equal(onSceneTemplate(null), false);
  assert.equal(
    stepFromSession({
      status: 'analysis_complete',
      sceneTemplate: { templateId: 'unboxing' },
      videoAnalysis: { status: 'complete' },
    }),
    'analysis-complete'
  );
});

it('у сессии на приёме нет позиции «Анализ» (этап 151)', () => {
  // Не спрятана, а не существует: разбирать нечего. Серая подпись
  // шага, которого у человека не будет никогда, — обещание работы,
  // которая не случится.
  assert.deepEqual(stepperIdsFor(false), STEPPER_IDS);
  assert.deepEqual(stepperIdsFor(true), TEMPLATE_STEPPER_IDS);
  assert.ok(!TEMPLATE_STEPPER_IDS.includes('analysis' as never));
  assert.equal(TEMPLATE_STEPPER_IDS.length, STEPPER_IDS.length - 1);
  // Порядок остальных сохраняется — степпер читают слева направо.
  assert.deepEqual(
    STEPPER_IDS.filter((id) => id !== 'analysis'),
    [...TEMPLATE_STEPPER_IDS]
  );
});

it('появившийся разбор отменяет приём (аудит 151, А-1)', () => {
  // Правило хранить нельзя — только считать: экран держит два факта в
  // разных местах состояния, и они меняются независимо. Хранимый ответ
  // устаревал молча: человек выбирал приём, потом всё же загружал
  // референс, и степпер оставался укороченным навсегда — без позиции
  // «Анализ», то есть без доступа к разбору, за который заплачено.
  assert.equal(usesSceneTemplate(undefined, true), true);
  assert.equal(usesSceneTemplate('pending', true), true);
  assert.equal(usesSceneTemplate('failed', true), true);
  assert.equal(usesSceneTemplate('complete', true), false);
  assert.equal(usesSceneTemplate('complete', false), false);
  assert.equal(usesSceneTemplate(undefined, false), false);
  // То же, что читает `onSceneTemplate` из сессии, — одно правило на
  // два входа, иначе они разойдутся.
  assert.equal(
    onSceneTemplate({
      sceneTemplate: { templateId: 'unboxing' },
      videoAnalysis: { status: 'complete' },
    }),
    usesSceneTemplate('complete', true)
  );
});

it('номер позиции означает РАЗНОЕ у двух списков (этап 151)', () => {
  // Это и есть причина, по которой переход по степперу ходит по
  // идентификатору, а не по номеру: у полного списка вторая позиция —
  // «Анализ», у укороченного — «Товар». Пока список был один, номер
  // работал; с появлением второго каждый клик уезжал бы на соседний
  // шаг или в никуда.
  assert.equal(stepperIdsFor(false)[1], 'analysis');
  assert.equal(stepperIdsFor(true)[1], 'product');
  assert.notEqual(stepperIdsFor(false)[1], stepperIdsFor(true)[1]);
  assert.equal(stepperIdsFor(false)[2], 'product');
  assert.equal(stepperIdsFor(true)[2], 'prompt');
  // Первая позиция совпадает у обоих — переход на неё номером ещё
  // работал бы, и именно поэтому ошибка была бы незаметной.
  assert.equal(stepperIdsFor(false)[0], stepperIdsFor(true)[0]);
  // Номер за границей укороченного списка — ничего, а не последний.
  assert.equal(stepperIdsFor(true)[4], undefined);
});

it('подписи: отличается только первая', () => {
  const labels = ['Видео', 'Анализ', 'Товар', 'Промпт', 'Генерация'];
  assert.deepEqual(stepperLabels(false, labels, 'Сцена'), labels);
  // Один общий список подписей: три из четырёх совпадают дословно, и
  // второй массив в пяти локалях был бы пятью местами, где они
  // разойдутся.
  assert.deepEqual(stepperLabels(true, labels, 'Сцена'), [
    'Сцена',
    'Товар',
    'Промпт',
    'Генерация',
  ]);
  // «Видео» у сессии на приёме не появляется нигде.
  assert.ok(!stepperLabels(true, labels, 'Сцена').includes('Видео'));
  assert.ok(!stepperLabels(true, labels, 'Сцена').includes('Анализ'));
});

console.log(`\n${passed} проверок пройдено`);
