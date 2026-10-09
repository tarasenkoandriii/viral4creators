/**
 * Заход 11 (хвост захода 10 «TMA: подробности отчёта автотеста Т-3»):
 * блок «Автотест» раздела «Голосовое управление сайтом» — последние отчёты
 * Т-3 по расписанию (`kind: autotest`, ≤ 5 из `GET …/tests`; №29,
 * Р-З10-19/43) и подробности одного отчёта (`GET …/tests/:tid` →
 * `report.autotest`): страницы, потерянные цели карты, контрольные
 * команды с фразой и статусом, код ошибки. Годности для `on` автотест не
 * даёт — блок только показывает.
 */
import { useRef, useState } from 'react';
import { Bot, FileText } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Badge, Button } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import type {
  AutotestView,
  VoiceTestSummary,
} from '../../lib/voice-control-api';

function resultTone(r: VoiceTestSummary['result']) {
  return r === 'pass' ? 'success' : r === 'partial' ? 'warning' : 'danger';
}

export function AutotestPanel({ siteId }: { siteId: string }) {
  const { appDict, voiceControl } = useAssist();
  const { locale } = useKit();
  const t = appDict.voiceControl.autotest;
  const errText = useSetupErrorText();
  const list = useAsync(
    () => voiceControl.tests(siteId),
    [voiceControl, siteId]
  );
  /** Открытый отчёт; `a: null` — подробностей в отчёте нет. */
  const [open, setOpen] = useState<{
    id: string;
    a: AutotestView | null;
  } | null>(null);
  const [err, setErr] = useState('');
  /** Последний запрошенный отчёт: ответ на устаревший клик отбрасывается. */
  const want = useRef<string | null>(null);
  const items = (list.data ?? []).filter((x) => x.kind === 'autotest');

  const toggle = async (id: string) => {
    setErr('');
    if (open?.id === id) {
      want.current = null;
      return setOpen(null);
    }
    want.current = id;
    try {
      const d = await voiceControl.test(siteId, id);
      if (want.current !== id) return;
      setOpen({ id, a: d?.autotest ?? null });
    } catch (e) {
      if (want.current === id) setErr(errText(e));
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3 text-xs">
      <div className="font-semibold text-sm flex items-center gap-2">
        <Bot size={16} /> {t.title}
      </div>
      <p className="text-silver-500">{t.intro}</p>
      {list.data && !items.length && <p>{t.none}</p>}
      {err && <p className="text-rose-600">{err}</p>}
      <ul className="space-y-2">
        {items.map((x) => (
          <li key={x.id} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span>{formatDate(x.createdAt, locale)}</span>
              {!x.reportedAt ? (
                <Badge tone="neutral">{t.running}</Badge>
              ) : x.result ? (
                <Badge tone={resultTone(x.result)}>{t.results[x.result]}</Badge>
              ) : (
                <Badge tone="neutral">{t.noResult}</Badge>
              )}
              {x.reportedAt && (
                <Button
                  variant="ghost"
                  icon={<FileText size={14} />}
                  onClick={() => void toggle(x.id)}
                >
                  {open?.id === x.id ? t.hide : t.details}
                </Button>
              )}
            </div>
            {open?.id === x.id &&
              (open.a ? (
                <AutotestDetails a={open.a} />
              ) : (
                <p className="text-silver-500">{t.noDetails}</p>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Подробности одного отчёта автотеста (чистая разметка — для тестов). */
export function AutotestDetails({ a }: { a: AutotestView }) {
  const { appDict } = useAssist();
  const t = appDict.voiceControl.autotest;
  const problems = a.commands.filter((c) => c.status !== 'found');
  const found = a.commands.length - problems.length;
  const errorText = a.error
    ? a.error === 'pages_failed' || a.error === 'nothing_checked'
      ? t.errors[a.error]
      : fmt(t.errors.other, { c: a.error })
    : null;
  return (
    <div className="space-y-1 rounded-lg border border-silver-200 dark:border-silver-800 p-2">
      {errorText && <p className="text-rose-600">{errorText}</p>}
      <p>{fmt(t.summary, { c: a.checked, l: a.lost })}</p>
      <p className="text-silver-500">
        {a.version ? fmt(t.version, { v: a.version }) : t.noMap}
      </p>
      {a.pages.length > 0 && (
        <div>
          <div className="font-medium">{t.pages}</div>
          <ul className="pl-1">
            {a.pages.map((p, i) => (
              <li
                key={i}
                className={p.ok ? 'text-emerald-700' : 'text-rose-600'}
              >
                {p.ok ? '✓' : '✗'} {p.path} —{' '}
                {p.ok ? t.pageOk : fmt(t.pageFail, { e: p.error ?? '—' })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.lostTargets.length > 0 && (
        <p className="text-rose-600">
          {fmt(t.lostTargets, { list: a.lostTargets.join(', ') })}
          {a.lostTargetsTotal > a.lostTargets.length &&
            ` ${fmt(t.moreTargets, { n: a.lostTargetsTotal - a.lostTargets.length })}`}
        </p>
      )}
      {a.fragileTargets > 0 && (
        <p className="text-amber-700">
          {fmt(t.fragile, { n: a.fragileTargets })}
        </p>
      )}
      {a.commands.length > 0 && (
        <div>
          <div className="font-medium">{t.commands}</div>
          {problems.length === 0 ? (
            <p className="text-emerald-700">
              {fmt(t.commandsOk, { n: found })}
            </p>
          ) : (
            <ul className="pl-1">
              {problems.map((c, i) => (
                <li
                  key={i}
                  className={
                    c.status === 'lost' ? 'text-rose-600' : 'text-silver-500'
                  }
                >
                  «{c.text || t.noText}» · {c.path} —{' '}
                  {t.commandStatus[c.status]}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
