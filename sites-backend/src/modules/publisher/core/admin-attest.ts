/**
 * AI Publisher, P-R-ADM — подтверждение оператора Админки для отложенного
 * вызова `pub.reddit.draft` (внутренний аудит 19.10.2026, IA-D1-03;
 * Р-IA-FXC-2).
 *
 * У участника кабинета очередь `ai-calls-run` перепроверяет право автора
 * по грантам в базе на сейчас (`recheckCall`, предаудит D2-03). У актора
 * `admin:<userId>` так нельзя: флаг `isOperator` живёт в базе backend, и
 * sites-backend её не видит. Зато каждый запрос оператора приходит сюда
 * только через прокси backend, который ПЕРЕД пересылкой проверяет
 * `assertOperator` (снятый оператор — 403, запрос не пересылается), а
 * `AdminRedditGuard` пишет на каждый пересланный запрос строку журнала
 * доступа `pub_reddit_admin_access_log` (Р-RD-ADM-7). Пока вызов ждёт
 * очереди, Админка опрашивает его (`cx/ai/calls/:callId`, шаг 2 с, до
 * 180 с) — каждый опрос и есть свежее подтверждение backend.
 *
 * Правило: очередь исполняет вызов актора `admin:` только если за последние
 * `ADMIN_ATTEST_MS` есть строка журнала этого актора. Оператора сняли — новых
 * строк нет, и не позже чем через окно вызов получает `refused`
 * (`PUB_ROLE_REQUIRED`) без вызова модели, как участник с отозванным
 * грантом. Оператор закрыл вкладку — тоже `refused` (стоимость 0, резерв
 * снят): повторить генерацию безопасно. Остаточное окно (≤ 60 с вместо
 * срока `ai-calls-reap` 10 мин) — плата за то, что право живёт в другой
 * базе; точная проверка потребовала бы обратного HTTP-вызова в backend.
 */
import type { SitesDb } from '../../../prisma/sites-db.service';
import { isAdminActor } from '../contracts/common';

/** Окно свежести подтверждения оператора (≈ 30 опросов Админки). */
export const ADMIN_ATTEST_MS = 60_000;

/**
 * Есть ли свежая строка журнала доступа Админки у актора `admin:<userId>`.
 * Для не-admin акторов — `true` (их право проверяет `recheckCall`).
 */
export async function adminActorAttested(
  db: SitesDb,
  actor: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!isAdminActor(actor)) return true;
  const row = await db
    .system(
      'ai-calls-run: подтверждение оператора Админки по журналу доступа (вне кабинета)',
    )
    .pubRedditAdminAccessLog.findFirst({
      where: { actor, at: { gte: new Date(nowMs - ADMIN_ATTEST_MS) } },
      select: { id: true },
    });
  return row !== null;
}
