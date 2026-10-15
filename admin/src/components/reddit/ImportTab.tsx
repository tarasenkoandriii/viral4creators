'use client';

// «Импорт» (Р-RD-ADM-4): три CSV исследования (формат research-import.ts),
// предпросмотр плана (dry-run, ничего не пишет) и «Применить» — только для
// того же набора, что прошёл предпросмотр. Импорт идемпотентен: повтор даёт
// «уже есть», текущий снимок правил (любой проверки) не вытесняется —
// сегмент дописывается в темы сообщества (Р-RD-AUD-2); снимки импорта —
// «не подтверждён», без первоисточника подтвердить нельзя (Р-RD-AUD-3).
// Отказ проекта или частичный импорт (дедлайн) — предупреждение, не
// «Импорт применён» (аудит ui-2, Р-RD-AUD-4).

import { useState } from 'react';
import {
  emptyImportForm,
  IMPORT_CODE_LABELS,
  IMPORT_ISSUE_TEXT,
  IMPORT_KIND_LABELS,
  IMPORT_MARKET_MAX,
  IMPORT_OUTCOME_LABELS,
  IMPORT_TITLE_MAX,
  IMPORT_WARNING_KIND_LABELS,
  IMPORT_WARNING_LABELS,
  importApplyNotice,
  importBlocksShown,
  importBody,
  importFingerprint,
  importSummaryRows,
  keptCurrentText,
  R,
  readImportFile,
  type ImportForm,
  type ImportReport,
} from '../../lib/reddit';
import { isUncertainOutcome } from '../../lib/reddit-shared/lib/publisher/reddit-view';
import { Alert, Badge, ConfirmButton, ErrorAlert, Field, Notice, Section, useMutation, useRx } from './ui';

const FILES: Array<{ key: 'communitiesCsv' | 'opportunitiesCsv' | 'keywordsCsv'; label: string; hint: string }> = [
  { key: 'communitiesCsv', label: 'Сообщества (…-communities.csv)', hint: 'обязательно' },
  { key: 'opportunitiesCsv', label: 'Возможности (…-opportunities.csv)', hint: 'необязательно' },
  { key: 'keywordsCsv', label: 'Запросы (…-keywords.csv)', hint: 'необязательно' },
];

const label = (map: Record<string, string>, k: string) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k);

