// Plain assertions runnable with `npx tsx scripts/greeting-policy.test.ts`.
//
// Этап D ТЗ Greeting 2.0 (§3.1, §3.5; Т-18): фронтенд больше не держит
// копию таблицы тонов по поводу — всё решается по `GET /greeting/policy`.
//
// Фикстура — НАСТОЯЩАЯ серверная таблица (`greetingPolicyView()` бэкенда),
// а не рукописный JSON. Рукописная копия в тесте была бы той самой второй
// копией правила, которую Т-18 убирает из кода: она разошлась бы с
// сервером молча, и тест продолжал бы зеленеть. Импорт живой таблицы
// превращает любое расхождение помощников интерфейса с сервером в
// красный тест, а перебор в конце — в приёмочный «перебор» §8 для UI.

import * as backendPolicyNs from '../../backend/src/common/greeting-policy';
import * as backendTypesNs from '../../backend/src/common/types/greeting.types';
import * as backendEditNs from '../../backend/src/common/greeting-session-edit';
import {
  allowedTones,
  briefRegister,
  GREETING_REGISTER_ORDER,
  predictedSessionResets,
  reconcileTone,
  recommendedTone,
  sessionSelectionsKey,
  stricter,
  type SelectedMusic,
  toneOptions,
} from '../src/lib/greeting-policy';
import { GREETING_OCCASIONS, GREETING_TONES } from '../src/types/project';

// Бэкенд — CommonJS, фронтенд — ESM (`"type": "module"`). tsx отдаёт
// CJS-модуль как `default`, а именованные экспорты node не распознаёт
// (esbuild пишет их через `__export`, который cjs-module-lexer не видит).
// Разворачиваем явно — так работает и под tsx, и если когда-нибудь
// экспорты станут видны напрямую.
function interop<T extends object>(ns: T): T {
  return (ns as { default?: T }).default ?? ns;
}
const backend = interop(backendPolicyNs);
const backendTypes = interop(backendTypesNs);
const backendEdit = interop(backendEditNs);

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

// Ровно то, что отдаёт `GET /greeting/policy` (через JSON — как по сети).
const policy = JSON.parse(JSON.stringify(backend.greetingPolicyView()));

// ── Перечисления совпадают с сервером ────────────────────────────────────

check('порядок регистров = серверный порядок строгости', () => {
  eq(GREETING_REGISTER_ORDER, backendTypes.GREETING_REGISTERS);
});

check('пять тонов в том же порядке, что на сервере', () => {
  eq(GREETING_TONES, backendTypes.GREETING_TONES);
});

check('каждый повод интерфейса есть в серверной таблице, и наоборот', () => {
  const server = policy.occasions.map((o: { occasion: string }) => o.occasion);
  eq([...GREETING_OCCASIONS].sort(), [...server].sort());
});

// ── briefRegister ────────────────────────────────────────────────────────

check('briefRegister: повод из каталога — регистр каталога', () => {
  eq(briefRegister(policy, 'CONDOLENCE', null), 'MOURNING');
  eq(briefRegister(policy, 'BIRTHDAY', null), 'CELEBRATORY');
  // Ответ о настроении у каталожного повода ничего не меняет.
  eq(briefRegister(policy, 'BIRTHDAY', 'MOURNING'), 'CELEBRATORY');
});

check('briefRegister: без таблицы каталожный повод — null', () => {
  eq(briefRegister(null, 'CONDOLENCE', null), null);
});

check('briefRegister: «Особый повод» без ответа — null', () => {
  eq(briefRegister(policy, 'OTHER', null), null);
});

check('briefRegister: без ответа, но сервер поднял — поднятый регистр', () => {
  // Бриф, поднятый ключевыми словами, после перезагрузки: ответа нет
  // (`initialMood`), но сервер ниже поднятого не опустит — тоны гаснут
  // сразу, а не горят все рядом со строкой «часть тонов недоступна».
  eq(briefRegister(policy, 'OTHER', null, 'MOURNING'), 'MOURNING');
  eq(
    toneOptions(
      policy,
      'OTHER',
      briefRegister(policy, 'OTHER', null, 'MOURNING')
    )
      .filter((o) => o.allowed)
      .map((o) => o.tone),
    ['SUPPORTIVE', 'RESPECTFUL']
  );
});

check('briefRegister: «Особый повод» с ответом — ответ', () => {
  eq(briefRegister(policy, 'OTHER', 'SOLEMN'), 'SOLEMN');
  // Настроение — выбор человека, таблица для него не нужна.
  eq(briefRegister(null, 'OTHER', 'SENSITIVE'), 'SENSITIVE');
});

check('briefRegister: сервер поднял регистр — строжайший побеждает', () => {
  eq(briefRegister(policy, 'OTHER', 'CELEBRATORY', 'MOURNING'), 'MOURNING');
});

