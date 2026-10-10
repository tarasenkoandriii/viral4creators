/**
 * Раздел «Голосовое управление сайтом» (Э6-бис (а)+(г), ТЗ §5-бис.2,
 * §5-бис.8, §5-бис.11, §5-бис.13–14; решения владельца 03.10.2026 п.1–2):
 *  - состояние `off | test | on | degraded`: `test` — только по ссылке
 *    мастера (владельцу); `on` — только с годным отчётом мастера (иначе
 *    сервер отвечает 409 с причиной; `partial` — с подтверждением);
 *    `degraded` — «только подсказка»;
 *  - кто/когда/почему сменил состояние (монитор, переходный период,
 *    нарушение запрета), баннер переходного периода (14 дней);
 *  - мастер проверки Т-2: одноразовая ссылка на сайт, последний отчёт с
 *    пунктами, двумя списками опасного, фрагментом разметки и «добавить в
 *    запрещённые»; монитор Т-4 за 24 ч (метрики, события, лимит команд);
 *  - правила (зоны, запреты, подтверждение заполнения, лимит шагов), экран
 *    рисков перед первым включением (версия текста — на сервер).
 * Доступно при включённом голосе сайта (тариф Business+, микрофон);
 * выключить — всегда.
 * (д) Р-67: включено по прежней редакции рисков — баннер «текст обновлён»
 * и «Прочитал(а)» (без перевода в `test`); метрики цепочек в мониторе.
 * (е) «Голос → Мемо» — `MemoSection` под монитором.
 * Заход 11: «Автотест» (Т-3 по расписанию) — `AutotestPanel` под мастером.
 */
import { useState } from 'react';
import { ExternalLink, FileText, Save, ShieldCheck } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  inputClass,
  Spinner,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { openExternal } from '../../lib/open-link';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  lines,
  pct,
  voiceControlErrorCode,
  VOICE_CONTROL_STATES,
  type VoiceControlRules,
  type VoiceControlSettingsView,
  type VoiceControlState,
  type VoiceTestDetail,
} from '../../lib/voice-control-api';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';
import { AutotestPanel } from './AutotestPanel';
import { Field, Toggle } from './controls';
import { MemoSection } from './MemoSection';
import { VoiceMapSection } from './VoiceMapSection';

export function VoiceControlSection({ siteId }: { siteId: string }) {
  return <VoiceControlSectionForSite key={siteId} siteId={siteId} />;
}

function VoiceControlSectionForSite({ siteId }: { siteId: string }) {
  const { dict } = useKit();
  const { voiceControl } = useAssist();
  const loaded = useAsync(
    () => voiceControl.get(siteId),
    [voiceControl, siteId]
  );
  if (loaded.loading && !loaded.data)
    return <Spinner label={dict.common.loading} />;
  if (!loaded.data)
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  return <VoiceControlForm siteId={siteId} initial={loaded.data} />;
}

type ListKey =
  'allowPaths' | 'denyPaths' | 'denySelectors' | 'allowSelectors' | 'denyWords';
const LISTS: ListKey[] = [
  'allowPaths',
  'denyPaths',
  'denySelectors',
  'allowSelectors',
  'denyWords',
];

