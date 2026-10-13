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
import { PUBLISHER_REDDIT_ENABLED_ENV } from '../../../../config/publisher-env';
import { PublisherContentModule } from '../../content/content.module';
import {
  asMember,
  coreStack,
  type CoreStack,
} from '../../core/testing/core-stack.testing';
import { PublisherDistributionModule } from '../../distribution/distribution.module';
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

/** Кабинет с продуктом `kind=test` и участниками TD-02. */
export async function redditWorld(s: CoreStack): Promise<RedditWorld> {
  const acc = await seedAccount(s.prisma);
  const product = await seedProduct(s.prisma, {
    accountId: acc.accountId,
    siteId: acc.siteId,
    kind: 'test',
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

let threadSeq = 0;
/** Уникальный id36 треда (только `[a-z0-9]`). */
export function threadKey(): string {
  threadSeq++;
  return `t${Date.now().toString(36)}${threadSeq.toString(36)}`.slice(0, 13);
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
