// Plain assertions runnable with `npx tsx scripts/persona-flow.test.ts`.
//
// «Я в кадре» (ТЗ Greeting 2.0 §4.1–§4.6, §4.9): шаг экрана, шлюз
// PERSONA_ENABLED, возраст образа (18…90, предупреждение > 20 лет),
// квота, причины отказа проверки и их синхронность с сервером.

import { readFileSync } from 'node:fs';
import {
  ageRangeLine,
  ageShiftWarns,
  canCreateLook,
  clampTargetAge,
  defaultTargetAge,
  galleryLooks,
  isPersonaDisabledResponse,
  lookDisplayLabel,
  lookSourceChoice,
  personaDeleteOnly,
  personaErrorInfo,
  quotaRefusalState,
  verifyRetryable,
  voiceState,
  isUnderageRefusal,
  lookCreateBody,
  lookState,
  LOOK_DESCRIPTION_MAX,
  LOOK_DESCRIPTION_MIN,
  LOOK_PRESETS,
  LOOK_WARNING_AGE_SHIFT,
  AGE_SHIFT_WARN_YEARS,
  personaQuotaState,
  personaStage,
  quotaLine,
  referenceAge,
  REFUSAL_REASONS,
  refusalLines,
  splitShares,
  TARGET_AGE_MAX,
  TARGET_AGE_MIN,
  type PersonaLook,
  type PersonaMe,
} from '../src/lib/persona-flow';
import { parseRoute, routes } from '../src/lib/router';
import {
  availableModes,
  canDeleteOriginal,
  isAnonymizeForced,
  supportsRemoveLogos,
} from '../src/features/sketch/sketch-model';
import ru from '../src/dictionaries/ru.json';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

const backend = (p: string) =>
  readFileSync(new URL(`../../backend/src/${p}`, import.meta.url), 'utf8');
