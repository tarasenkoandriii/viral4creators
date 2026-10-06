import { useState } from 'react';
import { ApiError, formatDate, useKit } from '../../kit';
import { Alert, Badge, Button, CopyField, inputClass } from '../../kit/ui';
import type { MemoListItem, MemoView } from '../../lib/admin-actions-api';
import type { MemoStats } from '../../lib/admin-memo-check';
import { useAssist } from '../../lib/assist-context';
import { openExternal } from '../../lib/open-link';
import { useErrorText } from '../../lib/use-error-text';
import { ADMIN_MEMO_CHECK_TEXTS } from '../../i18n/admin-memo-check';

/**
 * Мемо «Админки» АМ-N в TMA — сухой прогон, «требует проверки» и
 * статистика (аудит 06.10.2026; ТЗ §5-бис.17 п.7, п.8, п.13, п.14). Только
 * `assistAdmin: owner` (экран раздела «Админка»; сервер — 403).
 */

function useTexts() {
  const { locale } = useKit();
  return { t: ADMIN_MEMO_CHECK_TEXTS[locale], locale };
}

const pct = (r: number | null) =>
  r === null ? '—' : `${Math.round(r * 100)}%`;

/** Строка статистики (список и карточка): запуски, доля цели, сбои. */
function StatsLine({ s }: { s: MemoStats }) {
  const { t } = useTexts();
  return (
    <span className="text-xs text-silver-500">
      {s.runs
        ? t.stats({
            days: s.days,
            runs: s.runs,
            rate: pct(s.goalRate),
            failed: s.failed,
          })
        : t.noRuns(s.days)}
    </span>
  );
}

/** Причина «требует проверки» (§5-бис.17 п.8) — человеческим текстом. */
function ReviewText({ m }: { m: MemoListItem }) {
  const { t } = useTexts();
  const r = m.reviewReason;
  if (m.status !== 'needs_review') return null;
  return (
    <Alert tone="warning">
      {r ? t.reasons[r.code](r) : t.needsReview} {t.reviewExit}
    </Alert>
  );
}

/** Под строкой списка мемо: «требует проверки» и статистика 30 дней. */
export function MemoListMeta({ m }: { m: MemoListItem }) {
  const { t } = useTexts();
  return (
    <div className="space-y-1">
      {m.status === 'needs_review' && (
        <Badge tone="warning">{t.needsReview}</Badge>
      )}
      <div>
        <StatsLine s={m.stats} />
      </div>
    </div>
  );
}

/**
 * Карточка мемо: причина «требует проверки», статистика 7/30 дней, итог
 * прогона последней версии и кнопка «Прогнать» (ссылка в мастер `admin-vc`
 * на verified-хост админки — открывает владелец у себя).
 */
export function MemoCheckPanel({
  siteId,
  m,
  onRefresh,
}: {
  siteId: string;
  m: MemoView;
  onRefresh: () => void;
}) {
  const { adminActions } = useAssist();
  const { dict } = useKit();
  const { t, locale } = useTexts();
  const errText = useErrorText();
  const [path, setPath] = useState('/');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = m.versions[0];
  const check = last?.check ?? null;
  const s7 = m.stats7;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await adminActions.checkToken(siteId, m.number, {
        path: path.trim() || '/',
      });
      setLink(r.url || null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      setError(t.errors[code] ?? errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3">
      <ReviewText m={m} />
      <div className="space-y-1">
        <StatsLine s={m.stats} />
        {m.stats.lastRunAt && (
          <div className="text-xs text-silver-500">
            {t.lastRun}: {formatDate(m.stats.lastRunAt, locale)}
          </div>
        )}
        {m.publishedVersion !== null && (
          <div className="text-xs">
            <b>{t.stats7Title}:</b>{' '}
            {s7.runs
              ? t.statsLine({
                  reached: s7.reached,
                  notReached: s7.notReached,
                  unknown: s7.unknown,
                  stopped: s7.stopped,
                  pin: s7.pinMismatch,
                  employees: s7.employees,
                })
              : t.noRuns(s7.days)}
            {s7.failures.map((f) => (
              <div key={f.step} className="text-rose-500">
                {t.failureLine(f)}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="font-semibold text-sm">{t.checkTitle}</div>
      <p className="text-xs text-silver-500">{t.checkHint}</p>
      {!last || (last.status !== 'checking' && last.status !== 'held') ? (
        <div className="text-xs text-silver-500">{t.needBuild}</div>
      ) : !check ? (
        <div className="text-xs">{t.checkNone}</div>
      ) : (
        <div className="space-y-1 text-xs">
          <Alert
            tone={
              check.result === 'pass'
                ? 'success'
                : check.result === 'partial'
                  ? 'warning'
                  : 'danger'
            }
          >
            {t.checkResult[check.result]}
          </Alert>
          {check.inherited !== null && (
            <div className="text-silver-500">
              {t.checkInherited(check.inherited)}
            </div>
          )}
          {check.problems.map((p) => (
            <div key={`${p.step}${p.code}`} className="text-rose-500">
              {t.checkProblem(p.step, t.problemCodes[p.code] ?? p.code)}
            </div>
          ))}
          {check.phraseConflicts > 0 && (
            <div className="text-amber-600">
              {t.phraseConflicts(check.phraseConflicts)}
            </div>
          )}
        </div>
      )}
      {last && last.status === 'checking' && (
        <div className="space-y-2">
          <label className="block text-xs">
            {t.path}
            <input
              className={inputClass}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" loading={busy} onClick={() => void run()}>
              {t.run}
            </Button>
            {link && (
              <Button variant="outline" onClick={onRefresh}>
                {t.refresh}
              </Button>
            )}
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          {link && (
            <div className="space-y-2">
              <CopyField
                label={t.linkReady}
                value={link}
                copyLabel={dict.common.copy}
                copiedLabel={dict.common.copied}
              />
              <Button onClick={() => openExternal(link)}>{t.link}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
