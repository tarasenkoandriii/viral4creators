/**
 * AI Publisher — сквозные маршруты E2E-01…E2E-05 (план внешнего аудита
 * v1.1 §12; интеграция Z-2b) против НАСТОЯЩЕГО sites-backend (свежая база,
 * AI без сети) через HTTP-клиент кабинета assist (`src/lib/publisher/**`) —
 * те же функции, что зовут экраны. Публичный путь (сайт → заявка) проходит
 * настоящий `publisher-site` в Chromium (`scripts/built/z-e2e-site.mjs`
 * сайта), здесь — его результат (`PUB_E2E_SITE_RESULT`).
 *
 * Не `*.test.ts`: `npm test` его не гоняет — нужен поднятый стенд
 * (`scripts/publisher-e2e.sh` в корне репозитория: база, сид, сервер, сайт).
 *
 *   PUB_E2E_API=http://localhost:4141 PUB_E2E_SEED=/tmp/seed.json \
 *   PUB_E2E_OUT=/tmp/e2e.json npx tsx scripts/publisher-e2e.ts
 *
 * Итог — JSON по шагам (`passed`/`failed`/`blocked` с причиной и
 * доказательствами: id, hash, статусы); код выхода 1 при любом `failed`.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ApiError, createApiClient } from '../src/kit';
import * as ai from '../src/lib/publisher/ai-api';
import * as cal from '../src/lib/publisher/calendar-api';
import {
  createPublisherHttp,
  createRawGet,
} from '../src/lib/publisher/common-api';
import * as content from '../src/lib/publisher/content-api';
import * as core from '../src/lib/publisher/core-api';
import * as dist from '../src/lib/publisher/distribution-api';
import * as leads from '../src/lib/publisher/leads-api';
import * as reports from '../src/lib/publisher/reports-api';

const API = (process.env.PUB_E2E_API ?? 'http://localhost:4141').replace(
  /\/$/,
  ''
);
const BOT_TOKEN =
  process.env.PUB_E2E_BOT_TOKEN ?? '111111:AA-тестовый-токен-помощника';
const CRON_SECRET = process.env.PUB_E2E_CRON_SECRET ?? 'e2e-cron-secret';

interface SeedMember {
  memberId: string;
  telegramId: string;
}
interface Seed {
  accountId: string;
  siteId: string;
  /** Пустой сайт того же кабинета — цель восстановления копии. */
  restoreSiteId: string;
  /** Протокол приёмки qa-catalog: все 44 AT passed (засеян сидом). */
  qaRunId: string;
  /** Неполный протокол (AT-CORE-03 failed). */
  qaRunPartialId: string;
  host: string;
  owner: SeedMember;
  members: Record<
    'product_owner' | 'editor' | 'operator' | 'analyst' | 'sales' | 'viewer',
    SeedMember
  >;
  other: { accountId: string; siteId: string; owner: SeedMember };
}
const seed = JSON.parse(
  readFileSync(process.env.PUB_E2E_SEED ?? '/tmp/pub-e2e-seed.json', 'utf8')
) as Seed;

// ── Клиент кабинета под участником ───────────────────────────────────────

// ── Часы стенда (Р-PUB-Z2-21) ────────────────────────────────────────────

/**
 * Последнее известное состояние часов сервера стенда: момент установки по
 * часам драйвера и по часам стенда. Пока часы не переводились — системные.
 */
const standClockState = { active: false, real: 0, stand: 0, frozen: false };

/** «Сейчас» сервера стенда (для подписи initData и дат в телах запросов). */
function standNowMs(): number {
  if (!standClockState.active) return Date.now();
  return standClockState.frozen
    ? standClockState.stand
    : standClockState.stand + (Date.now() - standClockState.real);
}
const standNowIso = () => new Date(standNowMs()).toISOString();

/**
 * Перевести часы сервера стенда (`/__stand/publisher/clock`, Bearer
 * CRON_SECRET; маршрут есть только при PUBLISHER_STAND_CLOCK вне production).
 */
async function setStandClock(body: {
  at?: string;
  advanceMs?: number;
  freeze?: boolean;
}): Promise<{ now: string; frozen: boolean; offsetMs: number }> {
  const r = await fetch(`${API}/__stand/publisher/clock`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  // Ответ — в общем конверте приложения `{data}` (ошибка — `{error}`).
  const j = (await r.json()) as { data?: unknown };
  const out = (j.data ?? j) as {
    now: string;
    frozen: boolean;
    offsetMs: number;
  };
  if (r.status !== 200)
    throw new Error(`часы стенда: ${r.status} ${JSON.stringify(out)}`);
  if (Number.isNaN(Date.parse(out.now)))
    throw new Error(`часы стенда: нет now в ответе ${JSON.stringify(j)}`);
  Object.assign(standClockState, {
    active: true,
    real: Date.now(),
    stand: Date.parse(out.now),
    frozen: out.frozen,
  });
  return out;
}

/** initData Telegram, подписанный токеном бота стенда (алгоритм Telegram). */
function initData(userId: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(standNowMs() / 1000)),
    query_id: 'AAE-e2e',
    user: JSON.stringify({
      id: Number(userId),
      first_name: 'E2E',
      username: `e2e${userId}`,
      language_code: 'uk',
    }),
  };
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

function clientOf(m: SeedMember, accountId = seed.accountId) {
  const opts = {
    baseUrl: API,
    auth: () => ({
      headers: {
        'X-Telegram-App': 'assist',
        'X-Telegram-Init-Data': initData(m.telegramId),
      },
      credentials: 'omit' as RequestCredentials,
    }),
    accountId: () => accountId,
    locale: () => 'uk',
  };
  const http = createPublisherHttp(createApiClient(opts), createRawGet(opts));
  return {
    http,
    core: core.createCoreApi(http),
    dist: dist.createDistributionApi(http),
    leads: leads.createLeadsApi(http),
    reports: reports.createReportsApi(http),
    content: (pid: string) => content.createContentApi(http, pid),
    cal: (pid: string) => cal.createCalendarApi(http, pid),
    ai: (pid: string) => ai.createAiApi(http, http, pid),
  };
}
type Client = ReturnType<typeof clientOf>;

// ── Протокол шагов ───────────────────────────────────────────────────────

type Status = 'passed' | 'failed' | 'blocked';
interface StepResult {
  e2e: string;
  step: string;
  status: Status;
  evidence?: unknown;
  error?: string;
  reason?: string;
}
const results: StepResult[] = [];

class Check extends Error {}
function expect(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new Check(msg);
}
function errText(e: unknown): string {
  if (e instanceof ApiError)
    return `${e.code} ${e.status}: ${JSON.stringify((e as { details?: unknown }).details ?? null)}`;
  if (e instanceof Check) return `${e.name}: ${e.message}`;
  // Сбой самого драйвера/клиента — с местом (первые кадры стека).
  return e instanceof Error
    ? `${e.name}: ${e.message}${(e.stack ?? '').split('\n').slice(1, 4).join(' ')}`
    : String(e);
}
async function step<T>(
  e2e: string,
  name: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    const evidence = await fn();
    results.push({ e2e, step: name, status: 'passed', evidence });
    console.log(`ok   ${e2e} ${name}`);
    return evidence;
  } catch (e) {
    results.push({ e2e, step: name, status: 'failed', error: errText(e) });
    console.log(`FAIL ${e2e} ${name}: ${errText(e)}`);
    return undefined;
  }
}
function blocked(e2e: string, name: string, reason: string): void {
  results.push({ e2e, step: name, status: 'blocked', reason });
  console.log(`--   ${e2e} ${name}: blocked — ${reason}`);
}
/** Код ошибки сервера (или OK). */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof ApiError ? e.code : errText(e);
  }
}
async function errOf(
  p: Promise<unknown>
): Promise<{ code: string; status: number; details: unknown }> {
  try {
    await p;
    return { code: 'OK', status: 200, details: null };
  } catch (e) {
    if (e instanceof ApiError)
      return {
        code: e.code,
        status: e.status,
        details: (e as { details?: unknown }).details ?? null,
      };
    throw e;
  }
}
const letters = () =>
  randomUUID()
    .replace(/-/g, '')
    .slice(0, 8)
    .replace(/[0-9]/g, (d: string) => 'ghijklmnop'[Number(d)]);

