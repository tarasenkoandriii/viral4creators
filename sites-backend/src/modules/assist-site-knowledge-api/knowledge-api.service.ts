/**
 * Системный API знаний сайта — Э-С Ш5 (см. knowledge-api.ts):
 *   GET    /assist/v1/sites/:id/knowledge/site/documents       — ключи живых документов
 *   PUT    /assist/v1/sites/:id/knowledge/site/documents/:key  — создать/заменить
 *   DELETE /assist/v1/sites/:id/knowledge/site/documents/:key  — удалить
 *
 * Порядок проверок: форма id → подпись ключом сайта (нет ключа, чужой,
 * старая или битая подпись, несуществующий сайт — ОДИН ответ 401, не
 * оракул) → лимит частоты сайта → повтор (PUT/DELETE — один раз, 409
 * `KNOWLEDGE_API_REPLAY`; аудит Ш5) → тело → суточный лимит изменений
 * (только то, что публикует версию; 429 `KNOWLEDGE_API_CHANGES_LIMIT`).
 * PUT сайта — по одному (аренда, Ш5 (10)): лимит 50 документов источника
 * `api` и создание источника атомарны для параллельных PUT разных ключей.
 * Документы пишет общий код режима
 * «Сайт» (`ModeKnowledgeCore.apiUpsert/apiRemove`): источник `api`,
 * обычная версия знаний, карантин инъекций — как у файла владельца; тот же
 * текст — `unchanged` без версии и без эмбеддингов (идемпотентность по
 * хешу документа). В лог — только id сайта, ключ документа и код итога.
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_SITE_HOST } from '../site-core/ownership/host-roles';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  DocumentParseError,
  parseDocument,
} from '../assist-knowledge-core/documents/parse';
import { detectInjection } from '../assist-knowledge-core/injection';
import type { KnowledgeCtx } from '../assist-knowledge-core/types';
import { IntegrationsService } from '../assist-analytics/integrations.service';
import { SiteSourcesService } from '../assist-site-knowledge/site-sources.service';
import {
  KNOWLEDGE_API_DEFAULTS,
  findSecretLike,
  knowledgeRequestDigest,
  parseKnowledgeApiBody,
  validDocumentKey,
  validSiteId,
  verifyKnowledgeApiRequest,
  type KnowledgeApiMethod,
} from './knowledge-api';

export type KnowledgeApiCode =
  | 'SIGNATURE_INVALID'
  | 'RATE_LIMITED'
  | 'KNOWLEDGE_API_REPLAY'
  | 'KNOWLEDGE_API_CHANGES_LIMIT'
  | 'KNOWLEDGE_API_BUSY'
  | 'KNOWLEDGE_API_KEY_INVALID'
  | 'KNOWLEDGE_API_BODY_INVALID'
  | 'KNOWLEDGE_API_SECRET_LIKE'
  | 'KNOWLEDGE_API_URL_INVALID'
  | 'DOCUMENT_TOO_LARGE'
  | 'DOCUMENT_NO_TEXT';

export function knowledgeApiError(
  status: HttpStatus,
  code: KnowledgeApiCode,
  message: string,
): HttpException {
  return new HttpException({ error: code, code, message }, status);
}

export interface KnowledgeApiListView {
  siteId: string;
  documents: Array<{
    key: string;
    title: string | null;
    lang: string | null;
    hash: string | null;
    updatedAt: string;
  }>;
}

export interface KnowledgeApiPutView {
  key: string;
  status: 'created' | 'updated' | 'unchanged';
  /** Номер новой версии знаний; `unchanged` — null. */
  version: number | null;
  hash: string;
  /** Текст длиннее потолка разбора — в знания вошла первая часть. */
  truncated: boolean;
}

export interface KnowledgeApiDeleteView {
  key: string;
  status: 'deleted' | 'absent';
  version: number | null;
}

interface SignedRequest {
  siteId: string;
  key: string;
  rawBody: string;
  signature: string | undefined;
}

@Injectable()
export class KnowledgeApiService {
  private readonly logger = new Logger(KnowledgeApiService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: SitesDb,
    private readonly integrations: IntegrationsService,
    private readonly sources: SiteSourcesService,
  ) {}

