/**
 * Гид «Админка» помощника платформы (Э-С Ш6): разбор конфигурации,
 * загрузчик, обновление JWT, очередь `V4CAssist` — и шов разметки:
 * кнопки оплаты, удаления и запуска рендера в TMA несут
 * `data-assist="never"` (исполнитель «Админки» их не нажмёт никогда),
 * разовые платные действия — `data-assist="confirm"` (Р-Ш6-11: только
 * после карточки подтверждения), кнопки шагов степпера —
 * `data-assist-id`. Обратная проверка (хвост (12)) — разбор исходников
 * `src/` (`scripts/assist-marks.ts`): вызов платной/опасной функции из
 * обработчика элемента без пометки роняет тест.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  analyzeAssistMarks,
  type ElementHit,
  type LooseHit,
  type PaidApis,
  type Tier,
} from './assist-marks';
import {
  GUIDE_ASSIST_GLOBAL,
  GUIDE_ASSIST_SCRIPT_ID,
  GUIDE_IDENTITY_EVENT,
  GUIDE_JWT_MIN_DELAY_MS,
  assistOriginOf,
  callAssist,
  guideAssistLang,
  identityFailureOf,
  loaderAttributes,
  notifyIdentityChanged,
  parseGuideAssistConfig,
  parseIdentity,
  refreshDelayMs,
} from '../src/lib/guide-assist';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const ON = {
  engine: 'assist',
  pk: 'pk_live_v4c',
  origin: 'https://assist-wa.viral4creators.app',
};

it('конфигурация: assist целиком или старый гид', () => {
  assert.deepEqual(parseGuideAssistConfig(ON), ON);
  assert.deepEqual(parseGuideAssistConfig(null), { engine: 'legacy' });
  assert.deepEqual(parseGuideAssistConfig({ engine: 'legacy' }), {
    engine: 'legacy',
  });
  for (const bad of [
    { ...ON, pk: 'sk_live_x' },
    { ...ON, pk: undefined },
    { ...ON, origin: 'http://assist-wa.viral4creators.app' },
    { ...ON, origin: 'https://wa.x.app/evil' },
    { ...ON, origin: 'javascript:alert(1)' },
    { ...ON, origin: 'https://wa.x.app:444' },
  ]) {
    assert.deepEqual(parseGuideAssistConfig(bad), { engine: 'legacy' });
  }
});

it('origin: localhost — только с тестовым ключом', () => {
  assert.equal(
    assistOriginOf('http://localhost:5199', 'pk_test_x'),
    'http://localhost:5199'
  );
  assert.equal(assistOriginOf('http://localhost:5199', 'pk_live_x'), null);
});

it('загрузчик: src с origin «Админки», data-mode=admin, язык виджета', () => {
  const cfg = parseGuideAssistConfig(ON);
  assert.equal(cfg.engine, 'assist');
  if (cfg.engine !== 'assist') return;
  const l = loaderAttributes(cfg, 'de');
  assert.equal(l.src, 'https://assist-wa.viral4creators.app/v1/loader.js');
  assert.deepEqual(l.attrs, {
    id: GUIDE_ASSIST_SCRIPT_ID,
    'data-site': 'pk_live_v4c',
    'data-mode': 'admin',
    'data-lang': 'en',
  });
  assert.equal(guideAssistLang('uk'), 'uk');
  assert.equal(guideAssistLang('ru'), 'ru');
  assert.equal(guideAssistLang('es'), 'en');
});

it('JWT: форма проверяется, мусор — null', () => {
  assert.deepEqual(parseIdentity({ jwt: 'a.b.c', exp: 10 }), {
    jwt: 'a.b.c',
    exp: 10,
  });
  assert.equal(parseIdentity({ jwt: 'a.b', exp: 10 }), null);
  assert.equal(parseIdentity({ jwt: 'a.b.c<', exp: 10 }), null);
  assert.equal(parseIdentity({ jwt: 'a.b.c' }), null);
  assert.equal(parseIdentity(null), null);
});

it('обновление JWT — за 90 с до истечения, не чаще 15 с', () => {
  const now = 1_000_000_000_000;
  assert.equal(refreshDelayMs(now / 1000 + 600, now), 510_000);
  assert.equal(refreshDelayMs(now / 1000 + 30, now), GUIDE_JWT_MIN_DELAY_MS);
  assert.equal(refreshDelayMs(now / 1000 - 30, now), GUIDE_JWT_MIN_DELAY_MS);
});

it('V4CAssist до загрузки — в очередь q; после — прямой вызов', () => {
  const w: Record<string, unknown> = {};
  callAssist(w, 'identify-admin', 'a.b.c');
  callAssist(w, 'logout');
  const stub = w[GUIDE_ASSIST_GLOBAL] as { q?: unknown[][] };
  assert.deepEqual(stub.q, [['identify-admin', 'a.b.c'], ['logout']]);
  const calls: unknown[][] = [];
  w[GUIDE_ASSIST_GLOBAL] = (...a: unknown[]) => calls.push(a);
  callAssist(w, 'identify-admin', 'x.y.z');
  assert.deepEqual(calls, [['identify-admin', 'x.y.z']]);
});

it('отказ выдачи JWT: выход/флаг — logout, сбой сети/сервера — повтор (аудит Ш6)', () => {
  for (const st of [401, 403, 404]) assert.equal(identityFailureOf(st), 'off');
  for (const st of [undefined, 0, 429, 500, 502, 503])
    assert.equal(identityFailureOf(st), 'retry');
});

it('смена личности: событие окна, мини-апп и кнопка входа его используют', () => {
  const t = new EventTarget();
  let got = 0;
  t.addEventListener(GUIDE_IDENTITY_EVENT, () => (got += 1));
  notifyIdentityChanged(t);
  assert.equal(got, 1);
  const btn = readFileSync('src/components/TelegramLoginButton.tsx', 'utf8');
  for (const call of [
    'await telegramLoginCallback(payload);',
    'await devLoginTelegram(DEV_USER_ID);',
    'await logoutTelegram();',
  ]) {
    const at = btn.indexOf(call);
    assert.ok(at >= 0, call);
    assert.ok(
      /^\s*notifyIdentityChanged\(\);/.test(btn.slice(at + call.length)),
      `${call} без notifyIdentityChanged()`
    );
  }
  const mount = readFileSync('src/components/GuideAssistMount.tsx', 'utf8');
  assert.ok(
    mount.includes('addEventListener(GUIDE_IDENTITY_EVENT, onIdentityChanged)')
  );
  assert.ok(
    mount.includes(
      'removeEventListener(GUIDE_IDENTITY_EVENT, onIdentityChanged)'
    )
  );
});

// ── Шов разметки «никогда» (Ш6, решение Р-Ш6-3) ─────────────────────

/**
 * Открывающий тег элемента, внутри которого стоит `needle`: от последнего
 * `<Button`/`<button`/`<Card` до `needle`. В нём обязан быть атрибут.
 */
