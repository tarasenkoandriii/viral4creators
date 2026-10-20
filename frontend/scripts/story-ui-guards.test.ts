/**
 * Аудит Story‑Tales 2 (20.10.2026), пакет U — замки интерфейса, которые
 * ломаются тихо: чистые помощники и проводка в исходниках компонентов.
 * Поведение в браузере (диалог перед DELETE, фото 4000×3000, 320/360 px
 * без прокрутки, axe-контраст) проверяет Playwright `/tmp/fx2-ui/pw_fix.py`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STORY_THEMES,
  STORY_THEME_IDS,
} from '../src/features/stories/story-wizard';
import {
  CONFIDENCE_LABEL,
  confidenceLabel,
  confidenceNote,
} from '../src/features/stories/story-library';
import {
  STORY_PREAMBLE_FILE_MAX_BYTES,
  preambleFileError,
} from '../src/features/stories/story-video-plan';
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

/** Контраст WCAG 2.x для #rrggbb. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ── ST2-U-10: контраст ──────────────────────────────────────────────────
it('U-10: текст бейджа темы (ink на soft) ≥ 4.5:1 для каждой темы', () => {
  for (const id of STORY_THEME_IDS) {
    const t = STORY_THEMES[id];
    const c = contrast(t.ink, t.soft);
    assert.ok(c >= 4.5, `${id}: ${c.toFixed(2)}`);
    // Исходный сценарий: accent на soft был 2.48–2.61 — поэтому не текст.
    assert.ok(contrast(t.accent, t.soft) < 4.5);
  }
  like(
    src('features/stories/StoryGiftsScreen.tsx'),
    /color: t\.ink/,
    'ThemeBadge'
  );
});
it('U-10: в блоке образа нет светлых amber/emerald-300 без тёмной темы', () => {
  const looks = src('features/brand/NarratorLooksPanel.tsx');
  unlike(
    looks,
    /className="[^"]*(?<!dark:)text-(amber|emerald)-300/,
    'NarratorLooksPanel'
  );
  like(looks, /text-amber-700 dark:text-amber-300/);
  like(looks, /text-emerald-700 dark:text-emerald-300/);
});

// ── ST2-U-08: внутренние коды ──────────────────────────────────────────
it('U-08: уверенность модели — русскими словами, модель не показывается', () => {
  assert.equal(confidenceLabel('high'), 'высокая');
  assert.equal(confidenceLabel('MEDIUM'), 'средняя');
  assert.equal(confidenceLabel('low'), 'низкая');
  assert.equal(confidenceLabel('weird'), null);
  assert.equal(confidenceNote('high'), 'уверенность модели: высокая');
  assert.equal(confidenceNote(undefined), '');
  assert.deepEqual(Object.keys(CONFIDENCE_LABEL), ['high', 'medium', 'low']);
  const refs = src('features/stories/StoryReferencesPanel.tsx');
  unlike(refs, /\{r\.model\}/, 'имя модели в UI');
  unlike(
    refs,
    /уверенность: \{s\.confidence\}|уверенность: \$\{s\.reference\.confidence\}/,
    'сырой enum'
  );
});

// ── ST2-U-12: размер аудиофайла вступления ─────────────────────────────
it('U-12: файл больше 15 МБ отклоняется до декодирования', () => {
  assert.equal(STORY_PREAMBLE_FILE_MAX_BYTES, 15 * 1024 * 1024);
  assert.equal(preambleFileError({ size: 3 * 1024 * 1024 }), null);
  assert.equal(
    preambleFileError({ size: STORY_PREAMBLE_FILE_MAX_BYTES }),
    null
  );
  like(preambleFileError({ size: 230 * 1024 * 1024 }) ?? '', /больше 15 МБ/);
  const panel = src('features/stories/StoryVideoPanel.tsx');
  const body = panel.slice(panel.indexOf('async function acceptRecording'));
  assert.ok(
    body.indexOf('preambleFileError(blob)') <
      body.indexOf('blob.arrayBuffer()'),
    'проверка размера должна идти до чтения файла'
  );
});

// ── ST2-U-13: 404 ≠ сбой ───────────────────────────────────────────────
it('U-13: 404/401/403 — закрыто; сеть, 5xx, 429 — ошибка с повтором', () => {
  assert.equal(storyLoadFailure({ response: { status: 404 } }), 'closed');
  assert.equal(storyLoadFailure({ response: { status: 401 } }), 'closed');
  assert.equal(storyLoadFailure({ response: { status: 403 } }), 'closed');
  assert.equal(storyLoadFailure({ response: { status: 500 } }), 'error');
  assert.equal(storyLoadFailure({ response: { status: 429 } }), 'error');
  assert.equal(
    storyLoadFailure({ isAxiosError: true, code: 'ERR_NETWORK' }),
    'error'
  );
  assert.equal(storyLoadFailure(new Error('x')), 'error');
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(screen, /storyLoadFailure\(e\) === 'closed'/);
  // Проход 3: подпись «Повторить» — из словаря (`storyTales.access.retry`).
  like(screen, /setLoadNonce\(\(n\) => n \+ 1\)\}>\s*\{t\.access\.retry\}/);
  const app = src('App.tsx');
  like(app, /setStoryAccess\(storyLoadFailure\(e\)\)/);
  like(app, /setStoryNonce\(\(n\) => n \+ 1\)/);
});

// ── ST2-U-15 / U-03: вход в раздел и упоминания Story ──────────────────
it('U-15: App не пишет «закрытой разработке» — не-владельцу тот же «не найдено», что любой адрес', () => {
  const app = src('App.tsx');
  unlike(app, /закрытой разработке/, 'App.tsx');
  // Проход 3: вкладка — по ответу `GET /story-gifts/access` (не «closed»).
  like(app, /storyNavVisible\(storyView\) && \(\s*<NavTab/);
  like(
    app,
    /title=\{dict\.notFound\.title\}\s*hint=\{`#\/\$\{route\.name\}`\}/
  );
});
it('U-03: профиль рассказчика не упоминает Story — только блок образа после успешного GET', () => {
  const profile = src('features/brand/NarratorProfile.tsx');
  const code = profile.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  unlike(code, /Story‑Tales|#\/stories|Репке/, 'NarratorProfile');
  const looks = src('features/brand/NarratorLooksPanel.tsx');
  const early = looks.indexOf('if (hidden || !state) return null;');
  assert.ok(early > 0);
  assert.ok(
    looks.indexOf('href="#/stories"') > early,
    'ссылка — только после проверки доступа'
  );
});

// ── ST2-U-11: ширина file input ────────────────────────────────────────
it('U-11: file input профиля рассказчика не шире карточки', () => {
  like(
    src('features/brand/NarratorProfile.tsx'),
    /className="block w-full max-w-full text-sm"\s*type="file"\s*accept="video\/mp4"/
  );
});

// ── ST2-U-01 / U-07: подтверждения до запроса ──────────────────────────
it('U-01: DELETE сказки — только внутри подтверждения', () => {
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  const del = screen.indexOf('api.delete(`/story-gifts/${target.id}`)');
  assert.ok(del > 0, 'DELETE не найден');
  const ask = screen.lastIndexOf('deleteGiftConfirm(target', del);
  assert.ok(ask > 0 && del - ask < 300, 'DELETE вне confirm.ask');
  assert.equal(
    screen.split('api.delete(`/story-gifts/').length,
    2,
    'лишний DELETE'
  );
  like(screen, /\{confirm\.dialog\}/);
});
it('U-07: Nova, Soniox и Gemini — через confirm.ask, на кнопках резерв', () => {
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  // Проход 3: в тот же диалог Nova добавляется цена в кредитах.
  // Проход 3: озвучка — launchNova: confirm.ask, затем run(update('render', {expectedCredits})).
  like(
    screen,
    /confirm\.ask\(\s*text,\s*\(\) =>\s*void run\(async \(\) => \{\s*try \{\s*await update\('render', \{ expectedCredits:/
  );
  like(screen, /onClick=\{\(\) => launchNova\(selected\)\}/);
  like(
    screen,
    /confirm\.ask\(\s*owner\s*\?\s*audioQaConfirm\(selected, u\.confirm\)\s*:\s*qaConfirmMember\('audio', u\.confirm\),\s*\(\) => void run\(\(\) => update\('quality'\)\)/
  );
  like(
    screen,
    /`\$\{c\.voiceNova\}\$\{reserveSuffix\(selected\.reservedMicroUsd, u\.confirm\)\}`/
  );
  unlike(
    screen,
    /onClick=\{\(\) => void run\(\(\) => update\('(render|quality)'\)\)\}/,
    'прямой платный вызов'
  );
  const video = src('features/stories/StoryVideoPanel.tsx');
  like(
    video,
    /confirm\.ask\(\s*owner\s*\?\s*videoQaConfirm\(target, u\.confirm\)/
  );
  const refs = src('features/stories/StoryReferencesPanel.tsx');
  like(
    refs,
    /confirm\.ask\(\s*analyzeConfirm\(\{\s*retry,\s*quota,\s*analysis: quota\?\.analysis,?\s*\}\)/
  );
  unlike(refs, /onClick=\{\(\) => void analyze\(/, 'разбор без подтверждения');
  unlike(refs, /window\.confirm/, 'системный confirm');
});

// ── ST2-U-09: предпросмотр с неверным бюджетом ─────────────────────────
it('U-09: «Показать … и смету» заблокирована при ошибке бюджета', () => {
  like(
    src('features/stories/StoryGiftsScreen.tsx'),
    /disabled=\{busy \|\| !story \|\| !!budgetError\}/
  );
});

// ── ST2-U-02: фото — подгонка, а не фиксированные 960 px ───────────────
it('U-02: photoPng использует fitStoryPhoto, без фиксированных 960 px', () => {
  const screen = src('features/stories/StoryGiftsScreen.tsx');
  like(screen, /await fitStoryPhoto\(/);
  unlike(screen, /960 \/ Math\.max/, 'фиксированный масштаб');
  unlike(screen, /выберите изображение поменьше/, 'бесполезный совет');
});

// ── Доработка: общие компоненты и запись вступления ────────────────────
it('контраст общих компонентов: danger — rose-800/300, «Отмена» диалога — silver-700', () => {
  const button = src('components/ui/Button.tsx');
  like(button, /danger:\s*'[^']*text-rose-800 dark:text-rose-300/);
  unlike(button, /danger:\s*'[^']*text-rose-500/, 'светлый rose-500 на тексте');
  like(
    src('components/ui/ConfirmDialog.tsx'),
    /className="text-silver-700"\s*onClick=\{onCancel\}/
  );
});
it('ST2-U-16: карточка ConfirmDialog непрозрачная в обеих темах', () => {
  like(
    src('components/ui/ConfirmDialog.tsx'),
    /className="w-full max-w-sm p-5 !bg-white dark:!bg-silver-900"/
  );
});
it('удаление записи вступления — через подтверждение с числом удалённых сборок', () => {
  const video = src('features/stories/StoryVideoPanel.tsx');
  const del = video.indexOf('/video/recording/${r.id}');
  const ask = video.lastIndexOf('deleteRecordingConfirm(r', del);
  assert.ok(ask > 0 && del - ask < 400, 'DELETE записи вне confirm.ask');
  like(video, /recordingDeletedNotice\(res\.data, u\.confirm\)/);
  unlike(video, /Удаление записи не меняет/, 'устаревшая подсказка');
});

console.log(`story-ui-guards: ${passed} проверок пройдено`);
