/**
 * Э-С Ш5: база знаний консультанта из кода генератора → база знаний
 * тенанта «viral4creators» в sites-backend (системный API знаний).
 * Логика — `src/common/tutorial-knowledge/knowledge-sync.ts`; здесь только
 * сборка базы (та же, что `build-assistant-knowledge.ts`), env и вывод.
 *
 *   npm run assist:knowledge-sync            — сухой прогон: документы,
 *                                              размеры, проверка утечек
 *   npm run assist:knowledge-sync -- --apply — отправить (GET → PUT → DELETE)
 *
 * Env для --apply: SITES_BACKEND_URL (как у внутреннего API Ш1),
 * ASSIST_LANDING_SITE_ID (id сайта тенанта в кабинете помощника),
 * ASSIST_KNOWLEDGE_API_KEY (ключ `knsec_…`, выпускает владелец в TMA
 * помощника → «Интеграции» → «API знаний»); необязательно —
 * LANDING_PUBLIC_URL (документ локали ссылается на `<лендинг>/<локаль>`,
 * хост должен быть подтверждён у сайта тенанта). Без них --apply не идёт:
 * код выхода 0 и строка «пропущено» (шаг CI не красный, пока владелец не
 * включил), но с флагом `--require` — код 1.
 *
 * Никакой базы данных и Prisma: чистая функция от файлов репозитория,
 * поэтому шаг CI не нужен ни DSN, ни Vercel.
 */
import { buildAll } from './build-assistant-knowledge';
import {
  SyncError,
  buildSyncDocuments,
  landingPageBase,
  runKnowledgeSync,
  syncConfigFromEnv,
  type FetchLike,
} from '../src/common/tutorial-knowledge/knowledge-sync';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const apply = args.has('--apply');
  const requireConfig = args.has('--require');
  const docs = buildSyncDocuments(
    buildAll(),
    landingPageBase(process.env.LANDING_PUBLIC_URL),
  );
  const cfg = syncConfigFromEnv(process.env);
  if (apply && !cfg.ok) {
    const msg = `assist:knowledge-sync: --apply пропущено — нет ${cfg.missing.join(', ')}`;
    // eslint-disable-next-line no-console
    console.log(msg);
    if (requireConfig) process.exitCode = 1;
    // Проверка утечек — всё равно (сухой прогон).
  }
  const fetchImpl: FetchLike = async (url, init) => {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, text: () => res.text() };
  };
  const report = await runKnowledgeSync({
    docs,
    apply: apply && cfg.ok,
    config: cfg.ok ? cfg.config : undefined,
    fetchImpl,
  });
  for (const d of report.documents) {
    const r = report.results.find((x) => x.key === d.key);
    // eslint-disable-next-line no-console
    console.log(
      `${d.key}: ${(d.bytes / 1024).toFixed(1)} KB, sha ${d.sha.slice(0, 12)}${r ? ` → ${r.status}` : ''}`,
    );
  }
  for (const k of report.removed) {
    // eslint-disable-next-line no-console
    console.log(`${k}: удалён (нет в коде)`);
  }
  // eslint-disable-next-line no-console
  console.log(
    report.applied
      ? `assist:knowledge-sync: отправлено ${report.results.length}, удалено ${report.removed.length}`
      : 'assist:knowledge-sync: сухой прогон — утечек нет, ничего не отправлено (--apply — отправить)',
  );
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    e instanceof SyncError ? `assist:knowledge-sync: ${e.message}` : e,
  );
  process.exitCode = 1;
});
