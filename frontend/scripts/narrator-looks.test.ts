/**
 * «Образ для сказок» (Story‑Tales WP5, TODO стр. 79) — чистая логика
 * блока профиля рассказчика. Запуск: `npx tsx scripts/narrator-looks.test.ts`
 * (вместе с остальными — `npm test`).
 *
 * Проверяется то, что ломается тихо: кнопка генерации без согласия или
 * сверх квоты, «готовый вариант без оплаты» не того режима, подпись
 * активного образа (оригинал | вариант) × (фото | стиль) и выбор главной
 * кнопки карточки (применить / перестилизовать / недоступен).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  activeLabel,
  consentTitle,
  formatUsd,
  generationOffer,
  hasPendingLook,
  isHiddenForUser,
  isImageTooLarge,
  itemAction,
  lookTitle,
  modeKeepNote,
  narratorLookCodeText,
  NARRATOR_LOOK_POLL_MAX_MS,
  NARRATOR_LOOK_POLL_MS,
  narratorLookImagePath,
  narratorLooksPath,
  needsRepeatConfirm,
  previewAsset,
  quotaLine,
  restyleRepeatNeeded,
  statusText,
  type NarratorLookItem,
  type NarratorLooksState,
} from '../src/features/brand/narrator-looks';

/** `assert.match` нет в окружающих типах скриптов — своё сравнение. */
function like(value: string, re: RegExp) {
  assert.ok(re.test(value), `${JSON.stringify(value)} !~ ${re}`);
}

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const price1 = {
  perCall: [{ model: 'gemini-3.1-flash-image', estimateMicroUsd: 78_000 }],
  estimateMicroUsd: 78_000,
  reserveMicroUsd: 156_000,
};
const price2 = {
  perCall: [...price1.perCall, ...price1.perCall],
  estimateMicroUsd: 156_000,
  reserveMicroUsd: 312_000,
};

function item(over: Partial<NarratorLookItem> = {}): NarratorLookItem {
  return {
    id: 'l1',
    parentLookId: null,
    characterId: 'c1',
    outfit: 'cozy-home',
    makeup: 'light',
    status: 'READY',
    styleStatus: 'NONE',
    style: null,
    sourceHash: 'a',
    photoHash: 'p',
    styledHash: null,
    consentVersion: 'story-parent-image-v1',
    imageCalls: 1,
    reservedMicroUsd: 156_000,
    error: null,
    createdAt: '2026-10-19T10:00:00.000Z',
    active: false,
    problem: null,
    ...over,
  };
}

function state(over: Partial<NarratorLooksState> = {}): NarratorLooksState {
  return {
    manifestId: 'm1',
    consent: {
      version: 'story-parent-image-v1',
      text: '…',
      active: true,
      acceptedAt: '2026-10-19T09:00:00.000Z',
      acceptedVersion: 'story-parent-image-v1',
      revokedAt: null,
    },
    character: {
      id: 'c1',
      label: 'Мама',
      hasPhoto: true,
      originalDeleted: false,
      mode: 'photo',
      sketchRendering: null,
    },
    active: {
      kind: 'original',
      lookId: null,
      asset: null,
      mode: 'photo',
      problem: null,
      modeChanged: false,
    },
    presets: {
      outfits: ['casual', 'cozy-home', 'festive', 'business', 'winter'],
      makeups: ['none', 'light', 'natural'],
    },
    quota: { dayUsed: 0, dayLimit: 6, monthUsed: 0, monthLimit: 40 },
    price: { create: price1, restyle: null },
    items: [],
    ...over,
  };
}

const cartoon = (over: Partial<NarratorLooksState> = {}) =>
  state({
    character: {
      id: 'c1',
      label: 'Мама',
      hasPhoto: true,
      originalDeleted: false,
      mode: 'cartoon',
      sketchRendering: 'stylized',
    },
    price: { create: price2, restyle: price1 },
    ...over,
  });

console.log('narrator-looks (образ для сказок, WP5)');

it('пути API и скрытие блока для не-владельца Story (404)', () => {
  assert.equal(
    narratorLooksPath('m 1'),
    '/brand-manifests/m%201/narrator-looks'
  );
  assert.equal(
    narratorLooksPath('m1', '/revert'),
    '/brand-manifests/m1/narrator-looks/revert'
  );
  assert.equal(isHiddenForUser({ response: { status: 404 } }), true);
  assert.equal(isHiddenForUser({ response: { status: 409 } }), false);
  assert.equal(isHiddenForUser(null), false);
});

