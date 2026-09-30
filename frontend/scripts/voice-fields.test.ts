// Plain assertions runnable with `npx tsx scripts/voice-fields.test.ts`.
//
// Этап K5 ТЗ Greeting 2.0 §4А.7.1: голосом — в элементы сессии по тем же
// правилам, что руками. Имена хуков сверяются с ЖИВЫМ каталогом сервера
// (`SESSION_FIELD_HOOKS`), потолки — с серверными константами.

import * as intentNs from '../../backend/src/common/greeting-voice-intent';
import * as cardsNs from '../../backend/src/common/greeting-cards';
import * as stickerNs from '../../backend/src/common/sticker-overlay';
import {
  CARD_TEXT_MAX,
  cardsVoiceSave,
  needsSave,
  saveEffect,
  SESSION_VOICE_TARGETS as T,
  planCardsVoice,
  planMusicVoice,
  planReferenceVoice,
  planScenesVoice,
  planScriptVoice,
  planStickerVoice,
  planVoiceChoice,
  refusalLines,
  refusalReason,
  toggleOf,
  type MusicVoiceState,
  type SessionVoiceTexts,
  type StickerVoiceState,
  type VoiceChoiceState,
} from '../src/lib/voice-fields';
import { STICKER_PLACEMENTS } from '../src/types/project';
import { readFileSync } from 'node:fs';
import type { VoiceField } from '../src/lib/voice-types';
import ru from '../src/dictionaries/ru.json';

const unwrap = <M>(ns: M): M => (ns as { default?: M }).default ?? ns;
const intent = unwrap(intentNs);
const cards = unwrap(cardsNs);
const sticker = unwrap(stickerNs);

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
const f = (target: string, value: string | boolean): VoiceField => ({
  target,
  value,
  label: target,
});
const reasons = (r: {
  refused: Array<{ target: string; refusal: { reason: string } }>;
}) => r.refused.map((x) => `${x.target}:${x.refusal.reason}`);

// ── Каталог ──────────────────────────────────────────────────────────────

check('хуки клиента — ровно каталог сервера SESSION_FIELD_HOOKS', () => {
  const server = Object.fromEntries(
    Object.entries(intent.SESSION_FIELD_HOOKS).map(([k, v]) => [
      k,
      (v as { hook: string }).hook,
    ])
  );
  eq(T, server);
});

check('хуки брифа и сессии не пересекаются', () => {
  const brief = new Set<string>(Object.values(intent.BRIEF_FIELD_HOOKS));
  for (const t of Object.values(T)) if (brief.has(t)) throw new Error(t);
});

check('потолок титров — тот же, что у сервера и у поля', () => {
  eq(CARD_TEXT_MAX, cards.MAX_CARD_TEXT_LENGTH);
  // `services/greeting-api.ts` тянет axios и `import.meta.env` — число
  // читаем текстом, а не импортом.
  const api = readFileSync(
    new URL('../src/services/greeting-api.ts', import.meta.url),
    'utf8'
  );
  eq(Number(/MAX_GREETING_CARD_LENGTH = (\d+)/.exec(api)?.[1]), CARD_TEXT_MAX);
});

check('места наклейки — те же, что у сервера', () => {
  eq([...STICKER_PLACEMENTS], [...sticker.STICKER_PLACEMENTS]);
});

check('toggleOf: булево и его строки, остальное — null', () => {
  eq(
    [true, false, 'true', 'false', 'yes', '1'].map((v) => toggleOf(v)),
    [true, false, true, false, null, null]
  );
});

// ── Сцены ────────────────────────────────────────────────────────────────

const scenes = { sceneCount: 1, maxScenes: 3 };

check('сцены: число в пределах — тот же choose(n)', () => {
  eq(planScenesVoice(scenes, false, [f(T.scenesCount, '3')]), {
    count: 3,
    refused: [],
  });
});

check('сцены: больше maxScenes — отказ с потолком', () => {
  const r = planScenesVoice(scenes, false, [f(T.scenesCount, '4')]);
  eq(r.count, null);
  eq(r.refused[0].refusal, { reason: 'too-many', max: 3 });
});

check('сцены: ровно maxScenes — можно (граница)', () => {
  eq(planScenesVoice(scenes, false, [f(T.scenesCount, '3')]).count, 3);
});