function tagAround(src: string, needle: string, from = 0): string {
  const at = src.indexOf(needle, from);
  assert.ok(at >= 0, `не найдено: ${needle}`);
  const open = Math.max(
    src.lastIndexOf('<Button', at),
    src.lastIndexOf('<button', at),
    src.lastIndexOf('<input', at)
  );
  assert.ok(open >= 0 && at - open < 600, `тег не найден: ${needle}`);
  return src.slice(open, at + needle.length);
}

/** Все вхождения `needle` (у одной кнопки бывает две копии в ветках). */
function tagsAround(src: string, needle: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf(needle); at >= 0; at = src.indexOf(needle, at + 1))
    out.push(tagAround(src, needle, at));
  assert.ok(out.length > 0, `не найдено: ${needle}`);
  return out;
}

const NEVER: Array<[string, string]> = [
  ['src/features/plan/PlanScreen.tsx', "buy(id, 'STARS')"],
  ['src/features/plan/PlanScreen.tsx', "buy(id, 'WAYFORPAY')"],
  ['src/features/credits/CreditsScreen.tsx', "buy(pack, 'STARS')"],
  ['src/features/credits/CreditsScreen.tsx', "buy(pack, 'WAYFORPAY')"],
  ['src/features/projects/ProjectScreen.tsx', 'onClick={onDeleteProject}'],
  ['src/features/brand/ManifestScreen.tsx', 'onClick={onDelete}'],
  ['src/features/brand/ManifestScreen.tsx', 'void onDelete()'],
  ['src/features/brand/VoicePicker.tsx', 'void remove(v)'],
  ['src/features/persona/PersonaDelete.tsx', 'void remove([s])'],
  ['src/features/persona/PersonaDelete.tsx', 'void remove(left)'],
  ['src/features/generation/GenerationWizard.tsx', 'startGenerateVideo('],
  ['src/features/generation/ExportPanel.tsx', 'void onRerender('],
  ['src/features/generation/RevoicePanel.tsx', 'void onSubmit()'],
  ['src/features/projects/greeting/VideoStep.tsx', 'data-qa="greeting-render"'],
  ['src/features/projects/greeting/VideoStep.tsx', 'void revoice()'],
  // Аудит Ш6 (05.10.2026): пути, которые первая разметка пропустила.
  // Списание кредитов — пакетный рендер каталога и его повторы, A/B-тест.
  ['src/features/projects/CatalogBatchStartScreen.tsx', 'void onSubmit()'],
  [
    'src/features/projects/CatalogBatchProgressScreen.tsx',
    'onClick={retryAll}',
  ],
  [
    'src/features/projects/CatalogBatchProgressScreen.tsx',
    'retryItem(item.productItemId)',
  ],
  ['src/features/generation/AbTestPanel.tsx', 'void onCreate()'],
  // Смена тарифа без оплаты — тоже «оплата» (Р-Ш6-3).
  ['src/features/plan/PlanScreen.tsx', "cancelSubscription('LITE')"],
  ['src/features/plan/PlanScreen.tsx', 'onClick={() => void switchTo(id)}'],
  // Согласия — юридическое действие человека: оферта, биометрия
  // персоны, рассылка, клон голоса (платный, с согласием).
  ['src/features/plan/PlanScreen.tsx', 'void toggleConsent()'],
  ['src/components/TermsGate.tsx', 'data-qa="terms-accept-checkbox"'],
  ['src/components/TermsGate.tsx', 'data-qa="terms-accept-submit"'],
  [
    'src/features/persona/PersonaConsentStep.tsx',
    'setChecked(e.target.checked)',
  ],
  ['src/features/persona/PersonaConsentStep.tsx', 'onAccepted(consent)'],
  ['src/features/brand/VoicePicker.tsx', 'setConsent(e.target.checked)'],
  ['src/features/brand/VoicePicker.tsx', '{t.submitButton}'],
  ['src/features/persona/PersonaVoice.tsx', '{t.voiceSubmit}'],
  // Удаление и отзыв с `window.confirm` (в WebView Telegram его часто нет).
  ['src/features/generation/ReferenceSlotsPanel.tsx', 'deleteSceneConfirm'],
  [
    'src/features/projects/greeting/ReferencesStep.tsx',
    'deleteReferenceConfirm',
  ],
  ['src/features/projects/ClientSiteWizard.tsx', 'onClick={props.onDiscard}'],
  ['src/features/projects/ClientSiteWizard.tsx', '{t.dangerConfirm}'],
  ['src/features/api-keys/ApiKeysScreen.tsx', 'void issue()'],
  ['src/features/api-keys/ApiKeysScreen.tsx', 'void revoke(key)'],
  ['src/features/channels/ChannelsScreen.tsx', 'void disconnect(c)'],
  ['src/features/generation/PublishPanel.tsx', 'void withdraw('],
  ['src/features/generation/ShareVideoPanel.tsx', 'void withdraw(p)'],
  // Обратная проверка (хвост (12), 06.10.2026) нашла ещё четыре: экспорт
  // в форматы — это рендер; съёмка персоны уходит с `consent: true`;
  // согласие на вход в аккаунт сайта обучалки; согласие на лицо в
  // фото поздравления.
  ['src/features/generation/ExportPanel.tsx', 'void onExportSelected()'],
  ['src/features/persona/PersonaCaptureStep.tsx', 'onClick={submit}'],
  ['src/features/projects/ClientSiteWizard.tsx', '{t.consentButton}'],
  [
    'src/features/projects/greeting/ReferencesStep.tsx',
    'if (e.target.checked) onConfirm();',
  ],
];