/** Публичный API (как сайт: без авторизации кабинета). */
async function publicGet(
  path: string,
  query: Record<string, string>,
  origin?: string
) {
  const u = new URL(`${API}/public/publisher/v1/${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const r = await fetch(u, {
    headers: origin ? { Origin: origin } : {},
  });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body: body as Record<string, unknown> };
}

async function cron(schedule: 'tick' | 'daily' | 'minute') {
  const r = await fetch(`${API}/cron/publisher-${schedule}`, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  return { status: r.status, body: (await r.json()) as unknown };
}

/**
 * SQL стенда — ТОЛЬКО синтетическое время (у сервера нет подмены часов):
 * сдвиг дат публикации назад для окна наблюдения 7 дней и календаря
 * пилота. Бизнес-данные через SQL не пишутся. Клиент `pg` — из
 * зависимостей sites-backend.
 */
async function standSql(
  sql: string,
  params: unknown[] = []
): Promise<unknown[]> {
  const req = createRequire(
    new URL('../../sites-backend/package.json', import.meta.url)
  );
  const { Client: PgClient } = req('pg') as {
    Client: new (o: { connectionString: string }) => {
      connect(): Promise<void>;
      query(q: string, p: unknown[]): Promise<{ rows: unknown[] }>;
      end(): Promise<void>;
    };
  };
  const c = new PgClient({
    connectionString:
      process.env.PUB_E2E_DB ??
      'postgresql://postgres@localhost:55432/sites_pube2e',
  });
  await c.connect();
  try {
    // Гварды «ставится один раз» охраняют прод от правки истории; на стенде
    // время сдвигается в обход триггеров этой сессии.
    await c.query('SET session_replication_role = replica', []);
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

// ── Стенд ────────────────────────────────────────────────────────────────

const owner = clientOf(seed.owner);
const as = Object.fromEntries(
  Object.entries(seed.members).map(([k, m]) => [k, clientOf(m)])
) as Record<keyof Seed['members'], Client>;
const ctx: {
  pid: string;
  publicKey: string;
  siteChannelId: string;
  offerId: string;
  sourceId: string;
  source2Id: string;
  article?: {
    contentId: string;
    versionId: string;
    hash: string;
    slug: string;
    title: string;
    approvalId: string;
    claimId: string;
  };
  adaptations: string[];
  placement?: {
    id: string;
    code: string;
    issuedUrl: string;
    expenseId: string;
  };
  siteProspectId?: string;
  venueId?: string;
  backup?: { id: string; leads: number; sourceTitle: string };
} = {
  pid: '',
  publicKey: '',
  siteChannelId: '',
  offerId: '',
  sourceId: '',
  source2Id: '',
  adaptations: [],
};

async function setup(): Promise<void> {
  const E = 'SETUP';
  await step(
    E,
    'создание рабочего продукта по API (product-init)',
    async () => {
      const p = await owner.core.createProduct(seed.siteId, {
        name: `E2E ${letters()}`,
        kind: 'working',
      });
      ctx.pid = p.id;
      ctx.publicKey = p.publicKey;
      const ch = await owner.cal(p.id).channels();
      const site = ch.find((c) => c.kind === 'site');
      expect(site, 'нет канала site после product-init');
      ctx.siteChannelId = site.id;
      return { productId: p.id, publicKey: p.publicKey, mode: p.mode };
    }
  );
  await step(E, 'роли продукта выдаёт владелец (6 участников)', async () => {
    const out: Record<string, string> = {};
    for (const [role, m] of Object.entries(seed.members)) {
      const g = await owner.core.grant(ctx.pid, {
        memberId: m.memberId,
        role: role as core.RoleGrantView['role'],
      });
      out[role] = g.id;
    }
    return out;
  });
}

/** Утвердить текущее значение каждого недостающего параметра гейтов. */
async function approveGateParameters(
  gates: Array<
    'public_publish' | 'real_leads' | 'spend' | 'purchases' | 'ai_use'
  >
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let round = 0; round < 3; round++) {
    const g = await owner.core.gates(ctx.pid);
    const keys = new Set<string>();
    for (const name of gates)
      for (const m of g[name].missing)
        if (m.kind === 'parameter') keys.add(m.key);
    if (!keys.size) break;
    const params = new Map(
      (await owner.core.parameters(ctx.pid)).map((p) => [p.key, p])
    );
    for (const key of keys) {
      const p = params.get(key);
      if (!p || p.status === 'approved') continue;
      const r = await errOf(
        owner.core.decide(ctx.pid, key, {
          toStatus: 'approved',
          basis: 'Рішення власника для стенду E2E',
          expectedRevision: p.revision,
        })
      );
      out[key] =
        r.code === 'OK' ? 'approved' : `${r.code} ${JSON.stringify(r.details)}`;
    }
  }
  return out;
}

/** Предложить значение ключа и утвердить его решением владельца. */
async function approveValue(key: string, value: unknown): Promise<string> {
  const pr = await errOf(owner.core.propose(ctx.pid, key, value));
  if (pr.code !== 'OK')
    return `propose ${pr.code} ${JSON.stringify(pr.details)}`;
  const list = await owner.core.proposals(ctx.pid, key, {
    status: 'open',
    limit: 1,
  });
  const param = (await owner.core.parameters(ctx.pid)).find(
    (p) => p.key === key
  )!;
  const r = await errOf(
    owner.core.decide(ctx.pid, key, {
      toStatus: 'approved',
      proposalId: list.items[0]?.id ?? null,
      basis: 'Рішення власника для стенду E2E',
      expectedRevision: param.revision,
    })
  );
  return r.code === 'OK'
    ? 'approved'
    : `${r.code} ${JSON.stringify(r.details)}`;
}

async function currentValue<T = Record<string, unknown>>(
  key: string
): Promise<T> {
  return (await owner.core.parameters(ctx.pid)).find((p) => p.key === key)!
    .value as T;
}

/** Значения, которых нет в умолчаниях (адреса, ответственные, протоколы). */
async function approveLaunchValues(): Promise<Record<string, string>> {
  const sales = seed.members.sales.memberId;
  const out: Record<string, string> = {};
  out.domain_host = await approveValue('domain_host', { host: seed.host });
  out.perf_targets = await approveValue('perf_targets', {
    ...(await currentValue('perf_targets')),
    protocolRef: 'E2E-PERF-PROTOCOL-1',
  });
  out.responsibles = await approveValue('responsibles', {
    formOwnerMemberId: sales,
    salesMemberIds: [sales],
    afterT72MemberId: sales,
  });
  out.pilot_calendar = await approveValue('pilot_calendar', {
    t0Planned: new Date().toISOString(),
  });
  // DEF-C-04 / Р-PUB-Z2-26: заглушку уведомления о данных не утвердить —
  // владелец утверждает настоящий текст.
  out.data_notice_draft = await approveValue(
    'data_notice_version',
    await currentValue('data_notice_version')
  );
  out.data_notice_version = await approveValue('data_notice_version', {
    version: 'notice-e2e-1',
    text: 'Ми обробляємо імʼя, контакт і опис задачі із заявки лише для відповіді на неї; строк зберігання — за політикою продукту.',
  });
  // DEF-C-07 / Р-PUB-Z2-27: доказательство D0 — сохранённый прогон AT.
  const evidence = (qaRunId: string) => ({
    qaRunId,
    perfProtocolRef: 'E2E-PERF-PROTOCOL-1',
    note: null,
  });
  out.launch_evidence_d0_free = await approveValue(
    'launch_evidence_d0',
    evidence('qa-run-e2e-1')
  );
  out.launch_evidence_d0_partial = await approveValue(
    'launch_evidence_d0',
    evidence(seed.qaRunPartialId)
  );
  out.launch_evidence_d0 = await approveValue(
    'launch_evidence_d0',
    evidence(seed.qaRunId)
  );
  out.alt_contact = await approveValue('alt_contact', {
    label: 'Напишіть нам у Telegram',
    href: 'https://t.me/pub_e2e_support',
  });
  out.sales_hours_t42_t72 = await approveValue('sales_hours_t42_t72', {
    minutes: 120,
  });
  // Сессия на сайте (sessionRef в sessionStorage) и согласие не требуется —
  // путь метка → страница → форма восстанавливается (F11).
  out.analytics_storage = await approveValue('analytics_storage', 'session');
  out.consent_map = await approveValue('consent_map', {
    default: 'not_required',
    note: 'Лише технічна сесія без cookie',
  });
  return out;
}

// ── E2E-01 Подготовка и выпуск контента ──────────────────────────────────

async function e2e01(): Promise<void> {
  const E = 'E2E-01';
  const ed = as.editor.content(ctx.pid);
  const po = as.product_owner.content(ctx.pid);
  await step(E, 'оффер (PO) создан и активирован', async () => {
    const o = await po.createOffer({
      title: 'Пілот контенту',
      text: 'Повний цикл: бриф, текст, перевірка, публікація',
      priceNote: '10 000 грн',
    });
    const a = await po.activateOffer(o.id, 'Затверджено власником продукту');
    ctx.offerId = a.offer.id;
    return { offerId: a.offer.id, status: a.offer.status };
  });
  await step(E, 'разрешённые источники (редактор)', async () => {
    const s1 = await ed.createSource({
      kind: 'interview',
      title: 'Інтерв’ю з клієнтом',
      fragment: 'Клієнти питають, як обрати агенцію для контенту.',
      visibility: 'public',
      usage: 'allowed',
      url: `https://example.org/s/${letters()}`,
    });
    const s2 = await ed.createSource({
      kind: 'manual_text',
      title: 'Прайс',
      fragment: 'Вартість пілоту 10 000 грн за місяць.',
      visibility: 'public',
      usage: 'allowed',
    });
    ctx.sourceId = s1.id;
    ctx.source2Id = s2.id;
    return { sources: [s1.id, s2.id], usage: [s1.usage, s2.usage] };
  });
  let questionId = '';
  await step(E, 'вопрос выбран с оценками и источником', async () => {
    const q = await ed.createQuestion({
      text: 'Як оцінити агенцію?',
      stage: 'consideration',
    });
    const why = (k: string) => ({ score: 2, why: `Пояснення ${k}` });
    const s = await ed.patchQuestion(q.id, {
      expectedRevision: q.revision,
      scores: {
        offer_fit: why('offer'),
        confirmed_task: why('task'),
        own_answer: why('own'),
        cost: { score: 1, why: 'Пояснення cost' },
      },
      sources: [{ sourceId: ctx.sourceId, fragment: 'Фрагмент запитання' }],
      status: 'selected',
      selectedRank: 1,
    });
    questionId = s.id;
    return { questionId: s.id, status: s.status };
  });
  let briefId = '';
  await step(E, 'бриф создан и готов (оффер, CTA, источник)', async () => {
    const b = await ed.createBrief({
      questionId,
      goal: 'Пояснити вибір агенції',
      format: 'choice_guide',
      ownContribution: 'Власний досвід 12 запусків',
      cta: 'Обговорити задачу',
      ctaIntentNote:
        'Читач уже порівнює варіанти — доречно запропонувати розмову',
      sourceIds: [ctx.sourceId, ctx.source2Id],
    });
    const r = await ed.briefReady(b.id, b.revision);
    briefId = r.id;
    return { briefId: r.id, status: r.status };
  });
  const slug = `yak-obraty-${letters()}`;
  let contentId = '';
  let claimId = '';
  let version: content.VersionView | undefined;
  await step(E, 'черновик статьи с критическим claim', async () => {
    const c = await ed.createContent({ kind: 'article', briefId, slug });
    contentId = c.id;
    const cl = await ed.createClaim({
      statement: 'Вартість пілоту 10 000 грн',
      type: 'fact',
      risk: 'critical',
    });
    claimId = cl.id;
    const v = await ed.createVersion(c.id, {
      title: 'Як обрати агенцію для контенту',
      body: 'Короткий текст про вибір.\n\nДругий абзац з порівнянням.',
      meta: {
        description: 'Як порівняти агенції',
        shortAnswer: 'Порівняйте процес і ціну',
        cta: 'Обговорити задачу',
        editor: 'Редакторка',
      },
      sourceIds: [ctx.sourceId, ctx.source2Id],
      claimIds: [cl.id],
      offerVersionId: ctx.offerId,
    });
    version = await ed.submitVersion(c.id, v.id, v.revision);
    return { contentId, versionId: version.id, claimId, hash: version.hash };
  });
  await step(
    E,
    'неподтверждённый критический факт блокирует согласование',
    async () => {
      expect(version, 'нет версии');
      await po.qaCheck(version.id, { kind: 'editorial', result: 'pass' });
      await as.operator.content(ctx.pid).qaCheck(version.id, {
        kind: 'technical',
        result: 'pass',
      });
      const r = await errOf(
        po.approve(version.id, { versionHash: version.hash! })
      );
      expect(r.status === 409, `ожидали 409, получили ${r.status} ${r.code}`);
      return r;
    }
  );
  await step(
    E,
    'claim подтверждён источником → согласование hash версии',
    async () => {
      expect(version, 'нет версии');
      const cs = await po.claimSource(claimId, {
        sourceId: ctx.source2Id,
        supports: 'yes',
      });
      const v = await po.verifyClaim(claimId, {
        status: 'supported',
        expectedRevision: cs.revision,
      });
      // Старый hash заморожен с неподтверждённым claim — согласовать его
      // нельзя (PUB_APPROVAL_STALE); нужна новая версия и новая проверка.
      const stale = await errOf(
        po.approve(version.id, { versionHash: version.hash! })
      );
      expect(stale.status === 409, `старая версия: ${stale.code}`);
      const cur = await po.content(contentId);
      await po.transition(contentId, {
        to: 'changes_requested',
        reason: 'Факт підтверджено — потрібна нова версія',
        expectedRevision: cur.revision,
      });
      let nv = await ed.createVersion(contentId, {
        title: version.title,
        body: version.body,
        meta: version.meta as object,
        sourceIds: [ctx.sourceId, ctx.source2Id],
        claimIds: [claimId],
        offerVersionId: ctx.offerId,
      });
      nv = await ed.submitVersion(contentId, nv.id, nv.revision);
      await po.qaCheck(nv.id, { kind: 'editorial', result: 'pass' });
      await as.operator.content(ctx.pid).qaCheck(nv.id, {
        kind: 'technical',
        result: 'pass',
      });
      const fresh = await po.version(contentId, nv.id);
      const ap = await po.approve(fresh.id, { versionHash: fresh.hash! });
      expect(ap.versionHash === fresh.hash, 'hash согласования ≠ hash версии');
      ctx.article = {
        contentId,
        versionId: fresh.id,
        hash: fresh.hash!,
        slug,
        title: fresh.title,
        approvalId: ap.id,
        claimId,
      };
      return {
        claim: v.status,
        staleOldVersion: stale.code,
        newVersionId: fresh.id,
        approvalId: ap.id,
        hash: ap.versionHash,
        selfReview: ap.selfReview,
      };
    }
  );
  await step(E, 'материал включён в эксперимент pilot (до t0)', async () => {
    expect(ctx.article, 'нет статьи');
    const list = await as.analyst.reports.experiments(ctx.pid);
    const pilot = list.find(
      (x) =>
        x.kind === 'pilot' && !['superseded', 'cancelled'].includes(x.status)
    );
    expect(pilot, 'нет эксперимента pilot после product-init');
    const v = await as.product_owner.reports.experimentVersion(
      ctx.pid,
      pilot.id,
      randomUUID(),
      {
        contentIds: [ctx.article.contentId],
      }
    );
    return {
      experimentId: v.id,
      version: v.version,
      status: v.status,
      contentIds: v.contentIds,
    };
  });
  await step(
    E,
    'гейт public_publish: параметры владельца, хост подтверждён',
    async () => {
      const approved = await approveGateParameters([
        'public_publish',
        'real_leads',
      ]);
      const values = await approveLaunchValues();
      expect(
        /^PUB_VALIDATION .*draft_placeholder/.test(values.data_notice_draft),
        `заглушка уведомления утверждена: ${values.data_notice_draft}`
      );
      expect(
        /^PUB_CONFLICT .*qa_run_not_found/.test(values.launch_evidence_d0_free),
        `свободная строка как протокол: ${values.launch_evidence_d0_free}`
      );
      expect(
        /^PUB_CONFLICT .*qa_run_incomplete.*AT-CORE-03/.test(
          values.launch_evidence_d0_partial
        ),
        `неполный протокол: ${values.launch_evidence_d0_partial}`
      );
      for (const k of ['data_notice_version', 'launch_evidence_d0'])
        expect(values[k] === 'approved', `${k}: ${values[k]}`);
      const g = await owner.core.gates(ctx.pid);
      expect(
        g.public_publish.open,
        `public_publish закрыт: ${JSON.stringify(g.public_publish.missing)}`
      );
      expect(
        g.real_leads.open,
        `real_leads закрыт: ${JSON.stringify(g.real_leads.missing)}`
      );
      return {
        approved,
        values,
        public_publish: g.public_publish,
        real_leads: g.real_leads,
      };
    }
  );
  await step(
    E,
    'режим live (владелец), материал запланирован и опубликован на сайте',
    async () => {
      expect(ctx.article, 'нет статьи');
      const p = await owner.core.product(ctx.pid);
      const live = await owner.core.changeMode(ctx.pid, {
        mode: 'live',
        expectedRevision: p.revision,
      });
      const c = await po.content(ctx.article.contentId);
      await po.transition(ctx.article.contentId, {
        to: 'scheduled',
        expectedRevision: c.revision,
      });
      const pub = await as.operator.cal(ctx.pid).createPublication({
        versionId: ctx.article.versionId,
        channelId: ctx.siteChannelId,
      });
      return {
        mode: live.mode,
        publicationId: pub.id,
        status: pub.status,
        url: pub.finalUrl,
      };
    }
  );
  await step(
    E,
    'публичный текст = согласованная версия (API сайта)',
    async () => {
      expect(ctx.article, 'нет статьи');
      const r = await publicGet(`contents/${ctx.article.slug}`, {
        key: ctx.publicKey,
      });
      expect(r.status === 200, `contents/:slug → ${r.status}`);
      const data = (r.body as { data: { title: string; versionHash: string } })
        .data;
      expect(data.title === ctx.article.title, 'заголовок ≠ версии');
      expect(
        data.versionHash === ctx.article.hash,
        'hash ≠ согласованной версии'
      );
      return { title: data.title, versionHash: data.versionHash };
    }
  );
  await step(
    E,
    'три адаптации: смысловая проверка обязательна, затем согласование',
    async () => {
      expect(ctx.article, 'нет статьи');
      const specs = [
        {
          kind: 'post' as const,
          title: 'Пост: як обрати агенцію',
          meta: { cta: 'Читати статтю' },
          body: 'Головна думка поста.',
        },
        {
          kind: 'cards' as const,
          title: 'Картки: 5 кроків вибору',
          meta: {
            cta: 'Обговорити задачу',
            cards: [1, 2, 3, 4, 5].map((n) => ({
              title: `Крок ${n}`,
              text: `Опис ${n}`,
            })),
          },
          body: '',
        },
        {
          kind: 'checklist' as const,
          title: 'Чекліст вибору агенції',
          meta: { cta: 'Обговорити задачу' },
          body: '- процес\n- ціна\n- приклади',
        },
      ];
      const out: unknown[] = [];
      for (const sp of specs) {
        const c = await ed.createContent({
          kind: sp.kind,
          parentContentId: ctx.article.contentId,
        });
        let v = await ed.createVersion(c.id, {
          title: sp.title,
          body: sp.body,
          meta: sp.meta,
          offerVersionId: ctx.offerId,
          parentVersionId: ctx.article.versionId,
        });
        v = await ed.submitVersion(c.id, v.id, v.revision);
        await po.qaCheck(v.id, { kind: 'editorial', result: 'pass' });
        await as.operator
          .content(ctx.pid)
          .qaCheck(v.id, { kind: 'technical', result: 'pass' });
        const before = await errOf(po.approve(v.id, { versionHash: v.hash! }));
        expect(
          before.code !== 'OK',
          `${sp.kind}: согласовано без смысловой проверки`
        );
        await po.qaCheck(v.id, { kind: 'adaptation_meaning', result: 'pass' });
        const fresh = await po.version(c.id, v.id);
        const ap = await po.approve(fresh.id, { versionHash: fresh.hash! });
        ctx.adaptations.push(c.id);
        out.push({
          kind: sp.kind,
          contentId: c.id,
          blockedBefore: before.code,
          approvalId: ap.id,
        });
      }
      return out;
    }
  );
}