check('сцены: 0, не число, галочка — invalid', () => {
  for (const v of ['0', 'три', '', true, '2.5']) {
    eq(reasons(planScenesVoice(scenes, false, [f(T.scenesCount, v)])), [
      `${T.scenesCount}:invalid`,
    ]);
  }
});

check('сцены: то же число — «уже так», без вызова', () => {
  const r = planScenesVoice(scenes, false, [f(T.scenesCount, '1')]);
  eq([r.count, reasons(r)], [null, [`${T.scenesCount}:already`]]);
});

check('сцены: карточка занята или не загрузилась — отказ', () => {
  eq(reasons(planScenesVoice(scenes, true, [f(T.scenesCount, '2')])), [
    `${T.scenesCount}:busy`,
  ]);
  eq(reasons(planScenesVoice(null, false, [f(T.scenesCount, '2')])), [
    `${T.scenesCount}:not-on-screen`,
  ]);
});

check('сцены: чужие поля не трогает', () => {
  eq(planScenesVoice(scenes, false, [f(T.cardsTitle, 'x')]), {
    count: null,
    refused: [],
  });
});

// ── Титры ────────────────────────────────────────────────────────────────

check('титры: текст с потолком 70, пустая строка — убрать', () => {
  const long = 'а'.repeat(90);
  eq(
    planCardsVoice(true, false, [f(T.cardsTitle, long), f(T.cardsClosing, '')]),
    { refused: [], title: 'а'.repeat(70), closing: '' }
  );
});

check('титры: только одно поле — второе не трогается', () => {
  const r = planCardsVoice(true, false, [f(T.cardsClosing, 'Обнимаю')]);
  eq([r.title, r.closing], [undefined, 'Обнимаю']);
});

check('титры: галочка вместо текста — invalid; занято — busy', () => {
  eq(reasons(planCardsVoice(true, false, [f(T.cardsTitle, true)])), [
    `${T.cardsTitle}:invalid`,
  ]);
  eq(
    reasons(
      planCardsVoice(true, true, [f(T.cardsTitle, 'a'), f(T.cardsClosing, 'b')])
    ),
    [`${T.cardsTitle}:busy`, `${T.cardsClosing}:busy`]
  );
  eq(reasons(planCardsVoice(false, false, [f(T.cardsTitle, 'a')])), [
    `${T.cardsTitle}:not-on-screen`,
  ]);
});

check('титры: голос сохраняет продиктованное + СОХРАНЁННОЕ второе поле', () => {
  // Руками набрано «В конце: недописан…» и не сохранено; голос — «В начале».
  const plan = planCardsVoice(true, false, [f(T.cardsTitle, 'Маме')]);
  eq(cardsVoiceSave(plan, { title: null, closing: 'Обнимаю' }), {
    values: { title: 'Маме', closing: 'Обнимаю' },
    keep: { title: false, closing: true },
  });
  eq(cardsVoiceSave(plan, { title: 'x', closing: null })?.values.closing, '');
});

check('титры: оба поля голосом — оба новые, ничего не держим', () => {
  const plan = planCardsVoice(true, false, [
    f(T.cardsTitle, 'A'),
    f(T.cardsClosing, ''),
  ]);
  eq(cardsVoiceSave(plan, { title: 'old', closing: 'old' }), {
    values: { title: 'A', closing: '' },
    keep: { title: false, closing: false },
  });
});

check('титры: нечего сохранять или карточки нет — null', () => {
  eq(cardsVoiceSave({ refused: [] }, { title: null, closing: null }), null);
  eq(cardsVoiceSave({ refused: [], title: 'A' }, null), null);
});

check('эффект: null — сохранено, строка — не сохранилось с причиной', () => {
  eq(saveEffect(null), { kind: 'saved' });
  eq(saveEffect('Сеть'), { kind: 'failed', reason: 'Сеть' });
  eq(needsSave('Найти'), { kind: 'needs-save', button: 'Найти' });
});

// ── Музыка ───────────────────────────────────────────────────────────────

const music: MusicVoiceState = {
  themes: [
    { id: 'm1', title: 'Вальс' },
    { id: 'm2', title: 'Джаз' },
  ],
  selected: null,
  libraryEnabled: true,
};
function withM1Early(): MusicVoiceState {
  return { ...music, selected: { id: 'm1', source: 'catalog' } };
}
const withM1: MusicVoiceState = {
  ...music,
  selected: { id: 'm1', source: 'catalog' },
};