it('оплата, удаление, рендер — data-assist="never" на самой кнопке', () => {
  for (const [file, needle] of NEVER) {
    const src = readFileSync(file, 'utf8');
    for (const tag of tagsAround(src, needle))
      assert.ok(
        tag.includes('data-assist="never"'),
        `${file}: «${needle}» без data-assist="never"`
      );
  }
});

it('повтор рендера поздравления — тоже «никогда»', () => {
  const src = readFileSync(
    'src/features/projects/greeting/VideoStep.tsx',
    'utf8'
  );
  const retry = src.indexOf('{w.retryButton}');
  const tag = src.slice(src.lastIndexOf('<Button', retry), retry);
  assert.ok(tag.includes('data-assist="never"'));
});

// ── Р-Ш6-11: разовые платные действия — «с подтверждением» ──────────

/**
 * Решение владельца 05.10.2026: одиночное платное действие, которое
 * человек сам просит голосом/текстом, гид выполняет только после
 * карточки подтверждения (цена/списание — если видны на странице).
 * Запуск/повтор рендера, пакеты, A/B, оплата, удаление, отзыв,
 * согласия — остаются в `NEVER`.
 */
const CONFIRM: Array<[string, string]> = [
  ['src/features/postprod/AudioTracksPanel.tsx', 'void runBuild([locale])'],
  ['src/features/sketch/SketchSheet.tsx', 'onClick={() => void generate()}'],
  ['src/features/persona/PersonaBaseStep.tsx', 'onClick={onRegenerate}'],
  [
    'src/features/projects/greeting/ReferencesStep.tsx',
    'generateGreetingReferenceFrame(sessionId)',
  ],
  [
    'src/features/projects/greeting/ReferencesStep.tsx',
    'generateGreetingReferenceFrame(sessionId, setting)',
  ],
  ['src/features/projects/greeting/ReferencesStep.tsx', 'void suggest()'],
  [
    'src/features/projects/greeting/ScriptStep.tsx',
    '{w.regenerateScriptButton}',
  ],
  ['src/features/projects/greeting/ScriptStep.tsx', '{w.generateScriptButton}'],
  ['src/features/generation/GenerationWizard.tsx', 'onClick={generatePrompt}'],
  [
    'src/features/generation/PublishPanel.tsx',
    '{dict.publishPanel.submitToModeration}',
  ],
  [
    'src/features/generation/ShareVideoPanel.tsx',
    '{dict.shareVideoPanel.submitToModeration}',
  ],
  ['src/features/projects/ClientSiteWizard.tsx', 'onClick={props.onFinish}'],
  [
    'src/features/persona/PersonaLooks.tsx',
    '{busy ? t.creating : t.createLook}',
  ],
];

