// Plain assertions runnable with `npx tsx scripts/persona-greeting.test.ts`.
//
// «Я в кадре» в поздравлении и в личном бренд-буке (ТЗ Greeting 2.0 §4.7,
// §4.8, §4.9): что показывает клиент и что уходит на сервер.

import {
  type PersonaState,
  type PersonaLookLite,
  AI_PRESENTER_KEY,
  CARD_STYLE_COLORS,
  CARD_STYLE_COLOR_HEX,
  CARD_STYLE_FONTS,
  DEFAULT_CARD_STYLE,
  canCreateManifest,
  defaultLookOption,
  manifestsForProjectType,
  personaStateFromLoad,
  scenePhotoTextOnly,
  presenterOptionLabel,
  defaultCreateKind,
  hasVerifiedPersona,
  hedraSketchConflict,
  lookReady,
  normalizeCardStyle,
  parsePresenterKey,
  personalManifestPatch,
  presenterBlockMode,
  presenterFromBrief,
  presenterKey,
  presenterOptions,
  readyLooks,
  referenceFaceState,
  sharedVideoRequestExtra,
  shouldSendPresenter,
  showKindSwitch,
  snapshotUsesPersona,
  withPresenterBody,
} from '../src/lib/persona-greeting';
import { sessionBriefPatch } from '../src/lib/greeting-brief-diff';
import * as backendCardsNs from '../../backend/src/common/greeting-cards';

// Бэкенд — CommonJS: tsx отдаёт его как `default` (см. greeting-policy.test.ts).
function interop<T extends object>(ns: T): T {
  return (ns as { default?: T }).default ?? ns;
}
const backendCards = interop(backendCardsNs);

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

const look = (over: Partial<PersonaLookLite> = {}): PersonaLookLite => ({
  id: 'l1',
  label: 'Деловой',
  isBase: false,
  preset: null,
  status: 'ready',
  photoUrl: 'https://x/p.png',
  sketchUrl: null,
  ...over,
});
const ready = (looks: PersonaLookLite[], verified = true): PersonaState => ({
  kind: 'ready',
  me: { persona: { id: 'p1', verified }, looks },
});
const AI = { kind: 'ai' } as const;

console.log('── состояние персоны');

check('образ годен только готовым и с портретом', () => {
  eq(lookReady(look()), true);
  eq(lookReady(look({ status: 'pending' })), false);
  eq(lookReady(look({ status: 'failed' })), false);
  eq(lookReady(look({ photoUrl: null })), false);
});

check('проверенная персона — только ready + verified', () => {
  eq(hasVerifiedPersona(ready([])), true);
  eq(hasVerifiedPersona(ready([], false)), false);
  eq(
    hasVerifiedPersona({ kind: 'ready', me: { persona: null, looks: [] } }),
    false
  );
  eq(hasVerifiedPersona({ kind: 'disabled' }), false);
  eq(hasVerifiedPersona({ kind: 'loading' }), false);
  eq(hasVerifiedPersona({ kind: 'error' }), false);
});

check('готовые образы — базовый первым, у непроверенной — ничего', () => {
  const s = ready([
    look({ id: 'a' }),
    look({ id: 'b', isBase: true }),
    look({ id: 'c', status: 'pending' }),
  ]);
  eq(
    readyLooks(s).map((l) => l.id),
    ['b', 'a']
  );
  eq(readyLooks(ready([look()], false)), []);
});

console.log('── «Кто в кадре»');

check('ключ ведущего туда-обратно', () => {
  eq(presenterKey(AI), AI_PRESENTER_KEY);
  const p = { kind: 'persona', lookId: 'l1', variant: 'sketch' } as const;
  eq(parsePresenterKey(presenterKey(p)), p);
  eq(parsePresenterKey(presenterKey(AI)), AI);
});

check('испорченный ключ — null, а не «ИИ» молча', () => {
  eq(parsePresenterKey('video:l1'), null);
  eq(parsePresenterKey('photo:'), null);
  eq(parsePresenterKey('garbage'), null);
});

