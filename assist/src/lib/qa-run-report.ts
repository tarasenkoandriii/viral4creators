import { qaAcceptanceStatus, qaRunSummary, type QaRun } from './qa-runs-api';

const labels = {
  passed: 'Пройден',
  failed: 'Ошибка',
  blocked: 'Заблокирован',
  skipped: 'Пропущен',
  notRun: 'Не выполнен',
};
// Text is exported, never interpreted as HTML or a spreadsheet formula.
const text = (s: string) =>
  Array.from(s, (c) => (c.charCodeAt(0) < 32 ? ' ' : c))
    .join('')
    .replace(/[\\`*_{}[\]<>|#!]/g, '\\$&');

export function qaRunReport(siteId: string, run: QaRun): string {
  const counts = qaRunSummary(run);
  const accepted = counts.passed === run.snapshot.length && counts.passed > 0;
  const lines = [
    '# Отчёт QA',
    '',
    text(run.title),
    `Сайт: ${text(siteId)} · запуск: ${text(run.id)} · ревизия: ${run.revision}`,
    `Создан: ${text(run.createdAt)}`,
    `Итог: ${accepted ? 'Все выбранные кейсы пройдены' : 'Приёмка не подтверждена'}.`,
    Object.entries(counts)
      .map(([k, n]) => `${labels[k as keyof typeof labels]}: ${n}`)
      .join(' · '),
    '',
    'Область проверки: только кейсы и версии этого запуска. Это не сертификат качества всего сайта, безопасности или отсутствия ошибок.',
    'Приведены последние попытки на момент выгрузки. История, PNG и секретные ссылки на артефакты не включены. Перед передачей отчёта проверьте комментарии на персональные данные.',
  ];
  if (run.context) {
    const c = run.context,
      e = c.environment;
    lines.push(
      '',
      `План: ${text(c.planKey)} v${c.planVersion}; группа: ${text(c.suite)}.`,
      `Окружение: ${[e.name, e.browser, e.device, e.viewport, e.theme, e.locale].map(text).join(' · ')}.`,
      'Окружение задано в плане; это не доказательство запуска на физическом устройстве.'
    );
  }
  for (const s of run.snapshot) {
    const a = run.latestAttempts.find((a) => a.caseKey === s.caseKey);
    lines.push(
      '',
      `## ${text(s.caseKey)} · v${s.version} · ${text(s.payload.title)}`,
      `Результат для приёмки: ${labels[qaAcceptanceStatus(a)]}.`
    );
    if (!a) continue;
    lines.push(
      `Последняя попытка: ${text(a.id)} · #${a.attemptNumber} · ${text(a.createdAt)}.`,
      `Исходный результат: ${labels[a.status]}; источник: ${a.origin === 'manual' ? 'ручной' : 'автоматический'}.`,
      `Комментарий: ${text(a.comment) || 'не указан'}.`
    );
    if (a.origin === 'automated')
      lines.push(
        `Проект: ${text(a.project ?? 'не указан')}; runner: ${text(a.sourceMetadata?.runnerStatus ?? 'неизвестен')}.`,
        `SHA тестов: ${text(a.sourceMetadata?.testSourceSha ?? 'не указан')}; SHA деплоя: ${text(a.sourceMetadata?.deployedSha ?? 'не подтверждён')}.`
      );
    if (run.flakyCaseKeys.includes(s.caseKey))
      lines.push(
        'После неуспешной попытки получен passed; требуется разбор нестабильности.'
      );
  }
  return lines.join('\n') + '\n';
}

export function downloadQaRunReport(siteId: string, run: QaRun) {
  const url = URL.createObjectURL(
    new Blob([qaRunReport(siteId, run)], {
      type: 'text/markdown;charset=utf-8',
    })
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `qa-run-${run.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-r${run.revision}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