check('briefRegister: сервер ниже ответа — регистр не опускается', () => {
  eq(briefRegister(policy, 'OTHER', 'SENSITIVE', 'CELEBRATORY'), 'SENSITIVE');
});

// ── stricter ─────────────────────────────────────────────────────────────

check('stricter: строже — дальше по порядку, в обе стороны', () => {
  eq(stricter('CELEBRATORY', 'SOLEMN'), 'SOLEMN');
  eq(stricter('SOLEMN', 'CELEBRATORY'), 'SOLEMN');
  eq(stricter('WARM_NEUTRAL', null), 'WARM_NEUTRAL');
  eq(stricter('WARM_NEUTRAL', undefined), 'WARM_NEUTRAL');
});

check('stricter совпадает с серверным stricterRegister на всех парах', () => {
  for (const a of GREETING_REGISTER_ORDER) {
    for (const b of GREETING_REGISTER_ORDER) {
      eq([a, b, stricter(a, b)], [a, b, backend.stricterRegister(a, b)]);
    }
  }
});

// ── allowedTones ─────────────────────────────────────────────────────────

check('allowedTones: «Особый повод» — по регистру', () => {
  eq(allowedTones(policy, 'OTHER', 'MOURNING'), ['RESPECTFUL', 'SUPPORTIVE']);
  eq(allowedTones(policy, 'OTHER', 'CELEBRATORY'), ['WARM', 'FUNNY', 'FORMAL']);
  eq(allowedTones(policy, 'OTHER', null), null);
});

check('allowedTones: каталожный повод — тоны каталога в его порядке', () => {
  eq(
    allowedTones(policy, 'CONDOLENCE', 'MOURNING'),
    backend.tonesFor('CONDOLENCE', 'MOURNING')
  );
  eq(
    allowedTones(policy, 'GET_WELL', 'SENSITIVE'),
    backend.tonesFor('GET_WELL', 'SENSITIVE')
  );
});

check('allowedTones: без таблицы — null (не знаем)', () => {
  eq(allowedTones(null, 'CONDOLENCE', 'MOURNING'), null);
});

// ── toneOptions ──────────────────────────────────────────────────────────

check('toneOptions: все пять тонов, порядок постоянный', () => {
  for (const [occ, reg] of [
    ['BIRTHDAY', 'CELEBRATORY'],
    ['CONDOLENCE', 'MOURNING'],
    ['OTHER', 'SOLEMN'],
  ] as const) {
    eq(
      toneOptions(policy, occ, reg).map((o) => o.tone),
      GREETING_TONES
    );
  }
});

check('toneOptions: недоступные помечены, а не выброшены', () => {
  eq(toneOptions(policy, 'OTHER', 'MOURNING'), [
    { tone: 'WARM', allowed: false },
    { tone: 'FUNNY', allowed: false },
    { tone: 'FORMAL', allowed: false },
    { tone: 'SUPPORTIVE', allowed: true },
    { tone: 'RESPECTFUL', allowed: true },
  ]);
});

check('toneOptions: таблицы нет — доступны все (проверит сервер)', () => {
  eq(
    toneOptions(null, 'CONDOLENCE', 'MOURNING').map((o) => o.allowed),
    [true, true, true, true, true]
  );
});

// ── recommendedTone ──────────────────────────────────────────────────────

check('recommendedTone: соболезнование — уважительный', () => {
  eq(recommendedTone(policy, 'CONDOLENCE', 'MOURNING'), 'RESPECTFUL');
});

check('recommendedTone: корпоратив — официальный', () => {
  eq(
    recommendedTone(
      policy,
      'CORPORATE',
      briefRegister(policy, 'CORPORATE', null)
    ),
    'FORMAL'
  );
});

check('recommendedTone: выздоровление — поддерживающий', () => {
  eq(
    recommendedTone(
      policy,
      'GET_WELL',
      briefRegister(policy, 'GET_WELL', null)
    ),
    'SUPPORTIVE'
  );
});

check('recommendedTone: «Особый повод» траурный — уважительный', () => {
  eq(recommendedTone(policy, 'OTHER', 'MOURNING'), 'RESPECTFUL');
});

check('recommendedTone: не знаем — null', () => {
  eq(recommendedTone(null, 'CONDOLENCE', 'MOURNING'), null);
  eq(recommendedTone(policy, 'OTHER', null), null);
});

// ── reconcileTone ────────────────────────────────────────────────────────

check('reconcileTone: шутка → соболезнование — смена названа', () => {
  eq(reconcileTone(policy, 'CONDOLENCE', 'MOURNING', 'FUNNY'), {
    tone: 'RESPECTFUL',
    change: { from: 'FUNNY', to: 'RESPECTFUL' },
  });
});