it('цена и квота — понятными строками', () => {
  assert.equal(formatUsd(156_000), '$0.16');
  assert.equal(formatUsd(78_000), '$0.078');
  assert.equal(formatUsd(-5), '$0.000');
  assert.equal(
    quotaLine({ dayUsed: 2, dayLimit: 6, monthUsed: 5, monthLimit: 40 }),
    'Генераций сегодня: 2 из 6 · в месяце: 5 из 40'
  );
  const offer = generationOffer(cartoon(), 'casual', 'none');
  assert.equal(offer.calls, 2);
  assert.equal(offer.reserveMicroUsd, 312_000);
  like(offer.priceLine, /резерв \$0\.31 · вызовов модели: 2/);
});

it('генерация закрыта без согласия, без персонажа/фото, без цены, при брони и сверх квоты', () => {
  const reason = (s: NarratorLooksState) =>
    generationOffer(s, 'casual', 'none').disabledReason;
  assert.equal(reason(state()), null);
  like(
    reason(state({ consent: { ...state().consent, active: false } }))!,
    /согласие/
  );
  like(reason(state({ character: null }))!, /персонажа-рассказчика/);
  like(
    reason(state({ character: { ...state().character!, hasPhoto: false } }))!,
    /оригинальное фото/
  );
  like(
    reason(state({ price: { create: null, restyle: null } }))!,
    /Нет ставки/
  );
  like(
    reason(state({ items: [item({ status: 'PENDING' })] }))!,
    /уже генерируется/
  );
  like(
    reason(
      cartoon({
        quota: { dayUsed: 5, dayLimit: 6, monthUsed: 5, monthLimit: 40 },
      })
    )!,
    /нужно 2, осталось 1/
  );
  assert.equal(
    reason(
      state({
        quota: { dayUsed: 5, dayLimit: 6, monthUsed: 5, monthLimit: 40 },
      })
    ),
    null
  );
});

it('«готовый без оплаты» — только тот же пресет В ТОМ ЖЕ режиме', () => {
  const photoLook = item();
  const cartoonLook = item({ id: 'l2', style: 'cartoon', styledHash: 's' });
  const child = item({
    id: 'l3',
    parentLookId: 'l1',
    style: 'cartoon',
    styledHash: 's',
  });
  assert.equal(
    generationOffer(
      state({ items: [cartoonLook, photoLook] }),
      'cozy-home',
      'light'
    ).existing?.id,
    'l1'
  );
  assert.equal(
    generationOffer(state({ items: [cartoonLook] }), 'cozy-home', 'light')
      .existing,
    null
  );
  assert.equal(
    generationOffer(
      cartoon({ items: [photoLook, child, cartoonLook] }),
      'cozy-home',
      'light'
    ).existing?.id,
    'l2'
  );
  assert.equal(
    generationOffer(state({ items: [photoLook] }), 'cozy-home', 'none')
      .existing,
    null
  );
  assert.equal(
    generationOffer(
      state({ items: [item({ problem: 'consent' })] }),
      'cozy-home',
      'light'
    ).existing,
    null
  );
  // Квота не мешает применить уже готовое.
  assert.equal(
    generationOffer(
      state({
        items: [photoLook],
        quota: { dayUsed: 6, dayLimit: 6, monthUsed: 6, monthLimit: 40 },
      }),
      'cozy-home',
      'light'
    ).disabledReason,
    null
  );
});

it('активный образ = (оригинал | вариант) × (фото | стиль)', () => {
  assert.equal(activeLabel(state()), 'Оригинал × фото');
  const look = item({
    id: 'l9',
    style: 'cartoon',
    styledHash: 's',
    active: true,
  });
  assert.equal(
    activeLabel(
      cartoon({
        items: [look],
        active: {
          kind: 'variant',
          lookId: 'l9',
          asset: 'styled',
          mode: 'cartoon',
          problem: null,
          modeChanged: false,
        },
      })
    ),
    'Вариант «Домашняя уютная · лёгкий макияж» × цветной мультяшный'
  );
  assert.equal(
    activeLabel(
      state({
        active: {
          kind: 'variant',
          lookId: 'gone',
          asset: 'photo',
          mode: 'photo',
          problem: 'deleted',
          modeChanged: false,
        },
      })
    ),
    'Вариант «удалён» × фото'
  );
  assert.equal(
    lookTitle({ outfit: 'winter', makeup: 'none' }),
    'Зимняя · без макияжа'
  );
  assert.equal(lookTitle({ outfit: 'x', makeup: 'y' }), 'x · y');
});

