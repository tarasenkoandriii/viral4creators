/**
 * Э6-бис (г) без браузера: мастер проверки Т-2 в iframe (обмен ссылки,
 * шаги, отчёт, продолжение после перехода, истёкшая сессия), строгий разбор
 * разметки от check.js, протокол `voiceTest`/`vt-*`, выпуск в конфиге
 * загрузчика, согласие «натискати за вас» с версией текста и отзывом
 * (решение владельца 03.10.2026 п.3), паритет текстов мастера, сборка
 * выпусков канарейки (`scripts/release.mjs`).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VT_DICTS } from '../src/chat/i18n-vt';
import { DICTS } from '../src/chat/i18n';
import {
  UiPlanController,
  VC_CONSENT_VERSION,
  uiPlanOff,
  type UiPlanUi,
} from '../src/chat/ui-plan';
import {
  VoiceTestController,
  dryOk,
  parseMarkup,
  vtOff,
  type VtHost,
  type VtUi,
} from '../src/chat/voice-test';
import { parseLoaderConfig } from '../src/shared/config';
import {
  envelope,
  parseFrameMessage,
  parseParentMessage,
  type FrameMessage,
} from '../src/shared/protocol';

// ── тексты мастера: паритет ключей uk/ru/en ──────────────────────────────
{
  const shape = (o: unknown): unknown =>
    Array.isArray(o)
      ? o.length
      : o && typeof o === 'object'
        ? Object.fromEntries(
            Object.keys(o as object)
              .sort()
              .map((k) => [k, shape((o as Record<string, unknown>)[k])])
          )
        : typeof o;
  assert.deepEqual(shape(VT_DICTS.ru), shape(VT_DICTS.uk), 'ru ≠ uk');
  assert.deepEqual(shape(VT_DICTS.en), shape(VT_DICTS.uk), 'en ≠ uk');
}

// ── решение владельца п.3: версия текста согласия ─────────────────────────
{
  // Текст согласия поменяли — поднимите VC_CONSENT_VERSION и отпечаток:
  // каждый посетитель увидит вопрос заново.
  const FINGERPRINT: Record<string, string> = { '1': '250b69021cdc43be' };
  const fp = createHash('sha256')
    .update(
      JSON.stringify(['uk', 'ru', 'en'].map((l) => DICTS[l as 'uk'].vcConsent))
    )
    .digest('hex')
    .slice(0, 16);
  assert.equal(
    FINGERPRINT[VC_CONSENT_VERSION],
    fp,
    'текст согласия изменился — поднимите VC_CONSENT_VERSION'
  );
  // Согласие — с версией; другая версия = не дано; отзыв — снимает.
  const store = new Map<string, string>();
  let ui: UiPlanUi = uiPlanOff();
  const feed: string[] = [];
  const pc = new UiPlanController({
    ui: () => ui,
    setUi: (p) => (ui = { ...ui, ...p }),
    t: () => DICTS.uk,
    lang: () => 'uk',
    cfg: () => ({
      mode: 'on',
      denySelectors: [],
      allowSelectors: [],
      maxSteps: 6,
      memos: false,
    }),
    api: async () => null,
    toParent: () => undefined,
    conversationId: () => null,
    setConversation: () => undefined,
    feed: (_r, t) => feed.push(t),
    storage: (_k, n, v) => {
      if (v === undefined) return store.get(n) ?? null;
      if (v === null) store.delete(n);
      else store.set(n, v);
      return null;
    },
    pageUrl: () => null,
    listen: () => undefined,
    random: () => 'r'.repeat(16),
  });
  assert.equal(pc.consented(), false);
  store.set('vcconsent', '0');
  assert.equal(pc.consented(), false, 'старая версия — спросить снова');
  store.set('vcconsent', VC_CONSENT_VERSION);
  assert.equal(pc.consented(), true);
  pc.revokeConsent();
  assert.equal(pc.consented(), false, 'отзыв снимает согласие');
  assert.equal(feed.at(-1), DICTS.uk.vcRevoked);
}

// ── протокол: ссылка мастера в init, vt-* к чанку проверки ────────────────
{
  const init = parseParentMessage(
    envelope({
      type: 'init',
      pk: 'pk_live_abcdefgh',
      parentOrigin: 'https://shop.example.com',
      page: { url: 'https://shop.example.com/', title: 't' },
      uiLang: 'uk',
      mode: 'float',
      siteFont: null,
      siteTheme: null,
      previewToken: null,
      voiceTest: 'tok_ABCDEFGH12345678',
      restoreOpen: false,
    })
  );
  assert.equal(
    init && init.type === 'init' && init.voiceTest,
    'tok_ABCDEFGH12345678'
  );
  const bad = parseParentMessage(
    envelope({
      type: 'init',
      pk: 'pk_live_abcdefgh',
      parentOrigin: 'https://shop.example.com',
      page: { url: 'https://shop.example.com/', title: 't' },
      uiLang: 'uk',
      mode: 'float',
      voiceTest: '<script>',
    })
  );
  assert.equal(bad && bad.type === 'init' && bad.voiceTest, null);
  for (const t of ['vt-env', 'vt-markup', 'vt-mark'])
    assert.equal(parseFrameMessage(envelope({ type: t }))?.type, 'ui-raw', t);
  const r = parseParentMessage(
    envelope({
      type: 'vt-result',
      rid: 'abcdefgh12',
      op: 'env',
      data: { csp: 0 },
    })
  );
  assert.equal(r?.type, 'vt-result');
  assert.equal(
    parseParentMessage(
      envelope({ type: 'vt-result', rid: 'x', op: 'env', data: {} })
    ),
    null,
    'плохой rid'
  );
  assert.equal(
    parseParentMessage(
      envelope({ type: 'vt-result', rid: 'abcdefgh12', op: 'rm', data: {} })
    ),
    null,
    'чужая операция'
  );
}

// ── конфиг загрузчика: выпуск (канарейка) ─────────────────────────────────
{
  assert.equal(
    parseLoaderConfig({ release: '2026.10.05-1' }).release,
    '2026.10.05-1'
  );
  assert.equal(parseLoaderConfig({ release: '../x' }).release, null);
  assert.equal(parseLoaderConfig({}).release, null);
}

// ── разбор разметки check.js ──────────────────────────────────────────────
{
  const { markup, suspicious } = parseMarkup({
    total: 12,
    withId: 3,
    unnamed: [
      { key: 'u0', tag: 'button', selector: 'header > button' },
      { key: 'bad' },
    ],
    suspicious: [
      {
        key: 's0',
        why: 'icon_trash',
        tag: 'button',
        label: '',
        selector: 'button.trash',
      },
      { key: 's1', why: 'evil', tag: 'a', label: '', selector: '' },
    ],
    duplicates: [{ name: 'Купити', count: 4 }],
    closedShadow: -5,
  });
  assert.equal(markup.total, 12);
  assert.deepEqual(
    markup.unnamed.map((x) => x.key),
    ['u0']
  );
  assert.equal(markup.closedShadow, 0);
  assert.deepEqual(
    suspicious.map((x) => x.key),
    ['s0']
  );
}

// ── мастер: полный проход на подделке хоста ──────────────────────────────
async function wizard() {
  let ui: VtUi = vtOff();
  const store = new Map<string, string>();
  const sent: FrameMessage[] = [];
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let session: string | null = null;
  let cfg: unknown = null;
  let listened = 0;
  let now = 1_000_000;
  const plansRun: string[] = [];
  const host: VtHost = {
    ui: () => ui,
    setUi: (p) => (ui = { ...ui, ...p }),
    t: () => VT_DICTS.uk,
    lang: () => 'uk',
    api: async (_m, path, body) => {
      calls.push({ path, body: body as Record<string, unknown> });
      if (path.endsWith('/session'))
        return {
          session: 's'.repeat(43),
          testId: 'test1',
          expiresAt: new Date(now + 1_800_000).toISOString(),
          testHost: false,
          voiceControl: {
            mode: 'on',
            denySelectors: ['#x'],
            allowSelectors: [],
            maxSteps: 6,
          },
        };
      if (path.endsWith('/analyze'))
        return {
          commands: [
            { text: 'відкрий «Доставка»', safe: true },
            { text: 'знайди Футболки', safe: true },
          ],
          forbidden: [
            {
              kind: 'pay',
              command: 'оплати',
              candidates: 1,
              blocked: true,
              reasons: ['payment'],
            },
          ],
          never: [{ text: 'Видалити', reason: 'danger' }],
        };
      if (path.endsWith('/report'))
        return {
          result: 'pass',
          validUntil: '2026-11-02T00:00:00.000Z',
          report: {
            items: [{ step: 1, level: 'ok', code: 'ok' }],
            fragment: '<!-- x -->',
          },
        };
      throw Object.assign(new Error('x'), { code: 'NOT_FOUND' });
    },
    toParent: (m) => {
      sent.push(m);
      // Чанк проверки отвечает сразу.
      if (m.type === 'vt-env')
        queueMicrotask(() =>
          vt.onResult(m.rid, { widget: true, chunks: true, csp: 0, tt: 0 })
        );
      if (m.type === 'vt-markup')
        queueMicrotask(() =>
          vt.onResult(m.rid, {
            total: 5,
            withId: 1,
            unnamed: [],
            suspicious: [
              {
                key: 's0',
                why: 'icon_trash',
                tag: 'button',
                label: '',
                selector: 'button.t',
              },
              {
                key: 's1',
                why: 'class_danger',
                tag: 'a',
                label: 'Видалити',
                selector: 'a.rm',
              },
            ],
          })
        );
    },
    storage: (n, v) => {
      if (v === undefined) return store.get(n) ?? null;
      if (v === null) store.delete(n);
      else store.set(n, v);
      return null;
    },
    setSession: (s) => (session = s),
    setVoiceControl: (c) => (cfg = c),
    random: () => Math.random().toString(36).slice(2, 12).padEnd(10, 'a'),
    now: () => now,
    micPolicy: () => 'allowed',
    micProbe: async () => 'ok',
    listen: () => listened++,
    plans: {
      snap: async () => ({ url: 'https://shop.example.com/', elements: [] }),
      dry: async () => ({
        kind: 'plan',
        planId: 'p1',
        conversationId: null,
        status: 'done',
        steps: [
          {
            i: 0,
            kind: 'click',
            target: {
              ref: 'e1',
              assistId: null,
              role: 'link',
              text: 'Доставка',
              selector: null,
              href: null,
            },
            value: null,
            expect: null,
            risk: 'auto',
            reason: null,
            nav: true,
            say: null,
            state: 'pending',
          },
        ],
        currentStep: 0,
        notes: [],
        needsConfirm: false,
        stepsHash: 'h',
        marks: ['nav'],
        pnr: null,
        pnrConfirm: false,
        memo: null,
        repeat: false,
        goalStatus: null,
        chainStatus: null,
      }),
      command: async (text) => {
        plansRun.push(text);
        return true;
      },
    },
  };
  const vt = new VoiceTestController(host);
  assert.equal(await vt.start('t'.repeat(32)), true);
  assert.equal(session, 's'.repeat(43));
  assert.deepEqual(cfg, {
    mode: 'on',
    denySelectors: ['#x'],
    allowSelectors: [],
    maxSteps: 6,
    memos: false,
  });
  assert.equal(ui.step, 1);
  assert.deepEqual(ui.env, {
    widget: true,
    chunks: true,
    csp: 0,
    tt: 0,
    micPolicy: 'allowed',
  });
  vt.go(2);
  await vt.mic();
  assert.equal(ui.mic, 'ok');
  assert.equal(listened, 1);
  assert.equal(vt.heard('перевірка зв’язку'), true);
  assert.equal(ui.heard, 'перевірка зв’язку');
  vt.go(3);
  assert.equal(vt.heard('інше'), false, 'вне шага «микрофон» речь — обычная');
  await vt.markup({
    mode: 'on',
    denySelectors: ['#x'],
    allowSelectors: [],
    maxSteps: 6,
    memos: false,
  });
  const mk = sent.find((m) => m.type === 'vt-markup') as Extract<
    FrameMessage,
    { type: 'vt-markup' }
  >;
  assert.deepEqual(mk.deny, ['#x']);
  // «Видалити» уже в списке 1 (сервер распознал) — в списке 2 его нет.
  assert.deepEqual(
    ui.suspicious.map((s) => s.key),
    ['s0']
  );
  assert.equal(ui.safe.length, 2);
  assert.ok(store.get('vtsnap'), 'снимок страницы сохранён для отчёта');
  vt.review('s0', 'deny');
  vt.review('nope', 'safe');
  assert.deepEqual(ui.reviewed, { s0: 'deny' });
  vt.mark(['s0']);
  assert.deepEqual(sent.at(-1), { type: 'vt-mark', keys: ['s0'] });
  vt.mark(['s0']);
  assert.deepEqual(
    sent.at(-1),
    { type: 'vt-mark', keys: [] },
    'повтор — снять обводку'
  );
  vt.go(4);
  await vt.dryRun('відкрий «Доставка»');
  await vt.dryRun('відкрий «Доставка»');
  assert.equal(ui.dry.length, 1, 'одна и та же команда — один прогон');
  vt.markDry(0, 0, true);
  assert.equal(dryOk(ui.dry[0]), 1);
  vt.go(5);
  await vt.safeRun(0);
  assert.deepEqual(plansRun, ['відкрий «Доставка»']);
  assert.equal(ui.safe[0].state, 'running');
  vt.planDone('done');
  assert.equal(ui.safe[0].state, 'done');

  // Переход страницы (MPA): новое окно iframe — мастер продолжается с шага 5.
  const saved = new Map(store);
  let ui2: VtUi = vtOff();
  let sess2: string | null = null;
  const vt2 = new VoiceTestController({
    ...host,
    ui: () => ui2,
    setUi: (p) => (ui2 = { ...ui2, ...p }),
    storage: (n, v) => {
      if (v === undefined) return saved.get(n) ?? null;
      if (v === null) saved.delete(n);
      else saved.set(n, v);
      return null;
    },
    setSession: (s) => (sess2 = s),
  });
  assert.equal(vt2.resume(), true);
  assert.equal(ui2.step, 5);
  assert.equal(sess2, 's'.repeat(43));
  assert.equal(ui2.safe[0].state, 'done');

  vt.go(6);
  await vt.report(ui.env, ui.mic);
  const rep = calls.find((c) => c.path.endsWith('/report'))!.body;
  assert.deepEqual(rep.dry, [{ planId: 'p1', ok: 1 }]);
  assert.deepEqual(rep.reviewed, { s0: 'deny' });
  assert.equal(rep.mic, 'ok');
  assert.ok(rep.snapshot, 'снимок страницы — в отчёте');
  assert.equal(ui.step, 7);
  assert.equal(ui.result?.result, 'pass');
  // Сессия закрыта сдачей: заголовок и режим сняты, хранилище очищено.
  assert.equal(session, null);
  assert.equal(cfg, null);
  assert.equal(store.get('vtsess'), undefined);

  // Истёкшая сессия: продолжения нет, следы стёрты.
  const old = new Map<string, string>([
    ['vtsess', JSON.stringify({ s: 'x'.repeat(43), e: now - 1, cfg: {} })],
    ['vt', '{}'],
  ]);
  let ui3: VtUi = vtOff();
  const vt3 = new VoiceTestController({
    ...host,
    ui: () => ui3,
    setUi: (p) => (ui3 = { ...ui3, ...p }),
    storage: (n, v) => {
      if (v === undefined) return old.get(n) ?? null;
      if (v === null) old.delete(n);
      else old.set(n, v);
      return null;
    },
  });
  now += 1;
  assert.equal(vt3.resume(), false);
  assert.equal(old.size, 0);
  assert.equal(ui3.active, false);

  // Ссылка недействительна — «получите новую».
  let ui4: VtUi = vtOff();
  const vt4 = new VoiceTestController({
    ...host,
    ui: () => ui4,
    setUi: (p) => (ui4 = { ...ui4, ...p }),
    api: async () => {
      throw Object.assign(new Error('x'), { code: 'VOICE_TEST_INVALID' });
    },
  });
  assert.equal(await vt4.start('t'.repeat(32)), false);
  assert.equal(ui4.error, 'expired');
}
await wizard();

// ── выпуски канарейки: release.mjs ────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'v4c-rel-'));
  mkdirSync(join(dir, 'v1'), { recursive: true });
  for (const f of [
    'chat.js',
    'chat.css',
    'voice.js',
    'engage.js',
    'highlight.js',
    'act.js',
    'undo.js',
    'check.js',
    'vt.js',
  ])
    writeFileSync(join(dir, 'v1', f), `/* ${f} */`);
  const cfgPath = join(dir, 'release.json');
  writeFileSync(cfgPath, JSON.stringify({ current: null, keep: [] }));
  const run = (env: Record<string, string>) =>
    execFileSync('node', ['scripts/release.mjs'], {
      env: {
        ...process.env,
        WIDGET_DIST: dir,
        WIDGET_RELEASE_CONFIG: cfgPath,
        ...env,
      },
      stdio: 'pipe',
    }).toString();
  assert.match(run({}), /выпусков нет/);
  run({ WIDGET_RELEASE: '2026.10.05-1' });
  assert.ok(existsSync(join(dir, 'v1', 'r', '2026.10.05-1', 'vt.js')));
  assert.equal(
    readFileSync(join(dir, 'v1', 'r', '2026.10.05-1', 'act.js'), 'utf8'),
    '/* act.js */'
  );
  assert.throws(() => run({ WIDGET_RELEASE: '../evil' }), 'недопустимое имя');
  writeFileSync(
    cfgPath,
    JSON.stringify({ current: null, keep: ['2026.10.01-1'] })
  );
  assert.throws(
    () => run({}),
    'keep без WIDGET_RELEASE_ORIGIN — сборка падает'
  );
}

console.log('voice-test: ok');