check('музыка: тема из списка на экране — choose(id)', () => {
  eq(planMusicVoice(music, false, [f(T.musicTheme, 'm2')]), {
    refused: [],
    choose: 'm2',
  });
});

check(
  'музыка: «другую музыку» (D шлёт fill следующей темы) — тот же choose',
  () => {
    eq(planMusicVoice(withM1Early(), false, [f(T.musicTheme, 'm2')]), {
      refused: [],
      choose: 'm2',
    });
  }
);

check('музыка: тема не из списка — отказ, ничего не выбирается', () => {
  const r = planMusicVoice(music, false, [f(T.musicTheme, 'm9')]);
  eq([r.choose, reasons(r)], [undefined, [`${T.musicTheme}:not-on-screen`]]);
});

check('музыка: уже выбранная тема — «уже так»; своя с тем же id — нет', () => {
  eq(reasons(planMusicVoice(withM1, false, [f(T.musicTheme, 'm1')])), [
    `${T.musicTheme}:already`,
  ]);
  const legacy = { ...music, selected: { id: 'm1' } };
  eq(reasons(planMusicVoice(legacy, false, [f(T.musicTheme, 'm1')])), [
    `${T.musicTheme}:already`,
  ]);
  const upload = { ...music, selected: { id: 'm1', source: 'upload' } };
  eq(planMusicVoice(upload, false, [f(T.musicTheme, 'm1')]).choose, 'm1');
});

check('музыка: «выключи» симметрично «включи» — choose(null)', () => {
  eq(planMusicVoice(withM1, false, [f(T.musicEnabled, false)]), {
    refused: [],
    choose: null,
  });
  eq(planMusicVoice(withM1, false, [f(T.musicEnabled, 'false')]).choose, null);
});

check('музыка: «выключи» без музыки — «уже так»', () => {
  const r = planMusicVoice(music, false, [f(T.musicEnabled, false)]);
  eq(['choose' in r, reasons(r)], [false, [`${T.musicEnabled}:already`]]);
});

check('музыка: «включи» без темы — переспрос с перечнем', () => {
  const r = planMusicVoice(music, false, [f(T.musicEnabled, true)]);
  eq(r.refused[0].refusal, { reason: 'ambiguous', options: ['Вальс', 'Джаз'] });
  eq('choose' in r, false);
});

check('музыка: «включи» при выбранной — «уже так»', () => {
  eq(reasons(planMusicVoice(withM1, false, [f(T.musicEnabled, true)])), [
    `${T.musicEnabled}:already`,
  ]);
});

check('музыка: «включи, тему X» — выбор темы без отказа галочки', () => {
  eq(
    planMusicVoice(music, false, [
      f(T.musicEnabled, true),
      f(T.musicTheme, 'm2'),
    ]),
    { refused: [], choose: 'm2' }
  );
});

check('музыка: «без музыки» и тема в одной фразе — спор, ничего', () => {
  const r = planMusicVoice(withM1, false, [
    f(T.musicEnabled, false),
    f(T.musicTheme, 'm2'),
  ]);
  eq('choose' in r, false);
  eq(reasons(r).sort(), [
    `${T.musicEnabled}:conflict`,
    `${T.musicTheme}:conflict`,
  ]);
});

check('музыка: строка поиска — только если поиск на экране', () => {
  eq(planMusicVoice(music, false, [f(T.musicQuery, 'piano')]).query, 'piano');
  const off = { ...music, libraryEnabled: false };
  eq(
    planMusicVoice(off, false, [f(T.musicQuery, 'piano')]).refused[0].refusal,
    {
      reason: 'unavailable',
      why: 'no-search',
    }
  );
  eq(
    planMusicVoice(music, false, [f(T.musicQuery, 'x'.repeat(150))]).query
      ?.length,
    100
  );
  eq(reasons(planMusicVoice(music, false, [f(T.musicQuery, '  ')])), [
    `${T.musicQuery}:invalid`,
  ]);
});

check('музыка: занято — все поля busy', () => {
  eq(
    reasons(
      planMusicVoice(music, true, [f(T.musicTheme, 'm1'), f(T.musicQuery, 'a')])
    ),
    [`${T.musicTheme}:busy`, `${T.musicQuery}:busy`]
  );
});

// ── Наклейка ─────────────────────────────────────────────────────────────

const noSticker: StickerVoiceState = {
  selected: null,
  configured: true,
  allowed: true,
};
const picked: StickerVoiceState = {
  ...noSticker,
  selected: { placement: 'top-left' },
};

