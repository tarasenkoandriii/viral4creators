/**
 * Поиск по знаниям режима поверх таблиц из KnowledgeTables — K2.
 *
 * Версии (§4-тер.2) — членством: у фрагмента `versions int[]`; поиск видит
 * только `$v = ANY(versions)`, где $v — опубликованная версия (или явно
 * запрошенная — проверка ворот): старая база или новая целиком, не смесь.
 * Сборка, публикация и окно отката — versions.ts и indexer.ts.
 *
 * Гибрид (§4.3): вектор (top-20) + полнотекст (top-20) + триграмма по
 * «редким» словам вопроса (артикулы, коды, модели — вектор их не
 * различает) → RRF → top-6. FAQ и ручные правки — бонус (владелец сказал
 * «отвечай так»); UGC — только по запросу и с пониженным весом;
 * карантин — никогда.
 *
 * Сырой SQL: имена таблиц — qualified(tables.x); векторный оператор —
 * `OPERATOR("extensions".<=>)`; полнотекст — ровно выражение индекса
 * `to_tsvector('simple'::regconfig, "text")`; HNSW частичный — в запросе
 * обязательно `"embedding" IS NOT NULL`; каждый запрос — с `"siteId" = $1`.
 * pgvector < 0.8 (локально 0.6) не умеет iterative scan: если HNSW+фильтр
 * вернул меньше k — повтор точным перебором по siteId (MATERIALIZED CTE).
 */
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import type { PrismaClient } from '@prisma/client';
import { toVectorLiteral } from '../site-ai/embedder';
import { rrfMerge } from './rrf';
import { qualified, type KnowledgeTables } from './tables';
import type { DocumentKind, SearchHit, SearchQuery } from './types';

/** Бонус проверенным ответам — полранга первого места (§4.3, §4-тер.4). */
export function faqBonus(k: number): number {
  return 0.5 / (k + 1);
}
/** UGC — мнение посетителя: штраф, чтобы не обгонял текст владельца. */
export function ugcPenalty(k: number): number {
  return -0.5 / (k + 1);
}

const MAX_QUERY_TERMS = 24;
const MAX_TRGM_TERMS = 4;

