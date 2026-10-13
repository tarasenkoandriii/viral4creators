/**
 * AI Publisher (P-A0): хелпер db-спеков схемы `pub_*` — миграция
 * `…_publisher_core`, триггеры, роль `publisher_public`.
 *
 * Каждый тест идёт в своей транзакции под владельцем схемы (как
 * assist-public-role.spec.ts) и откатывается: append-only таблицы иначе не
 * почистить. Ожидаемый отказ — под SAVEPOINT, транзакция живёт дальше.
 * Сид — сырым SQL с явными колонками (без Prisma: проверяется сама база).
 *
 * Строка — `SITES_DIRECT_URL` (как у миграций). Без неё набор пропускается,
 * а при `CI=true` — падает (приёмка не должна тихо перестать выполняться).
 */
import { randomBytes } from 'crypto';
import { Client } from 'pg';

export const PUB_RAW_URL = process.env.SITES_DIRECT_URL;
export const PUB_IN_CI = process.env.CI === 'true';

/** `?schema=sites` нужен CLI Prisma; драйверу pg он ни к чему. */
export function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

/** Набор без базы: в CI — провал, локально — пропуск с причиной. */
export function describeWithoutDb(title: string): void {
  describe(title, () => {
    (PUB_IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
      () => {
        throw new Error(
          'CI=true, но SITES_DIRECT_URL не задана — db-проверка Publisher не выполнилась',
        );
      },
    );
  });
}

export const rid = (p: string): string =>
  `${p}_${randomBytes(6).toString('hex')}`;
export const hex64 = (seed = ''): string =>
  (randomBytes(32).toString('hex') + seed).slice(0, 64);
/** UUID v4 в нижнем регистре (opKey). */
export function uuid4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const publicKey = (): string =>
  `pp_${randomBytes(24)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, 'A')
    .slice(0, 24)}`;

export const M = 'member:m1';
const S = '"sites"';

type Row = Record<string, unknown>;

/** Значение jsonb-колонки как есть (строка `"B2B"`, число), а не текст. */
export class Json {
  constructor(readonly value: unknown) {}
}
export const json = (v: unknown): Json => new Json(v);

function sqlValue(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof Date) return v;
  if (v instanceof Json) return JSON.stringify(v.value);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

export interface PubWorld {
  accountId: string;
  siteId: string;
  productId: string;
}

/** Транзакция на тест + сид + проверки «проходит / отказ с кодом». */
export class PubDb {
  constructor(readonly c: Client) {}

  async begin(): Promise<void> {
    await this.c.query('BEGIN');
  }

  async rollback(): Promise<void> {
    await this.c.query('ROLLBACK');
  }

