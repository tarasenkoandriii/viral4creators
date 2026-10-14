/**
 * AI Publisher, P-R — стенд и построители данных раздела Reddit для db/http
 * тестов и приёмки AT-RD (reddit-manual-mvp-adapted.md §9).
 *
 * Стенд — ядро + P-B1 (источники) + P-C (каналы) + P-R на тестовой базе с
 * HTTP-приложением; флаг `PUBLISHER_REDDIT_ENABLED=true` на время стенда
 * (возвращается при `close`). Мутации идут через НАСТОЯЩИЕ маршруты
 * (`runOperation`: роль, ключ идемпотентности, аудит).
 */
import { randomUUID } from 'crypto';
import * as supertest from 'supertest';
import { PublisherContentModule } from '../../content/content.module';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../core/testing/core-stack.testing';
import { PublisherDistributionModule } from '../../distribution/distribution.module';
import { PublisherAiModule } from '../../ai/ai.module';
import { AiGatewayService } from '../../ai/ai-gateway.service';
import { REDDIT_DRAFT } from '../../ai/generators/reddit-draft.generator';
import {
  AI_PARAMS,
  ScriptedModel,
  approveParams,
  openAiMonth,
} from '../../ai/testing/ai-kit.testing';
import {
  PUBLISHER_REDDIT_AI_ENABLED_ENV,
  PUBLISHER_REDDIT_ENABLED_ENV,
} from '../../../../config/publisher-env';
import { sha256Hex, sourceContentHash } from '../../core/content-hash';
import type { PrismaService } from '../../../../prisma/prisma.service';
import {
  seedAccount,
  seedMembers,
  seedProduct,
  type SeededAccount,
  type SeededMember,
  type SeededMembers,
  type SeededProduct,
} from '../../testing/fixtures.testing';
import { PublisherRedditModule } from '../reddit.module';

export const REDDIT_MODULES = [
  PublisherContentModule,
  PublisherDistributionModule,
  PublisherAiModule,
  PublisherRedditModule,
];

export interface RedditStack extends CoreStack {
  srv(): Parameters<typeof supertest>[0];
}

/** Стенд P-R; `enabled:false` — флаг выключен (AT-RD-17). */
export async function redditStack(
  opts: { enabled?: boolean } = {},
): Promise<RedditStack> {
  const saved = process.env[PUBLISHER_REDDIT_ENABLED_ENV];
  process.env[PUBLISHER_REDDIT_ENABLED_ENV] =
    opts.enabled === false ? 'false' : 'true';
  const s = await coreStack({ http: true, imports: REDDIT_MODULES });
  return {
    ...s,
    srv: () => s.app!.getHttpServer(),
    async close() {
      await s.close();
      if (saved === undefined) delete process.env[PUBLISHER_REDDIT_ENABLED_ENV];
      else process.env[PUBLISHER_REDDIT_ENABLED_ENV] = saved;
    },
  };
}

export interface RedditWorld {
  acc: SeededAccount;
  product: SeededProduct;
  team: SeededMembers;
  P: string;
}

/** Кабинет с продуктом (по умолчанию `kind=test`) и участниками TD-02. */
export async function redditWorld(
  s: CoreStack,
  kind: 'test' | 'working' = 'test',
): Promise<RedditWorld> {
  const acc = await seedAccount(s.prisma);
  const product = await seedProduct(s.prisma, {
    accountId: acc.accountId,
    siteId: acc.siteId,
    kind,
  });
  const team = await seedMembers(s.prisma, product, acc.owner);
  return {
    acc,
    product,
    team,
    P: `/publisher/products/${product.id}/reddit`,
  };
}

export const opKey = (): string => randomUUID();

/** Случайное имя сабреддита из букв (цифры подряд похожи на телефон). */
export function subredditName(prefix = 'sub'): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let s = `${prefix}_`;
  for (let i = 0; i < 12; i++) s += letters[Math.floor(Math.random() * 26)];
  return s.slice(0, 21);
}

