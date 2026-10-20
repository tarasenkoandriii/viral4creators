/**
 * ST2-U-01 / ST2-U-07 (аудит Story‑Tales 2, 20.10.2026): тексты
 * подтверждений — удаление сказки с перечнем последствий и платные вызовы
 * (Nova, Soniox аудио/видео, разбор Gemini) с резервом из ответа сервера
 * или явным «платная операция» без суммы. То, что кнопки действительно
 * открывают диалог до запроса, проверяют `story-ui-guards.test.ts`
 * (исходник) и Playwright (`/tmp/fx2-ui/pw_fix.py`).
 */
import assert from 'node:assert/strict';
import {
  analyzeButtonSuffix,
  analyzeConfirm,
  audioQaConfirm,
  deleteGiftConfirm,
  deleteRecordingConfirm,
  recordingDeletedNotice,
  includedInReserve,
  novaConfirm,
  reserveSuffix,
  videoQaConfirm,
} from '../src/features/stories/story-confirm';
import type { StoryEstimate } from '../src/features/stories/story-wizard';
import { storyErrorText } from '../src/features/stories/story-errors';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}
function like(value: string, re: RegExp) {
  assert.ok(re.test(value), `${JSON.stringify(value)} !~ ${re}`);
}

const estimate: StoryEstimate = {
  lines: [
    {
      id: 'voice',
      label: 'Голос',
      status: 'included',
      costMicroUsd: 120_000,
      reserveMicroUsd: 480_000,
      items: [],
      note: '',
    },
    {
      id: 'qa',
      label: 'Проверка речи',
      status: 'included',
      costMicroUsd: 8_000,
      reserveMicroUsd: 20_000,
      items: [],
      note: '',
    },
  ],
  totalCostMicroUsd: 128_000,
  totalReserveMicroUsd: 500_000,
  audioReserveMicroUsd: 500_000,
  videoReserveMicroUsd: 0,
  budgetMicroUsd: 1_000_000,
  remainingMicroUsd: 500_000,
  overByMicroUsd: 0,
  withinBudget: true,
  policy: '',
};

it('удаление готовой сказки: аудио, видео, записи — без восстановления', () => {
  const t = deleteGiftConfirm({
    title: 'Репка',
    status: 'READY',
    hasGiftPhoto: true,
  });
  assert.equal(t.danger, true);
  like(t.title, /Репка/);
  like(t.body.join(' '), /без возможности восстановления/);
  const all = t.items.join(' ');
  like(all, /озвучка \(MP3\)/);
  like(all, /все сборки видео/);
  like(all, /записи вступления/);
  like(all, /фото подарка/);
  like(t.note ?? '', /не возвращается/);
});

it('удаление черновика: без пунктов про озвучку и видео', () => {
  const t = deleteGiftConfirm({
    title: 'Репка',
    status: 'DRAFT',
    hasGiftPhoto: false,
  });
  const all = t.items.join(' ');
  assert.ok(!/MP3|сборки видео|фото подарка/.test(all), all);
  like(all, /текст выпуска/);
});

it('удаление одобренного выпуска говорит, что восстановить нельзя', () => {
  const t = deleteGiftConfirm({
    title: 'Репка',
    status: 'APPROVED',
    hasGiftPhoto: false,
  });
  like(t.note ?? '', /одобрен/);
});

it('Nova: резерв из ответа сервера на кнопке и в диалоге', () => {
  assert.equal(reserveSuffix(500_000), ' · резерв $0.50');
  assert.equal(reserveSuffix(0), '');
  assert.equal(reserveSuffix(undefined), '');
  const t = novaConfirm({
    reservedMicroUsd: 500_000,
    budgetCents: 100,
    estimate,
  });
  assert.equal(t.danger, false);
  const body = t.body.join(' ');
  like(body, /Платная операция/);
  like(body, /Резерв \$0\.50 из бюджета \$1\.00/);
  like(body, /≈ \$0\.12/);
});

it('Nova без суммы с сервера — «платная операция», цифра не выдумывается', () => {
  const body = novaConfirm({ reservedMicroUsd: 0, budgetCents: 100 }).body.join(
    ' '
  );
  like(body, /Платная операция/);
  assert.ok(!/\$/.test(body), body);
});

it('Soniox аудио: оценка из строки qa, «входит в резерв»', () => {
  assert.equal(includedInReserve(500_000), ' · входит в резерв $0.50');
  assert.equal(includedInReserve(0), ' · входит в резерв');
  const body = audioQaConfirm({
    reservedMicroUsd: 500_000,
    estimate,
  }).body.join(' ');
  like(body, /Soniox/);
  like(body, /≈ \$0\.0080/);
  like(body, /новый резерв не создаётся/);
});