/** E2E-01 (конец): смена цены и ключевого claim — после закупки и отчётов. */
async function e2e01tail(): Promise<void> {
  const E = 'E2E-01';
  const po = as.product_owner.content(ctx.pid);
  await step(
    E,
    'изменение цены (новый оффер) → новая версия требует решения',
    async () => {
      expect(ctx.article, 'нет статьи');
      const o = await po.createOffer({
        title: 'Пілот контенту',
        text: 'Повний цикл: бриф, текст, перевірка, публікація',
        priceNote: '12 000 грн',
      });
      const a = await po.activateOffer(o.id, 'Нова ціна з листопада');
      const art = await po.content(ctx.article.contentId);
      const apps = await po.approvals({ objectId: ctx.article.versionId });
      return {
        newOffer: a.offer.id,
        cascade: a.cascade,
        articleStatus: art.status,
        approvals: apps.map((x) => ({ id: x.id, status: x.status })),
      };
    }
  );
  await step(
    E,
    'изменение ключевого claim → повторная проверка материала и адаптаций',
    async () => {
      expect(ctx.article, 'нет статьи');
      const list = await po.claims({});
      const cl = list.items.find((c) => c.id === ctx.article!.claimId);
      expect(cl, 'нет claim');
      const r = await po.patchClaim(cl.id, {
        statement: 'Вартість пілоту 12 000 грн',
        expectedRevision: cl.revision,
      });
      const tasks = await owner.core.reviewTasks(ctx.pid, { status: 'open' });
      return {
        newClaim: r.claim.id,
        supersededId: r.supersededId,
        cascade: r.cascade,
        openTasks: tasks.items.map((t) => ({
          reason: t.reason,
          objectType: t.objectType,
        })),
      };
    }
  );
}

// ── E2E-03 Закупка и денежная сверка (часть 1: основной путь) ─────────────

const PURCHASE_VALUES: Record<string, unknown> = {
  budget_total: { amountMinor: 1_000_000, currency: 'UAH' },
  budget_split: {
    placementsMinor: 600_000,
    toolsMinor: 200_000,
    reserveMinor: 200_000,
  },
  per_purchase_max: { amountMinor: 200_000 },
  // Р-PUB-Z2-27: протокол закупки — тот же сохранённый прогон (30 AT passed).
  launch_evidence_purchase: { qaRunId: seed.qaRunId, note: null },
};