it('Р-Ш6-11: разовые платные действия — data-assist="confirm"', () => {
  for (const [file, needle] of CONFIRM) {
    const src = readFileSync(file, 'utf8');
    for (const tag of tagsAround(src, needle))
      assert.ok(
        tag.includes('data-assist="confirm"'),
        `${file}: «${needle}» без data-assist="confirm"`
      );
  }
});

// ── Обратная проверка (хвост (12)): платный вызов → пометка ─────────

const N: Tier = 'never';
const C: Tier = 'confirm';

/**
 * Платные и опасные функции TMA. Как пополнять: новая функция в
 * `src/services/*-api.ts` (или обёртка в `src/lib`), которая
 *  - платит/меняет тариф, удаляет, отзывает, принимает согласие или
 *    запускает рендер/пакет/A/B → `N` (`never`);
 *  - разово тратит кредиты или лимит генераций — серверный маршрут зовёт
 *    `PlanService.assertCanSpend*`/квоту (сценарий, кадр, эскиз, проба
 *    голоса, разбор, проверка), отправляет на модерацию/сборку → `C`.
 * Не входят (и почему): ввод самого человека, который исполнитель не
 * сделает, — загрузка файлов (`uploadAndProcessPhoto`,
 * `uploadGreetingReference`, образцы голоса), голосовой ввод
 * (`understandVoice`, `uploadAndTranscribeVoice`); поиск без артефакта
 * (`searchYoutube`); старый гид (`wizard-guide-api`).
 * Вызов из списка, до которого разбор не нашёл помеченного элемента, —
 * падение с `файл:строка`; путь, который нельзя разметить, — в
 * `ASSIST_ALLOW` с обоснованием.
 */
