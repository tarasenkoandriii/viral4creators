import type { FindingRecheck } from '../lib/qa-findings-api';

export function QaFindingRecheck({
  recheck,
}: {
  recheck?: FindingRecheck | null;
}) {
  if (!recheck)
    return (
      <section aria-label="Автоматическая перепроверка" className="space-y-2">
        <h3 className="font-semibold">Автоматическая перепроверка</h3>
        <p>
          Новой сопоставимой попытки после исходного наблюдения нет. Это не
          подтверждает исправление.
        </p>
      </section>
    );
  const labels = {
    passed: 'Сценарий прошёл; исправление ещё должен подтвердить человек',
    failed: 'Сценарий снова завершился ошибкой',
    blocked: 'Проверка заблокирована; успешная приёмка не подтверждена',
    skipped: 'Сценарий пропущен; исправление не проверено',
  };
  return (
    <section
      aria-label="Автоматическая перепроверка"
      className="space-y-2 break-words"
    >
      <h3 className="font-semibold">Автоматическая перепроверка</h3>
      <p>{labels[recheck.status]}</p>
      <p>
        Кейс {recheck.caseKey} · v{recheck.caseVersion} · {recheck.project}
      </p>
      <p>Сохранено: {recheck.checkedAt}</p>
      <p>
        Запуск: {recheck.runId} · попытка: {recheck.attemptId}
      </p>
      <p>
        Результат попытки: {recheck.recordedStatus}; runner:{' '}
        {recheck.runnerStatus ?? 'не подтверждён'}
      </p>
      <p>SHA тестов: {recheck.testSourceSha ?? 'не подтверждён'}</p>
      <p>SHA деплоя: {recheck.deployedSha ?? 'не подтверждён'}</p>
      <p>SHA-256 отчёта: {recheck.reportHash}</p>
      <p>
        Статус и ревизия замечания не изменены. Это результат сохранённого
        сценария, а не полный аудит сайта.
      </p>
    </section>
  );
}