async function e2e03a(): Promise<void> {
  const E = 'E2E-03';
  const op = as.operator;
  const poDist = as.product_owner.dist;
  await step(
    E,
    'параметры бюджета (10 000 / 6 000 / 2 000 / 2 000) и закупок утверждены',
    async () => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(PURCHASE_VALUES))
        out[k] = await approveValue(k, v);
      Object.assign(out, await approveGateParameters(['spend', 'purchases']));
      const failing = Object.entries(out).filter(([, v]) => v !== 'approved');
      for (const [k] of failing) {
        const fix: Record<string, unknown> = {
          rates_by_role: {
            currency: 'UAH',
            rates: Object.fromEntries(
              [
                'product_owner',
                'editor',
                'operator',
                'analyst',
                'sales',
                'viewer',
                'admin',
              ].map((r) => [r, 40_000])
            ),
          },
          allowed_cpl_inputs: {
            contributionMinor: 500_000,
            pPayBp: 2000,
            shareBp: 5000,
          },
          investment_cpl_limit: { amountMinor: 300_000 },
          own_channels: {
            channels: [
              {
                code: 'tg',
                name: 'Telegram-канал',
                url: 'https://t.me/pub_e2e',
              },
            ],
          },
        };
        if (fix[k]) out[k] = await approveValue(k, fix[k]);
      }
      for (const kind of ['events_collector', 'web_analytics'] as const) {
        await as.analyst.reports.putIntegration(ctx.pid, kind, randomUUID(), {
          status: 'connected',
          note: 'Ручна перевірка стенду E2E',
        });
      }
      const b = await op.dist.budget(ctx.pid);
      return { params: out, budget: b };
    }
  );
  await step(
    E,
    'площадка: пять проверок, маркировка, доказательство → verified',
    async () => {
      const v = await op.dist.createVenue(ctx.pid, randomUUID(), {
        title: 'Майданчик E2E',
        url: 'https://venue.example',
        topic: 'Маркетинг для малого бізнесу',
        market: 'UA',
        language: 'uk',
        criteria: {
          topic: { score: 2, why: 'Тематика збігається' },
          geo_language: { score: 2, why: 'Україна, українська' },
          format: { score: 1, why: 'Стаття з поміткою' },
          evidence_freshness: { score: 1, why: 'Дані за місяць' },
          real_distribution: { score: 1, why: 'Є розсилка' },
        },
      } as never);
      const early = await errOf(
        op.dist.venueTransition(ctx.pid, v.id, randomUUID(), {
          to: 'verified',
          expectedRevision: v.revision,
        })
      );
      expect(early.status === 400, `verified без проверок: ${early.code}`);
      const p = await op.dist.patchVenue(
        ctx.pid,
        v.id,
        randomUUID(),
        v.revision,
        {
          checks: {
            topicMarket: true,
            priceConfirmed: true,
            formatConfirmed: true,
            termSet: true,
            supplierKnown: true,
          },
          linkMarking: 'sponsored',
          evidence: [
            {
              criterion: 'topic',
              sourceId: ctx.sourceId,
              checkedAt: new Date().toISOString(),
            },
          ],
        }
      );
      const ok = await op.dist.venueTransition(ctx.pid, v.id, randomUUID(), {
        to: 'verified',
        expectedRevision: p.revision,
      });
      ctx.venueId = ok.id;
      return {
        venueId: ok.id,
        status: ok.status,
        earlyRejected: early.details,
      };
    }
  );
  let placementId = '';
  const placementBody = () =>
    ({
      venueId: ctx.venueId!,
      versionId: ctx.article!.versionId,
      price: { currency: 'UAH', baseMinor: '90000', feesMinor: '10000' },
      priceSource: 'Прайс майданчика',
      terms: 'Публікація протягом 5 днів, позначка «реклама»',
    }) as never;
  await step(
    E,
    'закупка до 7 дней наблюдения — отказ PUB_OBSERVATION_PENDING',
    async () => {
      expect(ctx.article && ctx.venueId, 'нет статьи/площадки');
      const r = await errOf(
        op.dist.createPlacement(ctx.pid, randomUUID(), placementBody())
      );
      expect(
        r.code === 'PUB_OBSERVATION_PENDING',
        `ожидали PUB_OBSERVATION_PENDING: ${r.code}`
      );
      return r;
    }
  );
  await step(
    E,
    'синтетическое время: публикация материала сдвинута на 8 дней назад (SQL стенда)',
    async () => {
      expect(ctx.article, 'нет статьи');
      const days = 8;
      const r1 = await standSql(
        `UPDATE "sites"."pub_publications" SET "publishedAt" = "publishedAt" - make_interval(days => $2)
        WHERE "productId" = $1 AND "publishedAt" IS NOT NULL RETURNING "id"`,
        [ctx.pid, days]
      );
      const r2 = await standSql(
        `UPDATE "sites"."pub_contents" SET "firstPublishedAt" = "firstPublishedAt" - make_interval(days => $2)
        WHERE "productId" = $1 AND "firstPublishedAt" IS NOT NULL RETURNING "id"`,
        [ctx.pid, days]
      );
      return {
        publications: r1.length,
        contents: r2.length,
        shiftedDays: days,
      };
    }
  );
  await step(
    E,
    'согласование → резерв → заказ → оплата → публикация → проверка; вектор 10 000 − 2 000 − 1 000 − 2 000 = 5 000',
    async () => {
      expect(ctx.article && ctx.venueId, 'нет статьи/площадки');
      const tools = await op.dist.createExpense(ctx.pid, randomUUID(), {
        category: 'tools',
        description: 'Хостинг і домен',
        amount: { currency: 'UAH', minor: '200000' },
      });
      await op.dist.createEntry(ctx.pid, tools.id, randomUUID(), {
        kind: 'pay',
        amountMinor: '200000',
        status: 'confirmed',
        externalRef: 'INV-E2E-1',
      });
      const pl0 = await op.dist.createPlacement(
        ctx.pid,
        randomUUID(),
        placementBody()
      );
      placementId = pl0.id;
      const ap = await as.product_owner.dist.versionApproval(
        ctx.pid,
        ctx.article!.versionId
      );
      expect(ap, 'нет действующего согласования версии');
      let pl = await poDist.placementStep(
        ctx.pid,
        placementId,
        'approve',
        randomUUID(),
        {
          maxAmountMinor: '100000',
          currency: 'UAH',
          versionHash: ap!.versionHash,
          priceSnapshotHash: pl0.priceSnapshotHash,
          expectedRevision: pl0.revision,
        }
      );
      pl = await op.dist.placementStep(
        ctx.pid,
        placementId,
        'reserve',
        randomUUID(),
        {
          expectedRevision: pl.revision,
        }
      );
      const expenseId = pl.expenseId!;
      await op.dist.createEntry(ctx.pid, expenseId, randomUUID(), {
        kind: 'deliver',
        amountMinor: '40000',
        sourceDocument: 'Акт № 4578123 від 13.10',
      });
      const b1 = await op.dist.budget(ctx.pid);
      expect(
        String(b1.available) === '500000',
        `available до оплаты ${b1.available}`
      );
      // Повтор оплаты тем же opKey — одна запись.
      const payKey = randomUUID();
      await op.dist.createEntry(ctx.pid, expenseId, payKey, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'PAY-E2E-77',
      });
      await op.dist.createEntry(ctx.pid, expenseId, payKey, {
        kind: 'pay',
        amountMinor: '100000',
        status: 'confirmed',
        externalRef: 'PAY-E2E-77',
      });
      const b2 = await op.dist.budget(ctx.pid);
      expect(
        String(b2.available) === '500000',
        `available после оплаты ${b2.available}`
      );
      expect(
        String(b2.netPaid) === '300000',
        `netPaid ${b2.netPaid} (повтор оплаты?)`
      );
      pl = await op.dist.placement(ctx.pid, placementId);
      pl = await op.dist.placementStep(
        ctx.pid,
        placementId,
        'order',
        randomUUID(),
        {
          externalOrderId: '20261013457812',
          expectedRevision: pl.revision,
        }
      );
      pl = await op.dist.placementStep(
        ctx.pid,
        placementId,
        'publication',
        randomUUID(),
        {
          publishDueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          expectedRevision: pl.revision,
        }
      );
      pl = await op.dist.placementStep(
        ctx.pid,
        placementId,
        'published',
        randomUUID(),
        {
          url: 'https://venue.example/post/1',
          publishedAt: new Date().toISOString(),
          expectedRevision: pl.revision,
        }
      );
      pl = await op.dist.placementStep(
        ctx.pid,
        placementId,
        'verify',
        randomUUID(),
        {
          url: 'https://venue.example/post/1',
          linkUrl: pl.issuedUrl ?? '',
          evidenceUrl: 'https://archive.example/venue-post-1.png',
          marking: 'sponsored',
          expectedRevision: pl.revision,
        }
      );
      ctx.placement = {
        id: pl.id,
        code: pl.placementCode,
        issuedUrl: pl.issuedUrl ?? '',
        expenseId,
      };
      return {
        placementId: pl.id,
        status: pl.status,
        paymentStatus: pl.paymentStatus,
        code: pl.placementCode,
        budgetBeforePay: {
          available: b1.available,
          openCommitment: b1.openCommitment,
          deliveredUnpaid: b1.deliveredUnpaid,
        },
        budgetAfterPay: {
          available: b2.available,
          netPaid: b2.netPaid,
          cash: b2.cash,
        },
      };
    }
  );
}

// ── E2E-03 (часть 2): истёкшее согласование, рост цены, два претендента,
//    unknown, отмена и возврат ─────────────────────────────────────────────

async function e2e03b(): Promise<void> {
  const E = 'E2E-03';
  const op = as.operator.dist;
  const po = as.product_owner.dist;
  let decisionReportId = '';
  const newPlacement = async (baseMinor: string) =>
    op.createPlacement(ctx.pid, randomUUID(), {
      venueId: ctx.venueId!,
      versionId: ctx.article!.versionId,
      price: { currency: 'UAH', baseMinor, feesMinor: '0' },
      priceSource: 'Прайс майданчика',
      terms: 'Публікація протягом 5 днів, позначка «реклама»',
    } as never);
  const approve = async (pl: dist.PlacementView, maxAmountMinor: string) => {
    const ap = await po.versionApproval(ctx.pid, ctx.article!.versionId);
    return po.placementStep(ctx.pid, pl.id, 'approve', randomUUID(), {
      maxAmountMinor,
      currency: 'UAH',
      versionHash: ap?.versionHash ?? '',
      priceSnapshotHash: pl.priceSnapshotHash,
      expectedRevision: pl.revision,
      ...(pl.purchaseSeq >= 3 && decisionReportId
        ? { reportDecisionId: decisionReportId }
        : {}),
    });
  };
  await step(
    E,
    'решение по отчёту — основание для третьей и следующих закупок',
    async () => {
      const r = await as.analyst.reports.createReport(ctx.pid, randomUUID(), {
        kind: 'ad_hoc',
        periodStart: new Date(Date.now() - 10 * 86_400_000).toISOString(),
        periodEnd: new Date(Date.now() - 60_000).toISOString(),
      });
      const d = await as.product_owner.reports.reportDecision(
        ctx.pid,
        r.id,
        randomUUID(),
        'Продовжити обмежено: ще дві закупки на перевірених майданчиках'
      );
      decisionReportId = d.id;
      return { reportId: r.id, decisionReportId: d.id };
    }
  );
  await step(
    E,
    'рост цены после согласования — резерв отказан (согласование устарело)',
    async () => {
      let pl = await newPlacement('100000');
      pl = await approve(pl, '100000');
      pl = await op.patchPlacement(ctx.pid, pl.id, randomUUID(), pl.revision, {
        price: { currency: 'UAH', baseMinor: '120000', feesMinor: '0' },
        priceSource: 'Майданчик підняв ціну',
      } as never);
      const r = await errOf(
        op.placementStep(ctx.pid, pl.id, 'reserve', randomUUID(), {
          expectedRevision: pl.revision,
        })
      );
      expect(r.code !== 'OK', 'резерв по устаревшему согласованию');
      // Закупки идут по одной: висящую — отклонить (иначе гейт previous_purchase).
      const cur = await op.placement(ctx.pid, pl.id);
      const rej = await po.placementStep(
        ctx.pid,
        pl.id,
        'reject',
        randomUUID(),
        {
          expectedRevision: cur.revision,
          reason: 'Ціна зросла — шукаємо інший майданчик',
        }
      );
      return {
        placementId: pl.id,
        status: pl.status,
        reserve: r,
        after: rej.status,
      };
    }
  );
  await step(
    E,
    'истёкшее согласование (синтетическое время) — заказ не выполняется',
    async () => {
      let pl = await newPlacement('50000');
      pl = await approve(pl, '50000');
      await standSql(
        `UPDATE "sites"."pub_approvals" SET "decidedAt" = now() - interval '73 hours', "expiresAt" = now() - interval '1 hour'
        WHERE "id" = $1`,
        [pl.approvalId]
      );
      const r = await errOf(
        op.placementStep(ctx.pid, pl.id, 'reserve', randomUUID(), {
          expectedRevision: pl.revision,
        })
      );
      expect(r.code !== 'OK', 'резерв по истёкшему согласованию');
      const cur = await op.placement(ctx.pid, pl.id);
      const rej = await po.placementStep(
        ctx.pid,
        pl.id,
        'reject',
        randomUUID(),
        {
          expectedRevision: cur.revision,
          reason: 'Погодження прострочене',
        }
      );
      return {
        placementId: pl.id,
        approvalId: pl.approvalId,
        reserve: r,
        after: rej.status,
      };
    }
  );
  const reserved: string[] = [];
  await step(
    E,
    'два претендента на один остаток: вторая РАЗНАЯ закупка параллельно с резервом первой не получает остаток; повторный резерв той же — одно обязательство',
    async () => {
      const b0 = await op.budget(ctx.pid);
      const amount = '200000';
      const pl = await approve(await newPlacement(amount), amount);
      // DEF-C-02: претендент 2 — другая закупка на тот же остаток, в тот же
      // момент, что резерв первой. Через API кампании пилота закупки идут
      // по одной (аудит P3-10): вторая не создаётся, пока первая не
      // опубликована, — остаток ей не достаётся ни при каком порядке.
      // Атомарность резерва двух закупок разных кампаний (обход порядка
      // невозможен через API) — jest budget-reserve-concurrency.spec.
      const [rs1, rs2, other] = await Promise.all([
        errOf(
          op.placementStep(ctx.pid, pl.id, 'reserve', randomUUID(), {
            expectedRevision: pl.revision,
          })
        ),
        errOf(
          op.placementStep(ctx.pid, pl.id, 'reserve', randomUUID(), {
            expectedRevision: pl.revision,
          })
        ),
        errOf(newPlacement(amount)),
      ]);
      const rs = [rs1, rs2];
      const ok = rs.filter((r) => r.code === 'OK').length;
      const b1 = await op.budget(ctx.pid);
      expect(ok === 1, `резервов прошло: ${ok}`);
      expect(
        other.code === 'PUB_GATE_CLOSED' &&
          JSON.stringify(other.details).includes('previous_purchase'),
        `вторая закупка при занятом остатке: ${other.code} ${JSON.stringify(other.details)}`
      );
      expect(
        BigInt(b1.openCommitment) - BigInt(b0.openCommitment) ===
          BigInt(amount),
        `обязательство выросло на ${BigInt(b1.openCommitment) - BigInt(b0.openCommitment)}`
      );
      expect(
        Number(b1.available) >= 0,
        `перерасход: available ${b1.available}`
      );
      reserved.push(pl.id);
      return {
        availableBefore: b0.available,
        availableAfter: b1.available,
        results: rs.map((r) => r.code),
        secondPurchase: other,
      };
    }
  );
  await step(
    E,
    'оплата со статусом unknown — новые закупки стоят до сверки; сверка снимает блок',
    async () => {
      expect(reserved.length, 'нет зарезервированной закупки');
      const pl = await op.placement(ctx.pid, reserved[0]);
      const e = await op.createEntry(ctx.pid, pl.expenseId!, randomUUID(), {
        kind: 'pay',
        amountMinor: '100000',
        status: 'unknown',
        externalRef: 'PAY-E2E-UNKNOWN',
      });
      const entry = (e.entries ?? []).find((x) => x.status === 'unknown');
      const gate = (await owner.core.gates(ctx.pid)).purchases;
      expect(
        !gate.open && gate.missing.some((m) => m.kind === 'reconcile'),
        `гейт purchases при unknown: ${JSON.stringify(gate)}`
      );
      // Движение по обязательству до сверки тоже стоит.
      const blocked1 = await errOf(
        op.placementStep(ctx.pid, pl.id, 'order', randomUUID(), {
          externalOrderId: '20261013000001',
          expectedRevision: (await op.placement(ctx.pid, pl.id)).revision,
        })
      );
      await as.product_owner.dist.reconcileEntry(
        ctx.pid,
        pl.expenseId!,
        entry!.id,
        randomUUID(),
        {
          status: 'void',
          document: 'Банк: платіж не проходив (виписка № 77)',
        }
      );
      // DEF-C-03: заказ при unknown действительно отклонён.
      expect(
        blocked1.code === 'PUB_RECONCILE_REQUIRED',
        `заказ при unknown: ${blocked1.code}`
      );
      const gate2 = (await owner.core.gates(ctx.pid)).purchases;
      expect(
        !gate2.missing.some((m) => m.kind === 'reconcile'),
        'сверка не сняла блок'
      );
      return {
        gateDuringUnknown: gate.missing,
        orderDuringUnknown: blocked1.code,
        gateAfter: gate2.missing,
      };
    }
  );
  await step(
    E,
    'отмена закупки и возврат оплаты: обязательство снято, возврат ≤ оплаты',
    async () => {
      expect(reserved.length && ctx.placement, 'нет закупок');
      const b0 = await op.budget(ctx.pid);
      let pl = await op.placement(ctx.pid, reserved[reserved.length - 1]);
      pl = await op.placementStep(ctx.pid, pl.id, 'cancel', randomUUID(), {
        expectedRevision: pl.revision,
        // Остаток освобождается только на подтверждённую сумму отмены.
        confirmedAmountMinor: '200000',
        document: 'Майданчик відмовився, кошти не списано (лист № 12)',
      });
      const b1 = await op.budget(ctx.pid);
      expect(
        BigInt(b0.openCommitment) - BigInt(b1.openCommitment) === 200_000n,
        `обязательство: ${b0.openCommitment} → ${b1.openCommitment}`
      );
      const refund = await op.createEntry(
        ctx.pid,
        ctx.placement.expenseId,
        randomUUID(),
        {
          kind: 'refund',
          amountMinor: '20000',
          status: 'confirmed',
          externalRef: 'REF-E2E-1',
        }
      );
      const over = await errOf(
        op.createEntry(ctx.pid, ctx.placement.expenseId, randomUUID(), {
          kind: 'refund',
          amountMinor: '1000000',
          status: 'confirmed',
          externalRef: 'REF-E2E-2',
        })
      );
      expect(over.code !== 'OK', 'возврат больше оплаты принят');
      const b2 = await op.budget(ctx.pid);
      expect(
        BigInt(b1.netPaid) - BigInt(b2.netPaid) === 20_000n,
        `netPaid ${b1.netPaid} → ${b2.netPaid}`
      );
      return {
        cancelled: pl.status,
        openCommitment: [b0.openCommitment, b1.openCommitment],
        netPaid: [b1.netPaid, b2.netPaid],
        refundStatus: refund.status,
        overRefund: over.code,
        cash: b2.cash,
      };
    }
  );
}