export function ImportTab({ onApplied }: { onApplied: () => void }) {
  const { api } = useRx();
  const [form, setForm] = useState<ImportForm>(emptyImportForm);
  const [names, setNames] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ImportReport | null>(null);
  const [planned, setPlanned] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [applyWarn, setApplyWarn] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const plan = useMutation();
  const apply = useMutation();
  const { body, issues } = importBody(form);
  const fp = importFingerprint(body);
  const set = (patch: Partial<ImportForm>) => setForm((f) => ({ ...f, ...patch }));
  const shown = issues.filter((x) => !(x === 'communities' && !form.communitiesCsv) && !(x === 'title' && !form.projectTitle) && !(x === 'market' && !form.market));
  return (
    <div className="rx-stack">
      <Section title="Импорт исследования">
        <p className="muted rx-hint">
          Формат — CSV исследования, как у CLI <code>publisher/cli/reddit-import.ts</code>. Файлы читаются в браузере и уходят на
          сервер текстом (до 1 МБ вместе); к Reddit никто не обращается. Правила из вторичных источников становятся снимками «не
          подтверждён» — подтвердите их на вкладке «Сообщества и правила».
        </p>
        {FILES.map((f) => (
          <Field key={f.key} label={f.label} hint={names[f.key] ? `${names[f.key]} · ${f.hint}` : f.hint}>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={async (e) => {
                const input = e.target;
                const file = input.files?.[0];
                setReadError(null);
                // Прежний файл поля не остаётся ни при каком исходе (аудит ui-4):
                // поле и подпись очищаются, план надо строить заново.
                const clear = () => {
                  set({ [f.key]: '' } as Partial<ImportForm>);
                  setNames((n) => ({ ...n, [f.key]: '' }));
                  setPlanned('');
                };
                if (!file) {
                  clear();
                  return;
                }
                const res = await readImportFile(file);
                if (!res.ok) {
                  clear();
                  input.value = '';
                  setReadError(res.error);
                  return;
                }
                set({ [f.key]: res.text } as Partial<ImportForm>);
                setNames((n) => ({ ...n, [f.key]: `${file.name}, ${res.lines} строк` }));
              }}
            />
          </Field>
        ))}
        <Field label={R.projects.fields.title}>
          <input value={form.projectTitle} maxLength={IMPORT_TITLE_MAX} onChange={(e) => set({ projectTitle: e.target.value })} />
        </Field>
        <div className="rx-grid2">
          <Field label={R.projects.fields.locale}>
            <input value={form.locale} maxLength={16} onChange={(e) => set({ locale: e.target.value })} />
          </Field>
          <Field label={R.projects.fields.market}>
            <input value={form.market} maxLength={IMPORT_MARKET_MAX} onChange={(e) => set({ market: e.target.value })} />
          </Field>
        </div>
        <Field label="Метка сегмента в отчёте (необязательно)">
          <input value={form.segment} maxLength={64} onChange={(e) => set({ segment: e.target.value })} />
        </Field>
        {readError && <Alert tone="danger">{readError}</Alert>}
        {shown.length > 0 && (
          <ul className="rx-list rx-warn">
            {shown.map((x) => (
              <li key={x}>{IMPORT_ISSUE_TEXT[x]}</li>
            ))}
          </ul>
        )}
        <ErrorAlert error={plan.error} />
        <div className="rx-row">
          <button
            type="button"
            disabled={!body || plan.busy}
            onClick={async () => {
              if (!body) return;
              setNotice(null);
              setApplyWarn(null);
              const r = await plan.run(() => api.admin.importPlan(body), `plan:${fp}`);
              if (r) {
                setReport(r);
                setPlanned(fp);
              }
            }}
          >
            {plan.busy ? 'Строим план…' : 'Предпросмотр плана'}
          </button>
          <ConfirmButton
            busy={apply.busy}
            disabled={!body || planned !== fp}
            onConfirm={async () => {
              if (!body) return;
              const r = await apply.run(() => api.admin.importApply(body), `apply:${fp}`);
              if (r) {
                setReport(r);
                const n = importApplyNotice(r);
                setNotice(n.tone === 'success' ? n.text : null);
                setApplyWarn(n.tone === 'warning' ? n.text : null);
                onApplied();
              }
            }}
          >
            Применить
          </ConfirmButton>
        </div>
        {body && planned !== fp && <span className="muted rx-hint">«Применить» — после предпросмотра этого же набора файлов.</span>}
        <ErrorAlert error={apply.error} />
        {apply.busy && <Alert tone="neutral">Импорт может занять несколько минут. Дождитесь отчёта перед следующим запуском.</Alert>}
        {/* Только при неизвестном исходе (сеть, 502/503/504, UPSTREAM_TIMEOUT):
            явный отказ 400/413 — записи не было (аудит ui-6). */}
        {isUncertainOutcome(apply.error) && (
          <Alert tone="warning">
            Отсутствие ответа не означает откат: сервер мог сохранить часть или весь реестр.
            Повторите предпросмотр того же набора файлов — он покажет, что уже есть. Не подтверждайте правила автоматически.
          </Alert>
        )}
        <Notice text={notice} />
        {applyWarn && <Alert tone="warning">{applyWarn}</Alert>}
      </Section>
      {report && <ImportReportView report={report} />}
    </div>
  );
}

