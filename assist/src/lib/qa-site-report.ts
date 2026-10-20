import type { Finding, FindingHead, QaArtifact } from './qa-findings-api';
import { qaFindingReport } from './qa-finding-report';
export interface SiteQaReport {
  siteId: string;
  generatedAt: string;
  entries: { finding: Finding; artifacts: QaArtifact[] }[];
}
interface ReportApi {
  list(
    site: string,
    before?: string
  ): Promise<{ items: FindingHead[]; nextBeforeId: string | null }>;
  get(site: string, id: string): Promise<Finding>;
  artifacts(site: string, id: string): Promise<QaArtifact[]>;
}
async function inventory(api: ReportApi, site: string) {
  const rows: FindingHead[] = [];
  const cursors = new Set<string>();
  let before: string | undefined;
  do {
    const page = await api.list(site, before);
    rows.push(...page.items);
    if (
      rows.length > 200 ||
      new Set(rows.map((r) => r.id)).size !== rows.length
    )
      throw new Error('Реестр слишком большой или изменился. Экспорт отменён.');
    if (!page.nextBeforeId) return rows;
    if (cursors.has(page.nextBeforeId))
      throw new Error('Повтор страницы реестра.');
    cursors.add(page.nextBeforeId);
    before = page.nextBeforeId;
  } while (cursors.size < 200);
  throw new Error('Не удалось прочитать весь реестр.');
}
export async function loadSiteQaReport(
  api: ReportApi,
  siteId: string
): Promise<SiteQaReport> {
  const heads = await inventory(api, siteId);
  const entries: SiteQaReport['entries'] = [];
  for (const head of heads) {
    const finding = await api.get(siteId, head.id);
    if (finding.revision !== head.revision)
      throw new Error('Замечание изменилось. Повторите экспорт.');
    entries.push({ finding, artifacts: await api.artifacts(siteId, head.id) });
  }
  const after = await inventory(api, siteId);
  const key = (rows: FindingHead[]) =>
    JSON.stringify(
      rows
        .map((r) => [r.id, r.revision])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  if (key(heads) !== key(after))
    throw new Error('Реестр изменился. Повторите экспорт.');
  return { siteId, generatedAt: new Date().toISOString(), entries };
}
export function siteQaReportText(report: SiteQaReport) {
  const counts = ['P0', 'P1', 'P2', 'P3']
    .map(
      (p) =>
        `${p}: ${report.entries.filter((e) => e.finding.payload.severity === p).length}`
    )
    .join(' · ');
  return [
    'Сводный отчёт QA',
    `Сайт: ${report.siteId}`,
    `Выгружено: ${report.generatedAt}`,
    `Замечаний: ${report.entries.length} · ${counts}`,
    'Весь доступный реестр на момент чтения, до 200 записей. Наличие или отсутствие замечаний не подтверждает качество всего сайта. Статусы и приоритеты указаны авторами. Данные получены последовательным чтением с повторной сверкой ревизий, не атомарным снимком базы.',
    'Приватный файл для локального использования. Проверьте персональные данные перед передачей. Публикация и публичные ссылки не создаются.',
    ...report.entries.map((e) =>
      qaFindingReport(report.siteId, e.finding, e.artifacts)
    ),
  ].join('\n\n');
}