it('Soniox видео: входит в резерв сборки', () => {
  const body = videoQaConfirm({ reservedMicroUsd: 300_000 }).body.join(' ');
  like(body, /резерв этой сборки \$0\.30/);
  like(
    videoQaConfirm({ reservedMicroUsd: 0 }).body.join(' '),
    /Платная операция/
  );
});

it('Gemini: цены нет в ответе — «платная операция» и квота; повтор — отдельный заголовок', () => {
  const first = analyzeConfirm({
    retry: false,
    quota: { remaining: 2, limit: 3 },
  });
  like(first.body.join(' '), /Платная операция/);
  like(first.body.join(' '), /осталось 2 из 3/);
  assert.ok(!/\$/.test(first.body.join(' ')));
  const retry = analyzeConfirm({ retry: true, quota: null });
  like(retry.title, /новый платный вызов/);
  like(retry.confirmLabel, /Повторить/);
  like(retry.body.join(' '), /трёх платных разборов/);
});

it('Gemini: цена сервера (analysis) на кнопке и в диалоге, без кода модели', () => {
  const analysis = {
    estimateMicroUsd: 41_000,
    reserveMicroUsd: 41_000,
    maxSeconds: 300,
  };
  assert.equal(analyzeButtonSuffix(analysis), ' · до $0.04');
  assert.equal(analyzeButtonSuffix(null), ' · платно');
  assert.equal(analyzeButtonSuffix(undefined), ' · платно');
  assert.equal(
    analyzeButtonSuffix({
      estimateMicroUsd: null,
      reserveMicroUsd: null,
      maxSeconds: 300,
    }),
    ' · платно'
  );
  const t = analyzeConfirm({
    retry: false,
    quota: { remaining: 2, limit: 3 },
    analysis: { ...analysis, model: 'gemini-2.5-flash' } as typeof analysis,
  });
  const body = t.body.join(' ');
  like(body, /Оценка для ролика до 5 мин: до \$0\.04/);
  assert.ok(!/gemini-|flash/.test(body), body);
  const unpriced = analyzeConfirm({
    retry: true,
    quota: null,
    analysis: {
      estimateMicroUsd: null,
      reserveMicroUsd: null,
      maxSeconds: 300,
    },
  }).body.join(' ');
  like(unpriced, /сервером не сообщается/);
});

it('Soniox видео: оценка qaEstimateMicroUsd из ответа сервера', () => {
  const body = videoQaConfirm({
    reservedMicroUsd: 300_000,
    qaEstimateMicroUsd: 12_000,
  }).body.join(' ');
  like(body, /оценка ≈ \$0\.01/);
  like(body, /резерв этой сборки \$0\.30/);
  assert.ok(
    !/оценка/.test(
      videoQaConfirm({
        reservedMicroUsd: 300_000,
        qaEstimateMicroUsd: null,
      }).body.join(' ')
    )
  );
});

it('удаление записи: видео станут недоступны, основная речь сохраняется; ответ сервера', () => {
  const t = deleteRecordingConfirm({ seconds: 6.4 });
  assert.equal(t.danger, true);
  like(t.title, /6\.4 с/);
  like(t.items.join(' '), /станут недоступны/);
  like(t.note ?? '', /основная речь сказки сохраняется.*без новой оплаты/);
  assert.equal(
    recordingDeletedNotice({
      deleted: true,
      rendersDeleted: 2,
      segmentsErased: 1,
      mainNarrationKept: true,
    }),
    'Запись удалена. Видео с ней стали недоступны: 2. Основная речь сохранена — новая сборка переиспользует её без новой оплаты.'
  );
  assert.equal(
    recordingDeletedNotice({
      deleted: true,
      rendersDeleted: 0,
      mainNarrationKept: false,
    }),
    'Запись удалена. Собранных с ней видео не было.'
  );
  assert.equal(
    recordingDeletedNotice(undefined),
    'Запись удалена. Собранных с ней видео не было.'
  );
});

it('409 STORY_RECORDING_IN_USE — показывается текст сервера', () => {
  const msg =
    'Сборка с этой записью ещё идёт или ждёт оператора — удалить запись пока нельзя.';
  assert.equal(
    storyErrorText({
      response: {
        status: 409,
        data: {
          success: false,
          error: {
            code: 'CONFLICT',
            message: msg,
            details: { code: 'STORY_RECORDING_IN_USE' },
          },
        },
      },
    }),
    msg
  );
});

console.log(`story-confirm: ${passed} проверок пройдено`);
