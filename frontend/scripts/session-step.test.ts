/**
 * Восстановление шага мастера (§7, этап 39) — регрессия на находку, из-за
 * которой готовый оплаченный ролик становился недостижим после
 * сворачивания приложения.
 */
import assert from 'node:assert/strict';
import { isRenderInFlight, stepFromSession } from '../src/lib/session-step';

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

console.log(`\n${passed} проверок пройдено`);