check('наклейка: место из списка при выбранной — move', () => {
  eq(planStickerVoice(picked, false, [f(T.stickerPlacement, 'center')]), {
    action: { kind: 'move', placement: 'center' },
    refused: [],
  });
});

check('наклейка: место без наклейки — отказ «сначала выберите»', () => {
  eq(
    planStickerVoice(noSticker, false, [f(T.stickerPlacement, 'center')])
      .refused[0].refusal,
    { reason: 'unavailable', why: 'no-sticker' }
  );
});

check('наклейка: чужое место — отказ; то же место — «уже так»', () => {
  eq(
    reasons(planStickerVoice(picked, false, [f(T.stickerPlacement, 'left')])),
    [`${T.stickerPlacement}:not-on-screen`]
  );
  eq(
    reasons(
      planStickerVoice(picked, false, [f(T.stickerPlacement, 'top-left')])
    ),
    [`${T.stickerPlacement}:already`]
  );
});

check('наклейка: «выключи» снимает — даже там, где новые запрещены', () => {
  eq(
    planStickerVoice({ ...picked, allowed: false }, false, [
      f(T.stickerEnabled, false),
    ]).action,
    { kind: 'clear' }
  );
});

check('наклейка: «выключи» без наклейки — «уже так»', () => {
  const r = planStickerVoice(noSticker, false, [f(T.stickerEnabled, false)]);
  eq([r.action, reasons(r)], [null, [`${T.stickerEnabled}:already`]]);
});

check(
  'наклейка: «включи» — картинку голосом не выбрать; запрет — причина экрана',
  () => {
    eq(
      planStickerVoice(noSticker, false, [f(T.stickerEnabled, true)]).refused[0]
        .refusal,
      { reason: 'manual' }
    );
    eq(
      planStickerVoice({ ...noSticker, allowed: false }, false, [
        f(T.stickerEnabled, true),
      ]).refused[0].refusal,
      { reason: 'unavailable', why: 'sticker-register' }
    );
    eq(reasons(planStickerVoice(picked, false, [f(T.stickerEnabled, true)])), [
      `${T.stickerEnabled}:already`,
    ]);
  }
);

check('наклейка: «выключи» и место в одной фразе — спор, ничего', () => {
  const r = planStickerVoice(picked, false, [
    f(T.stickerEnabled, false),
    f(T.stickerPlacement, 'center'),
  ]);
  eq(r.action, null);
  eq(reasons(r), [
    `${T.stickerEnabled}:conflict`,
    `${T.stickerPlacement}:conflict`,
  ]);
});

check(
  'наклейка: поиск — запрет регистра (строка экрана), не настроен, пусто',
  () => {
    eq(
      planStickerVoice(noSticker, false, [f(T.stickerQuery, 'шар')]).query,
      'шар'
    );
    eq(
      planStickerVoice({ ...noSticker, allowed: false }, false, [
        f(T.stickerQuery, 'шар'),
      ]).refused[0].refusal,
      { reason: 'unavailable', why: 'sticker-register' }
    );
    eq(
      planStickerVoice({ ...noSticker, configured: false }, false, [
        f(T.stickerQuery, 'шар'),
      ]).refused[0].refusal,
      { reason: 'unavailable', why: 'no-search' }
    );
    eq(reasons(planStickerVoice(noSticker, false, [f(T.stickerQuery, '')])), [
      `${T.stickerQuery}:invalid`,
    ]);
  }
);

check('наклейка: карточки нет или занята — отказ', () => {
  eq(reasons(planStickerVoice(null, false, [f(T.stickerEnabled, false)])), [
    `${T.stickerEnabled}:not-on-screen`,
  ]);
  eq(reasons(planStickerVoice(picked, true, [f(T.stickerEnabled, false)])), [
    `${T.stickerEnabled}:busy`,
  ]);
});

// ── Голос отправителя ────────────────────────────────────────────────────

const voices: VoiceChoiceState = {
  presets: [
    { voiceId: 'eve', name: 'Eve' },
    { voiceId: 'rex', name: 'Rex' },
  ],
  clones: [{ voiceId: 'c1', label: 'Мой голос' }],
  presetVoiceId: null,
  cloneVoiceId: null,
};

