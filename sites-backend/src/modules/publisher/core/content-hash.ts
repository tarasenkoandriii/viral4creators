/**
 * AI Publisher — канонический hash версии материала (P-A1, проектный
 * документ §6.3, аудит P2-14; AT-CORE-10). ОДНА функция для сервера
 * (согласование `pub_approvals.versionHash`, публикация) и для проверки
 * страницы (`<meta name="pub-version">`, publisher-site).
 *
 * Hash включает СОДЕРЖИМОЕ связанных объектов, а не только их id: правка
 * текста claim, источника или значения факта меняет hash, поэтому прежнее
 * согласование не разрешает новый текст. Порядок связей не важен
 * (сортировка по id), ключи объектов — по алфавиту на любой глубине.
 *
 * Аудит P2-5: входят и МЕТАДАННЫЕ источника, которые страница показывает
 * (`title`, `visibility`, `url` — `pub_public_contents` отдаёт public-
 * источники с названием и адресом), и связи claim → источник
 * (`pub_claim_sources`: `claimId, sourceId, supports`). КОНТРАКТ ДЛЯ P-B1:
 * метаданные источника по §6.3 меняются без новой строки, поэтому P-B1
 * при заморозке версии (`frozenAt`) хеширует именно их снимок, а при
 * публикации пересчитывает hash по текущим значениям: расхождение с
 * `pub_approvals.versionHash` — согласование недействительно (новое
 * согласование), а не публикация «как есть».
 *
 * Чистый модуль.
 */
import { createHash } from 'crypto';

export interface ContentHashInput {
  title: string;
  body: string;
  meta: unknown;
  format: string;
  offerVersionId: string;
  /** `pub_offer_versions.hash` версии оффера. */
  offerHash: string;
  parentVersionId: string | null;
  /** Источники версии с тем, что о них показывает страница. */
  sources: ReadonlyArray<{
    id: string;
    /** `pub_sources.contentHash` = `sourceContentHash(url, fragment)`. */
    contentHash: string;
    title: string | null;
    /** `public | private`. */
    visibility: string;
    url: string | null;
  }>;
  claims: ReadonlyArray<{
    id: string;
    statement: string;
    type: string;
    risk: string;
  }>;
  facts: ReadonlyArray<{ id: string; version: number; value: unknown }>;
  /** Связи claim → источник (`pub_claim_sources`). */
  claimSources: ReadonlyArray<{
    claimId: string;
    sourceId: string;
    /** `yes | no | partial | unknown`. */
    supports: string;
  }>;
}

/**
 * Канонический JSON: ключи объектов отсортированы, `undefined` выброшен,
 * массивы — в своём порядке. Не-JSON значения (функции, bigint, NaN) —
 * ошибка: hash не должен зависеть от того, как их напечатал рантайм.
 */
export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v))
        throw new TypeError('canonicalJson: не конечное число');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
      if (v instanceof Date) return JSON.stringify(v.toISOString());
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: тип ${typeof v} не JSON`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** sha256 канонического JSON версии (64 hex, нижний регистр). */
export function contentVersionHash(input: ContentHashInput): string {
  return sha256Hex(
    canonicalJson({
      title: input.title,
      body: input.body,
      meta: input.meta ?? null,
      format: input.format,
      offerVersionId: input.offerVersionId,
      offerHash: input.offerHash,
      parentVersionId: input.parentVersionId,
      sources: [...input.sources]
        .sort(byId)
        .map((x) => [
          x.id,
          x.contentHash,
          x.title ?? null,
          x.visibility,
          x.url ?? null,
        ]),
      claims: [...input.claims]
        .sort(byId)
        .map((x) => [x.id, x.statement, x.type, x.risk]),
      facts: [...input.facts]
        .sort(byId)
        .map((x) => [x.id, x.version, x.value ?? null]),
      claimSources: [...input.claimSources]
        .map((x) => [x.claimId, x.sourceId, x.supports])
        .sort((a, b) => {
          const ka = `${a[0]}\u0000${a[1]}`;
          const kb = `${b[0]}\u0000${b[1]}`;
          return ka < kb ? -1 : ka > kb ? 1 : 0;
        }),
    }),
  );
}

/** sha256 содержимого источника `{url, fragment}` (`pub_sources.contentHash`). */
export function sourceContentHash(
  url: string | null,
  fragment: string,
): string {
  return sha256Hex(canonicalJson({ url, fragment }));
}

/**
 * Hash запроса (идемпотентность, §8.1): `{scope, pathParams, body, actor}`.
 * Актёр входит (аудит P3-2): тот же `opKey` другого участника кабинета —
 * 409 `PUB_IDEMPOTENCY_REUSED`, а не чужой сохранённый ответ (`opKey`
 * виден в логах и HAR).
 *
 * Это hash служебного ключа кабинета — без ПД. Для `pub_leads.requestHash`
 * (публичная форма, тело с контактом и именем) нужен КЛЮЧЕВОЙ HMAC —
 * `leadRequestHmac` (`contact-crypto`), см. `contracts/lead-validation.ts`.
 */
export function requestHashOf(
  scope: string,
  pathParams: Record<string, string>,
  body: unknown,
  actor: string,
): string {
  return sha256Hex(
    canonicalJson({ scope, pathParams, body: body ?? null, actor }),
  );
}