check(
  'ведущий из брифа: объект сервера, мусор — ИИ, неизвестный вариант — фото',
  () => {
    eq(presenterFromBrief({}), AI);
    eq(presenterFromBrief({ presenter: null }), AI);
    eq(presenterFromBrief({ presenter: { kind: 'ai' } }), AI);
    eq(presenterFromBrief({ presenter: { kind: 'persona' } }), AI);
    eq(presenterFromBrief({ presenter: { kind: 'persona', lookId: '' } }), AI);
    eq(
      presenterFromBrief({
        presenter: { kind: 'persona', lookId: 'l1', variant: 'sketch' },
      }),
      { kind: 'persona', lookId: 'l1', variant: 'sketch' }
    );
    eq(
      presenterFromBrief({
        presenter: { kind: 'persona', lookId: 'l1', variant: 'weird' },
      }),
      { kind: 'persona', lookId: 'l1', variant: 'photo' }
    );
  }
);

check(
  'блок: выключено — спрятан, нет персоны — «Создать себя», есть — выбор',
  () => {
    eq(presenterBlockMode({ kind: 'disabled' }, AI), 'hidden');
    eq(presenterBlockMode({ kind: 'loading' }, AI), 'hidden');
    eq(presenterBlockMode({ kind: 'error' }, AI), 'hidden');
    eq(
      presenterBlockMode(
        { kind: 'ready', me: { persona: null, looks: [] } },
        AI
      ),
      'create'
    );
    // Персона есть, но не проверена или получила отказ (надгробие «младше
    // 18») — «Создать себя» не предлагаем: вторую создать нельзя.
    eq(presenterBlockMode(ready([], false), AI), 'hidden');
    eq(presenterBlockMode(ready([look()]), AI), 'choose');
  }
);

check('блок: в брифе уже «я» — выбор виден даже при выключенном режиме', () => {
  const me = { kind: 'persona', lookId: 'l1', variant: 'photo' } as const;
  eq(presenterBlockMode({ kind: 'disabled' }, me), 'choose');
});

check('варианты: ИИ, образ-фото, скетч — только если он есть', () => {
  const opts = presenterOptions(
    ready([look({ id: 'a' }), look({ id: 'b', sketchUrl: 'https://x/s.png' })]),
    AI
  );
  eq(
    opts.map((o) => o.key),
    ['ai', 'photo:a', 'photo:b', 'sketch:b']
  );
  eq(opts[3].thumbUrl, 'https://x/s.png');
  eq(opts[1].thumbUrl, 'https://x/p.png');
});

check('варианты: удалённый образ из брифа остаётся с пометкой missing', () => {
  const cur = { kind: 'persona', lookId: 'gone', variant: 'photo' } as const;
  const opts = presenterOptions(ready([look()]), cur);
  const last = opts[opts.length - 1];
  eq(
    [last.key, last.missing, last.pending, last.thumbUrl],
    ['photo:gone', true, false, null]
  );
  eq(opts.filter((o) => o.missing).length, 1);
});

check(
  'варианты: пока персона грузится или упала — не «удалён», а pending',
  () => {
    const cur = { kind: 'persona', lookId: 'l1', variant: 'sketch' } as const;
    for (const st of [
      { kind: 'loading' },
      { kind: 'error' },
      { kind: 'disabled' },
    ] as const) {
      const last = presenterOptions(st, cur).pop()!;
      eq([last.key, last.missing, last.pending], ['sketch:l1', false, true]);
    }
  }
);

check('варианты: без персоны — только ИИ', () => {
  eq(
    presenterOptions({ kind: 'disabled' }, AI).map((o) => o.key),
    ['ai']
  );
});

check(
  'Hedra + скетч — предупреждение, Hedra + фото и Grok + скетч — нет',
  () => {
    const sk = { kind: 'persona', lookId: 'l', variant: 'sketch' } as const;
    const ph = { kind: 'persona', lookId: 'l', variant: 'photo' } as const;
    eq(hedraSketchConflict('hedra', sk), true);
    eq(hedraSketchConflict('hedra', ph), false);
    eq(hedraSketchConflict('grok', sk), false);
    eq(hedraSketchConflict('hedra', AI), false);
  }
);

check(
  'слать presenter: персона есть — всегда; нет — только если «я» было или стало',
  () => {
    const me = { kind: 'persona', lookId: 'l', variant: 'photo' } as const;
    eq(shouldSendPresenter(ready([]), AI, AI), true);
    eq(shouldSendPresenter({ kind: 'disabled' }, AI, AI), false);
    eq(shouldSendPresenter({ kind: 'disabled' }, me, AI), true);
    eq(shouldSendPresenter({ kind: 'error' }, AI, me), true);
  }
);