// ── E2E-05 Отчёт и решение ───────────────────────────────────────────────

async function e2e05(): Promise<void> {
  const E = 'E2E-05';
  const an = as.analyst.reports;
  let reportId = '';
  await step(
    E,
    'недельный снимок: pending ≠ qualified, уникальные проспекты, unknown отдельно, деньги раздельно, без контактов',
    async () => {
      const r = await an.createReport(ctx.pid, randomUUID(), {
        kind: 'weekly',
        periodStart: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        periodEnd: new Date(Date.now() - 1000).toISOString(),
      });
      reportId = r.id;
      const m = r.metrics.leads;
      expect(m, 'нет блока заявок');
      expect(
        m.qualifiedUnique === 1,
        `qualifiedUnique ${m.qualifiedUnique} (две заявки одного клиента — один)`
      );
      expect(m.pending >= 1, `pending ${m.pending}`);
      expect(r.attributionModel === 'last_non_direct_30d', 'модель атрибуции');
      const text = JSON.stringify(r);
      if (siteResult)
        expect(!text.includes(siteResult.person.contact), 'контакт в отчёте');
      return {
        reportId: r.id,
        snapshotAt: r.snapshotAt,
        inputsHash: r.inputsHash,
        leads: m,
        costs: {
          operational: r.costs.operational,
          investment: r.costs.investment,
          cashNetPaidMinor: r.costs.cashNetPaidMinor,
          advancesMinor: r.costs.advancesMinor,
        },
        economics: r.metrics.economics,
      };
    }
  );
  await step(
    E,
    'поздняя квалификация после снимка → новый снимок (report-staleness), исходный неизменен',
    async () => {
      expect(reportId, 'нет снимка');
      const before = await an.report(ctx.pid, reportId);
      // Ещё одна заявка (новый клиент) квалифицирована ПОСЛЕ снимка.
      const all = await as.sales.leads.leads(ctx.pid, {
        status: 'new',
        limit: 100,
      });
      const lead = all.items.find(
        (l) =>
          !l.testFlag &&
          l.enriched &&
          l.prospectId &&
          l.prospectId !== ctx.siteProspectId
      );
      expect(lead, 'нет новой заявки для поздней квалификации');
      const card = await as.sales.leads.transition(
        ctx.pid,
        lead.id,
        randomUUID(),
        {
          expectedRevision: lead.revision,
          to: 'contacted',
        }
      );
      await as.sales.leads.transition(ctx.pid, lead.id, randomUUID(), {
        expectedRevision: card.revision,
        to: 'qualified',
        confirmedInterestAt: new Date().toISOString(),
      });
      const daily = await cron('daily');
      const list = await an.reports(ctx.pid, {});
      const succ = list.items.find((x) => x.supersedesReportId === reportId);
      const orig = await an.report(ctx.pid, reportId);
      expect(succ, `нет наследника (крон daily ${daily.status})`);
      expect(
        orig.inputsHash === before.inputsHash,
        'исходный снимок изменился'
      );
      return {
        cronDaily: daily.status,
        successor: succ,
        original: { id: orig.id, superseded: orig.superseded },
      };
    }
  );
  await step(
    E,
    'решение по отчёту — новая строка (decision), история цепочки',
    async () => {
      const list = await an.reports(ctx.pid, {});
      const head = list.items.find(
        (x) => !x.superseded && x.kind === 'weekly' && !x.decision
      );
      expect(head, 'нет головы цепочки');
      const d = await as.product_owner.reports.reportDecision(
        ctx.pid,
        head.id,
        randomUUID(),
        'Продовжити обмежено: канал дав одну кваліфіковану заявку; причинний ефект не встановлено'
      );
      expect(
        d.supersedesReportId === head.id && d.recomputeReason === 'decision',
        'наследник решения'
      );
      const again = await errOf(
        as.product_owner.reports.reportDecision(
          ctx.pid,
          head.id,
          randomUUID(),
          'Друге рішення по тому ж знімку'
        )
      );
      expect(again.code !== 'OK', 'второе решение по тому же снимку');
      return {
        decisionReportId: d.id,
        supersedes: d.supersedesReportId,
        secondDecision: again.code,
      };
    }
  );
}

// ── E2E-04 Отказ и восстановление ───────────────────────────────────────