export function ImportReportView({ report }: { report: ImportReport }) {
  const rows = importSummaryRows(report);
  const problems = report.items.filter((x) => x.outcome === 'rejected');
  const skipped = report.items.filter((x) => x.outcome === 'not_attempted').length;
  const kept = report.items.filter((x) => x.code === 'kept_current' && /differs/.test(x.detail ?? ''));
  const blocks = importBlocksShown(report);
  // `kept_current`: detail сервера (`reviewed; differs: promotion …`) — по-русски.
  const detailOf = (x: ImportReport['items'][number]) => (x.code === 'kept_current' ? keptCurrentText(x.detail) : x.detail);
  const title = !report.apply ? 'План (ничего не записано)' : report.complete ? 'Отчёт: применено' : 'Отчёт: применено частично';
  return (
    <Section title={title} action={<Badge tone={!report.apply ? 'neutral' : report.complete ? 'success' : 'warning'}>{report.apply ? 'запись' : 'dry-run'}</Badge>}>
      <div className="table-scroll">
        <table className="table-narrow">
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind}>
                <td>{r.label}</td>
                <td>{r.cells.map(([k, n]) => `${k}: ${n}`).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {skipped > 0 && (
        <Alert tone="warning" title={`Не выполнялось: ${skipped}`}>
          {label(IMPORT_CODE_LABELS, report.stoppedBy ?? '')}. Повтор того же набора безопасен: созданное станет «уже есть».
        </Alert>
      )}
      {problems.length > 0 && (
        <Alert tone="warning" title={`Отклонено: ${problems.length}`}>
          <ul className="rx-list">
            {problems.slice(0, 100).map((x, i) => (
              <li key={i} className="rx-wrap">
                {label(IMPORT_KIND_LABELS, x.kind)} {x.ref}
                {x.code ? ` — ${label(IMPORT_CODE_LABELS, x.code)}` : ''}
                {x.detail ? `: ${x.detail}` : ''}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {kept.length > 0 && (
        <Alert tone="neutral" title={`Правила: текущий снимок оставлен, CSV отличается — ${kept.length}`}>
          <ul className="rx-list">
            {kept.slice(0, 100).map((x, i) => (
              <li key={i} className="rx-wrap">
                {x.ref}: {keptCurrentText(x.detail)}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {report.warnings.length > 0 && (
        <details>
          <summary>Записано не дословно — предупреждения ({report.warnings.length})</summary>
          <ul className="rx-list">
            {report.warnings.slice(0, 300).map((w, i) => (
              <li key={i} className="rx-wrap">
                {label(IMPORT_WARNING_KIND_LABELS, w.kind)} {w.ref}: {label(IMPORT_WARNING_LABELS, w.code)}
                {w.field ? ` [${w.field}]` : ''}
                {w.detail ? ` — ${w.detail}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {blocks.length > 0 && (
        <div className="rx-stack">
          <b>Гейт правил по сообществам (сейчас → после подтверждения снимка)</b>
          <ul className="rx-list">
            {blocks.map((b) => (
              <li key={b.subreddit} className="rx-wrap">
                r/{b.subreddit}: {b.now.map((x) => label(R.gate.reasons, x)).join(', ') || R.gate.verdicts.ok} →{' '}
                {b.afterReview.map((x) => label(R.gate.reasons, x)).join(', ') || R.gate.verdicts.ok}
                {!b.firstHandSource && ' · первоисточника нет: подтвердить можно только новый снимок со ссылкой на правила'}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>Все строки ({report.items.length})</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Вид</th>
                <th>Ключ</th>
                <th>Итог</th>
                <th>Подробности</th>
              </tr>
            </thead>
            <tbody>
              {report.items.slice(0, 500).map((x, i) => (
                <tr key={i}>
                  <td>{label(IMPORT_KIND_LABELS, x.kind)}</td>
                  <td className="rx-wrap">{x.ref}</td>
                  <td>{label(IMPORT_OUTCOME_LABELS, x.outcome)}</td>
                  <td className="rx-wrap">{[x.code ? label(IMPORT_CODE_LABELS, x.code) : '', detailOf(x)].filter(Boolean).join(': ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Section>
  );
}