check('голос: пресет из списка — preset; клон — clone', () => {
  eq(planVoiceChoice(voices, false, [f(T.voicePreset, 'rex')]).action, {
    kind: 'preset',
    voiceId: 'rex',
  });
  eq(planVoiceChoice(voices, false, [f(T.voiceClone, 'c1')]).action, {
    kind: 'clone',
    voiceId: 'c1',
  });
});

check('голос: не из списка — отказ; клон не пресет и наоборот', () => {
  eq(reasons(planVoiceChoice(voices, false, [f(T.voicePreset, 'c1')])), [
    `${T.voicePreset}:not-on-screen`,
  ]);
  eq(reasons(planVoiceChoice(voices, false, [f(T.voiceClone, 'eve')])), [
    `${T.voiceClone}:not-on-screen`,
  ]);
});

check('голос: уже выбранный — «уже так»', () => {
  eq(
    reasons(
      planVoiceChoice({ ...voices, presetVoiceId: 'eve' }, false, [
        f(T.voicePreset, 'eve'),
      ])
    ),
    [`${T.voicePreset}:already`]
  );
});

check(
  'голос: «свой голос выключи» — clear; уже по умолчанию — «уже так»',
  () => {
    eq(
      planVoiceChoice({ ...voices, cloneVoiceId: 'c1' }, false, [
        f(T.voiceCustom, false),
      ]).action,
      { kind: 'clear' }
    );
    eq(
      planVoiceChoice({ ...voices, presetVoiceId: 'eve' }, false, [
        f(T.voiceCustom, false),
      ]).action,
      { kind: 'clear' }
    );
    eq(reasons(planVoiceChoice(voices, false, [f(T.voiceCustom, false)])), [
      `${T.voiceCustom}:already`,
    ]);
  }
);

check('голос: «включи свой» без имени — переспрос с перечнем', () => {
  eq(
    planVoiceChoice(voices, false, [f(T.voiceCustom, true)]).refused[0].refusal,
    { reason: 'ambiguous', options: ['Мой голос', 'Eve', 'Rex'] }
  );
});

check('голос: «включи свой, Rex» — выбор без отказа галочки', () => {
  eq(
    planVoiceChoice(voices, false, [
      f(T.voiceCustom, true),
      f(T.voicePreset, 'rex'),
    ]),
    { action: { kind: 'preset', voiceId: 'rex' }, refused: [] }
  );
});

check('голос: пресет и клон разом, или «по умолчанию» с именем — спор', () => {
  const both = planVoiceChoice(voices, false, [
    f(T.voicePreset, 'eve'),
    f(T.voiceClone, 'c1'),
  ]);
  eq(both.action, null);
  eq(reasons(both), [`${T.voicePreset}:conflict`, `${T.voiceClone}:conflict`]);
  const off = planVoiceChoice({ ...voices, presetVoiceId: 'eve' }, false, [
    f(T.voiceCustom, false),
    f(T.voicePreset, 'rex'),
  ]);
  eq(off.action, null);
  eq(reasons(off), [`${T.voicePreset}:conflict`, `${T.voiceCustom}:conflict`]);
});

check('голос: занято — busy', () => {
  eq(reasons(planVoiceChoice(voices, true, [f(T.voicePreset, 'eve')])), [
    `${T.voicePreset}:busy`,
  ]);
});

// ── Голос Soniox (S2) ──

const withSoniox = {
  ...voices,
  soniox: [
    { voiceId: 'Maya', name: 'Maya' },
    { voiceId: 'Adrian', name: 'Adrian' },
  ],
  sonioxSelected: false,
  sonioxVoiceId: null,
};

check('Soniox: голос из раздела — soniox; не из раздела — отказ', () => {
  eq(planVoiceChoice(withSoniox, false, [f(T.voiceSoniox, 'Maya')]).action, {
    kind: 'soniox',
    voiceId: 'Maya',
  });
  // Имя пресета — не голос Soniox, и наоборот.
  eq(reasons(planVoiceChoice(withSoniox, false, [f(T.voiceSoniox, 'eve')])), [
    `${T.voiceSoniox}:not-on-screen`,
  ]);
  eq(reasons(planVoiceChoice(withSoniox, false, [f(T.voicePreset, 'Maya')])), [
    `${T.voicePreset}:not-on-screen`,
  ]);
  // Раздела нет на экране (ключа Soniox нет) — голос не выбирается.
  eq(reasons(planVoiceChoice(voices, false, [f(T.voiceSoniox, 'Maya')])), [
    `${T.voiceSoniox}:not-on-screen`,
  ]);
  eq(reasons(planVoiceChoice(withSoniox, false, [f(T.voiceSoniox, true)])), [
    `${T.voiceSoniox}:not-on-screen`,
  ]);
});