async function e2e04(): Promise<void> {
  const E = 'E2E-04';
  await step(
    E,
    'AI недоступен (без модели) — честный отказ, ручной путь работает',
    async () => {
      const r = await errOf(
        as.editor.ai(ctx.pid).helperAnswer({
          question: 'Яка ціна пілоту?',
          sourceIds: [ctx.sourceId],
        })
      );
      expect(
        r.code !== 'OK' && /^PUB_/.test(r.code),
        `AI без модели: ${r.code}`
      );
      const q = await as.editor
        .content(ctx.pid)
        .createQuestion({ text: 'Скільки триває пілот?', stage: 'decision' });
      return { ai: r, manualQuestionId: q.id };
    }
  );
  await step(
    E,
    'сбой провайдера AI при открытом гейте ai_use: честный отказ и журнал вызова, ручной путь работает (DEF-C-05)',
    async () => {
      // Гейт открывают параметры владельца (неоценённая конфигурация стенду
      // разрешена PUBLISHER_AI_ALLOW_UNEVALUATED); провайдер модели на
      // стенде недоступен (нет ключа и сети) — это и есть сбой провайдера.
      const params = {
        ai_budget_usd_month: await approveValue('ai_budget_usd_month', {
          microUsd: 5_000_000,
        }),
        ai_fx_rate: await approveValue('ai_fx_rate', {
          rate: '41.5',
          source: 'НБУ, стенд E2E',
          at: new Date(standNowMs()).toISOString(),
        }),
      };
      // Месяц AI открывается обязательством категории tools (задание
      // ai-month-open, тик): весь лимит tools E2E-03 уже занят — владелец
      // переносит часть резерва (решение с основанием), затем тик.
      const release = await errOf(
        as.product_owner.dist.reserveRelease(ctx.pid, randomUUID(), {
          toCategory: 'tools',
          amountMinor: '30000',
          basis: 'Резерв на місячний ліміт AI (стенд E2E)',
        })
      );
      const tick = await cron('tick');
      const before = (await as.editor.ai(ctx.pid).calls({ limit: 100 })).items
        .length;
      const r = await errOf(
        as.editor.ai(ctx.pid).helperAnswer({
          question: 'Скільки коштує пілот?',
          sourceIds: [ctx.sourceId],
        })
      );
      const calls = (await as.editor.ai(ctx.pid).calls({ limit: 100 })).items;
      expect(r.code !== 'OK', `ответ без модели: ${r.code}`);
      expect(
        r.code !== 'PUB_GATE_CLOSED' && r.code !== 'PUB_AI_BUDGET',
        `до провайдера не дошло: ${r.code} ${JSON.stringify(r.details)} (резерв ${release.code}, тик ${tick.status})`
      );
      expect(calls.length > before, 'вызов провайдера не записан в журнал AI');
      const last = calls[0] as unknown as Record<string, unknown>;
      expect(
        last.status !== 'succeeded' && last.status !== 'ok',
        `статус вызова: ${String(last.status)}`
      );
      const q = await as.editor.content(ctx.pid).createQuestion({
        text: 'Яка ціна пілоту? (ручна відповідь)',
        stage: 'decision',
      });
      return {
        params,
        reserveRelease: release.code,
        cronTick: tick.status,
        ai: r,
        lastCall: {
          status: last.status,
          generator: last.generator,
          error: last.errorCode ?? last.error ?? null,
        },
        manualQuestionId: q.id,
      };
    }
  );
  await step(
    E,
    'отказ импорта источника по URL: честная ошибка, источник не создан, ручной ввод работает (DEF-C-05)',
    async () => {
      const ed = as.editor.content(ctx.pid);
      const before = (await ed.sources({ limit: 100 })).items.length;
      const failures: Record<string, unknown> = {};
      for (const url of [
        'https://unreachable.e2e.invalid/price',
        'https://10.0.0.1/internal',
      ]) {
        failures[url] = await errOf(
          ed.importUrl({ url, visibility: 'private' })
        );
      }
      const after = (await ed.sources({ limit: 100 })).items.length;
      for (const [url, f] of Object.entries(failures)) {
        const code = (f as { code: string }).code;
        expect(code !== 'OK', `импорт ${url} «успешен»`);
        // Отказ — по сути (адрес недоступен/запрещён), а не ошибка формы.
        expect(code !== 'PUB_VALIDATION', `импорт ${url}: ${code}`);
      }
      expect(after === before, `источников было ${before}, стало ${after}`);
      const manual = await ed.createSource({
        kind: 'manual_text',
        title: 'Прайс (вручну, після збою імпорту)',
        fragment: 'Пілот коштує 10 000 грн; тривалість — 42 дні.',
        usage: 'allowed',
        visibility: 'private',
      });
      return { failures, sourcesBefore: before, manualSourceId: manual.id };
    }
  );
  await step(
    E,
    'сбой уведомления: повтор — честный статус, заявка цела',
    async () => {
      const n = await as.sales.leads.notifications(ctx.pid, 'failed');
      expect(n.items.length, 'нет неудачных уведомлений');
      const retry = await errOf(
        as.sales.leads.retryNotification(ctx.pid, n.items[0].id, randomUUID())
      );
      await cron('tick');
      const after = await as.sales.leads.notifications(ctx.pid);
      return {
        retried: n.items[0].id,
        retry: retry.code,
        statuses: after.items.map((x) => x.status),
      };
    }
  );
  await step(
    E,
    'аналитика отключена — новые закупки стоят (гейт purchases), после восстановления — открыто',
    async () => {
      const list = await as.analyst.reports.integrations(ctx.pid);
      const wa = list.find((x) => x.kind === 'web_analytics');
      expect(
        wa?.revision !== null && wa?.revision !== undefined,
        'нет интеграции web_analytics'
      );
      const off = await as.analyst.reports.putIntegration(
        ctx.pid,
        'web_analytics',
        randomUUID(),
        {
          status: 'disconnected',
          expectedRevision: wa.revision!,
          note: 'Лічильник зламався',
        }
      );
      const g = (await owner.core.gates(ctx.pid)).purchases;
      expect(
        !g.open && g.missing.some((m) => m.kind === 'integration'),
        `гейт при отключённой аналитике: ${JSON.stringify(g)}`
      );
      const on = await as.analyst.reports.putIntegration(
        ctx.pid,
        'web_analytics',
        randomUUID(),
        {
          status: 'connected',
          expectedRevision: off.revision!,
          note: 'Відновлено',
        }
      );
      const g2 = (await owner.core.gates(ctx.pid)).purchases;
      expect(
        !g2.missing.some((m) => m.kind === 'integration'),
        'интеграция всё ещё в missing'
      );
      return { off: off.status, gateMissing: g.missing, on: on.status };
    }
  );
  await step(
    E,
    'резервная копия до удаления и отзыва (ручная, хранилище стенда): sha256, счётчики таблиц',
    async () => {
      const src = await as.editor.content(ctx.pid).source(ctx.source2Id);
      expect(src.usage !== 'revoked', 'источник уже отозван до копии');
      // Копии и восстановление — администратор кабинета (матрица 4.2).
      const b = await owner.reports.createBackup(ctx.pid, randomUUID());
      expect(b.status === 'ok', `копия: ${b.status}`);
      expect(/^[0-9a-f]{64}$/.test(b.sha256), 'sha256 копии');
      const leadsInBackup = b.tableCounts.pub_leads ?? 0;
      expect(leadsInBackup > 0, 'в копии нет заявок');
      expect(
        src.title,
        'у источника нет заголовка (по нему ищем после восстановления)'
      );
      ctx.backup = { id: b.id, leads: leadsInBackup, sourceTitle: src.title };
      const list = await owner.reports.backups(ctx.pid);
      expect(
        list.some((x) => x.id === b.id),
        'копии нет в списке'
      );
      return {
        backupId: b.id,
        kind: b.kind,
        sha256: b.sha256,
        sizeBytes: b.sizeBytes,
        tableCounts: b.tableCounts,
        rotationUntil: b.rotationUntil,
      };
    }
  );
  await step(
    E,
    'удаление тестового контакта: раскрытие → 404, обезличенная запись; отзыв источника — задачи проверки',
    async () => {
      const all = await as.sales.leads.leads(ctx.pid, { limit: 100 });
      const lead = all.items.find((l) => !l.erased && l.status === 'new');
      expect(lead, 'нет заявки для удаления');
      const er = await as.sales.leads.erase(ctx.pid, lead.id, randomUUID(), {
        expectedRevision: lead.revision,
        basis: 'Запит заявника на видалення',
      });
      const rv = await errOf(
        as.sales.leads.revealContact(ctx.pid, lead.id, 'first_contact')
      );
      expect(rv.status === 404, `раскрытие после удаления: ${rv.status}`);
      const src = await as.editor
        .content(ctx.pid)
        .revokeSource(ctx.source2Id, 'Джерело застаріло — прайс змінено');
      return {
        erasedLead: er.id,
        erased: er.erased,
        reveal: rv.code,
        revokedSource: src.source.usage,
        tasksOpened: src.tasksOpened,
      };
    }
  );
  await step(
    E,
    'восстановление копии в новый продукт kind=restored: удалённый контакт и отозванный источник не возвращаются, внешние действия не повторяются',
    async () => {
      expect(ctx.backup, 'нет копии');
      const po = owner.reports;
      const dry = await po.restore(ctx.pid, ctx.backup.id, randomUUID(), {
        mode: 'dry_run',
      });
      expect(dry.status === 'done', `пробный прогон: ${dry.status}`);
      const r = await po.restore(ctx.pid, ctx.backup.id, randomUUID(), {
        mode: 'apply_new_product',
        targetSiteId: seed.restoreSiteId,
      });
      expect(
        r.status === 'done' && r.targetProductId,
        `восстановление: ${r.status} ${JSON.stringify(r.report)}`
      );
      const again = await po.restoreStatus(ctx.pid, r.id);
      expect(again.status === 'done', 'статус восстановления');
      const rp = r.targetProductId!;
      // Восстановленный продукт: роли сняты — видит владелец кабинета.
      const prod = await owner.core.product(rp);
      expect(prod.kind === 'restored', `вид продукта: ${prod.kind}`);
      const srcErased = (
        await as.sales.leads.leads(ctx.pid, { limit: 100 })
      ).items.filter((l) => l.erased).length;
      const restoredLeads = (await owner.leads.leads(rp, { limit: 100 })).items;
      expect(
        restoredLeads.length === ctx.backup.leads,
        `заявок в восстановленном ${restoredLeads.length} ≠ в копии ${ctx.backup.leads}`
      );
      const restoredErased = restoredLeads.filter((l) => l.erased);
      expect(
        srcErased > 0 && restoredErased.length === srcErased,
        `удалённых: в исходном ${srcErased}, в восстановленном ${restoredErased.length}`
      );
      // Раскрытие в restored закрыто всем (Р-PUB-Z2-14).
      const reveal = await errOf(
        owner.leads.revealContact(rp, restoredErased[0].id, 'first_contact')
      );
      expect(reveal.code !== 'OK', 'раскрытие в восстановленном продукте');
      const sources = (await owner.content(rp).sources({ limit: 100 })).items;
      const s2 = sources.find((x) => x.title === ctx.backup!.sourceTitle);
      expect(s2, 'источника нет в восстановленном продукте');
      expect(
        s2.usage === 'revoked',
        `источник отозван после копии, а восстановлен как ${s2.usage}`
      );
      const notif = await owner.leads.notifications(rp);
      expect(
        notif.items.length === 0,
        `уведомления повторены: ${notif.items.length}`
      );
      return {
        dryRun: { id: dry.id, report: dry.report },
        restoreId: r.id,
        targetProductId: rp,
        kind: prod.kind,
        leads: restoredLeads.length,
        erased: { source: srcErased, restored: restoredErased.length },
        revealInRestored: reveal.code,
        source: { title: s2.title, usage: s2.usage },
        notifications: notif.items.length,
        report: r.report,
      };
    }
  );
}

/** Снятие материала: сайт обновлён ревалидацией (Р-PUB-Z2-8), без повторов. */
async function e2e04withdraw(): Promise<void> {
  const E = 'E2E-04';
  await step(
    E,
    'снятие материала → задание site-revalidate вызывает /api/revalidate сайта; повтора нет',
    async () => {
      expect(ctx.article, 'нет статьи');
      const c = await as.product_owner
        .content(ctx.pid)
        .content(ctx.article.contentId);
      await as.product_owner
        .content(ctx.pid)
        .transition(ctx.article.contentId, {
          to: 'withdrawn',
          reason: 'Матеріал більше не актуальний',
          expectedRevision: c.revision,
        });
      const m1 = await cron('minute');
      const m2 = await cron('minute');
      const job = (r: { body: unknown }) =>
        (
          (
            r.body as {
              data?: {
                jobs?: Array<{
                  key: string;
                  processed?: number;
                  details?: unknown;
                }>;
              };
            }
          ).data?.jobs ?? []
        ).find((j) => j.key === 'site-revalidate');
      const audit = await owner.core.audit(ctx.pid, { objectType: 'product' });
      const marks = audit.items.filter(
        (a) => a.actor === 'system:site-revalidate'
      );
      expect(job(m1)?.processed, `первый проход: ${JSON.stringify(job(m1))}`);
      expect(!job(m2)?.processed, `повтор вызова: ${JSON.stringify(job(m2))}`);
      expect(marks.length === 1, `отметок: ${marks.length}`);
      const pub = await publicGet(`contents/${ctx.article.slug}`, {
        key: ctx.publicKey,
      });
      const site: {
        afterRevalidate?: number;
        final?: number;
        waitedMs?: number;
      } = {};
      if (siteResult) {
        const url = `http://localhost:${process.env.PUB_E2E_SITE_PORT ?? 3020}/materials/${ctx.article.slug}`;
        const get = async () => {
          const r = await fetch(url, { headers: { host: seed.host } });
          return { status: r.status, text: await r.text() };
        };
        // Сразу после ревалидации: список снятых middleware берёт из data
        // cache Next (сброшен ревалидацией), своя память — 1 с (P-F, хвост
        // Z-2b) — 410 сразу или в пределах ~1 с, не через 60 с.
        const a = await get();
        site.afterRevalidate = a.status;
        expect(
          a.status !== 200 && !a.text.includes(ctx.article.title),
          `сайт после ревалидации: ${a.status}`
        );
        const t0 = Date.now();
        let last = a.status;
        while (last !== 410 && Date.now() - t0 < 5_000) {
          await new Promise((r) => setTimeout(r, 250));
          last = (await get()).status;
        }
        site.final = last;
        site.waitedMs = Date.now() - t0;
        expect(
          last === 410,
          `сайт не дал 410 за 5 с после ревалидации: ${last}`
        );
      }
      return {
        firstPass: job(m1),
        secondPass: job(m2),
        marks: marks.length,
        api: pub.status,
        site,
      };
    }
  );
}

// ── E2E-02 Обращение и продажа ───────────────────────────────────────────

interface SiteResult {
  leadRef: string | null;
  sessionRef: string | null;
  person: { name: string; contact: string; business: string; task: string };
  checks: Array<{ ok: boolean; msg: string; evidence?: unknown }>;
  consoleErrors: string[];
  base: string;
}
const siteResult: SiteResult | null =
  process.env.PUB_E2E_SITE_RESULT && existsSync(process.env.PUB_E2E_SITE_RESULT)
    ? (JSON.parse(
        readFileSync(process.env.PUB_E2E_SITE_RESULT, 'utf8')
      ) as SiteResult)
    : null;

