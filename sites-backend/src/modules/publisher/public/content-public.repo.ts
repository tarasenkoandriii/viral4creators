/**
 * AI Publisher, P-B1 — публичное чтение опубликованного контента
 * (проектный документ §11.4 `GET /contents?key=`, `GET /contents/:slug?key=`;
 * §6.5 представления `pub_public_products`, `pub_public_contents`; AT-CORE-01).
 *
 * Только роль `publisher_public` (`PublisherPublicDb`) и только
 * представление контента — сырой SQL с явными колонками. Что показывать,
 * решает представление P-A0: в режиме `live` — последняя live-публикация
 * канала `site` с АКТИВНЫМ согласованием того же hash (отправка новой версии
 * на проверку страницу не снимает, автопроверка URL на показ не влияет), в
 * `test` — тестовая; снятый материал — строка `withdrawn` без тела (410).
 *
 * Публичная обвязка (ключ → продукт, Origin, ошибка и фильтр, лимит чтения
 * в памяти) — общая с приёмом P-D: `public-guard.ts`, `rate-limit.ts`
 * (интеграция Z-1, Р-PUB-Z1-7; было Р-PUB-B1-11).
 */
import { Injectable } from '@nestjs/common';
import { PublisherPublicDb } from '../../../prisma/publisher-public-db.service';
import type {
  PublicContent,
  PublicContentListItem,
} from '../contracts/content-api';

export const SLUG_RE = /^[a-z0-9-]{3,80}$/;
/** Лимит чтения контента на IP (§11.4: 120 в минуту). */
export const CONTENT_READS_PER_MIN = 120;

interface ContentRow {
  slug: string;
  title: string | null;
  body: string | null;
  meta: Record<string, unknown> | null;
  sources: PublicContent['sources'] | null;
  versionHash: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  stage: 'test' | 'live';
  withdrawn: boolean;
}

const iso = (d: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;
const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;

export function publicContentOf(r: ContentRow): PublicContent {
  const m = r.meta ?? {};
  return {
    title: r.title ?? '',
    shortAnswer: str(m.shortAnswer),
    body: r.body ?? '',
    example: str(m.example),
    limitations: Array.isArray(m.limitations)
      ? (m.limitations as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [],
    editor: str(m.editor),
    publishedAt: iso(r.publishedAt),
    substantiallyUpdatedAt: str(m.substantiallyUpdatedAt),
    sources: Array.isArray(r.sources) ? r.sources : [],
    cta: str(m.cta),
    versionHash: r.versionHash ?? '',
    stage: r.stage,
  };
}

@Injectable()
export class ContentPublicRepo {
  constructor(private readonly db: PublisherPublicDb) {}

  get configured(): boolean {
    return this.db.configured;
  }

  async list(productId: string): Promise<PublicContentListItem[]> {
    const rows = await this.db.$queryRaw<
      Array<
        Pick<
          ContentRow,
          'slug' | 'title' | 'publishedAt' | 'updatedAt' | 'stage' | 'withdrawn'
        > & { description: string | null }
      >
    >`
      SELECT "slug", "title", "meta" ->> 'description' AS "description",
             "publishedAt", "updatedAt", "stage", "withdrawn"
        FROM "sites"."pub_public_contents"
       WHERE "productId" = ${productId}
       ORDER BY "withdrawn", "publishedAt" DESC NULLS LAST, "slug"`;
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      publishedAt: iso(r.publishedAt),
      updatedAt: iso(r.updatedAt),
      stage: r.stage,
      withdrawn: r.withdrawn,
    }));
  }

  async bySlug(productId: string, slug: string): Promise<ContentRow | null> {
    const rows = await this.db.$queryRaw<ContentRow[]>`
      SELECT "slug", "title", "body", "meta", "sources", "versionHash",
             "publishedAt", "updatedAt", "stage", "withdrawn"
        FROM "sites"."pub_public_contents"
       WHERE "productId" = ${productId} AND "slug" = ${slug}
       LIMIT 1`;
    return rows[0] ?? null;
  }
}