check(
  'тело брифа: ключ → объект; не слать — поля нет; мусор — поля нет',
  () => {
    const body = { recipientName: 'Марина', presenter: 'sketch:l1' };
    eq(withPresenterBody(body, true), {
      recipientName: 'Марина',
      presenter: { kind: 'persona', lookId: 'l1', variant: 'sketch' },
    });
    eq(withPresenterBody(body, false), { recipientName: 'Марина' });
    eq(withPresenterBody({ presenter: 'nope' }, true), {});
    eq(withPresenterBody({ presenter: 'ai' }, true), {
      presenter: { kind: 'ai' },
    });
  }
);

check('после старта сессии presenter уходит только изменённым', () => {
  const base = { recipientName: 'Марина', presenter: 'ai' };
  eq(withPresenterBody(sessionBriefPatch(base, { ...base }), true), {});
  eq(
    withPresenterBody(
      sessionBriefPatch(base, { ...base, presenter: 'photo:l1' }),
      true
    ),
    { presenter: { kind: 'persona', lookId: 'l1', variant: 'photo' } }
  );
});

console.log('── лица в референсах');

check(
  'лицо: решает needsFaceConsent; hasFace различает «найдено» и «не проверено»',
  () => {
    const at = '2026-09-30T00:00:00Z';
    // Режим выключен или старый ответ: сервер согласия не требует.
    eq(referenceFaceState({ variant: 'original' }), 'none');
    eq(referenceFaceState({ hasFace: null, variant: 'original' }), 'none');
    eq(
      referenceFaceState({
        hasFace: true,
        needsFaceConsent: false,
        variant: 'original',
      }),
      'none'
    );
    // Лица нет — говорить не о чем, даже если флаг вдруг пришёл.
    eq(
      referenceFaceState({
        hasFace: false,
        needsFaceConsent: true,
        variant: 'original',
      }),
      'none'
    );
    // Лицо найдено, согласия нет.
    eq(
      referenceFaceState({
        hasFace: true,
        needsFaceConsent: true,
        variant: 'original',
      }),
      'needs-consent'
    );
    // Fail-closed: проверки не было (старый референс, сбой) — «не проверено».
    eq(
      referenceFaceState({
        hasFace: null,
        needsFaceConsent: true,
        variant: 'original',
      }),
      'unchecked'
    );
    eq(
      referenceFaceState({ needsFaceConsent: true, variant: 'original' }),
      'unchecked'
    );
    // После согласия сервер снимает флаг — строка «подтверждено» остаётся.
    eq(
      referenceFaceState({
        hasFace: true,
        needsFaceConsent: false,
        faceConsentAt: at,
        variant: 'original',
      }),
      'consented'
    );
    eq(
      referenceFaceState({
        hasFace: null,
        needsFaceConsent: false,
        faceConsentAt: at,
        variant: 'original',
      }),
      'consented'
    );
    // Скетч заменил найденное лицо.
    eq(
      referenceFaceState({
        hasFace: true,
        needsFaceConsent: false,
        variant: 'sketch',
      }),
      'sketched'
    );
    eq(
      referenceFaceState({
        hasFace: null,
        needsFaceConsent: false,
        variant: 'sketch',
      }),
      'none'
    );
  }
);

check('подпись варианта: ИИ, удалён, pending, образ через labelOf', () => {
  const t = {
    ai: 'ИИ',
    missing: 'удалён',
    pending: 'выбранный',
    photo: 'Я — образ «{label}»',
    sketch: 'Я — скетч «{label}»',
  };
  const labelOf = (l: PersonaLookLite) =>
    l.label.trim() || (l.isBase ? 'Базовый' : 'Без названия');
  const s = ready([
    look({ id: 'a', label: '', isBase: true, sketchUrl: 'https://x/s.png' }),
  ]);
  const opts = presenterOptions(s, AI).map((o) =>
    presenterOptionLabel(o, t, labelOf)
  );
  eq(opts, ['ИИ', 'Я — образ «Базовый»', 'Я — скетч «Базовый»']);
  const gone = presenterOptions(s, {
    kind: 'persona',
    lookId: 'x',
    variant: 'photo',
  }).pop()!;
  eq(presenterOptionLabel(gone, t, labelOf), 'удалён');
  const wait = presenterOptions(
    { kind: 'loading' },
    { kind: 'persona', lookId: 'x', variant: 'photo' }
  ).pop()!;
  eq(presenterOptionLabel(wait, t, labelOf), 'выбранный');
});