function VoiceControlForm({
  siteId,
  initial,
}: {
  siteId: string;
  initial: VoiceControlSettingsView;
}) {
  const { appDict, voiceControl } = useAssist();
  const { locale, dict } = useKit();
  const t = appDict.voiceControl;
  const errText = useSetupErrorText();
  const [view, setView] = useState(initial);
  const [state, setState] = useState<VoiceControlState>(initial.state);
  const [rules, setRules] = useState<VoiceControlRules>(initial.rules);
  const [texts, setTexts] = useState<Record<ListKey, string>>(() => {
    const o = {} as Record<ListKey, string>;
    for (const k of LISTS) o[k] = initial.rules[k].join('\n');
    return o;
  });
  const [accepted, setAccepted] = useState(false);
  const [partialAck, setPartialAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [testHost, setTestHost] = useState(false);
  const [host, setHost] = useState('');
  const [report, setReport] = useState<VoiceTestDetail | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);
  // Первое включение из `off` — экран рисков (их текст версионирован).
  const fromOff = view.state === 'off' && state !== 'off';
  const last = view.lastTest;
  const needAck =
    state === 'on' &&
    view.state !== 'on' &&
    last?.result === 'partial' &&
    last.problem === 'partial_ack';

  const save = async (rulesOverride?: VoiceControlRules) => {
    setBusy(true);
    setNotice(null);
    try {
      const next: VoiceControlRules = rulesOverride ?? { ...rules };
      if (!rulesOverride) for (const k of LISTS) next[k] = lines(texts[k]);
      const v = await voiceControl.save(siteId, {
        state,
        rules: next,
        ...(fromOff ? { risksVersion: accepted ? view.risksVersion : '' } : {}),
        ...(needAck && partialAck ? { partialAck: true } : {}),
      });
      setView(v);
      setRules(v.rules);
      for (const k of LISTS)
        setTexts((x) => ({ ...x, [k]: v.rules[k].join('\n') }));
      setState(v.state);
      setAccepted(false);
      setNotice({ tone: 'success', text: t.saved });
    } catch (e) {
      const code = voiceControlErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const startCheck = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await voiceControl.testToken(siteId, {
        ...(host.trim() ? { host: host.trim() } : {}),
        testHost,
      });
      setLink(r.url);
    } catch (e) {
      const code = voiceControlErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(false);
    }
  };

  /** (д) Р-67: новая редакция рисков прочитана — без смены состояния. */
  const ackRisks = async () => {
    setBusy(true);
    try {
      setView(
        await voiceControl.save(siteId, {
          state: view.state,
          rules: view.rules,
          risksVersion: view.risksVersion,
        })
      );
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const showReport = async () => {
    if (!last) return;
    setDevLink(null);
    if (report) return setReport(null);
    try {
      setReport(await voiceControl.test(siteId, last.id));
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    }
  };

  /** Заход 9: одноразовая ссылка «звіт для розробника» (72 ч, без ПД). */
  const makeDevLink = async () => {
    if (!report) return;
    setBusy(true);
    try {
      setDevLink((await voiceControl.devLink(siteId, report.id)).url);
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  /** «Добавить в запрещённые» из просмотренного владельцем списка 2. */
  const addDeny = async (sel: string[]) => {
    const next: VoiceControlRules = {
      ...rules,
      denySelectors: [...new Set([...rules.denySelectors, ...sel])].slice(
        0,
        30
      ),
    };
    for (const k of LISTS) if (k !== 'denySelectors') next[k] = lines(texts[k]);
    await save(next);
  };

  const m = view.monitor?.metrics;
  const changed =
    view.stateAt && view.stateBy && view.stateBy !== 'owner'
      ? fmt(t.changedAt, {
          date: formatDate(view.stateAt, locale),
          who:
            t.stateBy[view.stateBy as keyof typeof t.stateBy] ?? view.stateBy,
          why: view.stateReason
            ? ` — ${t.stateReasons[view.stateReason as keyof typeof t.stateReasons] ?? view.stateReason}`
            : '',
        })
      : null;

  return (
    <Card className="space-y-3">
      <div className="font-semibold text-sm">{t.title}</div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {view.checkDeadline && view.state === 'on' && (
        <Alert tone="warning">
          {fmt(t.banner, { date: formatDate(view.checkDeadline, locale) })}
        </Alert>
      )}
      {!view.available && view.state === 'off' && (
        <Alert tone="neutral">
          {view.reason === 'voice_off' ? t.needVoice : t.plan}
        </Alert>
      )}
      {view.state !== 'off' && view.reason && view.reason !== 'state_off' && (
        <Alert tone="neutral">{t.reasons[view.reason]}</Alert>
      )}
      {changed && <Alert tone="warning">{changed}</Alert>}
      {view.risksBanner && (
        <Alert tone="warning">
          <div className="space-y-2">
            <div>{t.risksBanner}</div>
            <ul className="list-disc pl-5 text-xs">
              <li>{t.risks.items[t.risks.items.length - 1]}</li>
            </ul>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void ackRisks()}
            >
              {t.risksAck}
            </Button>
          </div>
        </Alert>
      )}
      <NoticeBar notice={notice} />

      {/* Состояние */}
      <div className="grid grid-cols-2 gap-2" role="radiogroup">
        {VOICE_CONTROL_STATES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={state === s}
            disabled={!view.available && s !== 'off' && view.state === 'off'}
            className={`rounded-xl border px-3 py-2 text-left text-sm ${state === s ? 'border-accent bg-accent/10' : 'border-silver-200 dark:border-silver-800'}`}
            onClick={() => setState(s)}
          >
            <div className="font-medium">{t.states[s]}</div>
            <div className="text-[11px] text-silver-500">{t.stateHelp[s]}</div>
          </button>
        ))}
      </div>
      {state === 'on' && view.state !== 'on' && last?.problem && (
        <Alert tone="neutral">{t.wizard.problems[last.problem]}</Alert>
      )}
      {state === 'on' && view.state !== 'on' && !last && (
        <Alert tone="neutral">{t.wizard.problems.none}</Alert>
      )}
      {needAck && (
        <label className="flex gap-2 text-xs items-start">
          <input
            type="checkbox"
            checked={partialAck}
            onChange={(e) => setPartialAck(e.target.checked)}
          />
          <span>{t.wizard.partialAck}</span>
        </label>
      )}
      {fromOff && (
        <div className="space-y-2 rounded-xl border border-amber-300 p-3">
          <div className="font-semibold text-sm">{t.risks.title}</div>
          <ul className="list-disc pl-5 text-xs space-y-1">
            {t.risks.items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          <label className="flex gap-2 text-xs items-start">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>{t.risks.accept}</span>
          </label>
        </div>
      )}

      {/* Мастер проверки Т-2 */}
      <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3">
        <div className="font-semibold text-sm flex items-center gap-2">
          <ShieldCheck size={16} /> {t.wizard.title}
          {last?.result && (
            <Badge
              tone={
                last.result === 'pass'
                  ? 'success'
                  : last.result === 'partial'
                    ? 'warning'
                    : 'danger'
              }
            >
              {t.wizard.results[last.result]}
            </Badge>
          )}
        </div>
        <p className="text-xs text-silver-500">{t.wizard.intro}</p>
        <p className="text-xs">
          {last && last.reportedAt
            ? fmt(t.wizard.last, {
                result: last.result ? t.wizard.results[last.result] : '—',
                date: formatDate(last.reportedAt, locale),
              })
            : t.wizard.none}
        </p>
        <Field label={t.wizard.host} htmlFor="vc-host">
          <input
            id="vc-host"
            className={inputClass}
            placeholder="shop.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Toggle
          checked={testHost}
          label={t.wizard.testHost}
          onChange={setTestHost}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<ShieldCheck size={16} />}
            loading={busy}
            disabled={busy || (!view.available && view.state === 'off')}
            onClick={() => void startCheck()}
          >
            {t.wizard.start}
          </Button>
          {last?.reportedAt && (
            <Button
              variant="outline"
              icon={<FileText size={16} />}
              onClick={() => void showReport()}
            >
              {report ? t.wizard.hide : t.wizard.report}
            </Button>
          )}
        </div>
        {link && (
          <div className="space-y-2">
            <CopyField
              label={t.wizard.link}
              value={link}
              copyLabel={dict.common.copy}
              copiedLabel={dict.common.copied}
            />
            <Button
              variant="outline"
              icon={<ExternalLink size={16} />}
              onClick={() => openExternal(link)}
            >
              {t.wizard.open}
            </Button>
          </div>
        )}
        {report?.report && (
          <div className="space-y-2 text-xs">
            <ul className="space-y-1">
              {report.report.items
                .filter((x) => x.code !== 'ok')
                .map((x, i) => (
                  <li
                    key={i}
                    className={
                      x.level === 'fail' ? 'text-rose-600' : 'text-amber-700'
                    }
                  >
                    {x.step}. {t.wizard.items[x.code]}
                  </li>
                ))}
            </ul>
            {report.report.never.length > 0 && (
              <div>
                <div className="font-medium">{t.wizard.never}</div>
                <ul className="list-disc pl-5">
                  {report.report.never.slice(0, 20).map((n, i) => (
                    <li key={i}>{n.text}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <div className="font-medium">{t.wizard.forbidden}</div>
              <ul className="pl-1">
                {report.report.forbidden.map((f) => (
                  <li
                    key={f.kind}
                    className={f.blocked ? 'text-emerald-700' : 'text-rose-600'}
                  >
                    {f.blocked ? '✓' : '✗'} «{f.command}» —{' '}
                    {f.blocked ? t.wizard.blocked : t.wizard.leaked}
                  </li>
                ))}
              </ul>
            </div>
            {report.report.denySuggestions.length > 0 && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void addDeny(report.report!.denySuggestions)}
              >
                {fmt(t.wizard.denyAdd, {
                  n: report.report.denySuggestions.length,
                })}
              </Button>
            )}
            {report.report.fragment && (
              <CopyField
                label={t.wizard.fragment}
                value={report.report.fragment}
                copyLabel={dict.common.copy}
                copiedLabel={dict.common.copied}
              />
            )}
            <div className="space-y-1">
              <Button
                variant="outline"
                icon={<ExternalLink size={16} />}
                disabled={busy}
                onClick={() => void makeDevLink()}
              >
                {t.wizard.devLink}
              </Button>
              <div className="text-silver-500">{t.wizard.devLinkHint}</div>
              {devLink && (
                <CopyField
                  label={t.wizard.devLink}
                  value={devLink}
                  copyLabel={dict.common.copy}
                  copiedLabel={dict.common.copied}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Заход 11: автотест Т-3 по расписанию */}
      <AutotestPanel siteId={siteId} />

      {/* Монитор Т-4 */}
      {view.monitor && m && (
        <div className="space-y-1 rounded-xl border border-silver-200 dark:border-silver-800 p-3 text-xs">
          <div className="font-semibold text-sm">{t.monitor.title}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span>{t.monitor.plans}</span>
            <span>{m.plans}</span>
            <span>{t.monitor.done}</span>
            <span>{pct(m.done, m.plans)}</span>
            <span>{t.monitor.self}</span>
            <span>{pct(m.self, m.plans)}</span>
            <span>{t.monitor.notFound}</span>
            <span>{pct(m.notFound, m.plans)}</span>
            <span>{t.monitor.wrong}</span>
            <span>{m.wrong}</span>
            <span>{t.monitor.cancelled}</span>
            <span>{m.cancelled}</span>
            <span>{t.monitor.stoplist}</span>
            <span>{m.stoplistLive}</span>
            <span>{t.monitor.chains}</span>
            <span>
              {m.chainsWithTraces} / {m.chainsBroken}
            </span>
            <span>{t.monitor.undo}</span>
            <span>{pct(m.undoDone, m.undoAttempts)}</span>
            <span>{t.monitor.pnrUnknown}</span>
            <span>{m.pnrUnknown}</span>
            <span>{t.monitor.latency}</span>
            <span>
              {m.latencyP50Ms !== null
                ? `${(m.latencyP50Ms / 1000).toFixed(1)} / ${((m.latencyP95Ms ?? 0) / 1000).toFixed(1)} s`
                : '—'}
            </span>
          </div>
          <div className="text-silver-500">
            {fmt(t.monitor.perDay, { n: view.plansPerDay })}
          </div>
          {view.monitor.incidents.length > 0 && (
            <div>
              <div className="font-medium">{t.monitor.incidents}</div>
              <ul>
                {view.monitor.incidents.map((i, k) => (
                  <li key={k}>
                    {formatDate(i.createdAt, locale)} ·{' '}
                    {t.monitor.kinds[i.kind as keyof typeof t.monitor.kinds] ??
                      i.kind}
                    {i.code
                      ? ` — ${t.stateReasons[i.code as keyof typeof t.stateReasons] ?? i.code}`
                      : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* (е) Мемо */}
      {view.state !== 'off' && <MemoSection siteId={siteId} />}

      {/* Э6-тер: голосовая карта — редактор на сайте (в любом состоянии,
          включая `off`: способ подготовить сайт до мастера, §5-кватер.2) */}
      <VoiceMapSection siteId={siteId} />

      {/* Правила */}
      <div className="font-semibold text-sm">{t.rules.title}</div>
      <p className="text-xs text-silver-500">{t.rules.markup}</p>
      {LISTS.map((k) => (
        <Field key={k} label={t.rules[k]} htmlFor={`vc-${k}`}>
          <textarea
            id={`vc-${k}`}
            className={inputClass}
            rows={2}
            value={texts[k]}
            onChange={(e) => setTexts((x) => ({ ...x, [k]: e.target.value }))}
          />
        </Field>
      ))}
      <Toggle
        checked={rules.confirmFill}
        label={t.rules.confirmFill}
        onChange={(confirmFill) => setRules((r) => ({ ...r, confirmFill }))}
      />
      <Field label={t.rules.maxSteps} htmlFor="vc-steps">
        <input
          id="vc-steps"
          type="number"
          min={1}
          max={15}
          className={inputClass}
          value={rules.maxSteps}
          onChange={(e) =>
            setRules((r) => ({
              ...r,
              maxSteps: Math.max(1, Math.min(15, Number(e.target.value) || 6)),
            }))
          }
        />
      </Field>
      <Button
        icon={<Save size={16} />}
        loading={busy}
        disabled={busy || (fromOff && !accepted) || (needAck && !partialAck)}
        onClick={() => void save()}
      >
        {t.save}
      </Button>
    </Card>
  );
}
