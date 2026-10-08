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
import { readdirSync, readFileSync } from 'node:fs';
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
  // Аудит P2 (06.10.2026): кнопки повторной проверки соответствия раньше
  // прикрывала запись ASSIST_ALLOW по паре (файл, функция) — снятие
  // пометки не ловилось.
  ['src/features/generation/RelevancePanel.tsx', 'data-qa="relevance-check"'],
  ['src/features/generation/RelevancePanel.tsx', 'data-qa="relevance-recheck"'],
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

it('утверждение промпта: confirm, «несмотря на модерацию» — never (аудит P2)', () => {
  const src = readFileSync('src/components/PromptEditor.tsx', 'utf8');
  const tag = tagAround(src, 'onClick={() => void handleApprove()}');
  assert.ok(tag.includes('data-qa="prompt-approve"'));
  assert.ok(tag.includes("data-assist={isFlagged ? 'never' : 'confirm'}"));
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
    // Аудит P2: утверждение — шаг к платному рендеру (Р-Ш6-11).
    approvePrompt: C,
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
 * Пути, которые разметить нельзя или не нужно, — с обоснованием.
 *
 * Аудит P2 (06.10.2026): запись по паре (файл, функция) снимала ВСЕ
 * находки этой функции в файле — и непрослеженный путь, и кнопки; снятие
 * `data-assist` с кнопки или новая кнопка с тем же вызовом не ловились.
 * Теперь запись снимает ровно одну находку разбора без элемента: её вид
 * (`auto` — `useEffect`, `loose` — непрослеженный путь), функцию, след
 * (`trail` целиком) и фрагмент строки (`near`). Находку по элементу
 * (кнопке, полю) allowlist не снимает НИКОГДА — только пометка.
 * Неиспользованная запись — тоже падение.
 */
interface AllowEntry {
  kind: LooseHit['kind'];
  file: string;
  api: string;
  /** След разбора целиком, как в сообщении: `api ← обработчик ← …`. */
  trail: string;
  /** Фрагмент строки находки (не номер: номера съезжают от правок). */
  near: string;
  why: string;
}

const ASSIST_ALLOW: AllowEntry[] = [
  {
    kind: 'auto',
    file: 'src/features/generation/RelevancePanel.tsx',
    api: 'runRelevance',
    trail: 'runRelevance ← run',
    near: 'useEffect(() => {',
    why: 'автозапуск в useEffect при первом открытии панели без отчёта — не кнопка; повтор — кнопки с confirm (CONFIRM)',
  },
  {
    kind: 'loose',
    file: 'src/features/projects/greeting/ScriptStep.tsx',
    api: 'generateGreetingPrompt',
    trail: 'generateGreetingPrompt ← generate',
    near: ': {', // объект команды в `useVoiceCommand('regenerate-script', …)`
    why: 'голосовая команда «пересобери сценарий» (K3) старого голосового помощника — своя карточка «я понял так» и «Да» человека; кнопки — confirm',
  },
  {
    kind: 'loose',
    file: 'src/features/projects/greeting/VideoStep.tsx',
    api: 'startGreetingVideo',
    trail: 'startGreetingVideo ← start',
    near: 'useRenderVoiceConsent({',
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
  allow: AllowEntry[],
  tiers: Map<string, Tier>,
  used = new Set<number>()
): string[] {
  const allowed = (l: LooseHit) => {
    const i = allow.findIndex(
      (a) =>
        a.kind === l.kind &&
        a.file === l.file &&
        a.api === l.api &&
        a.trail === l.trail &&
        l.lineText.includes(a.near)
    );
    if (i >= 0) used.add(i);
    return i >= 0;
  };
  const out: string[] = [];
  for (const e of report.elements) {
    if (!e.executor) continue; // двойной клик, клавиатура — не исполнитель
    // Элементы allowlist не снимает (аудит P2) — только пометка.
    const apis = [...e.apis];
    const required = apis.some((a) => tiers.get(a) === N) ? N : C;
    // «никогда» строже «с подтверждением» и для confirm-действия допустимо.
    if (e.marked === required || (required === C && e.marked === N)) continue;
    out.push(
      `${e.file}:${e.line} ${e.where} → ${apis.join(', ')}: нужен ` +
        `data-assist="${required}", стоит ${e.marked ?? 'ничего'}`
    );
  }
  for (const l of report.loose) {
    if (allowed(l)) continue;
    out.push(
      `${l.file}:${l.line} ${l.kind} ${l.api}: ${l.why} (${l.trail}) — ` +
        'разметьте кнопку или внесите находку в ASSIST_ALLOW (вид, след, ' +
        `строка «${l.lineText.slice(0, 60)}») с обоснованием`
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

it('разбор (аудит P3): submit без type, import * as, ветка undefined, export { f }/default, capture', () => {
  const sources: Record<string, string> = {
    'src/services/x-api.ts': `export async function pay() {}
export async function gen() {}`,
    'src/lib/wrap.ts': `import { pay } from '../services/x-api';
async function wipe() { await pay(); }
async function other() { await pay(); }
export { wipe, other as renamed };`,
    'src/lib/wrap-default.ts': `import { pay } from '../services/x-api';
export default async function wipe2() { await pay(); }`,
    'src/lib/wrap-default2.ts': `import { gen } from '../services/x-api';
const g = async () => { await gen(); };
export default g;`,
    'src/S.tsx': `import * as X from './services/x-api';
import { wipe, renamed } from './lib/wrap';
import wipe2 from './lib/wrap-default';
import g2 from './lib/wrap-default2';
export function S({ on }: { on: boolean }) {
  return (<>
    <form onSubmit={() => void X.gen()}><Button data-assist="confirm" type="submit">a</Button><Button>b</Button></form>
    <form onSubmit={() => void X.gen()}><Button data-assist="confirm">c</Button><Button type="button">d</Button></form>
    <button data-assist={on ? 'confirm' : undefined} onClick={() => void X.gen()}>e</button>
    <button data-assist={on && 'never'} onClick={() => void X.pay()}>f</button>
    <button onClick={() => void wipe()}>g</button>
    <button onClick={() => void renamed()}>h</button>
    <button onClick={() => void wipe2()}>i</button>
    <button onClick={() => void g2()}>j</button>
    <button onPointerDownCapture={() => void X.pay()}>k</button>
    <form onSubmit={() => void X.gen()}><input type="submit" /></form>
  </>);
}`,
    'src/W.tsx': `import * as X from './services/x-api';
export function W() { useThing(X); return null; }`,
  };
  const paid: PaidApis = { 'src/services/x-api.ts': { pay: N, gen: C } };
  const r = analyzeAssistMarks(sources, paid);
  const at = (line: number) =>
    r.elements.filter((e) => e.file === 'src/S.tsx' && e.line === line);
  // Кнопка без type в форме — submit: форма не помечена целиком.
  assert.equal(at(7)[0]?.marked, null);
  // Без type, но помечена; type="button" не отправляет — форма помечена.
  assert.equal(at(8)[0]?.marked, C);
  // Ветка undefined / `&&` — не пометка; при этом X.fn прослежен.
  assert.equal(at(9)[0]?.marked, null);
  assert.ok(at(9)[0]?.apis.has('gen'));
  assert.equal(at(10)[0]?.marked, null);
  assert.ok(at(10)[0]?.apis.has('pay'));
  // export { f }, export { f as g }, export default function, export default f.
  assert.ok(at(11)[0]?.apis.has('pay'));
  assert.ok(at(12)[0]?.apis.has('pay'));
  assert.ok(at(13)[0]?.apis.has('pay'));
  assert.ok(at(14)[0]?.apis.has('gen'));
  // Capture-событие — исполнитель.
  assert.equal(at(15)[0]?.executor, true);
  // <input type="submit"> без пометки — форма не помечена.
  assert.equal(at(16)[0]?.marked, null);
  // Пространство имён целиком — непрослеженный путь, а не «чисто».
  assert.ok(
    r.loose.some(
      (l) => l.file === 'src/W.tsx' && /пространство имён X/.test(l.why)
    )
  );
  const v = violations(r, [], tiersOf(paid));
  for (const line of [7, 9, 10, 11, 12, 13, 14, 15, 16])
    assert.ok(
      v.some((m) => m.startsWith(`src/S.tsx:${line} `)),
      `строка ${line} не поймана:\n${v.join('\n')}`
    );
  assert.ok(!v.some((m) => m.startsWith('src/S.tsx:8 ')));
});

it('allowlist (аудит P2): снимает только находку без элемента — по виду, следу и строке', () => {
  const r = analyzeAssistMarks(
    {
      'src/services/x-api.ts': 'export async function pay() {}',
      'src/S.tsx': `import { pay } from './services/x-api';
import { useEffect } from 'react';
export function S() {
  const run = () => void pay();
  useEffect(() => { run(); }, []);
  return <button onClick={run}>x</button>;
}`,
    },
    { 'src/services/x-api.ts': { pay: N } }
  );
  const tiers = new Map<string, Tier>([['pay', N]]);
  const entry: AllowEntry = {
    kind: 'auto',
    file: 'src/S.tsx',
    api: 'pay',
    trail: 'pay ← run',
    near: 'useEffect(',
    why: 'тест',
  };
  const used = new Set<number>();
  const v = violations(r, [entry], tiers, used);
  // useEffect снят, кнопка — нет.
  assert.deepEqual(
    v.map((m) => m.split(' ')[0]),
    ['src/S.tsx:6']
  );
  assert.ok(used.has(0));
  // Другой вид или след — запись не подходит.
  for (const bad of [
    { ...entry, kind: 'loose' as const },
    { ...entry, trail: 'pay' },
    { ...entry, near: 'useLayoutEffect(' },
  ]) {
    const u = new Set<number>();
    assert.equal(violations(r, [bad], tiers, u).length, 2);
    assert.equal(u.size, 0);
  }
});

it('откат созданного проекта — только в catch рядом с createProject', () => {
  for (const p of ts.sys.readDirectory('src', ['.ts', '.tsx'])) {
    if (p === 'src/services/projects-api.ts') continue;
    const text = readFileSync(p, 'utf8');
    if (!text.includes('rollbackCreatedProject')) continue;
    const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'rollbackCreatedProject'
      ) {
        let inCatch = false;
        let fn: ts.Node | undefined = n.parent;
        for (; fn; fn = fn.parent) {
          if (ts.isCatchClause(fn)) inCatch = true;
          if (ts.isArrowFunction(fn) || ts.isFunctionLike(fn)) break;
        }
        assert.ok(inCatch, `${p}: rollbackCreatedProject вне catch`);
        assert.ok(
          fn && /\bcreateProject\(/.test(fn.getText(sf)),
          `${p}: rollbackCreatedProject в функции без createProject`
        );
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
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
    assert.ok(
      used.has(i),
      `ASSIST_ALLOW устарел: ${a.kind} ${a.file} ${a.api} (${a.trail})`
    )
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

// ── Ш6 (10): пользовательский текст TMA — `data-assist-ugc` ─────────

/**
 * Названия проектов, товаров, манифестов, ключей API, каналов,
 * публикаций и ленты, заголовки аналогов с маркетплейсов — текст, который
 * написал человек (или чужая площадка), а не интерфейс. Помеченный
 * `data-assist-ugc` элемент снимок исполнителя «Админки» не берёт в
 * кандидаты (`widget/src/act/snapshot.ts` `UGC`), а обход «Админки»
 * воркером не кладёт в знания ни его текст (`DATA_ZONE`), ни заголовок,
 * кнопку или ссылку, внутри которых он стоит (`collect.ts`, аудит
 * захода 10) — инъекция через своё же название проекта не становится
 * «фактом интерфейса». Пометка — на НЕинтерактивном держателе текста:
 * на кнопке она исключила бы из снимка сам элемент управления.
 *
 * Заголовок экрана (`ScreenHeader`) — проп `titleUgc`: пометка на самом
 * `<h1>`, а не на `<span>` внутри (аудит: span внутри h1 не скрывал
 * заголовок от обхода).
 */
const UGC: Array<[string, string]> = [
  ['src/features/projects/ProjectsListScreen.tsx', '{p.title}'],
  [
    'src/features/projects/ProjectScreen.tsx',
    '{itemLabel(item, index, dict.projectFormat.itemFallback)}',
  ],
  ['src/features/projects/ItemScreen.tsx', '{project.title}'],
  ['src/features/projects/ItemScreen.tsx', '{a.title}'],
  [
    'src/features/projects/CatalogBatchStartScreen.tsx',
    '{itemLabel(item, index, dict.projectFormat.itemFallback)}',
  ],
  ['src/features/brand/ManifestsListScreen.tsx', '{m.title}'],
  ['src/features/api-keys/ApiKeysScreen.tsx', '{key.name}'],
  ['src/features/channels/ChannelsScreen.tsx', '{c.title}'],
  ['src/features/generation/ShareVideoPanel.tsx', '{p.title}'],
  ['src/features/generation/PublishPanel.tsx', '{r.title}'],
  ['src/features/feed/FeedScreen.tsx', '{item.title}'],
  ['src/features/feed/FeedScreen.tsx', '{item.productName}'],
];

/** Заголовки экранов с текстом пользователя: `<ScreenHeader title={…} titleUgc>`. */
const UGC_HEADERS: Array<[string, string]> = [
  ['src/features/projects/ProjectScreen.tsx', 'project.title'],
  [
    'src/features/projects/ItemScreen.tsx',
    'itemLabel(item, index, dict.projectFormat.itemFallback)',
  ],
  ['src/features/brand/ManifestScreen.tsx', 'manifest.title'],
];

/** Теги, которые исполнитель нажимает/заполняет: на них UGC-пометки нет. */
const UGC_FORBIDDEN_HOLDERS = new Set([
  'a',
  'button',
  'Button',
  'input',
  'Input',
  'select',
  'Select',
  'option',
  'textarea',
  'Textarea',
  'label',
  'summary',
  'Card',
]);

/**
 * Осознанное исключение (аудит захода 10): внешняя ссылка на аналог с
 * маркетплейса — сама целиком чужой текст; помечена ссылка, и исполнитель
 * её не видит — нажимать внешнюю ссылку на чужую площадку ему незачем.
 */
const UGC_INTERACTIVE_ALLOWED: Array<[string, string]> = [
  ['src/features/projects/ItemScreen.tsx', 'a'],
];
const ugcInteractiveAllowed = (file: string, tag: string) =>
  UGC_INTERACTIVE_ALLOWED.some(([f, t]) => f === file && t === tag);

function parseTsx(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function jsxTagName(el: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (
    ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName
  ).getText();
}

function attrsOf(
  el: ts.JsxElement | ts.JsxSelfClosingElement
): ts.JsxAttributes {
  return ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes;
}

function attrOf(
  el: ts.JsxElement | ts.JsxSelfClosingElement,
  name: string
): ts.JsxAttribute | undefined {
  return attrsOf(el).properties.find(
    (a): a is ts.JsxAttribute =>
      ts.isJsxAttribute(a) && a.name.getText() === name
  );
}

/** Держатели текста `needle` (дети-выражения JSX, не атрибуты). */
function ugcHolders(file: string, needle: string): ts.JsxElement[] {
  const sf = parseTsx(file);
  const out: ts.JsxElement[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isJsxExpression(n) &&
      n.getText() === needle &&
      ts.isJsxElement(n.parent)
    )
      out.push(n.parent);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Ближайший JSX-предок (включая сам элемент) с пометкой UGC. */
function ugcMarkedSelfOrAncestor(el: ts.Node): ts.JsxElement | null {
  for (let n: ts.Node | undefined = el; n; n = n.parent) {
    if (ts.isJsxElement(n) && attrOf(n, 'data-assist-ugc')) return n;
  }
  return null;
}

it('Ш6 (10): пользовательские тексты TMA — data-assist-ugc на неинтерактивном держателе', () => {
  for (const [file, needle] of UGC) {
    const holders = ugcHolders(file, needle);
    assert.ok(holders.length > 0, `${file}: не найдено ${needle}`);
    for (const h of holders) {
      // Своя пометка у держателя; исключение — помеченная целиком
      // ссылка-предок из UGC_INTERACTIVE_ALLOWED.
      const marked = attrOf(h, 'data-assist-ugc')
        ? h
        : ugcMarkedSelfOrAncestor(h);
      const tag = marked ? jsxTagName(marked) : jsxTagName(h);
      assert.ok(
        marked &&
          (marked === h || ugcInteractiveAllowed(file, jsxTagName(marked))),
        `${file}: «${needle}» (<${jsxTagName(h)}>) без data-assist-ugc`
      );
      assert.ok(
        !UGC_FORBIDDEN_HOLDERS.has(tag) || ugcInteractiveAllowed(file, tag),
        `${file}: data-assist-ugc на интерактивном <${tag}> — исполнитель его не увидит`
      );
    }
  }
});

it('Ш6 (10): заголовок экрана с текстом пользователя — titleUgc, пометка на самом <h1>', () => {
  for (const [file, expr] of UGC_HEADERS) {
    const found: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
    const visit = (n: ts.Node) => {
      if (
        (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) &&
        jsxTagName(n) === 'ScreenHeader'
      ) {
        const init = attrOf(n, 'title')?.initializer;
        if (
          init &&
          ts.isJsxExpression(init) &&
          init.expression?.getText() === expr
        )
          found.push(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(parseTsx(file));
    assert.ok(found.length > 0, `${file}: нет <ScreenHeader title={${expr}}>`);
    for (const el of found) {
      const flag = attrOf(el, 'titleUgc');
      assert.ok(
        flag && !flag.initializer,
        `${file}: <ScreenHeader title={${expr}}> без titleUgc`
      );
    }
  }
  // Сам заголовок: пометка на <h1>, и только по titleUgc.
  let h1 = 0;
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) && jsxTagName(n) === 'h1') {
      const a = attrOf(n, 'data-assist-ugc');
      assert.ok(a, 'ScreenHeader: <h1> без data-assist-ugc');
      assert.ok(
        /titleUgc/.test(a?.initializer?.getText() ?? ''),
        'ScreenHeader: data-assist-ugc на <h1> не от titleUgc'
      );
      h1 += 1;
    }
    ts.forEachChild(n, visit);
  };
  visit(parseTsx('src/features/projects/shared.tsx'));
  assert.equal(h1, 1);
});

it('Ш6 (10): data-assist-ugc нигде в src не стоит на элементе управления', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (p.endsWith('.tsx')) files.push(p);
      else if (!/\.[a-z]+$/i.test(name)) walk(p);
    }
  };
  walk('src');
  let marks = 0;
  for (const file of files) {
    const visit = (n: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) &&
        n.attributes.properties.some(
          (a) => ts.isJsxAttribute(a) && a.name.getText() === 'data-assist-ugc'
        )
      ) {
        marks += 1;
        const tag = n.tagName.getText();
        assert.ok(
          !UGC_FORBIDDEN_HOLDERS.has(tag) || ugcInteractiveAllowed(file, tag),
          `${file}: data-assist-ugc на <${tag}>`
        );
      }
      ts.forEachChild(n, visit);
    };
    visit(parseTsx(file));
  }
  // Шов не пуст: каждая точка списков — минимум одна пометка
  // (заголовки экранов — одна пометка на <h1> в shared.tsx).
  assert.ok(marks >= UGC.length, `пометок ${marks} < ${UGC.length}`);
});

console.log(`guide-assist: ${passed} ok`);