check(
  'состояние из общего кеша FE1: гость и сбой — error, остальное как есть',
  () => {
    eq(personaStateFromLoad({ kind: 'loading' }), { kind: 'loading' });
    eq(personaStateFromLoad({ kind: 'disabled' }), { kind: 'disabled' });
    eq(personaStateFromLoad({ kind: 'guest' }), { kind: 'error' });
    eq(personaStateFromLoad({ kind: 'error' }), { kind: 'error' });
    const me = { persona: null, looks: [] };
    eq(personaStateFromLoad({ kind: 'ready', me }), { kind: 'ready', me });
  }
);

console.log('── личный бренд-бук');

check(
  'cardStyle: мусор — null, знаком хоть один ключ — второй по умолчанию',
  () => {
    eq(normalizeCardStyle(null), null);
    eq(normalizeCardStyle('x'), null);
    eq(normalizeCardStyle([1]), null);
    eq(normalizeCardStyle({}), null);
    eq(normalizeCardStyle({ font: 'Comic Sans', color: '#123456' }), null);
    eq(normalizeCardStyle({ font: 'serif', color: 'gold' }), {
      font: 'serif',
      color: 'gold',
    });
    eq(normalizeCardStyle({ font: 'mono' }), { font: 'mono', color: 'white' });
    eq(normalizeCardStyle({ color: 'pink' }), { font: 'sans', color: 'pink' });
  }
);

check('синхронизация с сервером: белые списки и нормализация карточек', () => {
  eq([...CARD_STYLE_FONTS].sort(), [...backendCards.CARD_FONT_KEYS].sort());
  eq(CARD_STYLE_COLOR_HEX, backendCards.CARD_COLORS);
  const samples: unknown[] = [
    null,
    'x',
    [],
    {},
    { font: 'serif' },
    { color: 'mint' },
    { font: 'condensed', color: 'sky' },
    { font: 'Comic Sans', color: 'gold' },
    { font: 'mono', color: '#FFFFFF' },
    { font: 1, color: true },
  ];
  for (const raw of samples) {
    eq(normalizeCardStyle(raw), backendCards.normalizeCardStyle(raw));
  }
});

check('белый список карточек непуст, умолчание в нём', () => {
  eq(CARD_STYLE_FONTS.includes(DEFAULT_CARD_STYLE.font), true);
  eq(
    (CARD_STYLE_COLORS as readonly string[]).includes(DEFAULT_CARD_STYLE.color),
    true
  );
  eq(new Set(CARD_STYLE_COLORS).size, CARD_STYLE_COLORS.length);
});

check(
  'переключатель вида: только у проверенной персоны или у уже личного',
  () => {
    eq(showKindSwitch(ready([]), 'COMPANY'), true);
    eq(showKindSwitch({ kind: 'disabled' }, 'COMPANY'), false);
    eq(showKindSwitch(ready([], false), 'COMPANY'), false);
    eq(showKindSwitch({ kind: 'disabled' }, 'PERSONAL'), true);
  }
);

check('создание: личный — только с персоной, корпоративный — по режиму', () => {
  eq(canCreateManifest('PERSONAL', false, ready([])), true);
  eq(canCreateManifest('PERSONAL', true, { kind: 'disabled' }), false);
  eq(canCreateManifest('COMPANY', false, ready([])), false);
  eq(canCreateManifest('COMPANY', true, { kind: 'disabled' }), true);
});

check('вид по умолчанию: LITE с персоной — личный, иначе компания', () => {
  eq(defaultCreateKind(false, ready([])), 'PERSONAL');
  eq(defaultCreateKind(true, ready([])), 'COMPANY');
  eq(defaultCreateKind(false, { kind: 'disabled' }), 'COMPANY');
});

check(
  'PATCH личного: пустое → null, подпись обрезана; компания — всё null',
  () => {
    const f = {
      defaultLookId: '',
      signature: '  Аня  ',
      defaultTone: 'WARM',
      cardStyle: { font: 'mono', color: 'white' } as const,
    };
    eq(personalManifestPatch('PERSONAL', f), {
      kind: 'PERSONAL',
      defaultLookId: null,
      signature: 'Аня',
      defaultTone: 'WARM',
      cardStyle: { font: 'mono', color: 'white' },
    });
    eq(personalManifestPatch('COMPANY', f), {
      kind: 'COMPANY',
      defaultLookId: null,
      signature: null,
      defaultTone: null,
      cardStyle: null,
    });
    eq(
      personalManifestPatch('PERSONAL', { ...f, signature: 'я'.repeat(200) })
        .signature!.length,
      120
    );
  }
);

