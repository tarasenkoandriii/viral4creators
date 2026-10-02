import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AccountMember, ProductRoles } from '../src/kit/types';
import { parseSandbox, parseVersion } from '../src/lib/knowledge-api';
import {
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_HOT_PAGES,
  MAX_URLS_PER_SOURCE,
  SANDBOX_QUESTION_MAX,
  budgetShare,
  canAdminKnowledge,
  canSiteKnowledge,
  canTransferSandbox,
  canUseSandbox,
  checkUpload,
  exclusionForDocument,
  failedGateChecks,
  formatUsd,
  langShares,
  normalizePageUrl,
  normalizeSiteUrl,
  parseUrlList,
  pollDelayMs,
  questionsLeft,
  sandboxIdFromLaunch,
  sandboxPhase,
  setPendingQuestion,
  sourceRefLabel,
  takePendingQuestion,
  toggleHot,
  versionActions,
  versionLabelKey,
  versionStats,
  versionTone,
} from '../src/lib/knowledge-view';

// ═══ Права (ТЗ §3.2; контракт Э1 §6) ═════════════════════════════════
const member = (
  role: AccountMember['role'],
  roles: Partial<ProductRoles> = {}
): AccountMember => ({
  memberId: 'm1',
  telegramId: '1',
  role,
  productRoles: { qa: 'none', assist: 'none', assistAdmin: 'none', ...roles },
});

// «Сайт»: владелец; менеджер с assist: manager. Оператор — никогда.
assert.equal(canSiteKnowledge(member('owner')), true);
assert.equal(canSiteKnowledge(member('manager', { assist: 'manager' })), true);
assert.equal(
  canSiteKnowledge(member('manager', { assist: 'operator' })),
  false
);
assert.equal(canSiteKnowledge(member('manager')), false);
assert.equal(
  canSiteKnowledge(member('operator', { assist: 'manager' })),
  false
);
assert.equal(
  canSiteKnowledge(member('operator', { assist: 'operator' })),
  false
);

// «Админка»: ТОЛЬКО assistAdmin: owner (manager «Сайта» — нет; К-9).
assert.equal(
  canAdminKnowledge(member('owner', { assistAdmin: 'owner' })),
  true
);
assert.equal(
  canAdminKnowledge(member('manager', { assist: 'manager' })),
  false,
  'менеджер «Сайта» без assistAdmin не видит «Админку»'
);
assert.equal(
  canAdminKnowledge(member('manager', { assistAdmin: 'employee' })),
  false,
  'сотрудник «Админки» знаний не правит'
);
assert.equal(
  canAdminKnowledge(member('owner')),
  false,
  'владельцу без права — нет'
);
assert.equal(
  canAdminKnowledge(member('operator', { assistAdmin: 'owner' })),
  false,
  'оператор не видит раздел «Админка»'
);
// Ответ сервера (право запрашивающего) решает, когда он есть.
assert.equal(
  canAdminKnowledge(member('owner', { assistAdmin: 'owner' }), {
    adminAvailable: false,
  }),
  false
);
assert.equal(
  canAdminKnowledge(member('manager'), { adminAvailable: true }),
  true
);
assert.equal(
  canAdminKnowledge(member('operator'), { adminAvailable: true }),
  false
);
assert.equal(canTransferSandbox(member('owner')), true);
assert.equal(canTransferSandbox(member('manager')), true);
assert.equal(
  canTransferSandbox(member('operator', { assist: 'manager' })),
  false
);