/** Слова вопроса (буквы/цифры с внутренними - . / _), без дублей. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of query
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+(?:[-_./][\p{L}\p{N}]+)*/gu)) {
    const w = m[0];
    if (w.length < 2 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/**
 * websearch-запрос «ИЛИ по словам»: вопрос посетителя целиком через И
 * почти никогда не совпадает с фрагментом. Слова в кавычках — оператор
 * `or` внутри вопроса не станет оператором.
 */
export function websearchOr(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' or ');
}

/** «Редкие» слова для триграммы: с цифрой или длинные — артикулы, модели. */
export function rareTerms(terms: string[]): string[] {
  const scored = terms
    .filter((t) => /\p{N}/u.test(t) || t.length >= 6)
    .sort(
      (a, b) =>
        Number(/\p{N}/u.test(b)) - Number(/\p{N}/u.test(a)) ||
        b.length - a.length,
    );
  return scored.slice(0, MAX_TRGM_TERMS);
}

interface HitRow {
  id: string;
  documentId: string;
  sourceType: string;
  url: string | null;
  title: string | null;
  headingPath: string | null;
  text: string;
  lang: string | null;
  ugc: boolean;
}

/**
 * Клиент поиска — только сырой SQL. Э2: чат виджета ищет под ролью
 * assist_public (AssistPublicDb), кабинет и крон — под основной
 * (PrismaService); оба подходят (у роли есть SELECT на фрагменты, assist_sites
 * — колонку knowledgeVersion).
 */
export type KnowledgeSearchDb = Pick<PrismaClient, '$queryRawUnsafe'>;

export class KnowledgeStore {
  private readonly C: string;
  private readonly S: string;

  constructor(
    readonly tables: KnowledgeTables,
    private readonly db: KnowledgeSearchDb,
  ) {
    this.C = qualified(tables.chunks);
    this.S = qualified(tables.settings);
  }

  /** Опубликованная версия режима сайта (0 — базы нет). */
  async publishedVersion(siteId: string): Promise<number> {
    const rows = await this.db.$queryRawUnsafe<{ v: number }[]>(
      `SELECT "knowledgeVersion" AS v FROM ${this.S} WHERE "siteId" = $1`,
      siteId,
    );
    return rows[0]?.v ?? 0;
  }

  private filter(ugc: boolean): string {
    // $1 siteId, $2 версия — во всех трёх запросах одинаково.
    return `"siteId" = $1 AND $2 = ANY("versions") AND NOT "quarantined"${
      ugc ? '' : ' AND NOT "ugc"'
    }`;
  }

  private async vectorIds(
    siteId: string,
    version: number,
    vec: string,
    k: number,
    ugc: boolean,
  ): Promise<string[]> {
    const where = `${this.filter(ugc)} AND "embedding" IS NOT NULL`;
    const rows = await this.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM ${this.C} WHERE ${where}
        ORDER BY "embedding" OPERATOR("extensions".<=>) $3::"extensions"."vector"
        LIMIT $4`,
      siteId,
      version,
      vec,
      k,
    );
    if (rows.length >= k) return rows.map((r) => r.id);
    // HNSW отдаёт k ближайших ДО фильтра: при малой доле сайта в индексе
    // фильтр съедает их. Точный перебор по сайту — сотни/тысячи строк.
    const exact = await this.db.$queryRawUnsafe<{ id: string }[]>(
      `WITH c AS MATERIALIZED (
         SELECT "id", "embedding" FROM ${this.C} WHERE ${where}
       )
       SELECT "id" FROM c
        ORDER BY "embedding" OPERATOR("extensions".<=>) $3::"extensions"."vector"
        LIMIT $4`,
      siteId,
      version,
      vec,
      k,
    );
    return exact.map((r) => r.id);
  }

  private async ftsIds(
    siteId: string,
    version: number,
    terms: string[],
    k: number,
    ugc: boolean,
  ): Promise<string[]> {
    if (!terms.length) return [];
    const rows = await this.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM ${this.C}
        WHERE ${this.filter(ugc)}
          AND to_tsvector('simple'::regconfig, "text") @@ websearch_to_tsquery('simple', $3)
        ORDER BY ts_rank(to_tsvector('simple'::regconfig, "text"), websearch_to_tsquery('simple', $3)) DESC, "id"
        LIMIT $4`,
      siteId,
      version,
      websearchOr(terms),
      k,
    );
    return rows.map((r) => r.id);
  }

  private async trgmIds(
    siteId: string,
    version: number,
    terms: string[],
    k: number,
    ugc: boolean,
  ): Promise<string[]> {
    const rare = rareTerms(terms);
    if (!rare.length) return [];
    // `term <% text` — в тексте есть слово, похожее на term (GIN gin_trgm_ops).
    const params = rare.map((_, i) => `$${i + 4}`);
    const rows = await this.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM ${this.C}
        WHERE ${this.filter(ugc)}
          AND (${params.map((p) => `${p} OPERATOR("extensions".<%) "text"`).join(' OR ')})
        ORDER BY GREATEST(${params
          .map((p) => `"extensions".word_similarity(${p}, "text")`)
          .join(', ')}) DESC, "id"
        LIMIT $3`,
      siteId,
      version,
      k,
      ...rare,
    );
    return rows.map((r) => r.id);
  }

  /**
   * Гибридный поиск. `queryVector` пустой — только текст (нет ключа
   * провайдера, сбой эмбеддинга): артикулы и слова всё равно найдутся.
   */
  async search(q: SearchQuery, queryVector: number[]): Promise<SearchHit[]> {
    if (!q.siteId) throw new Error('KnowledgeStore.search: siteId обязателен');
    const version = q.version ?? (await this.publishedVersion(q.siteId));
    if (!version) return [];
    const s = KNOWLEDGE_DEFAULTS.search;
    const limit = Math.max(1, Math.min(q.limit ?? s.resultTopK, 50));
    const ugc = q.includeUgc === true;
    const terms = queryTerms(q.query);

    const [vec, fts, trgm] = await Promise.all([
      queryVector.length
        ? this.vectorIds(
            q.siteId,
            version,
            toVectorLiteral(queryVector),
            s.vectorTopK,
            ugc,
          )
        : Promise.resolve([] as string[]),
      this.ftsIds(q.siteId, version, terms, s.textTopK, ugc),
      this.trgmIds(q.siteId, version, terms, s.textTopK, ugc),
    ]);

    const ids = [...new Set([...vec, ...fts, ...trgm])];
    if (!ids.length) return [];
    const rows = await this.db.$queryRawUnsafe<HitRow[]>(
      `SELECT "id", "documentId", "sourceType", "url", "title", "headingPath", "text", "lang", "ugc"
         FROM ${this.C}
        WHERE ${this.filter(ugc)} AND "id" = ANY($3::text[])`,
      q.siteId,
      version,
      ids,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rank = (list: string[]) => list.map((id, i) => ({ id, rank: i + 1 }));
    const vecRank = new Map(vec.map((id, i) => [id, i + 1]));
    const textRank = new Map<string, number>();
    for (const list of [fts, trgm]) {
      list.forEach((id, i) =>
        textRank.set(id, Math.min(textRank.get(id) ?? Infinity, i + 1)),
      );
    }
    const merged = rrfMerge([rank(vec), rank(fts), rank(trgm)], {
      k: s.rrfK,
      limit,
      bonus: (id) => {
        const r = byId.get(id);
        if (!r) return 0;
        if (r.ugc) return ugcPenalty(s.rrfK);
        return r.sourceType === 'faq' || r.sourceType === 'manual'
          ? faqBonus(s.rrfK)
          : 0;
      },
    });
    return merged
      .filter((m) => byId.has(m.id))
      .map((m) => {
        const r = byId.get(m.id)!;
        return {
          chunkId: r.id,
          documentId: r.documentId,
          sourceType: r.sourceType as DocumentKind,
          url: r.url,
          title: r.title,
          headingPath: r.headingPath,
          text: r.text,
          lang: r.lang,
          ugc: r.ugc,
          score: m.score,
          vectorRank: vecRank.get(r.id) ?? null,
          textRank: textRank.get(r.id) ?? null,
        };
      });
  }
}