  async q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.c.query(sql, params.map(sqlValue));
    return r.rows as T[];
  }

  /** INSERT с явными колонками; возвращает id. */
  async ins(table: string, row: Row): Promise<string> {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${S}."${table}" (${cols.map((c) => `"${c}"`).join(', ')})
                 VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING "id"`;
    const r = await this.q<{ id: string }>(
      sql,
      cols.map((c) => row[c]),
    );
    return r[0].id;
  }

  async upd(table: string, id: string, set: Row): Promise<void> {
    const cols = Object.keys(set);
    await this.q(
      `UPDATE ${S}."${table}" SET ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(', ')} WHERE "id" = $1`,
      [id, ...cols.map((c) => set[c])],
    );
  }

  async del(table: string, id: string): Promise<void> {
    await this.q(`DELETE FROM ${S}."${table}" WHERE "id" = $1`, [id]);
  }

  /** Ожидаемый отказ: код SQLSTATE (и текст), транзакция продолжается. */
  async fails(
    code: string,
    fn: () => Promise<unknown>,
    message?: RegExp,
  ): Promise<void> {
    await this.c.query('SAVEPOINT pub_t');
    let err: { code?: string; message?: string } | null = null;
    try {
      await fn();
    } catch (e) {
      err = e as { code?: string; message?: string };
    }
    if (err) {
      await this.c.query('ROLLBACK TO SAVEPOINT pub_t');
      expect({ code: err.code, message: err.message }).toEqual(
        expect.objectContaining({ code }),
      );
      if (message) expect(err.message).toMatch(message);
      return;
    }
    await this.c.query('RELEASE SAVEPOINT pub_t');
    throw new Error(`ожидался отказ ${code}, а операция прошла`);
  }

  /** Отказ триггера-гварда (23514), опционально по тексту правила. */
  rejects(fn: () => Promise<unknown>, message?: RegExp): Promise<void> {
    return this.fails('23514', fn, message);
  }

  // ── сид ядра site-core ────────────────────────────────────────────────

  async account(): Promise<string> {
    const id = rid('acc');
    await this.q(
      `INSERT INTO ${S}."site_accounts" ("id", "verifyToken", "updatedAt") VALUES ($1, $2, now())`,
      [id, rid('vt')],
    );
    return id;
  }

  async site(accountId: string): Promise<string> {
    const id = rid('site');
    await this.q(
      `INSERT INTO ${S}."site_sites" ("id", "accountId", "name", "updatedAt") VALUES ($1, $2, 'S', now())`,
      [id, accountId],
    );
    return id;
  }

  async host(
    accountId: string,
    siteId: string,
    over: Row = {},
  ): Promise<string> {
    const id = rid('host');
    // site_hosts — `timestamp(3)` без пояса, в UTC (как пишет Prisma). Драйвер
    // pg отдал бы Date местным временем процесса со смещением, а Postgres
    // для timestamp смещение отбрасывает — пишем UTC-строкой.
    const utc = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    const row: Row = {
      id,
      accountId,
      siteId,
      host: `${id.replace(/_/g, '-')}.example`,
      status: 'verified',
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      updatedAt: new Date(),
      ...over,
    };
    for (const k of [
      'verifiedAt',
      'expiresAt',
      'revokedAt',
      'reverifyBlockedAt',
      'updatedAt',
    ]) {
      row[k] = utc(row[k]);
    }
    await this.ins('site_hosts', row);
    return id;
  }

  // ── сид Publisher ─────────────────────────────────────────────────────

  async product(
    accountId: string,
    siteId: string,
    over: Row = {},
  ): Promise<string> {
    return this.ins('pub_products', {
      id: rid('prod'),
      accountId,
      siteId,
      kind: 'working',
      name: 'Продукт',
      publicKey: publicKey(),
      createdBy: M,
      ...over,
    });
  }

  /** Кабинет, сайт и продукт (по умолчанию рабочий, mode=closed). */
  async world(productOver: Row = {}): Promise<PubWorld> {
    const accountId = await this.account();
    const siteId = await this.site(accountId);
    const productId = await this.product(accountId, siteId, productOver);
    return { accountId, siteId, productId };
  }

  /** Второй продукт того же кабинета на своём сайте. */
  async sibling(w: PubWorld, over: Row = {}): Promise<PubWorld> {
    const siteId = await this.site(w.accountId);
    const productId = await this.product(w.accountId, siteId, over);
    return { accountId: w.accountId, siteId, productId };
  }

  /** Строка дочерней таблицы с кабинетом, продуктом и автором. */
  child(table: string, w: PubWorld, row: Row): Promise<string> {
    return this.ins(table, {
      id: rid(table.replace(/^pub_/, '').slice(0, 8)),
      accountId: w.accountId,
      productId: w.productId,
      createdBy: M,
      ...row,
    });
  }

  source(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_sources', w, {
      kind: 'manual_text',
      fragment: 'Фрагмент источника',
      usage: 'allowed',
      visibility: 'public',
      title: 'Источник',
      url: 'https://src.example/a',
      contentHash: hex64(),
      ...over,
    });
  }

  offer(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_offer_versions', w, {
      version: 1,
      title: 'Оффер',
      text: 'Текст оффера',
      priceNote: 'Отримати пропозицію',
      status: 'active',
      approvedBy: M,
      approvedAt: new Date(),
      hash: hex64(),
      ...over,
    });
  }

  question(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_questions', w, {
      text: 'Как выбрать?',
      stage: 'decision',
      scores: {},
      ...over,
    });
  }

  async brief(w: PubWorld, over: Row = {}): Promise<string> {
    const questionId = (over.questionId as string) ?? (await this.question(w));
    const offerVersionId =
      (over.offerVersionId as string) ??
      (await this.offer(w, {
        version: Math.floor(Math.random() * 1e6) + 2,
        status: 'draft',
      }));
    return this.child('pub_briefs', w, {
      goal: 'Цель',
      format: 'instruction',
      structure: [],
      channels: [],
      readinessCriteria: [],
      unresolved: [],
      ...over,
      questionId,
      offerVersionId,
    });
  }

  /** Статья с брифом; версии — отдельно. */
  async article(w: PubWorld, over: Row = {}): Promise<string> {
    const briefId = await this.brief(w);
    return this.child('pub_contents', w, {
      kind: 'article',
      briefId,
      // Р-PUB-Z2-12: без цифр — slug с 7+ цифрами подряд приём события
      // считает «похожим на телефон» и отбрасывает (флейк паспорта трафика).
      slug: `a-${randomBytes(4)
        .toString('hex')
        .replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`,
      ...over,
    });
  }

  async version(
    w: PubWorld,
    contentId: string,
    over: Row = {},
  ): Promise<string> {
    const offerVersionId =
      (over.offerVersionId as string) ??
      (await this.offer(w, {
        version: Math.floor(Math.random() * 1e6) + 2,
        status: 'draft',
      }));
    const kind = (
      await this.q<{ kind: string }>(
        `SELECT "kind" FROM ${S}."pub_contents" WHERE "id" = $1`,
        [contentId],
      )
    )[0].kind;
    return this.child('pub_content_versions', w, {
      contentId,
      number: 1,
      title: 'Заголовок',
      body: 'Текст',
      meta: { description: 'Описание' },
      format: kind,
      authorMemberId: 'm1',
      ...over,
      offerVersionId,
    });
  }

  /** Замороженная версия (submitted, hash, frozenAt). */
  frozenVersion(
    w: PubWorld,
    contentId: string,
    over: Row = {},
  ): Promise<string> {
    return this.version(w, contentId, {
      status: 'submitted',
      hash: hex64(),
      frozenAt: new Date(),
      ...over,
    });
  }

  async versionHash(versionId: string): Promise<string> {
    return (
      await this.q<{ hash: string }>(
        `SELECT "hash" FROM ${S}."pub_content_versions" WHERE "id" = $1`,
        [versionId],
      )
    )[0].hash;
  }

  async publishApproval(
    w: PubWorld,
    versionId: string,
    over: Row = {},
  ): Promise<string> {
    return this.child('pub_approvals', w, {
      type: 'publish_version',
      objectType: 'content_version',
      objectId: versionId,
      versionHash: await this.versionHash(versionId),
      approverMemberId: 'm1',
      approverDisplayName: 'Редактор',
      ...over,
    });
  }

  channel(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_channels', w, {
      code: `site-${randomBytes(3).toString('hex')}`,
      name: 'Сайт',
      kind: 'site',
      utmSource: 'site',
      utmMedium: 'owned',
      ...over,
    });
  }

  campaign(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_campaigns', w, {
      code: `pilot-${randomBytes(3).toString('hex')}`,
      name: 'Пилот',
      ...over,
    });
  }

  venue(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_venues', w, {
      name: 'Площадка',
      url: 'https://venue.example',
      formats: [],
      criteria: {},
      ...over,
    });
  }

  /** Закупка-кандидат: площадка, версия статьи, кампания. */
  async placement(w: PubWorld, over: Row = {}): Promise<string> {
    const contentId = await this.article(w);
    const versionId = await this.frozenVersion(w, contentId);
    return this.child('pub_placements', w, {
      venueId: (over.venueId as string) ?? (await this.venue(w)),
      versionId,
      campaignId: (over.campaignId as string) ?? (await this.campaign(w)),
      placementCode: `pl-${randomBytes(3).toString('hex')}`,
      purchaseSeq: 1,
      basePriceMinor: 90_000,
      feesMinor: 10_000,
      totalPriceMinor: 100_000,
      currency: 'UAH',
      ...over,
    });
  }

  /** Лимит бюджета продукта (валюта лимита для денежных гвардов). */
  budgetLimit(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_budget_limits', w, {
      currency: 'UAH',
      totalLimitMinor: 1_000_000,
      ...over,
    });
  }

  /** Продукт принимает заявки и события: live рабочего с открытыми гейтами. */
  async openForIntake(w: PubWorld): Promise<void> {
    await this.upd('pub_products', w.productId, {
      mode: 'live',
      liveSince: new Date(),
      paramsPublicPublishOk: true,
      paramsRealLeadsOk: true,
    });
  }

  /**
   * Согласование purchase закупки `placementId` (объект — эта закупка);
   * без него — новая закупка-кандидат продукта.
   */
  async purchaseApproval(w: PubWorld, over: Row = {}): Promise<string> {
    const decidedAt = new Date();
    const objectId = (over.objectId as string) ?? (await this.placement(w));
    return this.child('pub_approvals', w, {
      type: 'purchase',
      objectType: 'placement',
      objectId,
      versionHash: hex64(),
      priceSnapshotHash: hex64(),
      maxAmountMinor: 100_000,
      currency: 'UAH',
      approverMemberId: 'm1',
      approverDisplayName: 'Владелец',
      decidedAt,
      expiresAt: new Date(decidedAt.getTime() + 24 * 3_600_000),
      ...over,
    });
  }

  /**
   * Параметр с решением той же версии (сначала решение, потом параметр):
   * `assumption` с решением читается публичным представлением в режиме
   * test, `approved` — всегда; посев без решения — не читается.
   */
  async decidedParam(
    w: PubWorld,
    key: string,
    value: unknown,
    status: 'assumption' | 'approved' = 'assumption',
  ): Promise<string> {
    await this.child('pub_parameter_decisions', w, {
      parameterKey: key,
      version: 1,
      fromStatus: 'assumption',
      toStatus: status,
      valueSnapshot: value,
      decidedBy: M,
      basis: 'Решение владельца',
      dependentStages: [],
    });
    return this.child('pub_parameters', w, {
      key,
      value,
      status,
      ...(status === 'approved'
        ? { approvedBy: M, approvedAt: new Date() }
        : {}),
    });
  }

  /** Закупка с привязанным согласованием purchase этой закупки. */
  async approvedPlacement(
    w: PubWorld,
    approvalOver: Row = {},
  ): Promise<{ placementId: string; approvalId: string }> {
    const placementId = await this.placement(w);
    const approvalId = await this.purchaseApproval(w, {
      objectId: placementId,
      ...approvalOver,
    });
    await this.upd('pub_placements', placementId, { approvalId });
    return { placementId, approvalId };
  }

  /** Согласование reserve_release лимита продукта. */
  reserveApproval(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_approvals', w, {
      type: 'reserve_release',
      objectType: 'budget_limit',
      objectId: rid('bl'),
      maxAmountMinor: 500,
      currency: 'UAH',
      approverMemberId: 'm1',
      approverDisplayName: 'Владелец',
      ...over,
    });
  }

  lead(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_leads', w, {
      submissionKey: uuid4(),
      requestHash: hex64(),
      publicRef: `L-${randomBytes(8)
        .toString('hex')
        .toUpperCase()
        .replace(/[0189]/g, 'A')
        .slice(0, 10)}`,
      testFlag: false,
      contactMethod: 'email',
      consentState: 'not_required',
      reviewDueAt: new Date(Date.now() + 90 * 86_400_000),
      createdBy: 'public',
      ...over,
    });
  }

  prospect(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_prospects', w, {
      code: `P-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      isExternal: true,
      isTeamOrPartner: false,
      ...over,
    });
  }

  aiTask(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_ai_tasks', w, {
      generator: 'pub.brief.draft',
      objectType: 'brief',
      objectId: rid('obj'),
      ...over,
    });
  }

  async aiCall(w: PubWorld, over: Row = {}): Promise<string> {
    const taskId = (over.taskId as string) ?? (await this.aiTask(w));
    return this.child('pub_ai_calls', w, {
      attemptNo: 1,
      generator: 'pub.brief.draft',
      purpose: 'бриф',
      instructionVersion: 'pub.brief.draft@1',
      contextRulesVersion: 'ctx@1',
      sourceIds: [],
      provider: 'GEMINI',
      model: 'gemini-2.5-flash',
      opKey: uuid4(),
      requestedBy: M,
      ...over,
      taskId,
    });
  }

  experiment(w: PubWorld, over: Row = {}): Promise<string> {
    return this.child('pub_experiments', w, {
      key: `pilot-${randomBytes(3).toString('hex')}`,
      version: 1,
      kind: 'pilot',
      hypothesis: 'Гипотеза',
      change: 'Изменение',
      metric: 'Метрика',
      expectedSignal: 'Сигнал',
      stopConditions: 'Стоп',
      windowStart: new Date('2026-10-20T07:00:00Z'),
      windowEnd: new Date('2027-01-18T07:00:00Z'),
      thresholds: { d42: { minSampleForConclusion: 5 } },
      ...over,
    });
  }
}

/** Клиент pg владельца схемы для db-спеков. */
export async function connectOwner(): Promise<Client> {
  const c = new Client({ connectionString: pgUrl(PUB_RAW_URL as string) });
  await c.connect();
  return c;
}
