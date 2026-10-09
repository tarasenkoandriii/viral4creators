/**
 * №113 (заход 11, Р-З11-Б8) — запись кандидатов в термины карты
 * (`assist_site_stt_low_terms`) под ролью виджета: ОДИН многострочный
 * INSERT (горячий путь голоса), `ON CONFLICT DO NOTHING` без цели (у роли
 * только INSERT). Пишут те, кто знает назначение текста: план команды без
 * значений полей (`ui-plan.service.ts`) и вопрос чата при совпадении со
 * словарём сайта (`site-chat.service.ts`). Посетитель — хеш с id сайта,
 * IP — суточный хеш токена (`ipHash`; «разных посетителей» считается и по
 * нему). Сбой записи ответ не ломает; в лог — число, без фраз.
 */
import { createHash } from 'crypto';
import type { LowConfTerm } from './stt-low-conf';

export interface LowTermsDb {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const COLS =
  '"accountId", "siteId", "day", "norm", "word", "visitorHash", "ipHash"';

/** Ровно этот SQL (для 1…3 строк) сверяет `assist-public-role.spec.ts`. */
export function lowTermsSql(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const k = 6 + i * 2;
    return `($1, $2, $3, $${k}, $${k + 1}, $4, $5)`;
  });
  return `INSERT INTO "sites"."assist_site_stt_low_terms" (${COLS}) VALUES ${rows.join(', ')} ON CONFLICT DO NOTHING`;
}

export function sttVisitorHash(siteId: string, visitorId: string): string {
  return createHash('sha256')
    .update(`stt-low|${siteId}|${visitorId}`)
    .digest('hex')
    .slice(0, 32);
}

export async function insertLowConfTerms(
  db: LowTermsDb,
  p: {
    accountId: string;
    siteId: string;
    visitorId: string;
    ipHash: string;
    now: Date;
    terms: readonly LowConfTerm[];
  },
): Promise<number> {
  const terms = p.terms.slice(0, 3);
  if (!terms.length) return 0;
  return db.$executeRawUnsafe(
    lowTermsSql(terms.length),
    p.accountId,
    p.siteId,
    p.now.toISOString().slice(0, 10),
    sttVisitorHash(p.siteId, p.visitorId),
    p.ipHash.slice(0, 128),
    ...terms.flatMap((t) => [t.norm, t.text]),
  );
}