/** Публичная заявка как с сайта (Origin подтверждённого хоста). */
async function postPublicLead(body: Record<string, unknown>) {
  const r = await fetch(`${API}/public/publisher/v1/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `https://${seed.host}`,
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
}

async function leadByRef(ref: string): Promise<leads.LeadListItem | undefined> {
  let before: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await as.sales.leads.leads(ctx.pid, { before, limit: 100 });
    const hit = page.items.find((l) => l.publicRef === ref);
    if (hit) return hit;
    if (!page.nextBefore) return undefined;
    before = page.nextBefore;
  }
  return undefined;
}

async function e2e02(): Promise<void> {
  const E = 'E2E-02';
  const sl = as.sales.leads;
  const notice =
    (
      (await publicGet('site-config', { key: ctx.publicKey })).body as {
        data: { dataNotice: { version: string } | null };
      }
    ).data.dataNotice?.version ?? 'draft-1';
  const baseBody = (over: Record<string, unknown> = {}) => ({
    key: ctx.publicKey,
    submissionKey: randomUUID(),
    name: 'Ігор Синтетичний',
    contactMethod: 'email',
    contact: `igor.e2e.${letters()}@example.com`,
    business: 'cafe.example',
    task: 'Потрібні статті для кавʼярні',
    budgetRange: 'unknown',
    dataNoticeVersion: notice,
    consentState: 'not_required',
    elapsedMs: 15_000,
    ...over,
  });
  if (!siteResult) {
    blocked(
      E,
      'сайт → заявка (браузер)',
      'прогон без --site: publisher-site не собирался'
    );
  } else {
    await step(
      E,
      'сайт (Chromium, https-домен продукта): метка → материал → CTA → форма → успех с номером',
      async () => {
        const bad = siteResult.checks.filter((c) => !c.ok);
        expect(!bad.length, `проверки сайта: ${JSON.stringify(bad)}`);
        expect(siteResult.leadRef, 'нет номера обращения');
        return {
          leadRef: siteResult.leadRef,
          sessionRef: siteResult.sessionRef,
          checks: siteResult.checks.length,
        };
      }
    );
  }
  const tick = await cron('tick');
  let siteLead: leads.LeadCardView | undefined;
  await step(
    E,
    'заявка с сайта в кабинете: одна на операцию (двойной клик), атрибуция метка → материал → закупка',
    async () => {
      expect(siteResult?.leadRef, 'нет заявки с сайта');
      const item = await leadByRef(siteResult!.leadRef!);
      expect(item, `заявки ${siteResult!.leadRef} нет в кабинете`);
      const all = await sl.leads(ctx.pid, { limit: 100 });
      const same = all.items.filter((l) => l.publicRef === siteResult!.leadRef);
      expect(same.length === 1, `заявок с номером: ${same.length}`);
      siteLead = await sl.lead(ctx.pid, item.id);
      expect(siteLead.enriched, `не обогащена (крон tick ${tick.status})`);
      expect(
        siteLead.contentId === ctx.article?.contentId,
        `материал: ${siteLead.contentId}`
      );
      expect(
        siteLead.placementId === ctx.placement?.id,
        `закупка: ${siteLead.placementId}`
      );
      expect(
        siteLead.sessionRef === siteResult!.sessionRef,
        'sessionRef ≠ сессии браузера'
      );
      return {
        leadId: siteLead.id,
        status: siteLead.status,
        contentId: siteLead.contentId,
        placementId: siteLead.placementId,
        campaignId: siteLead.campaignId,
        attribution: siteLead.attribution,
        cronTick: tick.status,
      };
    }
  );
  await step(
    E,
    'сбой уведомления (бот недоступен на стенде) не теряет заявку; статус виден',
    async () => {
      expect(siteLead, 'нет заявки');
      const card = await sl.lead(ctx.pid, siteLead.id);
      const n = await sl.notifications(ctx.pid);
      expect(
        card.status === 'new' && card.notifications.length > 0,
        'заявка/уведомления'
      );
      return {
        leadStatus: card.status,
        notifications: card.notifications,
        outbox: card.outbox,
        queue: n.items.map((x) => ({ status: x.status, attempts: x.attempts })),
      };
    }
  );
  await step(
    E,
    'повтор отправки тем же submissionKey — тот же номер, одна заявка',
    async () => {
      const b = baseBody();
      const r1 = await postPublicLead(b);
      const r2 = await postPublicLead(b);
      expect(
        r1.status === 201,
        `первая ${r1.status} ${JSON.stringify(r1.body)}`
      );
      const ref1 = (r1.body.data as { leadRef: string }).leadRef;
      const ref2 = (r2.body.data as { leadRef: string } | undefined)?.leadRef;
      expect(
        r2.status === 200 && ref2 === ref1,
        `повтор: ${r2.status} ${ref2}`
      );
      const all = await sl.leads(ctx.pid, { limit: 100 });
      expect(
        all.items.filter((l) => l.publicRef === ref1).length === 1,
        'две заявки'
      );
      return { leadRef: ref1, first: r1.status, repeat: r2.status };
    }
  );
  await step(
    E,
    'без метки и без сессии (запрет хранения) — атрибуция unknown, не догадка',
    async () => {
      const r = await postPublicLead(baseBody({ consentState: 'denied' }));
      expect(r.status === 201, `заявка ${r.status} ${JSON.stringify(r.body)}`);
      await cron('tick');
      const item = await leadByRef(
        (r.body.data as { leadRef: string }).leadRef
      );
      expect(item, 'нет заявки');
      const card = await sl.lead(ctx.pid, item.id);
      expect(!card.placementId && !card.contentId, 'атрибуция «угадана»');
      return {
        leadId: card.id,
        attribution: card.attribution,
        sessionRef: card.sessionRef,
      };
    }
  );
  let prospectId = '';
  await step(
    E,
    'менеджер: раскрытие контакта, контакт, квалификация, предложение, тестовая оплата',
    async () => {
      expect(siteLead && siteResult, 'нет заявки с сайта');
      // Р-PUB-Z2-25 (D1-02): прежний GET раскрытия — 405, журнал не растёт.
      const revealsBefore = (
        await owner.core.audit(ctx.pid, {
          objectType: 'lead',
          objectId: siteLead.id,
          limit: 100,
        })
      ).items.filter((a) => a.action === 'reveal_contact').length;
      const viaGet = await fetch(
        `${API}/publisher/products/${ctx.pid}/leads/${siteLead.id}/contact?purpose=first_contact`,
        {
          headers: {
            'X-Telegram-App': 'assist',
            'X-Telegram-Init-Data': initData(seed.members.sales.telegramId),
          },
        }
      );
      expect(viaGet.status === 405, `GET раскрытия: ${viaGet.status}`);
      const c = await sl.revealContact(ctx.pid, siteLead.id, 'first_contact');
      const revealsAfter = (
        await owner.core.audit(ctx.pid, {
          objectType: 'lead',
          objectId: siteLead.id,
          limit: 100,
        })
      ).items.filter((a) => a.action === 'reveal_contact').length;
      expect(
        revealsAfter === revealsBefore + 1,
        `записей раскрытия: ${revealsBefore} → ${revealsAfter}`
      );
      expect(
        c.contact === siteResult.person.contact,
        'контакт ≠ введённому на сайте'
      );
      let card = await sl.transition(ctx.pid, siteLead.id, randomUUID(), {
        expectedRevision: siteLead.revision,
        to: 'contacted',
        note: 'Перший дзвінок, домовились про зустріч',
      });
      card = await sl.transition(ctx.pid, siteLead.id, randomUUID(), {
        expectedRevision: card.revision,
        to: 'qualified',
        confirmedInterestAt: new Date().toISOString(),
        note: 'Підтвердив інтерес до пілоту',
      });
      card = await sl.transition(ctx.pid, siteLead.id, randomUUID(), {
        expectedRevision: card.revision,
        to: 'proposal_sent',
      });
      prospectId = card.prospectId ?? '';
      expect(prospectId, 'нет проспекта после квалификации');
      ctx.siteProspectId = prospectId;
      const pay = await sl.createPayment(ctx.pid, randomUUID(), {
        prospectId,
        leadId: card.id,
        recordType: 'payment_received',
        payerKind: 'test',
        amountMinor: '150000',
        currency: 'UAH',
        occurredAt: new Date().toISOString(),
        paymentRef: `INV-E2E-${letters()}`,
      });
      return {
        status: card.status,
        prospectId,
        paymentId: pay.id,
        payerKind: pay.payerKind,
        paymentStatus: pay.status,
      };
    }
  );
  await step(
    E,
    'вторая задача того же клиента — тот же prospect_id (уникальные не растут)',
    async () => {
      expect(siteResult && prospectId, 'нет проспекта');
      const before = (await sl.prospects(ctx.pid)).items.length;
      const r = await postPublicLead(
        baseBody({
          name: siteResult.person.name,
          contact: siteResult.person.contact,
          task: 'Друга задача: розсилка',
        })
      );
      expect(r.status === 201, `заявка ${r.status}`);
      await cron('tick');
      const item = await leadByRef(
        (r.body.data as { leadRef: string }).leadRef
      );
      expect(item, 'нет второй заявки');
      const card = await sl.lead(ctx.pid, item.id);
      const after = (await sl.prospects(ctx.pid)).items.length;
      expect(
        card.prospectId === prospectId,
        `другой проспект: ${card.prospectId} ≠ ${prospectId}`
      );
      expect(after === before, `проспектов было ${before}, стало ${after}`);
      return { leadId: card.id, prospectId: card.prospectId, prospects: after };
    }
  );
}

// ── E2E-05 Синтетический календарь D42/D72/D90 (часы стенда) ─────────────

/** Публичное событие как с сайта (text/plain, Origin подтверждённого хоста). */
async function postPublicEvent(body: Record<string, unknown>) {
  const r = await fetch(`${API}/public/publisher/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      origin: `https://${seed.host}`,
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify({
      key: ctx.publicKey,
      eventId: randomUUID(),
      consentState: 'not_required',
      ...body,
    }),
  });
  return { status: r.status, text: await r.text() };
}

