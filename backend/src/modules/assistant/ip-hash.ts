/**
 * Хеш IP посетителя консультанта (ТЗ §8): `sha256(ip + суточная соль)`.
 * Никогда не хранится сырой IP — только этот хеш, в `AssistantExchange`
 * (§10, для будущего rate-limit-анализа по аналитике; сам rate limit
 * §7.1 считает по IP напрямую в отдельной таблице, эта колонка — только
 * для ревью).
 *
 * Соль дневная — хеш одного и того же IP меняется на следующие сутки,
 * поэтому сопоставить два дня по этой колонке нельзя, а поведение внутри
 * одного дня — можно. Секрет соли — выделенная переменная,
 * `ASSISTANT_IP_HASH_SECRET`; если не задана, используется тот же
 * секрет, что у крона (`CRON_SECRET`, уже обязателен на проде) — заводить
 * вторую production-переменную ради этого не критично, но локально, где
 * не задано ни то ни другое, используется фиксированная dev-строка (не
 * секрет, но и хешировать в деве точный IP не от кого).
 */
import { createHash } from 'crypto';

function ipHashSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ASSISTANT_IP_HASH_SECRET?.trim() ||
    env.CRON_SECRET?.trim() ||
    'dev-only-assistant-ip-salt'
  );
}

/** `now` — для тестов; по умолчанию сегодняшняя дата UTC. */
export function hashVisitorIp(
  ip: string,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dailySalt = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return createHash('sha256')
    .update(`${ip}:${dailySalt}:${ipHashSecret(env)}`)
    .digest('hex');
}