  private unauthorized(): HttpException {
    return knowledgeApiError(
      HttpStatus.UNAUTHORIZED,
      'SIGNATURE_INVALID',
      'Подпись не прошла проверку',
    );
  }

  /** Подпись → контекст сайта. Любая неудача — один и тот же 401. */
  private async authorize(
    method: KnowledgeApiMethod,
    r: SignedRequest,
  ): Promise<KnowledgeCtx> {
    if (!validSiteId(r.siteId)) throw this.unauthorized();
    const secret = await this.integrations.knowledgeApiSecret(r.siteId);
    const now = this.now();
    if (
      !secret ||
      verifyKnowledgeApiRequest(
        secret,
        { method, siteId: r.siteId, key: r.key, rawBody: r.rawBody },
        r.signature,
        Math.floor(now.getTime() / 1000),
      ) !== 'ok'
    ) {
      this.logger.warn(`API знаний: подпись отклонена (site ${r.siteId})`);
      throw this.unauthorized();
    }
    const site = await this.db
      .system('API знаний: кабинет сайта по id (после подписи)')
      .site.findUnique({
        where: { id: r.siteId },
        select: { id: true, accountId: true },
      });
    if (!site) throw this.unauthorized();
    if (!(await this.rateOk(site.id, now))) {
      throw knowledgeApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'RATE_LIMITED',
        'Слишком много запросов — повторите через минуту',
      );
    }
    if (method !== 'GET') {
      const d = knowledgeRequestDigest(
        secret,
        { method, siteId: r.siteId, key: r.key, rawBody: r.rawBody },
        r.signature,
      );
      if (!d || !(await this.firstUse(site.id, d.t, d.digest))) {
        this.logger.warn(`API знаний: повтор запроса (site ${site.id})`);
        throw knowledgeApiError(
          HttpStatus.CONFLICT,
          'KNOWLEDGE_API_REPLAY',
          'Этот подписанный запрос уже принят — для повтора подпишите заново',
        );
      }
    }
    await this.integrations.touchKnowledgeApi(site.id).catch(() => undefined);
    return { accountId: site.accountId, siteId: site.id };
  }

  private requireKey(key: string): void {
    if (!validDocumentKey(key)) {
      throw knowledgeApiError(
        HttpStatus.BAD_REQUEST,
        'KNOWLEDGE_API_KEY_INVALID',
        'Ключ документа: латиница в нижнем регистре, цифры, «.», «_», «-», до 80 символов',
      );
    }
  }

  async list(r: Omit<SignedRequest, 'key'>): Promise<KnowledgeApiListView> {
    const ctx = await this.authorize('GET', { ...r, key: '' });
    const documents = await this.sources.core.apiDocuments(ctx);
    return { siteId: ctx.siteId, documents };
  }

  async put(r: SignedRequest): Promise<KnowledgeApiPutView> {
    // Ключ проверяется ПОСЛЕ подписи: иначе ответ «ключ не тот» без
    // подписи подсказывал бы, что сайт существует.
    const ctx = await this.authorize('PUT', r);
    this.requireKey(r.key);
    const parsed = parseKnowledgeApiBody(r.rawBody);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') {
        throw knowledgeApiError(
          HttpStatus.PAYLOAD_TOO_LARGE,
          'DOCUMENT_TOO_LARGE',
          `Документ больше ${Math.round(KNOWLEDGE_API_DEFAULTS.contentMaxBytes / 1024)} КБ — разделите его на части`,
        );
      }
      if (parsed.reason === 'url') {
        throw knowledgeApiError(
          HttpStatus.BAD_REQUEST,
          'KNOWLEDGE_API_URL_INVALID',
          'url — https-адрес страницы на подтверждённом хосте этого сайта',
        );
      }
      throw knowledgeApiError(
        HttpStatus.BAD_REQUEST,
        'KNOWLEDGE_API_BODY_INVALID',
        'Тело: { title, lang?, format?: "markdown"|"text", content, url? }',
      );
    }
    const doc = parsed.doc;
    // Аудит Ш5: заголовок документа уходит в промпт атрибутом каждого его
    // фрагмента, а карантин проверяет только текст фрагментов — заголовок
    // с инструкцией модели отклоняется целиком (части в карантин не убрать).
    if (detectInjection(doc.title).quarantine) {
      throw knowledgeApiError(
        HttpStatus.BAD_REQUEST,
        'KNOWLEDGE_API_BODY_INVALID',
        'Заголовок похож на инструкцию для ИИ — переименуйте документ',
      );
    }
    if (doc.url && !(await this.onVerifiedHost(ctx, doc.url))) {
      throw knowledgeApiError(
        HttpStatus.BAD_REQUEST,
        'KNOWLEDGE_API_URL_INVALID',
        'url — https-адрес страницы на подтверждённом хосте этого сайта',
      );
    }
    const leak = findSecretLike(`${doc.title}\n${doc.content}`);
    if (leak) {
      this.logger.warn(
        `API знаний: документ ${r.key} отклонён — похоже на секрет (${leak}, site ${ctx.siteId})`,
      );
      throw knowledgeApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'KNOWLEDGE_API_SECRET_LIKE',
        `В документе есть строка, похожая на секрет (${leak}) — уберите её из источника`,
      );
    }
    let blocks;
    let lang: string | null;
    let truncated = false;
    try {
      const p = await parseDocument(
        Buffer.from(doc.content, 'utf8'),
        doc.format === 'markdown' ? 'md' : 'txt',
        `${r.key}.${doc.format === 'markdown' ? 'md' : 'txt'}`,
      );
      blocks = p.blocks;
      lang = doc.lang ?? p.lang;
      truncated = p.truncated === true;
    } catch (e) {
      if (e instanceof DocumentParseError) {
        throw knowledgeApiError(
          HttpStatus.BAD_REQUEST,
          'DOCUMENT_NO_TEXT',
          'В документе нет текста',
        );
      }
      throw e;
    }
    // Ш5 (10): запись документов сайта — по одной (аренда сайта): проверка
    // «≤ 50 документов источника api» и создание источника внутри
    // apiUpsert иначе гонялись бы у параллельных PUT разных ключей.
    const out = await this.withPutLease(ctx.siteId, () =>
      this.sources.core.apiUpsert(
        ctx,
        r.key,
        { title: doc.title, lang, blocks, url: doc.url },
        { beforeChange: () => this.chargeChange(ctx.siteId) },
      ),
    );
    this.logger.log(
      `API знаний: ${r.key} — ${out.status}${out.version ? ` (версия ${out.version})` : ''}, site ${ctx.siteId}`,
    );
    return { key: r.key, ...out, truncated };
  }

  async remove(r: SignedRequest): Promise<KnowledgeApiDeleteView> {
    const ctx = await this.authorize('DELETE', r);
    this.requireKey(r.key);
    const out = await this.sources.core.apiRemove(ctx, r.key, {
      beforeChange: () => this.chargeChange(ctx.siteId),
    });
    this.logger.log(`API знаний: ${r.key} — ${out.status}, site ${ctx.siteId}`);
    return { key: r.key, ...out };
  }

  /**
   * Хост адреса — подтверждённый (и не отозванный) хост «Сайта» ЭТОГО
   * сайта. Хост «Админки» — не хост сайта (аудит Ш5: ссылка-источник на
   * него в ответе посетителю отсеялась бы проверкой ответа как чужая).
   */
  private async onVerifiedHost(
    ctx: KnowledgeCtx,
    url: string,
  ): Promise<boolean> {
    const host = new URL(url).hostname.replace(/\.$/, '').toLowerCase();
    const row = await this.db.forAccount(ctx.accountId).siteHost.findFirst({
      where: {
        siteId: ctx.siteId,
        host,
        status: 'verified',
        revokedAt: null,
        ...PUBLIC_SITE_HOST,
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Защита от повтора: отпечаток изменяющего запроса — один раз. Строка
   * живёт до конца окна подписи (+ минута): позже запрос и так `stale`.
   * Уборка — общая для assist_rate_buckets (chat-retention).
   */
  private async firstUse(
    siteId: string,
    t: number,
    digest: string,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
       VALUES ('knowledge-api-replay', $1, $2, 1, $3)
       ON CONFLICT ("scope", "key", "bucket") DO NOTHING
       RETURNING "count"`,
      `${siteId}:${digest}`,
      String(t),
      new Date((t + KNOWLEDGE_API_DEFAULTS.signatureWindowSec + 60) * 1000),
    );
    return rows.length > 0;
  }

  /**
   * Ш5 (10): аренда записи документов сайта — условная вставка строки
   * `assist_rate_buckets` (`knowledge-api-put-lease`): взять можно, только
   * если строки нет или срок прежней аренды истёк (упавший запрос держит
   * сайт не дольше `putLeaseMs`). Пока аренда у одного PUT, другие ждут
   * (опрос) до `putLeaseWaitMs`, потом — 409 `KNOWLEDGE_API_BUSY`
   * (повторить с новой подписью). Отпускает ровно свою аренду: номер
   * (`count` растёт при каждом захвате) и срок — как жетон.
   */
  putLeaseMs = 120_000;
  putLeaseWaitMs = 20_000;
  putLeasePollMs = 100;

  private async acquirePutLease(
    siteId: string,
  ): Promise<{ count: number; expiresAt: Date } | null> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.putLeaseMs);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
       VALUES ('knowledge-api-put-lease', $1, 'lease', 1, $2)
       ON CONFLICT ("scope", "key", "bucket") DO UPDATE
         SET "count" = "sites"."assist_rate_buckets"."count" + 1, "expiresAt" = $2
         WHERE "sites"."assist_rate_buckets"."expiresAt" <= $3
       RETURNING "count"`,
      siteId,
      expiresAt,
      now,
    );
    return rows.length ? { count: rows[0].count, expiresAt } : null;
  }

  private async withPutLease<T>(
    siteId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + this.putLeaseWaitMs;
    let lease = await this.acquirePutLease(siteId);
    while (!lease) {
      if (Date.now() >= deadline) {
        throw knowledgeApiError(
          HttpStatus.CONFLICT,
          'KNOWLEDGE_API_BUSY',
          'Документы этого сайта сейчас записывает другой запрос — повторите (с новой подписью)',
        );
      }
      await new Promise((res) => setTimeout(res, this.putLeasePollMs));
      lease = await this.acquirePutLease(siteId);
    }
    try {
      return await fn();
    } finally {
      await this.prisma
        .$executeRawUnsafe(
          `DELETE FROM "sites"."assist_rate_buckets"
            WHERE "scope" = 'knowledge-api-put-lease' AND "key" = $1 AND "bucket" = 'lease'
              AND "count" = $2 AND "expiresAt" = $3`,
          siteId,
          lease.count,
          lease.expiresAt,
        )
        .catch(() => undefined);
    }
  }

  /** Суточный лимит изменений сайта — слот берётся ДО публикации версии. */
  private async chargeChange(siteId: string): Promise<void> {
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
       VALUES ('knowledge-api-site-day-changes', $1, $2, 1, $3)
       ON CONFLICT ("scope", "key", "bucket") DO UPDATE
         SET "count" = "sites"."assist_rate_buckets"."count" + 1
         WHERE "sites"."assist_rate_buckets"."count" < $4
       RETURNING "count"`,
      siteId,
      day,
      new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000),
      KNOWLEDGE_API_DEFAULTS.changesPerDay,
    );
    if (!rows.length) {
      throw knowledgeApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'KNOWLEDGE_API_CHANGES_LIMIT',
        `За сутки уже ${KNOWLEDGE_API_DEFAULTS.changesPerDay} изменений знаний по API — повторите завтра (тот же текст — «unchanged» — не считается)`,
      );
    }
  }

  private async rateOk(siteId: string, now: Date): Promise<boolean> {
    const win = 60_000;
    const start = Math.floor(now.getTime() / win) * win;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
       VALUES ('knowledge-api-site-min', $1, $2, 1, $3)
       ON CONFLICT ("scope", "key", "bucket") DO UPDATE
         SET "count" = "sites"."assist_rate_buckets"."count" + 1
         WHERE "sites"."assist_rate_buckets"."count" < $4
       RETURNING "count"`,
      siteId,
      new Date(start).toISOString(),
      new Date(start + win),
      KNOWLEDGE_API_DEFAULTS.ratePerMinute,
    );
    return rows.length > 0;
  }
}
