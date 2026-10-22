/**
 * Story‑Tales, проход 3, доработки по аудиту U (ST3-U-01…U-12): режим
 * только чтения для отозванного участника, цена без сумм провайдеров для
 * не-владельца, `expectedCredits` и 409 `STORY_PRICE_CHANGED`, весь
 * интерфейс Story на ru/uk/en (de/es — английские строки), тексты сервера
 * без русского в других языках, двойная точка в дате.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ru from '../src/dictionaries/ru.json';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import de from '../src/dictionaries/de.json';
import es from '../src/dictionaries/es.json';
import {
  fill,
  isStoryApiPath,
  storyNarratorConsentPending,
  parseStoryAccess,
  storyAcceptLanguage,
  storyAccessCode,
  storyAccessView,
  storyBlockerText,
  storyChargeConfirm,
  storyChargeParagraphs,
  storyIsOwner,
  storyNavVisible,
  storyPriceChanged,
  storyServerText,
  type StoryTalesStrings,
  type StoryUiStrings,
} from '../src/features/stories/story-pilot';
import {
  novaConfirm,
  novaConfirmMember,
  qaConfirmMember,
} from '../src/features/stories/story-confirm';
import {
  storyBuildGate,
  storyQuoteSummary,
  type StoryVideoQuote,
} from '../src/features/stories/story-video-plan';
import {
  storyErrorText,
  storyMicErrorText,
} from '../src/features/stories/story-errors';
import {
  wizardIssues,
  occasionCaption,
} from '../src/features/stories/story-wizard';
import { isHiddenForUser } from '../src/features/brand/narrator-looks';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}
function like(value: string, re: RegExp, label = '') {
  assert.ok(
    re.test(value),
    `${label} ${JSON.stringify(value.slice(0, 160))} !~ ${re}`
  );
}
function unlike(value: string, re: RegExp, label = '') {
  assert.ok(
    !re.test(value),
    `${label}: найдено ${re} в ${JSON.stringify(value.slice(0, 160))}`
  );
}
const src = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');
const UI: Record<string, StoryUiStrings> = {
  ru: ru.storyUi,
  uk: uk.storyUi as StoryUiStrings,
  en: en.storyUi as StoryUiStrings,
  de: de.storyUi as StoryUiStrings,
  es: es.storyUi as StoryUiStrings,
};
const T = ru.storyTales as StoryTalesStrings;
const TE = en.storyTales as StoryTalesStrings;
const CYR = /[А-Яа-яЁёІіЇїЄєҐґ]/;
const strings = (o: unknown): string[] =>
  typeof o === 'string'
    ? [o]
    : o && typeof o === 'object'
      ? Object.values(o).flatMap(strings)
      : [];

console.log('story-pilot-ux');

// ── U-01 ──────────────────────────────────────────────────────────────
it('U-01: отозванный участник — режим только чтения, вкладка видна', () => {
  const a = parseStoryAccess({
    mode: 'pilot',
    allowed: false,
    role: 'revoked',
    reason: 'pilot_revoked',
    readOnly: true,
    freeGiftAvailable: false,
    termsVersion: 'v',
  });
  assert.equal(a.readOnly, true);
  assert.equal(a.role, 'revoked');
  assert.equal(storyAccessView(a), 'readonly');
  assert.equal(storyNavVisible('readonly'), true);
  assert.equal(storyAccessView({ ...a, mode: 'public' }), 'readonly');
  // В режиме владельца раздела по-прежнему нет.
  assert.equal(storyAccessView({ ...a, mode: 'owner' }), 'closed');
  assert.equal(storyIsOwner(a), false);
  assert.equal(storyIsOwner({ ...a, role: 'owner' }), true);
  assert.equal(storyIsOwner(null), true);
});
it('U-01: проводка — App пускает readonly в мастер, мастер прячет создание и сборку', () => {
  like(src('App.tsx'), /storyView === 'allowed' \|\| storyView === 'readonly'/);
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(screen, /const readOnly = storyAccess\.access\?\.readOnly === true/);
  like(
    screen,
    /\{!readOnly && storySource === 'library' && catalog\.length > 0 && \(/
  );
  like(screen, /\{!readOnly && storySource === 'library' && story && \(/);
  like(screen, /\{!readOnly && selected\.status === 'DRAFT' && \(/);
  like(screen, /\{!readOnly && selected\.status === 'READY' && \(/);
  like(
    screen,
    /readOnly\s*\? Promise\.resolve\(\{ data: \[\] as Story\[\] \}\)/
  );
  like(screen, /<StorySharePanel[\s\S]{0,200}readOnly=\{readOnly\}/);
  like(screen, /<StoryVideoPanel[\s\S]{0,200}readOnly=\{readOnly\}/);
  // Удаление и предупреждение о сроке остаются.
  like(screen, /deleteGiftConfirm\(target, u\.confirm\)/);
  like(screen, /<StoryRetentionNotice/);
  const parts = src('features/stories/StoryPilotParts.tsx');
  like(parts, /\{!published && !readOnly && \(/);
  like(parts, /if \(readOnly && !published && !unknown\) return null;/);
  const video = src('features/stories/StoryVideoPanel.tsx');
  like(
    video,
    /\{!readOnly && \(\s*<Button\s*disabled=\{\s*busy \|\|\s*render\.status !== 'READY'/
  );
});

// ── U-02 ──────────────────────────────────────────────────────────────
it('U-02: текст о публикации видео — по режиму и ссылке, кнопка согласия', () => {
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(screen, /!storySharingEnabled\(mode\)\s*\? u\.video\.ownerOnly/);
  like(
    screen,
    /storyNarratorConsentPending\(selected\)\s*\? u\.video\.publicConsent\s*: u\.video\.publicLinked/
  );
  like(screen, /: u\.video\.publicNotShared/);
  const video = src('features/stories/StoryVideoPanel.tsx');
  like(video, /<p>\{publicNote \?\? v\.ownerOnly\}<\/p>/);
  unlike(video, /Публикация отключена на этапе/);
  const parts = src('features/stories/StoryPilotParts.tsx');
  like(parts, /published && consentPending && !readOnly/);
  like(
    parts,
    /storyShareConfirm\(t, true\)[\s\S]{0,300}storyShareBody\(true\)/
  );
  for (const d of [ru, uk, en, de, es]) {
    assert.ok(d.storyTales.share.consentButton.length > 5);
    assert.ok(d.storyUi.video.publicLinked.length > 20);
  }
});

// ── U-03 ──────────────────────────────────────────────────────────────
it('U-03: не-владельцу — только кредиты (≈$), без резерва и бюджета провайдера', () => {
  const paid = { credits: 3, usdEquivalent: 2.99, free: false };
  const member = novaConfirmMember(
    storyChargeParagraphs(paid, T, 'ru'),
    false,
    T.charge.confirmTitleFree,
    ru.storyUi.confirm
  );
  const text = [member.title, ...member.body].join(' ');
  like(text, /3 кредита \(≈ \$2\.99\)/);
  unlike(text, /Резерв|бюджет|Платная операция|Resemble/);
  assert.equal(member.title, 'Озвучить сказку?');
  const free = novaConfirmMember(
    storyChargeParagraphs(
      { credits: 0, usdEquivalent: 0, free: true },
      T,
      'ru'
    ),
    true,
    T.charge.confirmTitleFree,
    ru.storyUi.confirm
  );
  assert.equal(free.title, 'Запустить бесплатную сборку?');
  unlike(free.body.join(' '), /Платная операция|платную/);
  for (const kind of ['audio', 'video'] as const)
    unlike(
      qaConfirmMember(kind, ru.storyUi.confirm).body.join(' '),
      /\$|резерв/
    );
  // У владельца — как раньше: резерв и бюджет.
  like(
    novaConfirm({ reservedMicroUsd: 260000, budgetCents: 100 }).body[0],
    /Резерв \$0\.26 из бюджета \$1\.00/
  );
});
it('U-03/U-10: подтверждение сборки — «бесплатной» не называется «платной»', () => {
  assert.equal(
    storyChargeConfirm({ credits: 0, usdEquivalent: 0, free: true }, T, 'ru')
      .title,
    'Запустить бесплатную сборку?'
  );
  assert.equal(
    storyChargeConfirm(
      { credits: 4, usdEquivalent: 3.49, free: false },
      TE,
      'en'
    ).title,
    'Start a paid build?'
  );
});
it('U-03: смета и кнопка видео у не-владельца без $', () => {
  const q = {
    existingRender: null,
    segments: [],
    layout: { durationSeconds: 70 },
    voice: { profile: 'nova' },
    reserveMicroUsd: 180000,
    remainingMicroUsd: 264000,
    fits: true,
    blockers: [],
  } as unknown as StoryVideoQuote;
  const ps = { plan: ru.storyUi.plan, render: ru.storyUi.render };
  unlike(storyQuoteSummary(q, ps, true), /\$|резерв|бюджет/);
  like(storyQuoteSummary(q, ps, false), /резерв \$0\.18/);
  assert.equal(storyBuildGate(q, false, ps, true).label, 'Собрать с Nova');
  assert.equal(
    storyBuildGate(q, false, ps).label,
    'Собрать с Nova · резерв $0.18'
  );
  const over = { ...q, fits: false } as StoryVideoQuote;
  unlike(storyBuildGate(over, false, ps, true).reason ?? '', /\$/);
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(
    screen,
    /\{owner && <EstimateTable estimate=\{preview\.estimate\} \/>\}/
  );
  like(screen, /\{owner && \(\s*<p>\s*\{fill\(c\.budgetLine/);
  like(screen, /useState\(owner \? '1' : '5'\)/);
});

// ── U-04 ──────────────────────────────────────────────────────────────
it('U-04: expectedCredits из показанной сметы; 409 STORY_PRICE_CHANGED → новая цена', () => {
  const e = {
    response: {
      status: 409,
      data: {
        error: {
          code: 'CONFLICT',
          message: 'Цена изменилась',
          details: {
            code: 'STORY_PRICE_CHANGED',
            charge: { credits: 4, usdEquivalent: 3.49, free: false },
          },
        },
      },
    },
  };
  assert.deepEqual(storyPriceChanged(e), {
    charge: { credits: 4, usdEquivalent: 3.49, free: false },
  });
  assert.deepEqual(
    storyPriceChanged({
      response: {
        status: 409,
        data: { error: { details: { code: 'STORY_PRICE_CHANGED' } } },
      },
    }),
    { charge: null }
  );
  assert.equal(storyPriceChanged({ response: { status: 409 } }), null);
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(
    screen,
    /update\('render', \{ expectedCredits: charge\?\.credits \?\? 0 \}\)/
  );
  like(
    screen,
    /storyPriceChanged\(e\)[\s\S]{0,600}setTimeout\(\(\) => launchNova\(next\), 0\)/
  );
  const video = src('features/stories/StoryVideoPanel.tsx');
  like(video, /\{ \.\.\.body, expectedCredits: expected \}/);
  like(
    video,
    /storyPriceChanged\(e\)[\s\S]{0,1200}confirm\.ask\(storyChargeConfirm\(nextCharge, t, locale\)/
  );
});

// ── U-05 ──────────────────────────────────────────────────────────────
it('U-05: en/de/es — ни одной кириллической строки в storyUi (кроме цитаты)', () => {
  for (const loc of ['en', 'de', 'es'])
    for (const v of strings(UI[loc])) unlike(v, CYR, `${loc}`);
  // de/es — английские строки (решение главного агента), без русского.
  assert.deepEqual(UI.de, UI.en);
  assert.deepEqual(UI.es, UI.en);
});
it('U-05: uk — без русских букв (ы, э, ъ, ё) в storyUi и storyTales', () => {
  for (const v of [...strings(uk.storyUi), ...strings(uk.storyTales)]) {
    if (v.includes('Не будешь скучать')) continue; // намеренная цитата
    unlike(v, /[ЫыЭэЪъЁё]/, 'uk');
  }
});
it('U-05: компоненты Story без русских литералов вне комментариев', () => {
  const allowed = [/Русский/, /Українська/, /Сегодня я расскажу тебе сказку/];
  for (const f of [
    'features/stories/StoryGiftsScreen.tsx',
    'features/stories/StoryVideoPanel.tsx',
    'features/stories/StoryPilotParts.tsx',
    'features/stories/StoryAccessGate.tsx',
  ]) {
    const code = src(f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .map((l) => l.replace(/\/\/.*$/, ''));
    for (const l of code)
      if (CYR.test(l) && !allowed.some((re) => re.test(l)))
        assert.ok(false, `${f}: ${l.trim()}`);
  }
});
it('U-05: ошибки сервера — по коду на языке интерфейса; русский текст вне ru не показывается', () => {
  const outdated = {
    response: {
      status: 409,
      data: {
        error: {
          message: 'Правила обновились',
          details: { code: 'STORY_TERMS_OUTDATED' },
        },
      },
    },
  };
  assert.equal(
    storyErrorText(outdated, { locale: 'en', ui: UI.en }),
    UI.en.codes.STORY_TERMS_OUTDATED
  );
  assert.equal(
    storyErrorText(outdated, { locale: 'ru', ui: UI.ru }),
    'Правила обновились'
  );
  const ruOnly = {
    response: { status: 409, data: { error: { message: 'Конфликт' } } },
  };
  assert.equal(
    storyErrorText(ruOnly, { locale: 'uk', ui: UI.uk }),
    UI.uk.errors.s409
  );
  assert.equal(
    storyErrorText(ruOnly, { locale: 'en', ui: UI.en, fallback: 'F' }),
    'F'
  );
  assert.equal(storyErrorText(ruOnly), 'Конфликт');
  assert.equal(
    storyMicErrorText({ name: 'NotFoundError' }, UI.en),
    UI.en.errors.micNotFound
  );
  assert.equal(storyServerText('Ошибка сборки', 'en', 'X'), 'X');
  assert.equal(storyServerText('Ошибка сборки', 'ru', 'X'), 'Ошибка сборки');
  assert.equal(
    storyServerText('Provider timeout', 'uk', 'X'),
    'Provider timeout'
  );
  assert.equal(
    storyBlockerText('Пилот: три сборки одного подарка в сутки', UI.en, 'en'),
    UI.en.blockers.daily
  );
  assert.equal(
    storyBlockerText(
      'Итог по оценке 182.4 с — длиннее 180 с: сократите вступление или завершение',
      UI.en,
      'en'
    ),
    'Total ≈ 182.4 s — longer than 180 s: shorten the introduction or the ending.'
  );
  unlike(storyBlockerText('Неизвестное препятствие', UI.en, 'en'), CYR);
  // Помощники мастера на английском.
  assert.deepEqual(
    wizardIssues(
      {
        catalogId: 'x',
        budget: '1',
        country: 'UA',
        occasionKind: null,
        occasionLabel: '',
        theme: null,
        giftNoteEnabled: true,
        giftNote: '',
        giftNotePosition: 'end',
        photoDescription: '',
        includeVideo: false,
      },
      UI.en.wiz
    ),
    ['Enter the line about the gift or turn the mention off']
  );
  assert.equal(
    occasionCaption({ occasionKind: 'birthday' }, UI.uk.wiz),
    'День народження'
  );
});
it('U-07: разбор референсов, реестр редакций и образ рассказчика — только владельцу', () => {
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(
    screen,
    /\{owner && !readOnly && youtubeOpened && \([\s\S]{0,100}<StoryReferencesPanel \/>/
  );
  like(
    screen,
    /\{owner && !readOnly && storySource === 'library' && \([\s\S]{0,250}<StoryEditionsPanel \/>/
  );
  like(
    src('features/stories/StoryVideoPanel.tsx'),
    /\{owner && profileId && \(/
  );
  // Блок образов в брендбуке: 403 участнику пилота — блок скрыт, как при 404.
  assert.equal(isHiddenForUser({ response: { status: 403 } }), true);
  assert.equal(isHiddenForUser({ response: { status: 404 } }), true);
  assert.equal(isHiddenForUser({ response: { status: 409 } }), false);
});

// ── S3 ────────────────────────────────────────────────────────────────
it('U-10: нет «г..» / «р..» после даты', () => {
  assert.equal(
    fill('Действует до {{date}}.', { date: '18 января 2027 г.' }),
    'Действует до 18 января 2027 г.'
  );
  assert.equal(
    fill('Діє до {{date}}.', { date: '18 січня 2027 р.' }),
    'Діє до 18 січня 2027 р.'
  );
  assert.equal(
    fill('Valid until {{date}}.', { date: 'January 18, 2027' }),
    'Valid until January 18, 2027.'
  );
});
it('U-12: правила/отзыв в любой панели → перечитать доступ', () => {
  const code = (c: string) => ({
    response: { status: 403, data: { error: { details: { code: c } } } },
  });
  assert.equal(storyAccessCode(code('STORY_TERMS_REQUIRED')), true);
  assert.equal(storyAccessCode(code('STORY_TERMS_OUTDATED')), true);
  assert.equal(storyAccessCode(code('STORY_PILOT_REVOKED')), true);
  assert.equal(storyAccessCode(code('OTHER')), false);
  for (const f of [
    'StoryGiftsScreen.tsx',
    'StoryVideoPanel.tsx',
    'StoryPilotParts.tsx',
  ])
    like(
      src(`features/stories/${f}`),
      /if \(storyAccessCode\(e\)\) storyAccess\.refresh\(\)/,
      f
    );
  like(
    src('features/stories/StoryAccessGate.tsx'),
    /code === 'STORY_TERMS_OUTDATED'/
  );
});
it('U-11: экран кредитов — цена Story в смете (5 локалей)', () => {
  for (const d of [ru, uk, en, de, es])
    like(d.creditsScreen.hint, /Story‑Tales: /);
  like(ru.creditsScreen.hint, /цена указана в смете перед запуском/);
});

it('Accept-Language запросов Story = язык интерфейса (ru/uk/en; de/es → en)', () => {
  assert.equal(storyAcceptLanguage('ru'), 'ru');
  assert.equal(storyAcceptLanguage('uk'), 'uk');
  assert.equal(storyAcceptLanguage('en'), 'en');
  assert.equal(storyAcceptLanguage('de'), 'en');
  assert.equal(storyAcceptLanguage('es'), 'en');
  for (const u of [
    '/story-gifts',
    '/story-gifts/catalog',
    '/story-gifts/g1/video',
    'story-gifts/access',
    'https://api.example/api/story-gifts/g1/video',
    '/story-gift/abc',
    '/public/story-capabilities',
  ])
    assert.equal(isStoryApiPath(u), true, u);
  for (const u of [
    '/me/plan',
    '/projects',
    '/brand-manifests/m1',
    '/storybook',
    undefined,
  ])
    assert.equal(isStoryApiPath(u), false, String(u));
  const api = src('services/api.ts');
  like(
    api,
    /isStoryApiPath\(config\.url\)\s*\? storyAcceptLanguage\(locale\)\s*: locale/
  );
  // Смена языка перечитывает каталог (rights) и видеопанель (согласия).
  like(
    src('features/stories/StoryGiftsScreen.tsx'),
    /\}, \[loadNonce, locale\]\);/
  );
  like(
    src('features/stories/StoryVideoPanel.tsx'),
    /\}, \[giftId, locale\]\);/
  );
});

it('субтитры (fetch) — тот же язык, что и остальные запросы Story', () => {
  like(
    src('features/stories/StoryVideoPanel.tsx'),
    /'Accept-Language': storyAcceptLanguage\(locale\)/
  );
});

it('U-15: просьба о согласии рассказчика — только по narratorPublicConsentPending', () => {
  // Required=true у любого выпуска с голосом/образом; просить — только пока Pending.
  assert.equal(
    storyNarratorConsentPending({
      narratorPublicConsentRequired: true,
      narratorPublicConsentPending: true,
    }),
    true
  );
  assert.equal(
    storyNarratorConsentPending({
      narratorPublicConsentRequired: true,
      narratorPublicConsentPending: false,
    }),
    false
  );
  assert.equal(
    storyNarratorConsentPending({ narratorPublicConsentRequired: true }),
    false
  );
  const parts = src('features/stories/StoryPilotParts.tsx');
  like(
    parts,
    /const consentPending = storyNarratorConsentPending\(gift\) && !consentSaved;/
  );
  like(parts, /setConsentSaved\(true\);\s*setNotice\(t\.share\.consentSaved\)/);
  // Первая выдача ссылки по-прежнему спрашивает согласие по Required.
  like(parts, /const narratorConsent = storyNarratorConsentRequired\(gift\);/);
  like(parts, /storyShareConfirm\(t, narratorConsent\)/);
  unlike(parts, /published && narratorConsent && !readOnly/);
  // Подпись видео: согласие дано (Pending=false) — «показывается по ссылке».
  unlike(
    src('features/stories/StoryGiftsScreen.tsx'),
    /storyNarratorConsentRequired/
  );
});

console.log(`\n${passed} проверок пройдено`);