check(
  'Soniox: уже выбранный — «уже так»; поверх «по умолчанию» — выбор',
  () => {
    const picked = {
      ...withSoniox,
      sonioxSelected: true,
      sonioxVoiceId: 'Maya',
    };
    eq(reasons(planVoiceChoice(picked, false, [f(T.voiceSoniox, 'Maya')])), [
      `${T.voiceSoniox}:already`,
    ]);
    eq(planVoiceChoice(picked, false, [f(T.voiceSoniox, 'Adrian')]).action, {
      kind: 'soniox',
      voiceId: 'Adrian',
    });
    const byDefault = {
      ...withSoniox,
      sonioxSelected: true,
      sonioxVoiceId: null,
    };
    eq(planVoiceChoice(byDefault, false, [f(T.voiceSoniox, 'Maya')]).action, {
      kind: 'soniox',
      voiceId: 'Maya',
    });
    // id выбранного без флага выбора — не «уже» (флаг решает).
    eq(
      planVoiceChoice({ ...withSoniox, sonioxVoiceId: 'Maya' }, false, [
        f(T.voiceSoniox, 'Maya'),
      ]).action,
      { kind: 'soniox', voiceId: 'Maya' }
    );
  }
);

check('Soniox: с пресетом или клоном разом, с «выключи свой» — спор', () => {
  const two = planVoiceChoice(withSoniox, false, [
    f(T.voiceSoniox, 'Maya'),
    f(T.voiceClone, 'c1'),
  ]);
  eq(two.action, null);
  eq(reasons(two), [`${T.voiceClone}:conflict`, `${T.voiceSoniox}:conflict`]);
  const three = planVoiceChoice(withSoniox, false, [
    f(T.voicePreset, 'eve'),
    f(T.voiceSoniox, 'Maya'),
  ]);
  eq(reasons(three), [
    `${T.voicePreset}:conflict`,
    `${T.voiceSoniox}:conflict`,
  ]);
  const off = planVoiceChoice(withSoniox, false, [
    f(T.voiceCustom, false),
    f(T.voiceSoniox, 'Maya'),
  ]);
  eq(off.action, null);
  eq(reasons(off), [`${T.voiceSoniox}:conflict`, `${T.voiceCustom}:conflict`]);
});

check('Soniox: «выключи свой» при Soniox (и по умолчанию) — clear', () => {
  for (const id of ['Maya', null]) {
    eq(
      planVoiceChoice(
        { ...withSoniox, sonioxSelected: true, sonioxVoiceId: id },
        false,
        [f(T.voiceCustom, false)]
      ).action,
      { kind: 'clear' }
    );
  }
  eq(reasons(planVoiceChoice(withSoniox, false, [f(T.voiceCustom, false)])), [
    `${T.voiceCustom}:already`,
  ]);
});

check(
  'Soniox: «включи свой» — перечень с голосами Soniox; при Soniox — «уже»',
  () => {
    eq(
      planVoiceChoice(withSoniox, false, [f(T.voiceCustom, true)]).refused[0]
        .refusal,
      {
        reason: 'ambiguous',
        options: ['Мой голос', 'Eve', 'Rex', 'Maya', 'Adrian'],
      }
    );
    eq(
      reasons(
        planVoiceChoice(
          { ...withSoniox, sonioxSelected: true, sonioxVoiceId: null },
          false,
          [f(T.voiceCustom, true)]
        )
      ),
      [`${T.voiceCustom}:already`]
    );
    eq(
      planVoiceChoice(withSoniox, false, [
        f(T.voiceCustom, true),
        f(T.voiceSoniox, 'Adrian'),
      ]),
      { action: { kind: 'soniox', voiceId: 'Adrian' }, refused: [] }
    );
  }
);

check('Soniox: занято — busy и для раздела Soniox', () => {
  eq(reasons(planVoiceChoice(withSoniox, true, [f(T.voiceSoniox, 'Maya')])), [
    `${T.voiceSoniox}:busy`,
  ]);
});

// ── Сценарий ─────────────────────────────────────────────────────────────