/** Клиент API участника (тело мутации получает свежий `opKey`). */
export function api(s: RedditStack, accountId: string, m: SeededMember) {
  const h = asMember(m.telegramId, accountId);
  return {
    headers: h,
    get: (path: string, query: Record<string, string> = {}) =>
      supertest(s.srv()).get(path).query(query).set(h),
    post: (path: string, body: Record<string, unknown> = {}) =>
      supertest(s.srv())
        .post(path)
        .set(h)
        .send({ opKey: opKey(), ...body }),
    patch: (path: string, body: Record<string, unknown> = {}) =>
      supertest(s.srv())
        .patch(path)
        .set(h)
        .send({ opKey: opKey(), ...body }),
  };
}
export type Api = ReturnType<typeof api>;

/** Ответ API или падение теста с телом ответа (для читаемых отказов). */
export function ok<T = Record<string, unknown>>(
  res: supertest.Response,
  status: number,
): T {
  if (res.status !== status) {
    throw new Error(
      `ожидался ${status}, получен ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.data as T;
}

export const RULES_URL = (name: string) =>
  `https://www.reddit.com/r/${name}/about/rules`;

export type RulesScenario =
  | 'allowed'
  | 'restricted'
  | 'prohibited_links'
  | 'promotion_prohibited'
  | 'unknown';

/** Тело снимка правил по сценарию (четыре сценария M1.3 + allowed). */
export function rulesBody(
  name: string,
  scenario: RulesScenario,
  checkedAt = new Date(),
): Record<string, unknown> {
  const policy: Record<RulesScenario, [string, string]> = {
    allowed: ['allowed_with_conditions', 'allowed'],
    restricted: ['allowed_with_conditions', 'restricted'],
    prohibited_links: ['allowed_with_conditions', 'prohibited'],
    promotion_prohibited: ['prohibited', 'prohibited'],
    unknown: ['unknown', 'unknown'],
  };
  return {
    sourceUrl: RULES_URL(name),
    sourceExcerpt: `Rule 3: self-promotion only with disclosure, 10:1 ratio (r/${name}).`,
    promotionPolicy: policy[scenario][0],
    linksPolicy: policy[scenario][1],
    flairRequired: false,
    conditions: ['Disclose affiliation', 'No referral links'],
    checkedAt: checkedAt.toISOString(),
  };
}

/** Факторы оператора (все семь, без `policy_risk`). */
export function factorsBody(v = 70): Record<string, unknown> {
  const f = (value: number | null) => ({
    value,
    why: value === null ? null : `оцінка ${value}`,
  });
  return {
    topic_fit: f(v),
    intent_fit: f(v),
    audience_fit: f(v),
    answerability: f(v),
    promotionality: f(30),
    evidence_gap: f(20),
    context_uncertainty: f(10),
  };
}

/** Alphabetic base36-compatible fixture IDs cannot resemble a phone in keyword phrases. */
export function threadKey(): string {
  return (
    't' +
    randomUUID()
      .replace(/-/g, '')
      .slice(0, 12)
      .split('')
      .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
      .join('')
  );
}

export function threadUrl(name: string, key = threadKey()): string {
  return `https://old.reddit.com/r/${name}/comments/${key}/how_to_pick_a_site_assistant/?utm_source=share#c1`;
}

/** Проект → сообщество → (снимок правил [+ review]). */
export async function seedCommunity(
  a: Api,
  P: string,
  opts: {
    projectId?: string;
    name?: string;
    rules?: RulesScenario | null;
    reviewer?: Api | null;
    checkedAt?: Date;
  } = {},
): Promise<{
  projectId: string;
  communityId: string;
  name: string;
  snapshotId: string | null;
}> {
  const projectId =
    opts.projectId ??
    ok<{ id: string }>(
      await a.post(`${P}/projects`, {
        title: 'Пілот помічника сайту',
        locale: 'en',
        market: 'US',
      }),
      201,
    ).id;
  const name = opts.name ?? subredditName();
  const c = ok<{ id: string }>(
    await a.post(`${P}/communities`, { projectId, community: `r/${name}` }),
    201,
  );
  let snapshotId: string | null = null;
  if (opts.rules !== null) {
    const r = ok<{ id: string }>(
      await a.post(
        `${P}/communities/${c.id}/rules`,
        rulesBody(name, opts.rules ?? 'allowed', opts.checkedAt),
      ),
      201,
    );
    snapshotId = r.id;
    if (opts.reviewer !== null) {
      ok(await (opts.reviewer ?? a).post(`${P}/rules/${r.id}/review`), 200);
    }
  }
  return { projectId, communityId: c.id, name, snapshotId };
}

/** Возможность в сообществе (по умолчанию — со всеми факторами). */
export async function seedOpportunity(
  a: Api,
  P: string,
  c: { projectId: string; communityId: string; name: string },
  extra: Record<string, unknown> = {},
) {
  return a.post(`${P}/opportunities`, {
    projectId: c.projectId,
    communityId: c.communityId,
    threadUrl: threadUrl(c.name),
    titleManual: 'Which AI chat widget answers only from site content?',
    excerpt:
      'Looking for a widget that answers from our docs and says "I don\'t know" otherwise.',
    intent: 'recommendation',
    factors: factorsBody(),
    ...extra,
  });
}

// ── M2 AI Content Studio ─────────────────────────────────────────────────

/** Активная версия оффера продукта (в продукте — решение PO, F02). */
export async function seedOffer(
  db: PrismaService,
  w: RedditWorld,
): Promise<string> {
  const last = await db.pubOfferVersion.findFirst({
    where: { productId: w.product.id },
    orderBy: { version: 'desc' },
    select: { id: true, version: true, status: true },
  });
  if (last?.status === 'active') return last.id;
  const row = await db.pubOfferVersion.create({
    data: {
      accountId: w.acc.accountId,
      productId: w.product.id,
      version: (last?.version ?? 0) + 1,
      title: 'Демо: один матеріал — кілька форматів',
      text: 'Послуга Демо: 2 000 грн, розміщення окремо, без гарантій трафіку.',
      status: 'active',
      approvedBy: `member:${w.acc.owner.memberId}`,
      approvedAt: new Date(),
      hash: sha256Hex(`offer:${w.product.id}:${Date.now()}`),
      createdBy: 'system:test-seed',
    },
  });
  return row.id;
}

/** Разрешённый источник продукта (`origin=content`) для тезисов/claimMap. */
export async function seedContentSource(
  db: PrismaService,
  w: RedditWorld,
  fragment = 'З одного перевіреного матеріалу можна підготувати пост, картки і сценарій.',
  usage: 'allowed' | 'restricted' = 'allowed',
): Promise<string> {
  const row = await db.pubSource.create({
    data: {
      accountId: w.acc.accountId,
      productId: w.product.id,
      kind: 'document',
      title: 'Методика Демо',
      fragment,
      usage,
      visibility: 'private',
      contentHash: sourceContentHash(null, fragment),
      createdBy: 'system:test-seed',
    },
  });
  return row.id;
}

/** Ключи гейта `reddit_publish` утверждены (копирование возможно). */
export async function openRedditPublish(
  db: PrismaService,
  w: RedditWorld,
): Promise<void> {
  await approveParams(
    db,
    { accountId: w.acc.accountId, ownerMemberId: w.acc.owner.memberId },
    w.product.id,
    {
      niche: undefined,
      language: undefined,
      market: undefined,
      offer_active_version: undefined,
      responsibles: undefined,
      reddit_rules_stale_days: undefined,
    },
  );
}

/** Раскрытие по умолчанию — в начале тела (A08). */
export const DISCLOSURE =
  "Disclosure: I'm the founder of Demo, a content service.";

export function versionBody(extra = ''): string {
  return `${DISCLOSURE}\n\nStart from one verified article and plan a post, a few cards and a video script from it.${extra ? `\n\n${extra}` : ''}`;
}

export interface StudioIds {
  projectId: string;
  communityId: string;
  name: string;
  snapshotId: string | null;
  opportunityId: string | null;
  briefId: string;
  contentId: string;
  sourceId: string;
}

/**
 * Бриф Reddit до `ready` и материал (M2): сообщество с проверенными
 * правилами → (comment: возможность → qualify) → бриф с двумя тезисами →
 * `ready` → материал. Версия — отдельно (`draftVersion`).
 */
export async function seedStudio(
  s: RedditStack,
  w: RedditWorld,
  ed: Api,
  po: Api,
  opts: {
    contentType?: 'post' | 'comment';
    rules?: RulesScenario | null;
    affiliation?: string | null;
    linksAllowed?: boolean;
    briefExtra?: Record<string, unknown>;
    ready?: boolean;
    withContent?: boolean;
    /** Поля возможности (comment), например выдержка с командой. */
    opportunity?: Record<string, unknown>;
  } = {},
): Promise<StudioIds> {
  await seedOffer(s.prisma, w);
  const sourceId = await seedContentSource(s.prisma, w);
  const c = await seedCommunity(ed, w.P, {
    rules: opts.rules === undefined ? 'restricted' : opts.rules,
    reviewer: po,
  });
  const type = opts.contentType ?? 'comment';
  let opportunityId: string | null = null;
  if (type === 'comment') {
    const o = ok<{ id: string; revision: number }>(
      await seedOpportunity(ed, w.P, c, opts.opportunity),
      201,
    );
    const q = ok<{ id: string }>(
      await ed.post(`${w.P}/opportunities/${o.id}/qualify`, {
        expectedRevision: o.revision,
      }),
      200,
    );
    opportunityId = q.id;
  }
  const brief = ok<{ id: string; revision: number }>(
    await ed.post(`${w.P}/briefs`, {
      projectId: c.projectId,
      contentType: type,
      ...(opportunityId ? { opportunityId } : { communityId: c.communityId }),
      objective: 'Help the author reuse one article across formats',
      audience: 'Small business owners',
      keyPoints: [
        {
          text: 'One verified article can become a post, cards and a video script',
          sourceIds: [sourceId],
        },
        {
          text: 'Ask which formats the author tried',
          sourceIds: 'needs_verification',
        },
      ],
      affiliation:
        opts.affiliation === undefined ? 'founder' : opts.affiliation,
      brand: 'Demo',
      linksAllowed: opts.linksAllowed ?? false,
      language: 'en',
      ...(opts.briefExtra ?? {}),
    }),
    201,
  );
  if (opts.ready !== false) {
    ok(
      await ed.post(`${w.P}/briefs/${brief.id}/ready`, {
        expectedRevision: brief.revision,
      }),
      200,
    );
  }
  let contentId = '';
  if (opts.withContent !== false && opts.ready !== false) {
    const m = ok<{ content: { id: string } }>(
      await ed.post(`${w.P}/briefs/${brief.id}/contents`),
      201,
    );
    contentId = m.content.id;
  }
  return {
    projectId: c.projectId,
    communityId: c.communityId,
    name: c.name,
    snapshotId: c.snapshotId,
    opportunityId,
    briefId: brief.id,
    contentId,
    sourceId,
  };
}

/** Путь контента продукта (общие маршруты P-B1). */
export const contentPath = (w: RedditWorld) =>
  `/publisher/products/${w.product.id}`;

export interface VersionRef {
  id: string;
  revision: number;
  hash: string | null;
  status: string;
}

/** Черновик версии Reddit-материала (ручной путь, A10). */
export async function draftVersion(
  ed: Api,
  w: RedditWorld,
  ids: Pick<StudioIds, 'contentId' | 'sourceId'>,
  body: Record<string, unknown> = {},
): Promise<VersionRef> {
  return ok<VersionRef>(
    await ed.post(`${contentPath(w)}/contents/${ids.contentId}/versions`, {
      body: versionBody(),
      meta: {
        disclosure: DISCLOSURE,
        claimMap: [
          {
            text: 'One verified article can become a post, cards and a video script',
            sourceIds: [ids.sourceId],
          },
        ],
        uncertainties: [],
      },
      ...body,
    }),
    201,
  );
}

/** Отправка версии (заморозка + `reddit_policy`). */
export async function submitVersion(
  ed: Api,
  w: RedditWorld,
  contentId: string,
  v: VersionRef,
): Promise<VersionRef> {
  return ok<VersionRef>(
    await ed.post(
      `${contentPath(w)}/contents/${contentId}/versions/${v.id}/submit`,
      { expectedRevision: v.revision },
    ),
    200,
  );
}

/** QA человека editorial + technical `pass` (как у всех материалов). */
export async function humanQaPass(
  po: Api,
  w: RedditWorld,
  versionId: string,
): Promise<void> {
  for (const kind of ['editorial', 'technical'])
    ok(
      await po.post(`${contentPath(w)}/versions/${versionId}/qa-checks`, {
        kind,
        result: 'pass',
      }),
      201,
    );
}

/** Ручной путь до согласования: версия → отправка → QA → approve. */
export async function approvedVersion(
  ed: Api,
  po: Api,
  w: RedditWorld,
  ids: Pick<StudioIds, 'contentId' | 'sourceId'>,
  opts: { body?: Record<string, unknown>; ack?: string[] } = {},
): Promise<VersionRef> {
  const d = await draftVersion(ed, w, ids, opts.body);
  const v = await submitVersion(ed, w, ids.contentId, d);
  await humanQaPass(po, w, v.id);
  ok(
    await po.post(`${contentPath(w)}/versions/${v.id}/approve`, {
      versionHash: v.hash,
      acknowledgedWarnings: opts.ack ?? (await warningCodes(po, w, v.id)),
    }),
    201,
  );
  return v;
}

/** Коды WARN последней `reddit_policy` версии (для подтверждения). */
export async function warningCodes(
  a: Api,
  w: RedditWorld,
  versionId: string,
): Promise<string[]> {
  const qa = ok<{
    items: Array<{ kind: string; warnings: Array<{ code: string }> }>;
  }>(await a.get(`${contentPath(w)}/versions/${versionId}/qa-checks`), 200);
  const last = qa.items.filter((q) => q.kind === 'reddit_policy').pop();
  return (last?.warnings ?? []).map((x) => x.code);
}

// ── fake-контур генерации (M2.3; живая модель — после eval 2.3) ─────────

const ALLOW_UNEVALUATED_ENV = 'PUBLISHER_AI_ALLOW_UNEVALUATED';

export interface RedditAi {
  model: ScriptedModel;
  /** Вернуть флаги, `enabledInP0` генератора и модель шлюза. */
  restore(): void;
}

/**
 * Fake-контур генерации Reddit: флаг `PUBLISHER_REDDIT_AI_ENABLED`, генератор
 * включён ТОЛЬКО в тесте (`enabledInP0` в коде — false до живого прогона
 * 2.3, Р-RD-17), модель без сети (`ScriptedModel`), параметры AI и месяц
 * потолка продукта, `PUBLISHER_AI_ALLOW_UNEVALUATED` (вне production снимает
 * «нет оценённой конфигурации», но не параметры и не «вне набора»).
 */
export async function redditAi(
  s: RedditStack,
  w: RedditWorld,
  opts: { params?: boolean } = {},
): Promise<RedditAi> {
  if (opts.params !== false) {
    await approveParams(
      s.prisma,
      { accountId: w.acc.accountId, ownerMemberId: w.acc.owner.memberId },
      w.product.id,
      AI_PARAMS,
    );
    await openAiMonth(
      s.prisma,
      { id: w.product.id, accountId: w.acc.accountId },
      20_000_000n,
    );
  }
  const saved = {
    ai: process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV],
    unev: process.env[ALLOW_UNEVALUATED_ENV],
  };
  process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = 'true';
  process.env[ALLOW_UNEVALUATED_ENV] = 'true';
  const spec = REDDIT_DRAFT as { enabledInP0: boolean };
  const enabled = spec.enabledInP0;
  spec.enabledInP0 = true;
  const model = new ScriptedModel();
  s.mod.get(AiGatewayService).useModel(model);
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  return {
    model,
    restore() {
      s.mod.get(AiGatewayService).useModel(null);
      spec.enabledInP0 = enabled;
      put(PUBLISHER_REDDIT_AI_ENABLED_ENV, saved.ai);
      put(ALLOW_UNEVALUATED_ENV, saved.unev);
    },
  };
}

/** Ответ модели `pub.reddit.draft`: N вариантов (раскрытие в начале). */
export function redditDraftJson(
  n: number,
  type: 'post' | 'comment',
  sourceId: string,
  over: (i: number) => Record<string, unknown> = () => ({}),
): string {
  return JSON.stringify({
    variants: Array.from({ length: n }, (_, i) => ({
      title:
        type === 'post' ? `One article, several formats (${'ABC'[i]})` : null,
      body: `${DISCLOSURE}\n\nVariant ${'ABC'[i]}: start from one verified article and plan a post, cards and a video script from it.\n\nCheck the inputs and steps for each format before you publish.`,
      disclosure: DISCLOSURE,
      flair_suggestion: null,
      claim_map: [
        {
          text: 'One verified article can become a post, cards and a video script',
          source_ids: [sourceId],
        },
      ],
      uncertainties: ['Which formats the author already tried'],
      ...over(i),
    })),
  });
}