it('подсказка о сохранении режима', () => {
  like(modeKeepNote(state()), /1 вызов/);
  like(modeKeepNote(cartoon()), /«цветной мультяшный» сохранится.*2 вызова/);
  like(modeKeepNote(state({ character: null })), /фото/);
});

it('главная кнопка карточки: активен / применить / перестилизовать / недоступен', () => {
  assert.equal(itemAction(state(), item({ active: true })).kind, 'active');
  assert.equal(
    itemAction(state(), item({ status: 'PENDING' })).kind,
    'pending'
  );
  assert.equal(itemAction(state(), item()).kind, 'apply');
  const restyle = itemAction(cartoon(), item({ problem: 'mode-mismatch' }));
  assert.equal(restyle.kind, 'restyle');
  like(restyle.label, /цветной мультяшный.*\$0\.16/);
  const noConsent = itemAction(
    cartoon({ consent: { ...state().consent, active: false } }),
    item({ problem: 'mode-mismatch' })
  );
  assert.equal(noConsent.kind, 'blocked');
  const stale = itemAction(state(), item({ problem: 'source-changed' }));
  assert.deepEqual(stale, {
    kind: 'blocked',
    label: 'Недоступен',
    reason: 'Фото рассказчика заменено после создания варианта.',
  });
  const unknown = itemAction(
    state(),
    item({ status: 'UNKNOWN', photoHash: null, problem: 'asset-missing' })
  );
  assert.equal(unknown.kind, 'blocked');
  // S3‑7: статус уже написан в карточке — причина не повторяет его,
  // а говорит, где повторить.
  const unknownReason = (unknown as { reason: string }).reason;
  like(unknownReason, /«Новый вариант».*оплачивается заново/);
  assert.notEqual(unknownReason, statusText(item({ status: 'UNKNOWN' })));
  const child = itemAction(
    state(),
    item({ status: 'FAILED', parentLookId: 'l0', problem: 'asset-missing' })
  );
  like((child as { reason: string }).reason, /«Перестилизовать»/);
});

it('not-ready: «Применить» не показывается, причина — человеческим текстом', () => {
  const notReady = itemAction(
    state(),
    item({ status: 'READY', problem: 'not-ready' })
  );
  assert.equal(notReady.kind, 'blocked');
  like(
    (notReady as { reason: string }).reason,
    /Вариант не готов: генерация не завершилась успешно/
  );
  // Не-READY без проблемы от сервера — тоже не «Применить».
  assert.equal(
    itemAction(state(), item({ status: 'DELETED', problem: null })).kind,
    'blocked'
  );
  const failed = itemAction(
    state(),
    item({ status: 'FAILED', problem: 'not-ready' })
  );
  assert.equal(failed.kind, 'blocked');
  like((failed as { reason: string }).reason, /«Новый вариант»/);
});

it('перестилизация после FAILED/UNKNOWN требует явного повтора (S2‑2)', () => {
  const parent = item({ id: 'l2', style: 'pencil', problem: 'mode-mismatch' });
  const failedChild = item({
    id: 'l3',
    parentLookId: 'l2',
    status: 'UNKNOWN',
    style: 'cartoon',
    problem: 'asset-missing',
  });
  const withChild = cartoon({ items: [parent, failedChild] });
  assert.equal(restyleRepeatNeeded(withChild, parent), true);
  const action = itemAction(withChild, parent);
  assert.equal(action.kind, 'restyle');
  assert.equal((action as { repeatNeeded: boolean }).repeatNeeded, true);
  // Другой режим или чужой исходник — повтор не нужен.
  assert.equal(
    restyleRepeatNeeded(
      cartoon({ items: [parent, { ...failedChild, style: 'pencil' }] }),
      parent
    ),
    false
  );
  assert.equal(
    restyleRepeatNeeded(
      cartoon({ items: [parent, { ...failedChild, parentLookId: 'x' }] }),
      parent
    ),
    false
  );
  assert.equal(
    (
      itemAction(cartoon({ items: [parent] }), parent) as {
        repeatNeeded: boolean;
      }
    ).repeatNeeded,
    false
  );
  assert.equal(
    restyleRepeatNeeded(state({ items: [failedChild] }), parent),
    false
  );
});