/** Все `not_computable` с причиной в дереве отчёта (путь → входы). */
function notComputable(
  v: unknown,
  reason: string,
  at = '$'
): Array<{ path: string; inputs: unknown }> {
  if (!v || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  if (o.kind === 'not_computable' && o.reason === reason)
    return [{ path: at, inputs: o.inputs }];
  return Object.entries(o).flatMap(([k, x]) =>
    notComputable(x, reason, `${at}.${k}`)
  );
}

const calendar: {
  t0?: number;
  t42?: number;
  t72?: number;
  t90?: number;
  sIn?: string;
  sOut?: string;
  leadIn?: string;
  leadOut?: string;
  d42?: string;
  d72?: string;
} = {};

/** Снимок вехи, сделанный заданием `report-staleness` (milestones). */
async function milestone(kind: 'd42' | 'd72' | 'd90') {
  const list = await as.analyst.reports.reports(ctx.pid, { kind });
  const head = list.items.find((x) => !x.supersedesReportId);
  return head ? as.analyst.reports.report(ctx.pid, head.id) : undefined;
}

async function e2e05calendar(): Promise<void> {
  const E = 'E2E-05';
  const sl = as.sales.leads;
  const leadBody = async (sessionRef: string) => ({
    key: ctx.publicKey,
    submissionKey: randomUUID(),
    name: 'Марта Календарна',
    contactMethod: 'email',
    contact: `marta.cal.${letters()}@example.com`,
    business: 'bakery.example',
    task: 'Потрібні статті для пекарні',
    budgetRange: 'unknown',
    dataNoticeVersion:
      (
        (await publicGet('site-config', { key: ctx.publicKey })).body as {
          data: { dataNotice: { version: string } | null };
        }
      ).data.dataNotice?.version ?? 'draft-1',
    consentState: 'not_required',
    elapsedMs: 15_000,
    sessionRef,
  });
  await step(
    E,
    'синтетический календарь: часы стенда → t42 − 1 мс и ровно t42; время сессий и заявок ставит сервер БД стенда',
    async () => {
      const exps = await as.analyst.reports.experiments(ctx.pid);
      const pilot = exps
        .filter((x) => x.key === 'pilot' && x.t0)
        .sort((a, b) => a.version - b.version)[0];
      expect(pilot?.t0 && pilot.t42 && pilot.t72 && pilot.t90, 'нет t0 пилота');
      Object.assign(calendar, {
        t0: Date.parse(pilot.t0!),
        t42: Date.parse(pilot.t42!),
        t72: Date.parse(pilot.t72!),
        t90: Date.parse(pilot.t90!),
      });
      const t42 = calendar.t42!;
      expect(standNowMs() < t42 - 1, 'часы стенда уже за t42');
      calendar.sIn = `calin${letters()}${letters()}`;
      calendar.sOut = `calout${letters()}${letters()}`;
      const at = async (ms: number, sessionRef: string) => {
        await setStandClock({ at: new Date(ms).toISOString(), freeze: true });
        const ev = await postPublicEvent({
          name: 'content_view',
          path: '/materials',
          sessionRef,
        });
        expect(ev.status === 202, `событие ${ev.status} ${ev.text}`);
        const lead = await postPublicLead(await leadBody(sessionRef));
        expect(
          lead.status === 201,
          `заявка ${lead.status} ${JSON.stringify(lead.body)}`
        );
        return (lead.body.data as { leadRef: string }).leadRef;
      };
      calendar.leadIn = await at(t42 - 1, calendar.sIn);
      calendar.leadOut = await at(t42, calendar.sOut);
      // Часы снова идут — сразу за t42.
      await setStandClock({ at: new Date(t42 + 1000).toISOString() });
      const tick = await cron('tick');
      const sess = (await standSql(
        `SELECT "sessionRef", "startedAt" FROM "sites"."pub_sessions"
          WHERE "productId" = $1 AND "sessionRef" = ANY($2)`,
        [ctx.pid, [calendar.sIn, calendar.sOut]]
      )) as Array<{ sessionRef: string; startedAt: Date }>;
      const leadsAt = (await standSql(
        `SELECT "publicRef", "receivedAt" FROM "sites"."pub_leads"
          WHERE "productId" = $1 AND "publicRef" = ANY($2)`,
        [ctx.pid, [calendar.leadIn, calendar.leadOut]]
      )) as Array<{ publicRef: string; receivedAt: Date }>;
      const startedOf = (ref: string) =>
        sess.find((x) => x.sessionRef === ref)?.startedAt.getTime();
      const receivedOf = (ref: string) =>
        leadsAt.find((x) => x.publicRef === ref)?.receivedAt.getTime();
      expect(
        startedOf(calendar.sIn) === t42 - 1,
        `сессия внутри: ${startedOf(calendar.sIn)} ≠ t42−1`
      );
      expect(
        startedOf(calendar.sOut) === t42,
        `сессия на границе: ${startedOf(calendar.sOut)} ≠ t42`
      );
      expect(
        receivedOf(calendar.leadIn) === t42 - 1 &&
          receivedOf(calendar.leadOut) === t42,
        'время заявок ≠ часам стенда'
      );
      return {
        t0: pilot.t0,
        t42: pilot.t42,
        t72: pilot.t72,
        t90: pilot.t90,
        sessions: sess.map((x) => ({
          sessionRef: x.sessionRef,
          startedAt: x.startedAt.toISOString(),
        })),
        leads: { inside: calendar.leadIn, boundary: calendar.leadOut },
        cronTick: tick.status,
      };
    }
  );
  await step(
    E,
    'D42 (задание после t42): когорта [t0,t42) — сессия ровно в t42 вне неё; независимый пересчёт сессий; нулевые знаменатели — «не рассчитывается»',
    async () => {
      expect(calendar.t42 && calendar.t0, 'нет календаря');
      await setStandClock({
        at: new Date(calendar.t42! + 3_600_000).toISOString(),
      });
      const daily = await cron('daily');
      const r = await milestone('d42');
      expect(r, `нет снимка D42 (крон daily ${daily.status})`);
      calendar.d42 = r.id;
      expect(
        Date.parse(r.periodStart) === calendar.t0 &&
          Date.parse(r.periodEnd) === calendar.t42,
        `период ${r.periodStart}…${r.periodEnd}`
      );
      const [n] = (await standSql(
        `SELECT count(*) FILTER (WHERE "startedAt" < $3)::int AS "lt",
                count(*) FILTER (WHERE "startedAt" <= $3)::int AS "le"
           FROM "sites"."pub_sessions"
          WHERE "productId" = $1 AND NOT "testFlag" AND "startedAt" >= $2`,
        [ctx.pid, new Date(calendar.t0!), new Date(calendar.t42!)]
      )) as Array<{ lt: number; le: number }>;
      const m = r.metrics;
      expect(
        m.sessions?.value === n.lt && n.le === n.lt + 1,
        `сессии отчёта ${m.sessions?.value}, пересчёт [t0,t42) ${n.lt}, [t0,t42] ${n.le}`
      );
      expect(
        (m.leads?.outsideCohort?.nextPeriod ?? 0) >= 1,
        `заявка сессии t42 не «следующий период»: ${JSON.stringify(m.leads?.outsideCohort)}`
      );
      const zeros = notComputable(r, 'zero_denominator');
      expect(
        zeros.length > 0,
        'нет «не рассчитывается» при нулевом знаменателе'
      );
      return {
        reportId: r.id,
        createdBy: r.createdBy,
        snapshotAt: r.snapshotAt,
        cohort: r.cohort,
        sessions: m.sessions,
        recount: n,
        leads: m.leads,
        signalD42: m.signalD42,
        zeroDenominators: zeros,
        cronDaily: daily.status,
      };
    }
  );
  await step(
    E,
    'D72 (после t72): окно обращений закрыто, pending отдельно от qualified',
    async () => {
      await setStandClock({
        at: new Date(calendar.t72! + 3_600_000).toISOString(),
      });
      const daily = await cron('daily');
      const r = await milestone('d72');
      expect(r, `нет снимка D72 (крон daily ${daily.status})`);
      calendar.d72 = r.id;
      const m = r.metrics;
      expect(m.windowClosed === true, `окно: ${m.windowClosed}`);
      expect((m.leads?.pending ?? 0) >= 1, `pending ${m.leads?.pending}`);
      return {
        reportId: r.id,
        snapshotAt: r.snapshotAt,
        windowClosed: m.windowClosed,
        leads: m.leads,
        economics: m.economics,
        costs: {
          operational: r.costs.operational,
          investment: r.costs.investment,
          cashNetPaidMinor: r.costs.cashNetPaidMinor,
        },
        cronDaily: daily.status,
      };
    }
  );
  await step(
    E,
    'поздняя квалификация после D72 → наследник late_decision, исходный D72 неизменен',
    async () => {
      expect(calendar.d72 && calendar.leadIn, 'нет D72');
      const before = await as.analyst.reports.report(ctx.pid, calendar.d72!);
      const item = await leadByRef(calendar.leadIn!);
      expect(item, 'нет заявки внутри когорты');
      let card = await sl.lead(ctx.pid, item.id);
      card = await sl.transition(ctx.pid, card.id, randomUUID(), {
        expectedRevision: card.revision,
        to: 'contacted',
      });
      card = await sl.transition(ctx.pid, card.id, randomUUID(), {
        expectedRevision: card.revision,
        to: 'qualified',
        confirmedInterestAt: standNowIso(),
      });
      const daily = await cron('daily');
      const list = await as.analyst.reports.reports(ctx.pid, { kind: 'd72' });
      const succ = list.items.find(
        (x) => x.supersedesReportId === calendar.d72
      );
      expect(succ, `нет наследника D72 (крон daily ${daily.status})`);
      expect(
        succ.recomputeReason === 'late_decision',
        `причина: ${succ.recomputeReason}`
      );
      const after = await as.analyst.reports.report(ctx.pid, calendar.d72!);
      const full = await as.analyst.reports.report(ctx.pid, succ.id);
      expect(after.inputsHash === before.inputsHash, 'исходный D72 изменился');
      expect(
        (full.metrics.leads?.qualifiedUnique ?? 0) >
          (before.metrics.leads?.qualifiedUnique ?? 0),
        'наследник не учёл позднюю квалификацию'
      );
      return {
        leadId: card.id,
        status: card.status,
        original: {
          id: before.id,
          qualifiedUnique: before.metrics.leads?.qualifiedUnique,
          pending: before.metrics.leads?.pending,
        },
        successor: {
          id: full.id,
          reason: full.recomputeReason,
          snapshotAt: full.snapshotAt,
          qualifiedUnique: full.metrics.leads?.qualifiedUnique,
          pending: full.metrics.leads?.pending,
        },
      };
    }
  );
  await step(
    E,
    'D90 (после t90): период [t0,t90), поисковый сигнал отдельно; история снимков',
    async () => {
      await setStandClock({
        at: new Date(calendar.t90! + 3_600_000).toISOString(),
      });
      const daily = await cron('daily');
      const r = await milestone('d90');
      expect(r, `нет снимка D90 (крон daily ${daily.status})`);
      expect(
        Date.parse(r.periodStart) === calendar.t0 &&
          Date.parse(r.periodEnd) === calendar.t90,
        `период ${r.periodStart}…${r.periodEnd}`
      );
      expect(r.metrics.searchSignalD90, 'нет поискового сигнала D90');
      const all = await as.analyst.reports.reports(ctx.pid, {});
      const kinds = all.items.map((x) => x.kind);
      for (const k of ['d42', 'd72', 'd90'] as const)
        expect(kinds.includes(k), `нет снимка ${k} в истории`);
      return {
        reportId: r.id,
        period: [r.periodStart, r.periodEnd],
        searchSignalD90: r.metrics.searchSignalD90,
        history: all.items.map((x) => ({
          kind: x.kind,
          snapshotAt: x.snapshotAt,
          supersedes: x.supersedesReportId,
          reason: x.recomputeReason,
        })),
        cronDaily: daily.status,
      };
    }
  );
}

// ── Запуск ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const only = (process.env.PUB_E2E_ONLY ?? '').split(',').filter(Boolean);
  const want = (id: string) => !only.length || only.includes(id);
  const phase = process.env.PUB_E2E_PHASE ?? 'all';
  const ctxFile = process.env.PUB_E2E_CTX;
  if (phase === 'b') {
    expect(ctxFile && existsSync(ctxFile), 'PUB_E2E_CTX: нет файла фазы a');
    const prev = JSON.parse(readFileSync(ctxFile!, 'utf8')) as {
      ctx: typeof ctx;
      results: StepResult[];
    };
    Object.assign(ctx, prev.ctx);
    results.push(...prev.results);
  } else {
    await setup();
    if (want('E2E-01')) await e2e01();
    if (want('E2E-03')) await e2e03a();
  }
  if (phase !== 'a') {
    if (want('E2E-02')) await e2e02();
    if (want('E2E-03')) await e2e03b();
    if (want('E2E-05')) await e2e05();
    if (want('E2E-04')) await e2e04();
    if (want('E2E-01')) await e2e01tail();
    if (want('E2E-04')) await e2e04withdraw();
    // Последним: часы стенда идут только вперёд (t42 → t72 → t90).
    if (want('E2E-05')) await e2e05calendar();
  }
  const out = process.env.PUB_E2E_OUT;
  if (out) writeFileSync(out, JSON.stringify({ ctx, results }, null, 2));
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log(
    `publisher-e2e: шагов ${results.length}, passed ${results.filter((r) => r.status === 'passed').length}, failed ${failed}, blocked ${results.filter((r) => r.status === 'blocked').length}`
  );
  if (failed) process.exitCode = 1;
}

void main();
void cron;
void codeOf;
void blocked;