const PAID: PaidApis = {
  'src/services/billing-api.ts': {
    startSubscriptionCheckout: N,
    startCreditPackCheckout: N,
    submitWayForPayForm: N,
  },
  'src/services/projects-api.ts': {
    setPlan: N,
    acceptTerms: N,
    deleteProject: N,
    deleteItem: N,
    deleteBrandManifest: N,
    deleteBrandCharacter: N,
    deleteBrandScene: N,
    deleteUserVoice: N,
    cloneUserVoice: N,
    deleteScene: N,
    withdrawPublication: N,
    withdrawSharedVideo: N,
    disconnectChannel: N,
    requestPublication: C,
    createSharedVideo: C,
    generateCharacterPreview: C,
    runAudit: C,
    applyAuditFix: C,
    runSoundCheck: C,
    runRelevance: C,
    previewVoice: C,
  },
  'src/services/api.ts': {
    generateVideo: N,
    generatePrompt: C,
    triggerAnalysis: C,
  },
  'src/services/ab-test-api.ts': { startAbTest: N },
  'src/services/catalog-batch-api.ts': {
    startCatalogBatch: N,
    retryCatalogBatch: N,
  },
  'src/services/export-api.ts': {
    startExportBatch: N,
    startExportRerender: N,
  },
  'src/services/postprod-api.ts': {
    reVoiceVideo: N,
    deletePostprodVideo: N,
  },
  'src/services/greeting-api.ts': {
    startGreetingVideo: N,
    deleteGreetingReference: N,
    generateGreetingReferenceFrame: C,
    suggestGreetingSceneSettings: C,
    generateGreetingPrompt: C,
  },
  'src/services/audio-tracks-api.ts': { buildAudioTrack: C },
  'src/services/sketch-api.ts': {
    generateSketch: C,
    deleteSketchOriginal: N,
  },
  'src/services/persona-api.ts': {
    createPersona: N, // уходит с `consent: true` — согласие на биометрию
    deletePersona: N,
    deleteLook: N,
    unpublishShare: N,
    clonePersonaVoice: N,
    verifyPersona: C,
    createLook: C,
    regenerateBaseLook: C,
  },
  'src/services/api-keys-api.ts': { issueApiKey: N, revokeApiKey: N },
  'src/services/marketing-api.ts': {
    acceptMarketingConsent: N,
    revokeMarketingConsent: N,
  },
  'src/services/client-site-tutorial-api.ts': {
    acceptAccountConsent: N,
    deleteSiteTutorial: N,
    finishSiteTutorial: C,
    exploreSite: C,
    stepSite: C,
    loginSite: C,
    refreshSiteTutorial: C,
    startLiveLogin: C,
  },
  'src/services/test-accounts-api.ts': { forgetTestAccount: N },
  'src/lib/persona-greeting-api.ts': { confirmReferenceFaceConsent: N },
};

/**
 * Пути, которые разметить нельзя или не нужно, — с обоснованием. Запись
 * снимает функцию `api` с находок в файле `file` (элемент, `useEffect`,
 * непрослеженный путь). Неиспользованная запись — тоже падение.
 */
const ASSIST_ALLOW: Array<{ file: string; api: string; why: string }> = [
  {
    file: 'src/features/projects/ProjectCreateScreen.tsx',
    api: 'deleteProject',
    why: 'откат только что созданного проекта обучалки при сбое первого разбора — не удаление по просьбе; кнопка «Исследовать» — confirm (exploreSite)',
  },
  {
    file: 'src/features/generation/RelevancePanel.tsx',
    api: 'runRelevance',
    why: 'автозапуск в useEffect при первом открытии панели без отчёта — не кнопка; повтор — кнопки с confirm',
  },
  {
    file: 'src/features/projects/greeting/ScriptStep.tsx',
    api: 'generateGreetingPrompt',
    why: 'голосовая команда «пересобери сценарий» (K3) старого голосового помощника — своя карточка «я понял так» и «Да» человека; кнопки — confirm',
  },
  {
    file: 'src/features/projects/greeting/VideoStep.tsx',
    api: 'startGreetingVideo',
    why: 'голосовое согласие на рендер (K7) — сводка с ценой и «Да» человека; сама кнопка рендера — never',
  },
];

function tiersOf(paid: PaidApis): Map<string, Tier> {
  const out = new Map<string, Tier>();
  for (const fns of Object.values(paid))
    for (const [name, tier] of Object.entries(fns)) {
      assert.ok(!out.has(name), `имя ${name} в списке дважды`);
      out.set(name, tier);
    }
  return out;
}
const TIER_OF = tiersOf(PAID);