it('превью: JSON, а слишком большое — бинарно через /image/raw', () => {
  assert.equal(
    narratorLookImagePath('m 1', 'l1', 'styled'),
    '/brand-manifests/m%201/narrator-looks/l1/image?asset=styled'
  );
  assert.equal(
    narratorLookImagePath('m1', 'l1', 'photo', true),
    '/brand-manifests/m1/narrator-looks/l1/image/raw?asset=photo'
  );
  assert.equal(isImageTooLarge({ response: { status: 413 } }), true);
  assert.equal(
    isImageTooLarge({
      response: {
        status: 400,
        data: { error: { details: { code: 'NARRATOR_LOOK_IMAGE_TOO_LARGE' } } },
      },
    }),
    true
  );
  assert.equal(isImageTooLarge({ response: { status: 404 } }), false);
  assert.equal(isImageTooLarge(new Error('x')), false);
});

it('версия согласия показывается человеческим названием (S3‑7)', () => {
  assert.equal(consentTitle('story-parent-image-v1'), 'версия 1');
  assert.equal(consentTitle('story-parent-image-v9'), 'текущая редакция');
  assert.equal(consentTitle(null), 'текущая редакция');
});

it('статусы, превью и явный повтор после FAILED/UNKNOWN', () => {
  assert.equal(statusText(item()), 'Готов');
  assert.equal(statusText(item({ status: 'PENDING' })), 'Генерируется…');
  assert.equal(
    statusText(item({ status: 'FAILED', error: 'SAFETY' })),
    'Не удалось: SAFETY'
  );
  assert.equal(statusText(item({ status: 'FAILED' })), 'Не удалось');
  assert.equal(previewAsset(item()), 'photo');
  assert.equal(previewAsset(item({ styledHash: 's' })), 'styled');
  assert.equal(previewAsset(item({ photoHash: null })), null);
  const failed = item({ status: 'UNKNOWN', photoHash: null });
  assert.equal(
    needsRepeatConfirm(state({ items: [failed] }), 'cozy-home', 'light'),
    true
  );
  assert.equal(
    needsRepeatConfirm(state({ items: [failed] }), 'casual', 'light'),
    false
  );
  assert.equal(
    needsRepeatConfirm(cartoon({ items: [failed] }), 'cozy-home', 'light'),
    false
  );
  assert.equal(
    needsRepeatConfirm(
      cartoon({ items: [item({ status: 'FAILED', style: 'cartoon' })] }),
      'cozy-home',
      'light'
    ),
    true
  );
});

// ST2-U-14 (аудит Story‑Tales 2): после таймаута клиента вариант остаётся
// PENDING — блок опрашивает (GET) и показывает «Обновить блок».
it('PENDING после таймаута: опрос и подсказка про «Обновить блок»', () => {
  assert.equal(hasPendingLook(null), false);
  assert.equal(hasPendingLook({ items: [item({ status: 'READY' })] }), false);
  assert.equal(hasPendingLook({ items: [item({ status: 'PENDING' })] }), true);
  assert.ok(NARRATOR_LOOK_POLL_MS >= 5_000 && NARRATOR_LOOK_POLL_MS <= 30_000);
  // Сервер переводит PENDING старше 10 мин в UNKNOWN — опрос не дольше 15 мин.
  assert.equal(NARRATOR_LOOK_POLL_MAX_MS, 15 * 60_000);
  const panel = readFileSync(
    new URL('../src/features/brand/NarratorLooksPanel.tsx', import.meta.url),
    'utf8'
  );
  like(panel, /setInterval\(/);
  like(panel, /Обновить блок/);
  // Опрос только читает: в таймере нет POST.
  const timer = panel.slice(
    panel.indexOf('const timer = setInterval('),
    panel.indexOf('}, NARRATOR_LOOK_POLL_MS);')
  );
  like(timer, /void load\(true\)/);
  assert.ok(!/api\.post/.test(timer), 'опрос не должен отправлять POST');
});

it('новые коды отказа сервера — своими словами', () => {
  like(
    narratorLookCodeText('NARRATOR_LOOK_TOO_LARGE') ?? '',
    /слишком большой для видео/
  );
  like(
    narratorLookCodeText('NARRATOR_CHARACTER_CHANGED') ?? '',
    /обновите блок/
  );
  assert.equal(narratorLookCodeText('OTHER'), null);
  assert.equal(narratorLookCodeText(null), null);
});

console.log(`narrator-looks: ${passed} проверок пройдено`);