// ═══ Версии ═════════════════════════════════════════════════════════
const base = {
  number: 5,
  trigger: 'crawl',
  stats: { added: 2, removed: 1, changed: '3', chunks: 120.7 },
  gateReport: {
    checks: [
      { check: 'gone_or_error_share', value: 0.5, threshold: 0.3, held: true },
      { check: 'lang_shift', value: 2, threshold: 40, held: false },
    ],
    held: true,
    coldStart: false,
  },
  createdAt: 'x',
};
const held = parseVersion({ ...base, status: 'held' });
assert.deepEqual(versionActions(held), {
  publish: true,
  discard: true,
  rollback: false,
});
assert.equal(versionTone(held), 'warning');
assert.deepEqual(
  failedGateChecks(held.gateReport).map((c) => c.check),
  ['gone_or_error_share']
);
assert.deepEqual(failedGateChecks(null), []);
assert.deepEqual(versionStats(held), {
  added: 2,
  removed: 1,
  changed: 0,
  chunks: 120,
});
const current = parseVersion({
  ...base,
  status: 'published',
  isPublished: true,
  canRollback: true,
});
assert.deepEqual(versionActions(current), {
  publish: false,
  discard: false,
  rollback: false,
});
assert.equal(versionLabelKey(current), 'current');
assert.equal(versionTone(current), 'success');
const old = parseVersion({ ...base, status: 'published', canRollback: true });
assert.equal(versionActions(old).rollback, true);
assert.equal(versionLabelKey(old), 'published');
assert.equal(
  versionActions(parseVersion({ ...base, status: 'published' })).rollback,
  false,
  'вне окна отката — без кнопки'
);
assert.equal(
  versionActions(
    parseVersion({ ...base, status: 'discarded', canRollback: true })
  ).publish,
  false
);
assert.equal(
  versionTone(parseVersion({ ...base, status: 'checking' })),
  'accent'
);

// ═══ Песочница ══════════════════════════════════════════════════════
const now = new Date('2026-10-01T12:00:00Z');
const sb = (o: Record<string, unknown>) =>
  parseSandbox({
    status: 'ready',
    questions: 0,
    questionsLimit: 20,
    expiresAt: '2026-10-08T12:00:00Z',
    ...o,
  });
assert.equal(sandboxPhase(sb({ status: 'queued' }), now), 'preparing');
assert.equal(sandboxPhase(sb({ status: 'crawling' }), now), 'preparing');
assert.equal(sandboxPhase(sb({ status: 'indexing' }), now), 'preparing');
assert.equal(sandboxPhase(sb({}), now), 'ready');
assert.equal(sandboxPhase(sb({ questions: 20 }), now), 'exhausted');
assert.equal(questionsLeft(sb({ questions: 25 })), 0);
assert.equal(questionsLeft(sb({ questions: 3 })), 17);
assert.equal(sandboxPhase(sb({ status: 'expired' }), now), 'expired');
assert.equal(
  sandboxPhase(sb({ expiresAt: '2026-10-01T11:59:59Z' }), now),
  'expired',
  'срок вышел — не «готово», даже если сервер не успел сменить статус'
);
assert.equal(sandboxPhase(sb({ status: 'blocked' }), now), 'blocked');
assert.equal(sandboxPhase(sb({ status: 'weird' }), now), 'failed');
assert.equal(pollDelayMs(0), 2000);
assert.equal(pollDelayMs(100), 6000);
assert.equal(pollDelayMs(-5), 2000);
assert.equal(SANDBOX_QUESTION_MAX, 500);

assert.equal(sandboxIdFromLaunch('sb_AbC-123_x'), 'AbC-123_x');
assert.equal(sandboxIdFromLaunch('inv_abc'), null);
assert.equal(sandboxIdFromLaunch('sb_a"b'), null);
assert.equal(sandboxIdFromLaunch(null), null);
// 16 байт base64url (22 символа) влезают в sb_<id>.
assert.equal(sandboxIdFromLaunch(`sb_${'A'.repeat(22)}`), 'A'.repeat(22));

setPendingQuestion('Есть доставка?');
assert.equal(takePendingQuestion(), 'Есть доставка?');
assert.equal(takePendingQuestion(), null, 'вопрос берётся один раз');
setPendingQuestion('x'.repeat(900));
assert.equal(takePendingQuestion()!.length, 500);