/** Нарушения разметки с учётом allowlist (строки для сообщения). */
function violations(
  report: { elements: ElementHit[]; loose: LooseHit[] },
  allow: typeof ASSIST_ALLOW,
  tiers: Map<string, Tier>,
  used = new Set<number>()
): string[] {
  const allowed = (file: string, api: string) => {
    const i = allow.findIndex((a) => a.file === file && a.api === api);
    if (i >= 0) used.add(i);
    return i >= 0;
  };
  const out: string[] = [];
  for (const e of report.elements) {
    if (!e.executor) continue; // двойной клик, клавиатура — не исполнитель
    const apis = [...e.apis].filter((a) => !allowed(e.file, a));
    if (!apis.length) continue;
    const required = apis.some((a) => tiers.get(a) === N) ? N : C;
    // «никогда» строже «с подтверждением» и для confirm-действия допустимо.
    if (e.marked === required || (required === C && e.marked === N)) continue;
    out.push(
      `${e.file}:${e.line} ${e.where} → ${apis.join(', ')}: нужен ` +
        `data-assist="${required}", стоит ${e.marked ?? 'ничего'}`
    );
  }
  for (const l of report.loose) {
    if (allowed(l.file, l.api)) continue;
    out.push(
      `${l.file}:${l.line} ${l.api}: ${l.why} (${l.trail}) — разметьте ` +
        'кнопку или внесите путь в ASSIST_ALLOW с обоснованием'
    );
  }
  return out;
}

it('разбор: прямой вызов, обработчик, useCallback, проп, хук, форма, диалог', () => {
  const api = `export async function pay() {}
export async function gen() {}`;
  const sources: Record<string, string> = {
    'src/services/x-api.ts': api,
    'src/Child.tsx': `export function Child({ onGo }: { onGo: () => void }) {
  return <Button onClick={onGo}>go</Button>;
}`,
    'src/useThing.ts': `import { gen } from './services/x-api';
import { useCallback } from 'react';
export function useThing() {
  const run = useCallback(async () => { await gen(); }, []);
  return { run };
}`,
    'src/Screen.tsx': `import { pay, gen } from './services/x-api';
import { Child } from './Child';
import { useThing } from './useThing';
import { useCallback } from 'react';
export function Screen() {
  const t = useThing();
  const buy = useCallback(() => void pay(), []);
  function again() { void gen(); }
  return (<>
    <button onClick={() => void pay()}>A</button>
    <Button data-assist="never" onClick={buy}>B</Button>
    <Child onGo={again} />
    <div data-assist="confirm"><Child onGo={again} /></div>
    <Button onClick={t.run}>C</Button>
    <form onSubmit={() => void gen()}><Button type="submit" data-assist="confirm">D</Button></form>
    <ConfirmDialog danger={false} onConfirm={buy} />
    <Textarea onDoubleClick={() => void gen()} />
  </>);
}`,
  };
  const paid: PaidApis = { 'src/services/x-api.ts': { pay: N, gen: C } };
  const r = analyzeAssistMarks(sources, paid);
  const by = (line: number, file = 'src/Screen.tsx') =>
    r.elements.filter((e) => e.file === file && e.line === line);
  assert.equal(by(10)[0]?.marked, null); // A: без пометки
  assert.equal(by(10)[0]?.required, N);
  assert.equal(by(11)[0]?.marked, N); // B: через useCallback
  const child = r.elements.filter((e) => e.file === 'src/Child.tsx');
  assert.deepEqual(child.map((e) => e.marked).sort(), [C, null]); // проп, обёртка
  assert.equal(by(14)[0]?.marked, null); // C: член хука
  assert.ok(by(14)[0]?.trails.has('gen ← run ← useThing().run'));
  assert.equal(by(15)[0]?.marked, C); // D: форма — по submit-кнопке
  assert.equal(by(16)[0]?.marked, C); // диалог danger={false}
  assert.equal(by(16)[0]?.required, N);
  assert.equal(by(17)[0]?.executor, false); // двойной клик
  assert.equal(r.loose.length, 0);
  const v = violations(r, [], tiersOf(paid));
  assert.ok(v.some((m) => m.startsWith('src/Screen.tsx:10 <button onClick>')));
  assert.ok(v.some((m) => m.startsWith('src/Screen.tsx:14 <Button onClick>')));
  assert.ok(v.some((m) => m.includes('src/Screen.tsx:16 <ConfirmDialog')));
  assert.ok(
    v.some((m) =>
      m.startsWith(
        'src/Child.tsx:2 <Button onClick> через <Child> src/Screen.tsx:12'
      )
    )
  );
  assert.equal(v.length, 4);
});

