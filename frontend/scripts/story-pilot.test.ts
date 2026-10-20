/**
 * Story‑Tales, проход 3 (пакет FE): вход по `GET /story-gifts/access`,
 * цена в кредитах, 402, публикация по ссылке с текстом ТЗ §11.3, срок
 * хранения и подсказки валидатора на языке интерфейса. Моки — по
 * контракту брифа ST3. Плюс замки проводки в исходниках компонентов
 * (браузерную проверку 320/360 px и тем делает Playwright отдельно).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ru from '../src/dictionaries/ru.json';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import de from '../src/dictionaries/de.json';
import es from '../src/dictionaries/es.json';
import {
  STORY_RULES_SLUG,
  STORY_SCENARIO_MAX,
  STORY_SHARE_BODY,
  fill,
  formatChargeUsd,
  formatStoryDate,
  parseStoryAccess,
  parseStoryShare,
  plural,
  storyAccessView,
  storyApplyBody,
  storyCanShare,
  storyChargeConfirm,
  storyChargeLine,
  storyChargeNeedsConfirm,
  storyChargeOf,
  storyChargeParagraphs,
  storyCode,
  storyCreditsRequired,
  storyCreditsRequiredText,
  storyNavVisible,
  storyPromiseText,
  storyRetentionWarning,
  storyScenario,
  storyNarratorConsentRequired,
  storyShareBody,
  storyShareConfirm,
  storyShareKnown,
  storySharedUntil,
  storySharingEnabled,
  storyTermsBody,
  storyUnshareConfirm,
  type StoryTalesStrings,
} from '../src/features/stories/story-pilot';
import { storyLoadFailure } from '../src/features/stories/story-errors';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}
function like(value: string, re: RegExp, label = '') {
  assert.ok(
    re.test(value),
    `${label} ${JSON.stringify(value.slice(0, 200))} !~ ${re}`
  );
}
function unlike(value: string, re: RegExp, label = '') {
  assert.ok(!re.test(value), `${label}: найдено ${re}`);
}
const src = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

const T: Record<string, StoryTalesStrings> = {
  ru: ru.storyTales,
  uk: uk.storyTales as StoryTalesStrings,
  en: en.storyTales as StoryTalesStrings,
  de: de.storyTales as StoryTalesStrings,
  es: es.storyTales as StoryTalesStrings,
};
const t = T.ru;

const base = {
  freeGiftAvailable: false,
  termsVersion: 'story-rules-2026-10-20',
};

console.log('story-pilot');

// ── 1. Доступ ─────────────────────────────────────────────────────────
it('режим владельца: не-владельцу «закрыто», вкладки нет', () => {
  const a = parseStoryAccess({
    mode: 'owner',
    allowed: false,
    reason: 'closed',
    ...base,
  });
  assert.equal(storyAccessView(a), 'closed');
  assert.equal(storyNavVisible(storyAccessView(a)), false);
});
it('мусор и неизвестный режим — закрыто, а не открыто', () => {
  for (const raw of [null, 'x', {}, { mode: 'beta', allowed: true }])
    assert.equal(storyAccessView(parseStoryAccess(raw)), 'closed');
});
it('allowed — мастер (владелец, участник, пользователь public)', () => {
  for (const [mode, role] of [
    ['owner', 'owner'],
    ['pilot', 'member'],
    ['public', 'user'],
  ])
    assert.equal(
      storyAccessView(parseStoryAccess({ mode, role, allowed: true, ...base })),
      'allowed'
    );
});
it('пилот: не приглашён → заявка; мест 0 → «мест нет»', () => {
  const a = parseStoryAccess({
    mode: 'pilot',
    allowed: false,
    role: 'user',
    reason: 'not_invited',
    seatsLeft: 3,
    ...base,
  });
  assert.equal(storyAccessView(a), 'apply');
  assert.equal(a.seatsLeft, 3);
  assert.equal(storyNavVisible('apply'), true);
  assert.equal(storyAccessView({ ...a, seatsLeft: 0 }), 'full');
});
it('пилот: заявка ждёт / отклонена — статус, не форма', () => {
  const pending = parseStoryAccess({
    mode: 'pilot',
    allowed: false,
    reason: 'application_pending',
    application: { status: 'pending', createdAt: '2026-10-20T10:00:00Z' },
    ...base,
  });
  assert.equal(storyAccessView(pending), 'pending');
  assert.equal(pending.application?.createdAt, '2026-10-20T10:00:00Z');
  const rejected = parseStoryAccess({
    mode: 'pilot',
    allowed: false,
    reason: 'not_invited',
    application: { status: 'rejected', createdAt: '2026-10-19T10:00:00Z' },
    ...base,
  });
  assert.equal(storyAccessView(rejected), 'rejected');
});
it('правила 18+ — экран принятия (pilot и public)', () => {
  for (const mode of ['pilot', 'public'])
    assert.equal(
      storyAccessView(
        parseStoryAccess({
          mode,
          allowed: false,
          role: mode === 'pilot' ? 'member' : 'user',
          reason: 'terms_required',
          ...base,
        })
      ),
      'terms'
    );
});
it('public без причины «terms» и not_invited вне пилота — закрыто', () => {
  assert.equal(
    storyAccessView(
      parseStoryAccess({
        mode: 'public',
        allowed: false,
        reason: 'not_invited',
        ...base,
      })
    ),
    'closed'
  );
});
it('ST2-U-13 сохранён: сбой загрузки — ошибка, 404/401/403 — закрыто', () => {
  assert.equal(storyLoadFailure({ response: { status: 500 } }), 'error');
  assert.equal(storyLoadFailure({ isAxiosError: true }), 'error');
  for (const status of [401, 403, 404])
    assert.equal(storyLoadFailure({ response: { status } }), 'closed');
});

// ── 1. Заявка и правила ───────────────────────────────────────────────
it('сценарий заявки: необязателен, ≤500, пробелы схлопнуты', () => {
  assert.deepEqual(storyApplyBody('   '), {});
  assert.deepEqual(storyApplyBody('  на ночь \n в командировке '), {
    scenario: 'на ночь в командировке',
  });
  assert.equal(storyScenario('a'.repeat(500), t).error, null);
  assert.equal(
    storyScenario('a'.repeat(501), t).error,
    'Не больше 500 символов.'
  );
  assert.equal(STORY_SCENARIO_MAX, 500);
  assert.equal(
    storyApplyBody('b'.repeat(600)).scenario?.length,
    STORY_SCENARIO_MAX
  );
});
it('подсказка заявки — без детских имён и просит их не писать', () => {
  for (const [loc, d] of Object.entries(T)) {
    assert.ok(d.access.scenarioHint.length > 20, loc);
    // Пример не содержит имени: только повод и обстоятельства.
    unlike(
      d.access.scenarioPlaceholder,
      /\b(Маш|Саш|Петр|Олен|Emma|Anna|Max|Lukas)/u
    );
  }
  like(ru.storyTales.access.scenarioHint, /имя, возраст/);
  like(en.storyTales.access.scenarioHint, /name, age/);
});
it('правила: тело только при 18+ И согласии; версия из ответа сервера', () => {
  const v = 'story-rules-2026-10-20';
  assert.equal(storyTermsBody(v, true, false), null);
  assert.equal(storyTermsBody(v, false, true), null);
  assert.equal(storyTermsBody('', true, true), null);
  assert.deepEqual(storyTermsBody(v, true, true), {
    termsVersion: v,
    adult: true,
  });
  assert.equal(STORY_RULES_SLUG, 'story-tales-rules');
});

// ── 2. Цена ───────────────────────────────────────────────────────────
it('charge: из сметы/карточки (`charge`) и запасной `estimate.charge`', () => {
  assert.deepEqual(
    storyChargeOf({ charge: { credits: 3, usdEquivalent: 2.99, free: false } }),
    { credits: 3, usdEquivalent: 2.99, free: false }
  );
  assert.deepEqual(
    storyChargeOf({
      estimate: { charge: { credits: 0, usdEquivalent: 0, free: true } },
    }),
    { credits: 0, usdEquivalent: 0, free: true }
  );
  assert.equal(storyChargeOf({}), null);
  assert.equal(storyChargeOf({ charge: { credits: -1 } }), null);
  assert.equal(storyChargeOf(null), null);
});
it('строка цены: кредиты с числовой формой, эквивалент $, бесплатно', () => {
  const paid = { credits: 3, usdEquivalent: 2.99, free: false };
  assert.equal(storyChargeLine(paid, t, 'ru'), 'Цена: 3 кредита (≈ $2.99)');
  assert.equal(
    storyChargeLine({ ...paid, credits: 5 }, t, 'ru'),
    'Цена: 5 кредитов (≈ $2.99)'
  );
  assert.equal(
    storyChargeLine({ ...paid, credits: 1 }, T.en, 'en'),
    'Price: 1 credit (≈ $2.99)'
  );
  assert.equal(
    storyChargeLine({ ...paid, credits: 21 }, T.uk, 'uk'),
    'Ціна: 21 кредит (≈ $2.99)'
  );
  assert.equal(
    storyChargeLine({ credits: 0, usdEquivalent: 0, free: true }, t, 'ru'),
    'Бесплатно: первая сказка участника пилота'
  );
  // Владелец: credits 0, не free — «без списания».
  assert.equal(
    storyChargeLine({ credits: 0, usdEquivalent: 0, free: false }, t, 'ru'),
    'Без списания кредитов'
  );
  assert.equal(formatChargeUsd(3.3333), '$3.33');
});
it('подтверждение платного запуска: цена в теле, владелец — без диалога', () => {
  const paid = { credits: 4, usdEquivalent: 3.5, free: false };
  assert.equal(storyChargeNeedsConfirm(paid), true);
  assert.equal(
    storyChargeNeedsConfirm({ credits: 0, usdEquivalent: 0, free: true }),
    true
  );
  assert.equal(
    storyChargeNeedsConfirm({ credits: 0, usdEquivalent: 0, free: false }),
    false
  );
  assert.equal(storyChargeNeedsConfirm(null), false);
  const c = storyChargeConfirm(paid, t, 'ru');
  assert.equal(c.danger, false);
  like(c.body[0], /4 кредита \(≈ \$3\.50\)/);
  like(c.body.join(' '), /возвращаются/);
  assert.deepEqual(
    storyChargeParagraphs(
      { credits: 0, usdEquivalent: 0, free: true },
      t,
      'ru'
    ),
    [t.charge.confirmFree]
  );
  assert.deepEqual(
    storyChargeParagraphs(
      { credits: 0, usdEquivalent: 0, free: false },
      t,
      'ru'
    ),
    []
  );
});
it('402 STORY_CREDITS_REQUIRED: «нужно N, у вас M» из error.details', () => {
  // Так отвечает backend: HttpExceptionFilter кладёт upstreamDetails в details.
  const e = {
    response: {
      status: 402,
      data: {
        success: false,
        error: {
          code: 'PAYMENT_REQUIRED',
          message: 'Недостаточно кредитов',
          details: { code: 'STORY_CREDITS_REQUIRED', required: 3, balance: 1 },
        },
      },
    },
  };
  assert.equal(storyCode(e), 'STORY_CREDITS_REQUIRED');
  const info = storyCreditsRequired(e);
  assert.deepEqual(info, { required: 3, balance: 1 });
  assert.equal(
    storyCreditsRequiredText(info!, t, 'ru'),
    'Не хватает кредитов: нужно 3 кредита, у вас 1 кредит.'
  );
  assert.equal(
    storyCreditsRequiredText(info!, T.en, 'en'),
    'Not enough credits: 3 credits needed, you have 1 credit.'
  );
});
it('402 без чисел — баланс из режима или общий текст; чужие ошибки — не 402', () => {
  const bare = { response: { status: 402, data: { error: {} } } };
  const info = storyCreditsRequired(bare)!;
  assert.deepEqual(info, { required: null, balance: null });
  assert.equal(
    storyCreditsRequiredText(info, t, 'ru'),
    t.charge.requiredUnknown
  );
  assert.equal(
    storyCreditsRequiredText({ required: 5, balance: null }, t, 'ru', 2),
    'Не хватает кредитов: нужно 5 кредитов, у вас 2 кредита.'
  );
  assert.equal(
    storyCreditsRequired({
      response: {
        status: 403,
        data: { error: { details: { code: 'STORY_TERMS_REQUIRED' } } },
      },
    }),
    null
  );
  assert.equal(storyCreditsRequired(new Error('x')), null);
});

// ── 3. Публикация ─────────────────────────────────────────────────────
it('ТЗ §11.3: точный текст перед выдачей ссылки (ru) и переводы', () => {
  assert.equal(
    ru.storyTales.share.body,
    'Этот подарок будет доступен любому, у кого есть ссылка. Поисковым системам запрещается индексирование. Ссылку можно переслать.'
  );
  for (const [loc, d] of Object.entries(T)) {
    const c = storyShareConfirm(d);
    assert.deepEqual(c.body, [d.share.body], loc);
    assert.equal(c.danger, false);
    assert.ok(d.share.body.split('. ').length >= 3, `${loc}: три фразы`);
  }
  like(en.storyTales.share.body, /anyone who has the link/);
  like(uk.storyTales.share.body, /заборонено індексування/);
});
it('ссылка — только после подтверждения: тело {acknowledgePublic:true}', () => {
  assert.deepEqual(STORY_SHARE_BODY, { acknowledgePublic: true });
  const panel = src('features/stories/StoryPilotParts.tsx');
  // POST share и DELETE share вызываются только из колбэка confirm.ask.
  const post = panel.indexOf('/share`,\n');
  const ask = panel.lastIndexOf('confirm.ask(', post);
  assert.ok(post > 0 && ask > 0 && post - ask < 400, 'POST внутри confirm.ask');
  like(panel, /storyShareConfirm\(t, narratorConsent\)/);
  like(panel, /storyUnshareConfirm\(t\)/);
  const del = panel.indexOf('api.delete(`/story-gifts/${giftId}/share`)');
  const ask2 = panel.lastIndexOf('confirm.ask(', del);
  assert.ok(del > 0 && del - ask2 < 300, 'DELETE внутри confirm.ask');
  assert.equal(storyUnshareConfirm(t).danger, true);
});
it('кнопка «Получить ссылку»: pilot/public и только APPROVED', () => {
  assert.equal(storyCanShare('pilot', 'APPROVED'), true);
  assert.equal(storyCanShare('public', 'APPROVED'), true);
  assert.equal(storyCanShare('owner', 'APPROVED'), false);
  assert.equal(storyCanShare(null, 'APPROVED'), false);
  assert.equal(storyCanShare('pilot', 'READY'), false);
  assert.equal(storySharingEnabled('owner'), false);
});
it('ответ публикации: https-ссылка и срок; мусор — ошибка', () => {
  assert.deepEqual(
    parseStoryShare({
      url: 'https://api.example/api/story-gift/abc',
      expiresAt: '2027-01-18T00:00:00.000Z',
    }),
    {
      url: 'https://api.example/api/story-gift/abc',
      expiresAt: '2027-01-18T00:00:00.000Z',
    }
  );
  assert.equal(parseStoryShare({ url: 'javascript:alert(1)' }), null);
  assert.equal(parseStoryShare(null), null);
});
it('состояние публикации из карточки: активная ссылка, истёкшая — нет', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const active = '2026-12-01T00:00:00.000Z';
  assert.equal(
    storySharedUntil({ retention: { shareExpiresAt: active } }, now),
    active
  );
  assert.equal(storySharedUntil({ shareExpiresAt: active }, now), active);
  assert.equal(
    storySharedUntil({ shareExpiresAt: '2026-10-01T00:00:00Z' }, now),
    null
  );
  assert.equal(storyShareKnown({ shareExpiresAt: null }), true);
  assert.equal(storyShareKnown({ retention: { shareExpiresAt: null } }), true);
  assert.equal(storyShareKnown({ id: 'x' }), false);
});

// ── 4. Срок хранения ──────────────────────────────────────────────────
it('retention.warning → «будет удалено <дата>» локализованной датой', () => {
  const gift = {
    retention: { purgeAt: '2026-10-30T12:00:00.000Z', warning: true },
  };
  assert.equal(
    storyRetentionWarning(gift, t, 'ru')?.badge,
    'Будет удалено 30 октября 2026 г.'
  );
  assert.equal(
    storyRetentionWarning(gift, T.en, 'en')?.badge,
    'Will be deleted on October 30, 2026'
  );
  like(storyRetentionWarning(gift, T.uk, 'uk')!.badge, /30 жовтня 2026/);
  like(storyRetentionWarning(gift, t, 'ru')!.body, /скачайте MP3/);
  assert.equal(
    storyRetentionWarning(
      { retention: { purgeAt: '2027-03-01T00:00:00Z', warning: false } },
      t,
      'ru'
    ),
    null
  );
  assert.equal(storyRetentionWarning({}, t, 'ru'), null);
  assert.equal(
    storyRetentionWarning(
      { retention: { purgeAt: null, warning: true } },
      t,
      'ru'
    ),
    null
  );
});
it('раньше удаления кончается ссылка (basis published) — текст о ссылке', () => {
  const w = storyRetentionWarning(
    {
      retention: {
        purgeAt: '2026-10-30T12:00:00.000Z',
        warning: true,
        basis: 'published',
      },
    },
    t,
    'ru'
  )!;
  assert.equal(w.link, true);
  like(w.badge, /^Ссылка закроется 30 октября/);
  assert.equal(formatStoryDate('не дата', 'ru'), '');
});

// ── 5. Валидатор на языке интерфейса ─────────────────────────────────
const PROMISE_CODES = [
  'STORY_PROMISE_RETURN_DATE',
  'STORY_PROMISE_THERAPY',
  'STORY_PROMISE_DELIVERY',
  'STORY_HINT_RETURN_WITHOUT_DATE',
  'STORY_HINT_RELATIVE_TIME',
  'STORY_HINT_FEELING_PROMISE',
];
it('коды валидатора обещаний переведены во всех локалях', () => {
  for (const [loc, d] of Object.entries(T))
    for (const code of PROMISE_CODES) {
      const text = storyPromiseText(code, 'server', d);
      assert.notEqual(text, 'server', `${loc}/${code}`);
      if (loc !== 'ru')
        assert.notEqual(
          text,
          storyPromiseText(code, '', T.ru),
          `${loc}/${code}`
        );
    }
  assert.equal(storyPromiseText('OTHER_CODE', 'как есть', t), 'как есть');
  assert.equal(storyPromiseText(null, 'как есть', t), 'как есть');
});
it('плейсхолдеры {{…}} одинаковы во всех локалях storyTales', () => {
  const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join(',');
  const walk = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    path: string
  ) => {
    for (const [k, v] of Object.entries(a)) {
      const w = b[k];
      if (typeof v === 'string') {
        assert.equal(typeof w, 'string', `${path}.${k}`);
        assert.equal(vars(w as string), vars(v), `${path}.${k}`);
      } else if (v && typeof v === 'object' && w && typeof w === 'object') {
        // числовые формы: сверяем с формой `other`
        if ('other' in v)
          for (const form of Object.values(w as Record<string, string>))
            assert.equal(vars(form), vars((v as { other: string }).other));
        else
          walk(
            v as Record<string, unknown>,
            w as Record<string, unknown>,
            `${path}.${k}`
          );
      }
    }
  };
  for (const [loc, d] of Object.entries(T))
    walk(
      ru.storyTales as unknown as Record<string, unknown>,
      d as unknown as Record<string, unknown>,
      loc
    );
});
it('числовые формы и подстановка', () => {
  assert.equal(plural(t.access.seatsLeft, 2, 'ru'), 'Осталось 2 места.');
  assert.equal(plural(t.access.seatsLeft, 11, 'ru'), 'Осталось 11 мест.');
  assert.equal(plural(T.en.access.seatsLeft, 1, 'en'), '1 place left.');
  assert.equal(fill('{{a}} и {{b}}', { a: 1 }), '1 и {{b}}');
});

// ── Проводка в компонентах ────────────────────────────────────────────
it('App: вход по /story-gifts/access, экран заявки/правил, контекст', () => {
  const app = src('App.tsx');
  like(app, /'\/story-gifts\/access'/);
  unlike(app, /'\/story-gifts\/catalog'/);
  like(app, /storyNavVisible\(storyView\)/);
  like(app, /<StoryAccessGate/);
  like(app, /<StoryAccessContext\.Provider/);
});
it('экран доступа: заявка, правила и ссылка на правила Story', () => {
  const gate = src('features/stories/StoryAccessGate.tsx');
  like(gate, /'\/story-gifts\/pilot\/apply', storyApplyBody\(/);
  like(gate, /'\/story-gifts\/terms\/accept', body/);
  like(gate, /routes\.legal\(STORY_RULES_SLUG\)/);
  like(gate, /STORY_PILOT_FULL/);
  unlike(gate, /legal-content/);
});
it('мастер: цена до запуска, 402 → покупка кредитов, ссылка, срок', () => {
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(screen, /storyChargeParagraphs\(/);
  like(screen, /<StoryChargeLine charge=\{storyChargeOf\(preview\)\}/);
  like(screen, /<StoryCreditsNotice info=\{credits\}/);
  like(screen, /storyCanShare\(mode, selected\.status\)/);
  like(screen, /<StoryRetentionBadge/);
  // Соседи в одной карточке: одинаковый key у панели ссылки и видео
  // дублировал панель ссылки в DOM (найдено Playwright).
  like(screen, /<StorySharePanel\s+key=\{`share-\$\{selected\.id\}`\}/);
  like(screen, /<StoryRetentionNotice/);
  like(screen, /if \(storyAccessCode\(e\)\) storyAccess\.refresh\(\)/);
  const video = src('features/stories/StoryVideoPanel.tsx');
  like(video, /storyChargeConfirm\(charge!, t, locale\)/);
  like(video, /<StoryCreditsNotice info=\{credits\}/);
  const parts = src('features/stories/StoryPilotParts.tsx');
  like(parts, /navigate\(routes\.credits\(\)\)/);
});
it('контраст новых ссылок и меток (обе темы) ≥ 4.5:1', () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // sky-800 на белом; sky-300 на тёмной карточке (silver-900 #17212b).
  assert.ok(contrast('#075985', '#ffffff') >= 4.5);
  assert.ok(contrast('#7dd3fc', '#17212b') >= 4.5);
  // Метка срока: amber-900 на amber-100; amber-200 на amber-500/20 поверх silver-900 (≈ #433a25).
  assert.ok(contrast('#78350f', '#fef3c7') >= 4.5);
  assert.ok(contrast('#fde68a', '#433a25') >= 4.5);
  const parts = src('features/stories/StoryPilotParts.tsx');
  like(parts, /text-amber-900 dark:bg-amber-500\/20 dark:text-amber-200/);
  like(
    src('features/stories/StoryAccessGate.tsx'),
    /text-sky-800 .*dark:text-sky-300/
  );
});

// ── Доработки координатора: «до N семей», согласие рассказчика ─────────
it('maxMembers из /access → «до N семей»; без него — фолбэк по seatsLeft', () => {
  const a = parseStoryAccess({
    mode: 'pilot',
    allowed: false,
    reason: 'not_invited',
    seatsLeft: 4,
    maxMembers: 15,
    ...base,
  });
  assert.equal(a.maxMembers, 15);
  assert.equal(
    fill(t.access.pilotLimit, { max: 15 }),
    'В пилоте — до 15 семей.'
  );
  assert.equal(
    fill(T.en.access.pilotLimit, { max: 15 }),
    'The pilot is limited to 15 families.'
  );
  const gate = src('features/stories/StoryAccessGate.tsx');
  like(gate, /fill\(t\.access\.pilotLimit, \{ max: access\.maxMembers \}\)/);
  like(gate, /plural\(t\.access\.seatsLeft, access\.seatsLeft, locale\)/);
});
it('согласие рассказчика: флажок обязателен, тело с narratorPublicConsent', () => {
  assert.equal(
    storyNarratorConsentRequired({ narratorPublicConsentRequired: true }),
    true
  );
  assert.equal(storyNarratorConsentRequired({}), false);
  assert.deepEqual(storyShareBody(false), { acknowledgePublic: true });
  assert.deepEqual(storyShareBody(true), {
    acknowledgePublic: true,
    narratorPublicConsent: true,
  });
  assert.equal(storyShareConfirm(t).requiredCheck, undefined);
  for (const [loc, d] of Object.entries(T)) {
    const c = storyShareConfirm(d, true);
    assert.equal(c.requiredCheck, d.share.narratorConsent, loc);
    assert.deepEqual(c.body, [d.share.body], loc);
    assert.ok(d.share.narratorConsentError.length > 20, loc);
  }
  assert.equal(
    ru.storyTales.share.narratorConsent,
    'Рассказчик (чей голос или образ звучит в сказке) согласен, что подарок будет доступен по ссылке'
  );
  const parts = src('features/stories/StoryPilotParts.tsx');
  like(parts, /storyShareConfirm\(t, narratorConsent\)/);
  like(parts, /storyShareBody\(narratorConsent\)/);
  like(parts, /STORY_NARRATOR_PUBLIC_CONSENT_REQUIRED/);
  const dlg = src('features/stories/StoryConfirm.tsx');
  like(dlg, /confirmDisabled=\{!!pending\?\.text\.requiredCheck && !checked\}/);
  like(dlg, /if \(current\?\.text\.requiredCheck && !checked\) return;/);
  const ui = src('components/ui/ConfirmDialog.tsx');
  like(ui, /disabled=\{loadingBody \|\| confirmDisabled\}/);
  like(ui, /'button:not\(:disabled\), input:not\(:disabled\)'/);
});

console.log(`\n${passed} проверок пройдено`);