// ═══ Документы ══════════════════════════════════════════════════════
// Зеркало KNOWLEDGE_DEFAULTS.documentMimeTypes / maxDocumentBytes.
const defaults = readFileSync(
  new URL('../../sites-backend/src/config/assist-defaults.ts', import.meta.url),
  'utf8'
);
const mimes = defaults.match(/documentMimeTypes:\s*\[([\s\S]*?)\]/);
assert.ok(mimes, 'assist-defaults.ts: нет documentMimeTypes');
assert.deepEqual(
  [...DOCUMENT_MIME_TYPES].sort(),
  [...mimes![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
);
assert.ok(/maxDocumentBytes:\s*20 \* 1024 \* 1024/.test(defaults));
assert.equal(MAX_DOCUMENT_BYTES, 20 * 1024 * 1024);
assert.ok(/maxHotPages:\s*10\b/.test(defaults));
assert.equal(MAX_HOT_PAGES, 10);

assert.deepEqual(
  checkUpload({ name: 'a.pdf', size: 10, type: 'application/pdf' }),
  {
    ok: true,
    mimeType: 'application/pdf',
  }
);
// Пустой type (WebView) — по расширению.
assert.deepEqual(checkUpload({ name: 'Прайс.MD', size: 10, type: '' }), {
  ok: true,
  mimeType: 'text/markdown',
});
assert.deepEqual(
  checkUpload({ name: 'a.md', size: 1, type: 'text/x-markdown' }),
  {
    ok: true,
    mimeType: 'text/markdown',
  }
);
assert.deepEqual(
  checkUpload({ name: 'a.csv', size: 1, type: 'text/csv; charset=utf-8' }),
  { ok: true, mimeType: 'text/csv' }
);
assert.deepEqual(checkUpload({ name: 'a.exe', size: 1, type: '' }), {
  ok: false,
  code: 'DOCUMENT_TYPE',
});
assert.deepEqual(
  checkUpload({ name: 'a.doc', size: 1, type: 'application/msword' }),
  {
    ok: false,
    code: 'DOCUMENT_TYPE',
  }
);
assert.deepEqual(
  checkUpload({
    name: 'a.pdf',
    size: MAX_DOCUMENT_BYTES + 1,
    type: 'application/pdf',
  }),
  { ok: false, code: 'DOCUMENT_TOO_LARGE' }
);
assert.equal(
  checkUpload({
    name: 'a.pdf',
    size: MAX_DOCUMENT_BYTES,
    type: 'application/pdf',
  }).ok,
  true
);
assert.deepEqual(exclusionForDocument({ id: 'd1', url: 'https://e.com/x' }), {
  kind: 'url',
  value: 'https://e.com/x',
});
assert.deepEqual(exclusionForDocument({ id: 'd1', url: null }), {
  kind: 'document',
  value: 'd1',
});

// ═══ Адреса ═════════════════════════════════════════════════════════
assert.equal(normalizePageUrl('e.com/delivery#x'), 'https://e.com/delivery');
assert.equal(normalizePageUrl('https://E.com/A?b=1'), 'https://e.com/A?b=1');
assert.equal(normalizePageUrl('http://e.com/'), null);
assert.equal(normalizePageUrl('https://e.com:8443/'), null);
assert.equal(normalizePageUrl('https://u:p@e.com/'), null);
assert.equal(normalizePageUrl('https://127.0.0.1/'), null);
assert.equal(normalizePageUrl('https://[::1]/'), null);
assert.equal(normalizePageUrl('localhost'), null);
assert.equal(normalizePageUrl('   '), null);
const l = parseUrlList(
  'e.com/a\nhttps://e.com/a, http://e.com/b  javascript:alert(1)'
);
assert.deepEqual(l.urls, ['https://e.com/a']);
assert.deepEqual(l.invalid, ['http://e.com/b', 'javascript:alert(1)']);
assert.equal(parseUrlList('a.com/1 a.com/2 a.com/3', 2).tooMany, true);

assert.deepEqual(normalizeSiteUrl('Shop.Example.com/catalog?x=1'), {
  ok: true,
  url: 'https://shop.example.com/',
  host: 'shop.example.com',
});
// www не срезается — отдельный хост (§3.3).
assert.equal(
  (normalizeSiteUrl('www.e.com') as { host: string }).host,
  'www.e.com'
);
assert.deepEqual(normalizeSiteUrl('http://e.com'), {
  ok: false,
  error: 'not_https',
});
assert.deepEqual(normalizeSiteUrl('10.0.0.1'), { ok: false, error: 'ip' });
assert.deepEqual(normalizeSiteUrl('e.com:8080'), { ok: false, error: 'port' });
assert.deepEqual(normalizeSiteUrl(''), { ok: false, error: 'empty' });

// Горячие страницы: ≤ 10, без дублей.
const ten = Array.from({ length: 10 }, (_, i) => `https://e.com/${i}`);
assert.deepEqual(toggleHot(ten, 'https://e.com/x', true), {
  ok: false,
  code: 'HOT_PAGES_LIMIT',
});
assert.deepEqual(toggleHot(ten, 'https://e.com/3', true), {
  ok: true,
  urls: [...ten.filter((u) => u !== 'https://e.com/3'), 'https://e.com/3'],
});
assert.equal(
  (toggleHot(ten, 'https://e.com/3', false) as { urls: string[] }).urls.length,
  9
);
assert.deepEqual(toggleHot([], 'https://e.com/a', true), {
  ok: true,
  urls: ['https://e.com/a'],
});

// ═══ Сводка ═════════════════════════════════════════════════════════
assert.deepEqual(langShares({ ru: 0.08, uk: 0.92, en: 0.001 }), [
  { lang: 'uk', pct: 92 },
  { lang: 'ru', pct: 8 },
]);
assert.equal(budgetShare({ capMicroUsd: 500000, spentMicroUsd: 125000 }), 0.25);
assert.equal(budgetShare({ capMicroUsd: 500000, spentMicroUsd: 900000 }), 1);
assert.equal(
  budgetShare({ capMicroUsd: 0, spentMicroUsd: 0 }),
  1,
  'нет потолка — нет бюджета'
);
assert.equal(formatUsd(500000), '$0.50');
assert.equal(formatUsd(-5), '$0.00');

// Песочница — owner|manager кабинета (создаёт сайт, как POST /sites).
assert.equal(canUseSandbox(member('manager')), true);
assert.equal(canUseSandbox(member('operator', { assist: 'manager' })), false);
// Адресов в источнике — не больше 20 (MAX_URLS_PER_SOURCE у K3).
assert.equal(MAX_URLS_PER_SOURCE, 20);
assert.equal(
  parseUrlList(Array.from({ length: 21 }, (_, i) => `e.com/${i}`).join(' '))
    .tooMany,
  true
);

// Подпись источника — как маркер в тексте ответа ([S#], sanitize.ts K3).
assert.equal(
  sourceRefLabel({ n: 3, title: 'Доставка', url: 'https://e.com/d' }),
  '[S3] Доставка'
);
assert.equal(
  sourceRefLabel({ n: 1, title: null, url: 'https://e.com/' }),
  '[S1] https://e.com/'
);
assert.equal(sourceRefLabel({ n: 2, title: null, url: null }), '[S2]');

// ═══ Необратимые действия — только в два нажатия (ConfirmButton) ═════
// Исключение удаляет фрагменты из всех версий (откат не вернёт), откат и
// публикация меняют то, что видят посетители, удаление — насовсем. Обычная
// <Button> с таким обработчиком — одно случайное касание в TMA.
{
  const IRREVERSIBLE =
    /\.(addExclusion|liftExclusion|deleteSource|deleteFaq|versionAction|allowQuarantined)\(/;
  /** Открывающие теги `<Tag …>` с учётом `{…}` (стрелки `=>` внутри). */
  const openTags = (src: string, tag: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`<${tag}\\b`, 'g');
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 0;
      let i = m.index + m[0].length;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      out.push(src.slice(m.index, i + 1));
    }
    return out;
  };
  const dir = new URL('../src/screens/knowledge/', import.meta.url);
  for (const file of [
    'ExclusionsTab.tsx',
    'FaqTab.tsx',
    'QuarantineTab.tsx',
    'SourcesTab.tsx',
    'VersionsTab.tsx',
  ]) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    // Обработчики, внутри которых зовётся необратимый метод клиента.
    const heads = [
      ...src.matchAll(
        /(?:function (\w+)\s*\(|const (\w+) = (?:async )?\([^)]*\)\s*=>)/g
      ),
    ];
    const handlers = heads
      .map((h, i) => ({
        name: h[1] ?? h[2],
        body: src.slice(h.index, heads[i + 1]?.index ?? src.length),
      }))
      .filter((h) => IRREVERSIBLE.test(h.body) && !/^[A-Z]/.test(h.name))
      .map((h) => h.name);
    for (const tag of openTags(src, 'Button')) {
      assert.equal(
        IRREVERSIBLE.test(tag),
        false,
        `${file}: необратимый вызов прямо в <Button>: ${tag}`
      );
      for (const h of handlers) {
        assert.equal(
          new RegExp(`\\b${h}\\b`).test(tag),
          false,
          `${file}: «${h}» (необратимо) висит на <Button> в одно нажатие`
        );
      }
    }
  }
  // Ручное «Исключить» во вкладке исключений — тоже в два нажатия.
  const ex = readFileSync(new URL('ExclusionsTab.tsx', dir), 'utf8');
  assert.ok(
    openTags(ex, 'ConfirmButton').some((t) => /\badd\(\)/.test(t)),
    'ExclusionsTab: «Исключить» не через ConfirmButton'
  );
}

console.log('knowledge-view: ok');