it('разбор: useEffect и непрослеженный путь — находки, а не «чисто»', () => {
  const r = analyzeAssistMarks(
    {
      'src/services/x-api.ts': 'export async function pay() {}',
      'src/S.tsx': `import { pay } from './services/x-api';
import { useEffect } from 'react';
export function S() {
  useEffect(() => { void pay(); }, []);
  useCommand('buy', { run: () => void pay() });
  return null;
}`,
    },
    { 'src/services/x-api.ts': { pay: N } }
  );
  assert.deepEqual(
    r.loose.map((l) => `${l.kind}:${l.line}`),
    ['auto:4', 'loose:5']
  );
});

it('обратная проверка: каждый платный вызов TMA ведёт к размеченной кнопке', () => {
  const sources: Record<string, string> = {};
  for (const p of ts.sys.readDirectory('src', ['.ts', '.tsx']))
    sources[p] = readFileSync(p, 'utf8');
  const report = analyzeAssistMarks(sources, PAID);
  // Список жив: каждая функция PAID существует и где-то вызывается.
  for (const [file, fns] of Object.entries(PAID)) {
    const src = sources[file];
    assert.ok(src, `нет модуля ${file}`);
    for (const name of Object.keys(fns))
      assert.ok(
        new RegExp(`export (async )?(function|const) ${name}\\b`).test(src),
        `${file}: нет экспорта ${name}`
      );
  }
  const reached = new Set(report.elements.flatMap((e) => [...e.apis]));
  for (const l of report.loose) reached.add(l.api);
  for (const name of TIER_OF.keys())
    assert.ok(
      reached.has(name),
      `${name}: ни одного вызова в src — убрать из PAID?`
    );
  const used = new Set<number>();
  const bad = violations(report, ASSIST_ALLOW, TIER_OF, used);
  assert.deepEqual(bad, [], `\n${bad.join('\n')}`);
  ASSIST_ALLOW.forEach((a, i) =>
    assert.ok(used.has(i), `ASSIST_ALLOW устарел: ${a.file} ${a.api}`)
  );
  const marked = report.elements.filter((e) => e.executor);
  console.log(
    `    (элементов: ${marked.length}; never — ${
      marked.filter((e) => e.marked === N).length
    }, confirm — ${marked.filter((e) => e.marked === C).length}; жесты вне исполнителя — ${
      report.elements.length - marked.length
    }; allowlist — ${ASSIST_ALLOW.length})`
  );
});

it('диалог подтверждения: удаление — never, прочее — confirm', () => {
  const src = readFileSync('src/components/ui/ConfirmDialog.tsx', 'utf8');
  const tag = tagAround(src, 'onClick={onConfirm}');
  assert.ok(tag.includes("data-assist={danger ? 'never' : 'confirm'}"));
  assert.ok(
    /data-assist=\{danger \? 'never' : 'confirm'\}\s*>\s*\{secondaryAction\}/.test(
      src
    ),
    'третье действие диалога — в той же зоне'
  );
});

it('степпер: data-assist-id у кнопки шага (свой список или data-qa)', () => {
  const src = readFileSync('src/components/ui/Stepper.tsx', 'utf8');
  assert.ok(
    src.includes('data-assist-id={assistIds?.[i] || qa?.[i] || undefined}')
  );
  const cs = readFileSync('src/features/projects/ClientSiteWizard.tsx', 'utf8');
  assert.ok(cs.includes('`client-site-step-${t}`'));
});

it('CSP мини-аппа (если появится) пропускает загрузчик и iframe «Админки»', () => {
  // Сейчас CSP у TMA нет — ничего не блокирует origin `wa.`. Если её
  // заведут, этот шов не даст молча отрезать помощника: в политике
  // должны быть frame-src и script-src с origin «Админки».
  const sources = [
    readFileSync('index.html', 'utf8'),
    readFileSync('vercel.json', 'utf8'),
  ].join('\n');
  const csp = /Content-Security-Policy/i.test(sources);
  if (csp) {
    assert.ok(/frame-src[^;"]*assist-wa\./.test(sources));
    assert.ok(/script-src[^;"]*assist-wa\./.test(sources));
  }
});

console.log(`guide-assist: ${passed} ok`);
