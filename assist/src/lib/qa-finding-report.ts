import {
  findingStatusLabels,
  type Finding,
  type QaArtifact,
} from './qa-findings-api';

const text = (s: string) =>
  Array.from(s, (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c
  )
    .join('')
    .replace(/[\\`*_{}[\]<>|#!]/g, '\\$&');

/** Deliberately excludes page/evidence URLs and signed artifact links. */
export function qaFindingReport(
  siteId: string,
  finding: Finding,
  artifacts: QaArtifact[]
): string {
  const p = finding.payload;
  const lines = [
    '# Отчёт по замечанию QA',
    '',
    text(p.title),
    `Сайт: ${text(siteId)} · замечание: ${text(finding.id)} · ревизия: ${finding.revision}`,
    `Наблюдение: ${text(p.observedAt)} · обновлено: ${text(finding.updatedAt)}`,
    `Приоритет: ${p.severity} · категория: ${text(p.category)}`,
    `Статус автора: ${findingStatusLabels[p.status]}`,
    'Это одно сохранённое наблюдение, не полный аудит сайта. Статус и приоритет указаны автором; экспорт не подтверждает их автоматически.',
    '',
    '## Воспроизведение',
    `Условия: ${text(p.context)}`,
    `Шаги: ${text(p.steps)}`,
    `Ожидалось: ${text(p.expected)}`,
    `Фактически: ${text(p.actual)}`,
    `Влияние: ${text(p.impact)}`,
    `SHA наблюдения: ${text(p.deployedSha ?? 'не подтверждён')}`,
  ];
  if (p.source)
    lines.push(
      `Источник: запуск ${text(p.source.runId)} · кейс ${text(p.source.caseKey)} · попытка ${text(p.source.attemptId)}`
    );
  lines.push('', '## Повторная проверка');
  if (p.verification) {
    const v = p.verification;
    lines.push(
      `Проверено: ${text(v.checkedAt)}`,
      `Шаги: ${text(v.steps)}`,
      `Результат: ${text(v.result)}`,
      `SHA перепроверки: ${text(v.deployedSha ?? 'не подтверждён')}`
    );
  } else
    lines.push(
      'Повторная проверка не записана. Не считать исправленным на основании экспорта.'
    );
  if (finding.recheck) {
    const r = finding.recheck;
    lines.push(
      '',
      '## Сохранённая автоматическая перепроверка',
      `Кейс: ${text(r.caseKey)} · v${r.caseVersion} · ${text(r.project)}`,
      `Сохранено: ${text(r.checkedAt)} · запуск ${text(r.runId)} · попытка ${text(r.attemptId)}`,
      `Результат: ${r.status} · записано: ${r.recordedStatus} · runner: ${r.runnerStatus ?? 'не подтверждён'}`,
      `SHA тестов: ${text(r.testSourceSha ?? 'не подтверждён')}`,
      `SHA деплоя: ${text(r.deployedSha ?? 'не подтверждён')}`,
      `SHA-256 отчёта: ${text(r.reportHash)}`,
      'Требуется ручная проверка. Статус замечания не изменён; успешная попытка не закрывает его автоматически.'
    );
  }
  lines.push('', '## Приватные доказательства');
  if (!artifacts.length)
    lines.push('Файлы не приложены или уже удалены по сроку хранения.');
  for (const a of artifacts)
    lines.push(
      `- ${text(a.id)} · ревизия замечания ${a.findingRevision} · SHA-256 ${a.sha256} · ${a.bytes} байт · хранится до ${text(a.expiresAt)}`
    );
  lines.push(
    '',
    'PNG и адреса страниц/доказательств не включены. Доступ к файлам остаётся в кабинете согласно роли и сроку хранения; экспорт не создаёт публичную ссылку. Список файлов прочитан отдельно и может измениться после выгрузки. Перед передачей проверьте текст на персональные данные и секреты.'
  );
  return lines.join('\n') + '\n';
}

export async function loadQaFindingReport(
  api: {
    get(site: string, id: string): Promise<Finding>;
    artifacts(site: string, id: string): Promise<QaArtifact[]>;
  },
  site: string,
  id: string
): Promise<{ finding: Finding; report: string }> {
  const first = await api.get(site, id);
  const artifacts = await api.artifacts(site, id);
  const latest = await api.get(site, id);
  if (first.revision !== latest.revision)
    throw new Error(
      'Замечание изменилось во время выгрузки. Повторите скачивание.'
    );
  return { finding: latest, report: qaFindingReport(site, latest, artifacts) };
}