/** Строки массива `export const NAME = [ ... ]` из исходника сервера. */
function serverList(src: string, name: string): string[] {
  const m = src.match(
    new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`)
  );
  if (!m) throw new Error(`${name} не найден в исходнике сервера`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
function serverNumber(src: string, name: string): number {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`${name} не найден в исходнике сервера`);
  return Number(m[1]);
}

const look = (over: Partial<PersonaLook> = {}): PersonaLook => ({
  id: 'l1',
  label: 'Образ',
  preset: null,
  targetAge: null,
  isBase: false,
  status: 'ready',
  photoUrl: 'https://x/l1.jpg',
  sketchUrl: null,
  createdAt: '2026-09-30T10:00:00.000Z',
  ...over,
});
const persona = {
  id: 'p1',
  consentGivenAt: '2026-09-30T09:00:00.000Z',
  verified: true,
  ageMin: 28,
  ageMax: 34,
  sourcesPurgedAt: null,
};
const me = (over: Partial<PersonaMe> = {}): PersonaMe => ({
  persona,
  looks: [look({ id: 'base', isBase: true })],
  voice: null,
  quota: { dayLeft: 3, monthLeft: 20 },
  ...over,
});

/**
 * Конверт ошибки — как у настоящего фильтра исключений
 * (backend/src/common/filters/http-exception.filter.ts): машинный код
 * персоны — в `error.details.code`, остаток квоты — в `error.details.quota`.
 */
function envelope(
  httpCode: string,
  code: string,
  extra: Record<string, unknown> = {}
) {
  return {
    success: false,
    error: {
      code: httpCode,
      message: 'текст сервера',
      details: { code, ...extra },
    },
    meta: { timestamp: '2026-09-30T00:00:00.000Z', requestId: 'r1' },
  };
}

console.log('persona-flow (Я в кадре, §4)');

// ── Шлюз ───────────────────────────────────────────────────────────────
check(
  '404 PERSONA_DISABLED — режим выключен, код узнаётся в error.details',
  () => {
    eq(
      isPersonaDisabledResponse(404, envelope('NOT_FOUND', 'PERSONA_DISABLED')),
      { disabled: true, flagged: true }
    );
  }
);
check('любой 404 на /personas/me прячет вход; 401 и 500 — нет', () => {
  eq(isPersonaDisabledResponse(404, undefined), {
    disabled: true,
    flagged: false,
  });
  eq(
    isPersonaDisabledResponse(401, { code: 'PERSONA_DISABLED' }).disabled,
    false
  );
  eq(isPersonaDisabledResponse(500, undefined).disabled, false);
});

// ── Шаг ────────────────────────────────────────────────────────────────
check('нет персоны — вступление; не проверена — «не завершено»', () => {
  eq(personaStage(null), 'intro');
  eq(personaStage(me({ persona: null })), 'intro');
  eq(
    personaStage(me({ persona: { ...persona, verified: false } })),
    'unverified'
  );
});
check('отказ по возрасту — закрытый шаг, а не «переснять»', () => {
  eq(
    personaStage(
      me({ persona: { ...persona, verified: false, refusals: ['under-18'] } })
    ),
    'closed'
  );
  eq(
    personaStage(
      me({ persona: { ...persona, verified: false, ageMin: 16, ageMax: 20 } })
    ),
    'closed'
  );
});
check(
  'проверена, базовый образ в работе или сбой — шаг базового образа',
  () => {
    eq(personaStage(me({ looks: [] })), 'base');
    eq(
      personaStage(
        me({
          looks: [look({ isBase: true, status: 'pending', photoUrl: null })],
        })
      ),
      'base'
    );
    eq(
      personaStage(me({ looks: [look({ isBase: true, status: 'failed' })] })),
      'base'
    );
  }
);
check('готовый базовый образ — галерея', () => {
  eq(personaStage(me()), 'ready');
});

// ── Образы ─────────────────────────────────────────────────────────────
check('«готов» без картинки — всё ещё в работе (показать нечего)', () => {
  eq(lookState({ status: 'ready', photoUrl: null }), 'pending');
  eq(lookState({ status: 'ready', photoUrl: 'u' }), 'ready');
  eq(lookState({ status: 'failed', photoUrl: null }), 'failed');
  eq(lookState({ status: 'deleted', photoUrl: 'u' }), 'deleted');
});
check(
  'галерея: без удалённых, базовый первым, остальные — новые сверху',
  () => {
    const list = galleryLooks([
      look({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
      look({ id: 'gone', status: 'deleted' }),
      look({ id: 'base', isBase: true, createdAt: '2026-08-01T00:00:00.000Z' }),
      look({ id: 'new', createdAt: '2026-09-29T00:00:00.000Z' }),
    ]);
    eq(
      list.map((l) => l.id),
      ['base', 'new', 'old']
    );
  }
);
check('пресеты — те же коды и порядок, что у сервера', () => {
  eq(
    LOOK_PRESETS,
    serverList(
      backend('modules/persona/persona-looks.rules.ts'),
      'PERSONA_LOOK_PRESETS'
    )
  );
});
check('у каждого пресета и причины отказа есть перевод', () => {
  for (const p of LOOK_PRESETS)
    if (!(ru.persona.presets as Record<string, string>)[p]) throw new Error(p);
  for (const r of REFUSAL_REASONS)
    if (!(ru.persona.reasons as Record<string, string>)[r]) throw new Error(r);
});

// ── Возраст (§4.4, Т-6) ────────────────────────────────────────────────
check('ползунок — всегда 18…90, как на сервере', () => {
  const src = backend('modules/persona/persona-looks.rules.ts');
  eq(TARGET_AGE_MIN, serverNumber(src, 'LOOK_AGE_MIN'));
  eq(TARGET_AGE_MAX, serverNumber(src, 'LOOK_AGE_MAX'));
  eq(AGE_SHIFT_WARN_YEARS, serverNumber(src, 'LOOK_AGE_SHIFT_WARN'));
  eq(TARGET_AGE_MIN, 18);
  eq(clampTargetAge(5), 18);
  eq(clampTargetAge(17.4), 18);
  eq(clampTargetAge(120), 90);
  eq(clampTargetAge(Number.NaN), 18);
  eq(clampTargetAge(44.6), 45);
});
check('опорный возраст — зеркало referenceLookAge сервера', () => {
  eq(referenceAge(persona), 31);
  eq(referenceAge(persona, { targetAge: 60 }), 60);
  eq(referenceAge(persona, { targetAge: null }), 31);
  eq(referenceAge({ ageMin: null, ageMax: null }), 30);
  eq(referenceAge({ ageMin: 20, ageMax: null }), 20);
  // Оценка у нижней границы не тянет опору ниже 18.
  eq(referenceAge({ ageMin: 14, ageMax: 17 }), 18);
  eq(defaultTargetAge(31), 31);
});
check('предупреждение — строго больше 20 лет, в обе стороны', () => {
  eq(ageShiftWarns(51, 31), false);
  eq(ageShiftWarns(52, 31), true);
  eq(ageShiftWarns(18, 38), false);
  eq(ageShiftWarns(18, 39), true);
});
check('код предупреждения сервера совпадает', () => {
  const src = backend('modules/persona/persona-looks.rules.ts');
  if (!src.includes(`LOOK_WARNING_AGE_SHIFT = '${LOOK_WARNING_AGE_SHIFT}'`))
    throw new Error('LOOK_WARNING_AGE_SHIFT разошёлся с сервером');
});
check('«ИИ оценил возраст на фото как 28–34»', () => {
  eq(
    ageRangeLine(ru.persona.ageRange, 28, 34),
    'ИИ оценил возраст на фото как 28–34'
  );
  eq(ageRangeLine('{{range}}', 30, 30), '30');
  eq(ageRangeLine('{{range}}', null, 34), null);
});

// ── Квота (В-7) ────────────────────────────────────────────────────────
check('месяц важнее дня', () => {
  eq(personaQuotaState({ dayLeft: 0, monthLeft: 0 }), 'month-over');
  eq(personaQuotaState({ dayLeft: 0, monthLeft: 5 }), 'day-over');
  eq(personaQuotaState({ dayLeft: 2, monthLeft: 5 }), 'ok');
  eq(personaQuotaState(null), 'ok');
});
check('строка квоты не показывает минус', () => {
  eq(quotaLine({ dayLeft: -1, monthLeft: 7 }, '{{day}}/{{month}}'), '0/7');
});
check('создать образ: нужен пресет или описание, и квота', () => {
  const quota = { dayLeft: 1, monthLeft: 1 };
  eq(canCreateLook({ preset: null, description: '', quota }), false);
  eq(canCreateLook({ preset: null, description: ' a ', quota }), false);
  eq(canCreateLook({ preset: null, description: 'ab', quota }), true);
  eq(canCreateLook({ preset: 'winter', description: '', quota }), true);
  eq(canCreateLook({ preset: 'winter', description: 'a', quota }), false);
  eq(
    canCreateLook({
      preset: 'winter',
      description: '',
      quota: { dayLeft: 0, monthLeft: 3 },
    }),
    false
  );
  eq(
    canCreateLook({
      preset: null,
      description: 'x'.repeat(LOOK_DESCRIPTION_MAX + 1),
      quota,
    }),
    false
  );
});
check('границы описания — те же, что @Length в DTO', () => {
  const dto = backend('modules/persona/persona-looks.dto.ts');
  // Последний @Length перед полем description.
  const pair = dto
    .split('description?')[0]
    .match(/@Length\((\d+),\s*(\d+)\)[^@]*$/);
  if (!pair) throw new Error('@Length у description не найден');
  eq(
    [LOOK_DESCRIPTION_MIN, LOOK_DESCRIPTION_MAX],
    [Number(pair[1]), Number(pair[2])]
  );
});
check('тело создания — только заполненное, возраст зажат', () => {
  eq(
    lookCreateBody({
      preset: null,
      description: '  ',
      targetAge: null,
      sourceLookId: null,
    }),
    {}
  );
  eq(
    lookCreateBody({
      preset: 'sport',
      description: ' в парке ',
      targetAge: 12,
      sourceLookId: 'l2',
    }),
    {
      preset: 'sport',
      description: 'в парке',
      targetAge: 18,
      sourceLookId: 'l2',
    }
  );
});

// ── Отказ проверки ─────────────────────────────────────────────────────
check('коды причин — те же, что PERSONA_REFUSALS сервера', () => {
  eq(
    [...REFUSAL_REASONS],
    serverList(backend('modules/persona/persona-rules.ts'), 'PERSONA_REFUSALS')
  );
});
check(
  'известный код — перевод; фраза — как есть; неизвестный код — общая фраза',
  () => {
    eq(
      refusalLines(['no-face', 'Слишком далеко', 'brand-new-check', 'NO-FACE']),
      [
        { kind: 'known', reason: 'no-face' },
        { kind: 'text', text: 'Слишком далеко' },
        { kind: 'generic' },
      ]
    );
    eq(refusalLines(undefined), [{ kind: 'generic' }]);
    eq(refusalLines(['', '  ']), [{ kind: 'generic' }]);
  }
);
check('отказ по возрасту — по коду или по оценке, только у refused', () => {
  eq(isUnderageRefusal({ status: 'refused', reasons: ['under-18'] }), true);
  eq(
    isUnderageRefusal({ status: 'refused', reasons: ['no-face'], ageMin: 17 }),
    true
  );
  eq(
    isUnderageRefusal({ status: 'refused', reasons: ['no-face'], ageMin: 18 }),
    false
  );
  eq(isUnderageRefusal({ status: 'ok', ageMin: 16 }), false);
});

// ── Т-16: никаких «личность подтверждена» ──────────────────────────────
check('в словарях нет «личность подтверждена» / identity verified', () => {
  const forbidden = [
    /личност\S*\s+подтвержд/i,
    /подтвержд\S*\s+личност/i,
    /особ\S*\s+підтвердж/i,
    /identity\s+(is\s+)?(confirmed|verified)/i,
    /verified\s+identity/i,
    /identität\s+(ist\s+)?(bestätigt|verifiziert)/i,
    /identidad\s+(confirmada|verificada)/i,
  ];
  for (const loc of ['ru', 'uk', 'en', 'de', 'es']) {
    const text = JSON.stringify(
      JSON.parse(
        readFileSync(
          new URL(`../src/dictionaries/${loc}.json`, import.meta.url),
          'utf8'
        )
      ).persona
    );
    for (const re of forbidden)
      if (re.test(text)) throw new Error(`${loc}: ${re}`);
  }
});

// ── CONTRACT5 ──────────────────────────────────────────────────────────
check(
  'фильтр кладёт code в details — тест сверяет с исходником фильтра',
  () => {
    const src = backend('common/filters/http-exception.filter.ts');
    if (!/details\.code\s*=\s*code/.test(src))
      throw new Error('фильтр больше не кладёт code в error.details');
  }
);
check('разбор отказа: код PERSONA_… и квота из details', () => {
  eq(
    personaErrorInfo(
      envelope('HTTP_429', 'PERSONA_LOOK_QUOTA', {
        quota: { dayLeft: 2, monthLeft: 0 },
      })
    ),
    { code: 'PERSONA_LOOK_QUOTA', quota: { dayLeft: 2, monthLeft: 0 } }
  );
  // Общий код фильтра — не код персоны.
  eq(personaErrorInfo(envelope('NOT_FOUND', 'SOMETHING')), {
    code: null,
    quota: null,
  });
  eq(personaErrorInfo(undefined), { code: null, quota: null });
  eq(
    personaErrorInfo(
      envelope('HTTP_429', 'PERSONA_LOOK_QUOTA', { quota: { dayLeft: '1' } })
    ).quota,
    null
  );
});
check('429: месяц — по остатку месяца, иначе «на сегодня»', () => {
  eq(quotaRefusalState({ dayLeft: 3, monthLeft: 0 }), 'month-over');
  eq(quotaRefusalState({ dayLeft: 0, monthLeft: 9 }), 'day-over');
  eq(quotaRefusalState(null), 'day-over');
});
check('подпись образа: своя → «Базовый образ» → пресет → без названия', () => {
  const d = ru.persona;
  eq(
    lookDisplayLabel({ label: ' Мой ', isBase: true, preset: 'sport' }, d),
    'Мой'
  );
  eq(
    lookDisplayLabel({ label: '', isBase: true, preset: null }, d),
    d.baseLabel
  );
  eq(
    lookDisplayLabel({ label: ' ', isBase: false, preset: 'winter' }, d),
    d.presets.winter
  );
  eq(
    lookDisplayLabel({ label: '', isBase: false, preset: 'unknown' }, d),
    d.lookUntitled
  );
  eq(
    lookDisplayLabel({ label: '', isBase: false, preset: null }, d),
    d.lookUntitled
  );
});
check('статус голоса — без учёта регистра, неизвестное — обучается', () => {
  eq(voiceState('READY'), 'ready');
  eq(voiceState('ready'), 'ready');
  eq(voiceState('Failed'), 'failed');
  eq(voiceState('TRAINING'), 'training');
  eq(voiceState(undefined), 'training');
});
check('check-unavailable — «проверить ещё раз», прочие — нет', () => {
  eq(verifyRetryable(['no-face', 'CHECK-UNAVAILABLE']), true);
  eq(verifyRetryable(['no-face']), false);
  eq(verifyRetryable(null), false);
});
check(
  'после срока хранения «Из селфи» нет, по умолчанию — базовый образ',
  () => {
    const looks = [look({ id: 'x' }), look({ id: 'b', isBase: true })];
    eq(lookSourceChoice({ sourcesPurgedAt: null }, looks), {
      selfieOption: true,
      defaultSourceId: '',
    });
    eq(lookSourceChoice({ sourcesPurgedAt: '2026-10-01' }, looks), {
      selfieOption: false,
      defaultSourceId: 'b',
    });
    eq(
      lookSourceChoice({ sourcesPurgedAt: '2026-10-01' }, [look({ id: 'x' })])
        .defaultSourceId,
      'x'
    );
  }
);
check('флаг выключен, персона есть — только удаление', () => {
  eq(personaDeleteOnly(me({ enabled: false })), true);
  eq(personaDeleteOnly(me({ enabled: true })), false);
  eq(personaDeleteOnly(me()), false);
  eq(personaDeleteOnly(me({ enabled: false, persona: null })), false);
});
check('скетч образа: только «по образу», без «удалить оригинал»', () => {
  eq(availableModes(true, 'persona-look'), ['from-image']);
  eq(availableModes(false, 'persona-look'), ['from-image']);
  eq(availableModes(true, 'brand-character'), ['from-image', 'from-text']);
  eq(availableModes(false), ['from-text']);
  eq(canDeleteOriginal('persona-look'), false);
  eq(canDeleteOriginal('session-character'), true);
});

// ── Удаление (§4.9) ────────────────────────────────────────────────────
check('снять можно только страницы с sessionId; остальные — ссылкой', () => {
  const r = splitShares([
    { id: 'a', url: 'u1', sessionId: 's1' },
    { id: 'b', url: 'u2' },
    { id: 'c', url: 'u3', sessionId: null },
  ]);
  eq(
    r.removable.map((s) => s.id),
    ['a']
  );
  eq(
    r.linkOnly.map((s) => s.id),
    ['b', 'c']
  );
});

// ── Маршрут и скетч ────────────────────────────────────────────────────
check('маршрут #/persona', () => {
  eq(parseRoute('#/persona'), { name: 'persona' });
  eq(parseRoute(`#${routes.persona()}`), { name: 'persona' });
});
check('скетч образа: лицо не обезличивается, логотипов не предлагаем', () => {
  eq(isAnonymizeForced('persona-look', 'from-image'), false);
  eq(supportsRemoveLogos('persona-look'), false);
  // Прочие слоты — как были.
  eq(isAnonymizeForced('session-character', 'from-image'), true);
  eq(supportsRemoveLogos('project-item'), true);
});

console.log(`persona-flow: ${passed} проверок пройдено`);
if (failed) {
  console.error(`persona-flow: ${failed} провалено`);
  process.exit(1);
}