check('сценарий: полный текст с потолком 2000', () => {
  eq(planScriptVoice(true, false, [f(T.scriptText, 'Привет')]), {
    text: 'Привет',
    refused: [],
  });
  eq(
    planScriptVoice(true, false, [f(T.scriptText, 'я'.repeat(2100))]).text
      ?.length,
    2000
  );
});

check(
  'сценарий: нет сценария — причина экрана; пересборка — busy; пусто',
  () => {
    eq(
      planScriptVoice(false, false, [f(T.scriptText, 'x')]).refused[0].refusal,
      {
        reason: 'unavailable',
        why: 'no-script',
      }
    );
    eq(reasons(planScriptVoice(true, true, [f(T.scriptText, 'x')])), [
      `${T.scriptText}:busy`,
    ]);
    eq(reasons(planScriptVoice(true, false, [f(T.scriptText, ' ')])), [
      `${T.scriptText}:invalid`,
    ]);
  }
);

// ── Кадры ────────────────────────────────────────────────────────────────

check('кадр: одна открытая форма — подпись (≤80) и описание', () => {
  eq(
    planReferenceVoice('one', false, [
      f(T.referenceLabel, 'б'.repeat(100)),
      f(T.referenceDescription, 'у моря'),
    ]),
    { refused: [], label: 'б'.repeat(80), description: 'у моря' }
  );
});

check('кадр: пустая подпись — invalid; пустое описание — можно стереть', () => {
  const r = planReferenceVoice('one', false, [
    f(T.referenceLabel, ' '),
    f(T.referenceDescription, ''),
  ]);
  eq([reasons(r), r.description], [[`${T.referenceLabel}:invalid`], '']);
});

check('кадр: форма закрыта, две формы, правки заперты — своя причина', () => {
  const why = (s: 'none' | 'two' | 'locked') =>
    (
      planReferenceVoice(s, false, [f(T.referenceLabel, 'x')]).refused[0]
        .refusal as { why: string }
    ).why;
  eq(
    [why('none'), why('two'), why('locked')],
    ['form-closed', 'two-forms', 'references-locked']
  );
});

// ── Строки ───────────────────────────────────────────────────────────────

const vf = ru.voiceFields;
const texts: SessionVoiceTexts = {
  refusedField: ru.voiceAssistant.refusedField,
  invalid: vf.invalid,
  notOnScreen: vf.notOnScreen,
  busy: vf.busy,
  tooMany: vf.tooMany,
  ambiguous: vf.ambiguous,
  ambiguousNone: vf.ambiguousNone,
  manual: vf.manual,
  conflict: vf.conflict,
  already: vf.already,
  unavailable: {
    'sticker-register': ru.greetingVideoWizard.stickerUnavailable,
    'no-search': vf.noSearch,
    'no-sticker': vf.noSticker,
    'no-script': ru.greetingVideoWizard.scriptEmpty,
    'references-locked': ru.greetingVideoWizard.referencesLockedHint,
    'form-closed': vf.formClosed,
    'two-forms': vf.twoForms,
  },
};

check('строка отказа: подпись поля и причина, без двойной точки', () => {
  const lines = refusalLines(
    [
      { target: T.scenesCount, refusal: { reason: 'too-many', max: 3 } },
      {
        target: T.scriptText,
        refusal: { reason: 'unavailable', why: 'no-script' },
      },
    ],
    [
      { target: T.scenesCount, value: '5', label: 'Сцены' },
      { target: T.scriptText, value: 'x', label: 'Текст' },
    ],
    texts
  );
  eq(lines, [
    'Не применил «Сцены»: сцен можно не больше 3.',
    'Не применил «Текст»: Сценарий ещё не собран.',
  ]);
});

check('строка отказа: перечень вариантов или «выберите руками»', () => {
  eq(
    refusalReason({ reason: 'ambiguous', options: ['Вальс', 'Джаз'] }, texts),
    'назовите, какой именно: Вальс, Джаз'
  );
  eq(
    refusalReason({ reason: 'ambiguous', options: [] }, texts),
    vf.ambiguousNone
  );
});

check(
  'строка отказа: наклейка под запретом — та же строка, что на экране',
  () => {
    eq(
      refusalReason({ reason: 'unavailable', why: 'sticker-register' }, texts),
      ru.greetingVideoWizard.stickerUnavailable
    );
  }
);

console.log(
  `\n${passed} проверок пройдено${failed ? `, ${failed} упало` : ''}`
);
if (failed) process.exit(1);