check(
  'образ по умолчанию: нет / есть / удалён / pending пока не загружено',
  () => {
    const s = ready([look({ id: 'a' }), look({ id: 'p', status: 'pending' })]);
    eq(defaultLookOption('', s), 'none');
    eq(defaultLookOption('a', s), 'present');
    eq(defaultLookOption('p', s), 'missing');
    eq(defaultLookOption('gone', s), 'missing');
    eq(defaultLookOption('a', { kind: 'loading' }), 'pending');
    eq(defaultLookOption('a', { kind: 'error' }), 'pending');
  }
);

check(
  'личный бренд-бук — только поздравлению; уже привязанный остаётся',
  () => {
    const list = [
      { id: 'c', kind: 'COMPANY' as const },
      { id: 'p', kind: 'PERSONAL' as const },
      { id: 'o' },
    ];
    eq(
      manifestsForProjectType(list, 'GREETING_VIDEO').map((m) => m.id),
      ['c', 'p', 'o']
    );
    eq(
      manifestsForProjectType(list, 'SINGLE').map((m) => m.id),
      ['c', 'o']
    );
    eq(
      manifestsForProjectType(list, 'LINE', null).map((m) => m.id),
      ['c', 'o']
    );
    eq(
      manifestsForProjectType(list, 'SINGLE', 'p').map((m) => m.id),
      ['c', 'p', 'o']
    );
  }
);

check('флаг выключен, а персона есть (200, enabled:false) — disabled', () => {
  const me = { persona: { id: 'p', verified: true }, looks: [look()] };
  eq(personaStateFromLoad({ kind: 'ready', me: { ...me, enabled: false } }), {
    kind: 'disabled',
  });
  const on = { ...me, enabled: true };
  eq(personaStateFromLoad({ kind: 'ready', me: on }), {
    kind: 'ready',
    me: on,
  });
  // Итог для брифа и бренд-бука: ни образов, ни личного бренд-бука.
  const off = personaStateFromLoad({
    kind: 'ready',
    me: { ...me, enabled: false },
  });
  eq(presenterBlockMode(off, AI), 'hidden');
  eq(canCreateManifest('PERSONAL', false, off), false);
});

check('сбой проверки лица — «не проверено», а не «лицо найдено»', () => {
  eq(
    referenceFaceState({
      hasFace: true,
      faceCheckUnavailable: true,
      needsFaceConsent: true,
      variant: 'original',
    }),
    'unchecked'
  );
  eq(
    referenceFaceState({
      hasFace: true,
      faceCheckUnavailable: false,
      needsFaceConsent: true,
      variant: 'original',
    }),
    'needs-consent'
  );
});

check(
  'сцена бренд-бука: заметка «только словами» — только при явном false',
  () => {
    const on = ready([]);
    const a = {
      photoUrl: 'https://x/s.png',
      photoVariant: 'original' as const,
    };
    eq(scenePhotoTextOnly({ ...a, photoFaceChecked: false }, on), true);
    eq(scenePhotoTextOnly({ ...a, photoFaceChecked: true }, on), false);
    eq(scenePhotoTextOnly(a, on), false);
    eq(
      scenePhotoTextOnly(
        { ...a, photoFaceChecked: false, photoVariant: 'sketch' },
        on
      ),
      false
    );
    eq(
      scenePhotoTextOnly({ photoUrl: null, photoFaceChecked: false }, on),
      false
    );
    for (const st of [
      { kind: 'disabled' },
      { kind: 'loading' },
      { kind: 'error' },
    ] as const) {
      eq(scenePhotoTextOnly({ ...a, photoFaceChecked: false }, st), false);
    }
  }
);

console.log('── витрина');

check('usesPersona: только строгое true в снимке', () => {
  eq(snapshotUsesPersona({ usesPersona: true }), true);
  eq(snapshotUsesPersona({ usesPersona: 'true' }), false);
  eq(snapshotUsesPersona({}), false);
  eq(snapshotUsesPersona(null), false);
  eq(snapshotUsesPersona(undefined), false);
});

check('галочка витрины уходит только у ролика с персоной', () => {
  eq(sharedVideoRequestExtra(true, false), { allowShowcaseWithPersona: false });
  eq(sharedVideoRequestExtra(true, true), { allowShowcaseWithPersona: true });
  eq(sharedVideoRequestExtra(false, true), {});
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
