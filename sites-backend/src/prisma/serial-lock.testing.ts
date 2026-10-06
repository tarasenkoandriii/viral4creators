/**
 * Сериализация файлов jest, которые делают ГЛОБАЛЬНЫЕ проходы по базе
 * (монитор голосового управления `VoiceMonitorService.run()` — переходы,
 * нарушения, канарейка, `needs_review` мемо по всем сайтам). В CI jest
 * гоняет файлы в нескольких воркерах на одной базе, и глобальный проход
 * одного файла может перевести состояние сайтов другого (урок CI 229b803
 * с очередью воркера — `jobs-db.testing.ts`). Сессионная
 * advisory-блокировка на своём соединении сериализует ровно файлы с
 * одним ключом; остальные идут параллельно как раньше. Без
 * `SITES_DIRECT_URL` — ничего не делает (наборы и так пропущены).
 */
export function serializeDbTests(key: string): void {
  const raw = process.env.SITES_DIRECT_URL;
  if (!raw) return;
  let client: import('pg').Client | null = null;
  const sql = (fn: 'lock' | 'unlock') =>
    `SELECT pg_advisory_${fn}(hashtext($1))`;
  beforeAll(async () => {
    const { Client } = await import('pg');
    const u = new URL(raw);
    u.searchParams.delete('schema');
    client = new Client({ connectionString: u.toString() });
    await client.connect();
    await client.query(sql('lock'), [`v4c:test:${key}`]);
  }, 600_000);
  afterAll(async () => {
    if (!client) return;
    try {
      await client.query(sql('unlock'), [`v4c:test:${key}`]);
    } finally {
      await client.end();
      client = null;
    }
  });
}
