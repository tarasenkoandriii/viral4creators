/**
 * Понятная диагностика недоступности Postgres (этап 29).
 *
 * Раньше сбой связи выглядел так: health молча отвечал `degraded`, а в
 * логах лежал stack trace драйвера, из которого не видно главного — куда
 * мы вообще стучались и что именно не так. Эта функция превращает
 * ошибку в одну строку, по которой понятно, что чинить, и при этом
 * **никогда не печатает пароль**: из строки подключения берутся только
 * хост, порт и имя базы.
 */

export interface DbFailureInfo {
  /** Строка для лога — уже без секретов. */
  message: string;
  /** Короткий код для метрик/грепа: unreachable | auth | timeout | unknown. */
  kind: 'unreachable' | 'auth' | 'timeout' | 'tls' | 'unknown';
  /** `host:port/база` или null, если DATABASE_URL не разобрался. */
  target: string | null;
  hint: string;
}

/** `postgresql://user:pass@host:5432/db?x=1` → `host:5432/db`, без учётки. */
export function describeTarget(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const db =
      decodeURIComponent(u.pathname.replace(/^\//, '')) || '(без имени)';
    return `${u.hostname}:${u.port || '5432'}/${db}`;
  } catch {
    return null;
  }
}

const HINTS: Record<DbFailureInfo['kind'], string> = {
  unreachable:
    'Postgres не отвечает по адресу из DATABASE_URL: проверьте, что база поднята (локально — `pg_ctlcluster 16 main start` или `make up`), а в проде — что используется ПУЛЛЕР Supabase (порт 6543), а не прямое подключение.',
  auth: 'Логин/пароль или имя базы в DATABASE_URL не подходят — сверьте строку подключения в Supabase → Settings → Database.',
  timeout:
    'Подключение открывается слишком долго: обычно это исчерпанный пул Supabase (слишком много одновременных функций) или сеть между регионами.',
  tls: 'Не сошёлся TLS: у Supabase требуется `sslmode=require` в строке подключения.',
  unknown:
    'Причина не распознана — смотрите оригинальное сообщение драйвера ниже.',
};

function classify(raw: string): DbFailureInfo['kind'] {
  const t = raw.toLowerCase();
  if (
    /econnrefused|enotfound|ehostunreach|connection refused|can't reach database/.test(
      t,
    )
  )
    return 'unreachable';
  if (
    /password|authentication|role .* does not exist|database .* does not exist/.test(
      t,
    )
  )
    return 'auth';
  if (/etimedout|timeout|timed out/.test(t)) return 'timeout';
  if (/ssl|tls|certificate/.test(t)) return 'tls';
  return 'unknown';
}

/** Ошибка драйвера → строка для лога + подсказка, что чинить. */
export function describeDbFailure(
  error: unknown,
  databaseUrl = process.env.DATABASE_URL,
): DbFailureInfo {
  const raw =
    error instanceof Error ? error.message : String(error ?? 'unknown error');
  // Пароль может попасть в текст ошибки драйвера — вырезаем его и там.
  const safe = raw.replace(/:\/\/[^@\s]+@/g, '://***@');
  const kind = classify(safe);
  const target = describeTarget(databaseUrl);
  return {
    kind,
    target,
    hint: HINTS[kind],
    message: `Нет связи с базой (${kind})${target ? ` — ${target}` : ''}: ${safe}`,
  };
}