check('reconcileTone: допустимый тон не трогается', () => {
  // FORMAL у дня рождения допустим, хоть и не первый — выбран осознанно.
  eq(reconcileTone(policy, 'BIRTHDAY', 'CELEBRATORY', 'FORMAL'), {
    tone: 'FORMAL',
    change: null,
  });
});

check('reconcileTone: нет таблицы или ответа — не трогается', () => {
  eq(reconcileTone(null, 'CONDOLENCE', 'MOURNING', 'FUNNY'), {
    tone: 'FUNNY',
    change: null,
  });
  eq(reconcileTone(policy, 'OTHER', null, 'FUNNY'), {
    tone: 'FUNNY',
    change: null,
  });
});

// ── predictedSessionResets ───────────────────────────────────────────────

check(
  'predictedSessionResets: траур сбрасывает наклейку и лишние сцены',
  () => {
    eq(
      predictedSessionResets(policy, 'OTHER', 'MOURNING', {
        sticker: true,
        sceneCount: 4,
      }),
      ['sticker', 'sceneCount']
    );
  }
);

check('predictedSessionResets: в рамках правил — ничего', () => {
  eq(
    predictedSessionResets(policy, 'OTHER', 'MOURNING', {
      sticker: false,
      sceneCount: 2,
    }),
    []
  );
  eq(
    predictedSessionResets(policy, 'OTHER', 'CELEBRATORY', {
      sticker: true,
      sceneCount: 4,
    }),
    []
  );
  // Сцены не выбраны — считается одна, как у сервера.
  eq(
    predictedSessionResets(policy, 'OTHER', 'MOURNING', {
      sticker: false,
      sceneCount: null,
    }),
    []
  );
});

check('predictedSessionResets: граница — ровно потолок сцен допустим', () => {
  eq(
    predictedSessionResets(policy, 'OTHER', 'SOLEMN', {
      sticker: false,
      sceneCount: 3,
    }),
    []
  );
  eq(
    predictedSessionResets(policy, 'OTHER', 'SOLEMN', {
      sticker: false,
      sceneCount: 4,
    }),
    ['sceneCount']
  );
});

check('predictedSessionResets: не знаем регистр — ничего не обещаем', () => {
  eq(
    predictedSessionResets(null, 'OTHER', 'MOURNING', {
      sticker: true,
      sceneCount: 4,
    }),
    []
  );
  eq(
    predictedSessionResets(policy, 'OTHER', null, {
      sticker: true,
      sceneCount: 4,
    }),
    []
  );
});

check('predictedSessionResets: тема только для дня рождения → свадьба', () => {
  // Регистр у обоих праздничный — сброс решает ПОВОД. Раньше музыку не
  // смотрели вовсе, и предупреждение молчало, а сервер тему снимал.
  const music: SelectedMusic = { source: 'catalog', occasions: ['BIRTHDAY'] };
  eq(
    predictedSessionResets(policy, 'WEDDING', 'CELEBRATORY', {
      sticker: false,
      sceneCount: 1,
      music,
    }),
    ['musicTheme']
  );
  eq(
    predictedSessionResets(policy, 'BIRTHDAY', 'CELEBRATORY', {
      sticker: false,
      sceneCount: 1,
      music,
    }),
    []
  );
});

check(
  'predictedSessionResets: тема «для любого повода» в трауре — сброс',
  () => {
    eq(
      predictedSessionResets(policy, 'OTHER', 'MOURNING', {
        sticker: false,
        sceneCount: 1,
        music: { occasions: null },
      }),
      ['musicTheme']
    );
  }
);

check(
  'predictedSessionResets: своя музыка и выбор до этапа B — не сброс',
  () => {
    for (const music of [
      { source: 'upload', occasions: ['BIRTHDAY'] },
      { source: 'library' },
      { source: 'catalog' },
    ] as SelectedMusic[]) {
      eq(
        predictedSessionResets(policy, 'CONDOLENCE', 'MOURNING', {
          sticker: false,
          sceneCount: 1,
          music,
        }),
        []
      );
    }
  }
);

check(
  'predictedSessionResets = серверный reconcileSelections (перебор)',
  () => {
    // Сверка с тем, что сервер ДЕЛАЕТ при правке сессии, — всеми тремя
    // сбрасываемыми полями, по всем поводам. Раньше перебор шёл по одному
    // OTHER и отфильтровывал музыку — и прятал, что её не предсказывают.
    const musics: Array<SelectedMusic | null> = [
      null,
      {},
      { source: 'catalog', occasions: null },
      { occasions: null },
      { source: 'catalog', occasions: ['BIRTHDAY'] },
      { source: 'catalog', occasions: ['WEDDING', 'BIRTHDAY'] },
      { source: 'catalog', occasions: ['CONDOLENCE'] },
      { source: 'catalog', occasions: ['OTHER'] },
      { source: 'upload', occasions: ['BIRTHDAY'] },
      { source: 'link' },
      { source: 'library', occasions: null },
    ];
    let n = 0;
    for (const { occasion } of policy.occasions as Array<{
      occasion: (typeof GREETING_OCCASIONS)[number];
    }>) {
      const moods =
        occasion === 'OTHER' ? GREETING_REGISTER_ORDER : ([null] as const);
      for (const mood of moods) {
        const register = briefRegister(policy, occasion, mood);
        if (!register) throw new Error(`${occasion}: нет регистра`);
        for (const sticker of [false, true]) {
          for (const sceneCount of [null, 1, 2, 3, 4]) {
            for (const music of musics) {
              const snapshot = {
                occasion,
                occasionRegister: mood,
                tone: backend.defaultToneForRegister(occasion, register),
                recipientName: 'Марина',
                sticker: sticker ? { id: 's1', url: 'https://x/s.png' } : null,
                sceneCount,
                musicTheme: music
                  ? { id: 't1', title: 'T', url: 'https://x/t.mp3', ...music }
                  : null,
              } as unknown as Parameters<
                typeof backendEdit.reconcileSelections
              >[0];
              const server =
                backendEdit.reconcileSelections(snapshot).resetFields;
              eq(
                [occasion, mood, sticker, sceneCount, music, server],
                [
                  occasion,
                  mood,
                  sticker,
                  sceneCount,
                  music,
                  predictedSessionResets(policy, occasion, register, {
                    sticker,
                    sceneCount,
                    music,
                  }),
                ]
              );
              n++;
            }
          }
        }
      }
    }
    if (n < 1000) throw new Error(`перебор ослеп: всего ${n} комбинаций`);
  }
);

// ── sessionSelectionsKey ─────────────────────────────────────────────────

check('sessionSelectionsKey: нет сессии или регистра — читать нечего', () => {
  eq(sessionSelectionsKey(null, 'BIRTHDAY', 'CELEBRATORY', 0), null);
  eq(sessionSelectionsKey('s1', 'OTHER', null, 0), null);
});

check('sessionSelectionsKey: меняется от повода при том же регистре', () => {
  // День рождения → свадьба: регистр тот же, а тема музыки может слететь.
  const a = sessionSelectionsKey('s1', 'BIRTHDAY', 'CELEBRATORY', 0);
  const b = sessionSelectionsKey('s1', 'WEDDING', 'CELEBRATORY', 0);
  if (a === b) throw new Error('ключ не зависит от повода');
});

check('sessionSelectionsKey: меняется после сохранения', () => {
  // Сохранение само сбросило несовместимое — предупреждение надо
  // перечитать, хотя повод и регистр те же.
  const a = sessionSelectionsKey('s1', 'CONDOLENCE', 'MOURNING', 0);
  const b = sessionSelectionsKey('s1', 'CONDOLENCE', 'MOURNING', 1);
  if (a === b) throw new Error('ключ не зависит от счётчика сохранений');
});

// ── Перебор: интерфейс = сервер на каждой комбинации (приёмка §8) ────────

check('перебор: каждый повод каталога × каждый тон — как у сервера', () => {
  let n = 0;
  for (const { occasion } of policy.occasions as Array<{
    occasion: (typeof GREETING_OCCASIONS)[number];
  }>) {
    if (occasion === 'OTHER') continue;
    const register = briefRegister(policy, occasion, null);
    if (!register) throw new Error(`${occasion}: нет регистра`);
    const options = toneOptions(policy, occasion, register);
    for (const { tone, allowed } of options) {
      const server = backend.toneAllowedForRegister(occasion, register, tone);
      if (allowed !== server) {
        throw new Error(
          `${occasion}/${register}/${tone}: интерфейс ${allowed}, сервер ${server}`
        );
      }
      n++;
    }
    eq(
      [occasion, recommendedTone(policy, occasion, register)],
      [occasion, backend.defaultToneForRegister(occasion, register)]
    );
  }
  // Защита от пустого перебора: 23 каталожных повода × 5 тонов.
  if (n < 100) throw new Error(`перебор ослеп: всего ${n} комбинаций`);
});

check('перебор: «Особый повод» × 5 регистров × 5 тонов — как у сервера', () => {
  let n = 0;
  for (const register of GREETING_REGISTER_ORDER) {
    for (const { tone, allowed } of toneOptions(policy, 'OTHER', register)) {
      const server = backend.toneAllowedForRegister('OTHER', register, tone);
      if (allowed !== server) {
        throw new Error(
          `OTHER/${register}/${tone}: интерфейс ${allowed}, сервер ${server}`
        );
      }
      n++;
    }
    eq(
      [register, recommendedTone(policy, 'OTHER', register)],
      [register, backend.defaultToneForRegister('OTHER', register)]
    );
  }
  eq(n, 25);
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
