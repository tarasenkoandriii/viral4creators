/**
 * Вкладка «Голос» «Админки» — голосовое управление админкой заказчика
 * (Э6-бис (б), ТЗ §5-бис.2, §5-бис.13; Р-Э6б-1…12):
 *  - состояние `off | test | on | degraded`: выйти из `off` — только
 *    владелец, после экрана рисков с вводом названия сайта; `on` — только с
 *    годным отчётом мастера (иначе сервер 409 с причиной; «частично» — с
 *    подтверждением); кто/когда/почему сменил (монитор, нарушение запрета);
 *  - адреса админки и отметка «тестовый» (staging): только на нём мастер
 *    проверяет «Зберегти» (на рабочем — лишь подсветка);
 *  - мастер: одноразовая ссылка, последний отчёт с попытками по
 *    запрещённым целям и заглушёнными отправками; метрики за 24 ч.
 * Только владелец «Админки» (экран выше уже проверил; сервер — тоже).
 */
import { useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { ApiError, fmt, formatDate, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  inputClass,
} from '../../kit/ui';
import {
  ADMIN_VC_RISKS_VERSION,
  type AdminVoiceSettingsPatch,
  type AdminVoiceSettingsView,
  type AdminVoiceTestDetail,
} from '../../lib/admin-voice-api';
import { useAssist } from '../../lib/assist-context';
import { openExternal } from '../../lib/open-link';
import { useErrorText } from '../../lib/use-error-text';
import {
  VOICE_CONTROL_STATES,
  type VoiceControlState,
} from '../../lib/voice-control-api';
import { ADMIN_VOICE_TEXTS } from '../../i18n/admin-voice';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';

export function AdminVoiceSection({ siteId }: { siteId: string }) {
  const { adminMode } = useAssist();
  const st = useAsync(() => adminMode.voice.get(siteId), [siteId]);
  if (st.loading && !st.data) return null;
  if (st.error || !st.data)
    return <LoadError error={st.error} onRetry={st.reload} />;
  return (
    <AdminVoiceForm siteId={siteId} initial={st.data} reload={st.reload} />
  );
}

function AdminVoiceForm({
  siteId,
  initial,
  reload,
}: {
  siteId: string;
  initial: AdminVoiceSettingsView;
  reload: () => void;
}) {
  const { adminMode } = useAssist();
  const { locale, dict } = useKit();
  const t = ADMIN_VOICE_TEXTS[locale];
  const errText = useErrorText();
  const [view, setView] = useState(initial);
  const [state, setState] = useState<VoiceControlState>(initial.state);
  const [siteName, setSiteName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [partialAck, setPartialAck] = useState(false);
  const [path, setPath] = useState('/');
  const [hostId, setHostId] = useState(
    initial.hosts.find((h) => h.verified)?.id ?? ''
  );
  const [link, setLink] = useState<string | null>(null);
  const [report, setReport] = useState<AdminVoiceTestDetail | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const fromOff = view.state === 'off' && state !== 'off';
  const needRisks = fromOff || (!view.risksAccepted && state !== 'off');
  const last = view.report;
  const needAck =
    state === 'on' && view.state !== 'on' && last?.result === 'partial';
  const errorOf = (e: unknown) =>
    e instanceof ApiError && t.errors[e.code] ? t.errors[e.code] : errText(e);

  const save = async (patch: AdminVoiceSettingsPatch) => {
    setBusy(true);
    try {
      const v = await adminMode.voice.patch(siteId, patch);
      setView(v);
      setState(v.state);
      setNotice({ tone: 'success', text: t.saved });
    } catch (e) {
      setNotice({ tone: 'danger', text: errorOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const applyState = () =>
    save({
      state,
      ...(needRisks
        ? { risksVersion: ADMIN_VC_RISKS_VERSION, siteName: siteName.trim() }
        : {}),
      ...(needAck ? { partialAck } : {}),
    });

  const toggleTestHost = (id: string) => {
    const now = view.hosts.filter((h) => h.test).map((h) => h.id);
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    void save({ testHostIds: next });
  };

  const getLink = async () => {
    setBusy(true);
    try {
      if (!view.risksAccepted)
        await adminMode.voice.patch(siteId, {
          risksVersion: ADMIN_VC_RISKS_VERSION,
          siteName: siteName.trim(),
        });
      const r = await adminMode.voice.testToken(siteId, {
        ...(hostId ? { hostId } : {}),
        path: path.trim() || '/',
      });
      setLink(r.url || null);
      reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errorOf(e) });
    } finally {
      setBusy(false);
    }
  };

  const showReport = async () => {
    if (!last) return;
    if (report) return setReport(null);
    try {
      setReport(await adminMode.voice.test(siteId, last.id));
    } catch (e) {
      setNotice({ tone: 'danger', text: errorOf(e) });
    }
  };

  const verified = view.hosts.filter((h) => h.verified);
  const canEnable = view.planAllows && view.adminModeOk && view.platformOn;
  const m = view.metrics;
  const changed =
    view.stateAt && view.stateBy && !view.stateBy.startsWith('tg:')
      ? fmt(t.changed, {
          date: formatDate(view.stateAt, locale),
          who: view.stateBy,
          why: view.stateReason ? ` — ${view.stateReason}` : '',
        })
      : null;
  const risksOk = !needRisks || (accepted && siteName.trim().length > 0);

  return (
    <Card className="space-y-3">
      <div className="font-semibold text-sm">{t.title}</div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {!view.planAllows && <Alert tone="neutral">{t.needPlan}</Alert>}
      {!view.adminModeOk && <Alert tone="neutral">{t.needAdminMode}</Alert>}
      {!view.platformOn && <Alert tone="neutral">{t.platformOff}</Alert>}
      {view.platformOn && !view.voiceAvailable && (
        <Alert tone="neutral">{t.needVoice}</Alert>
      )}
      {changed && <Alert tone="warning">{changed}</Alert>}
      <NoticeBar notice={notice} />

      {/* Состояние */}
      <div className="grid grid-cols-2 gap-2" role="radiogroup">
        {VOICE_CONTROL_STATES.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={state === s}
            disabled={!canEnable && s !== 'off' && view.state === 'off'}
            className={`rounded-xl border px-3 py-2 text-left text-sm ${state === s ? 'border-accent bg-accent/10' : 'border-silver-200 dark:border-silver-800'}`}
            onClick={() => setState(s)}
          >
            <div className="font-medium">{t.states[s]}</div>
            <div className="text-[11px] text-silver-500">{t.stateHelp[s]}</div>
          </button>
        ))}
      </div>
      {state === 'on' && view.state !== 'on' && view.onProblem && (
        <Alert tone="neutral">{t.wizard.problems[view.onProblem]}</Alert>
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
      {(needRisks || !view.risksAccepted) && (
        <div className="space-y-2 rounded-xl border border-amber-300 p-3">
          <div className="font-semibold text-sm">{t.risks.title}</div>
          <ul className="list-disc pl-5 text-xs space-y-1">
            {t.risks.items.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          <label className="block text-xs space-y-1">
            <span>{fmt(t.risks.siteName, { name: view.siteName })}</span>
            <input
              className={inputClass}
              value={siteName}
              autoComplete="off"
              onChange={(e) => setSiteName(e.target.value)}
            />
          </label>
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
      {state !== view.state && (
        <Button
          disabled={busy || !risksOk || (needAck && !partialAck)}
          onClick={() => void applyState()}
        >
          {t.save}
        </Button>
      )}

      {/* Адреса админки и «тестовый» */}
      <div className="space-y-1">
        <div className="font-semibold text-sm">{t.hostsTitle}</div>
        <p className="text-xs text-silver-500">{t.hostsHelp}</p>
        {!verified.length && <Alert tone="neutral">{t.noHosts}</Alert>}
        {verified.map((h) => (
          <label key={h.id} className="flex gap-2 text-sm items-center">
            <input
              type="checkbox"
              checked={h.test}
              disabled={busy}
              onChange={() => toggleTestHost(h.id)}
            />
            <span>{h.host}</span>
            {h.test && <Badge tone="neutral">{t.hostTest}</Badge>}
          </label>
        ))}
      </div>

      {/* Мастер проверки */}
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
        {verified.length > 1 && (
          <select
            className={inputClass}
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
          >
            {verified.map((h) => (
              <option key={h.id} value={h.id}>
                {h.host}
                {h.test ? ` (${t.hostTest})` : ''}
              </option>
            ))}
          </select>
        )}
        <label className="block text-xs space-y-1">
          <span>{t.wizard.path}</span>
          <input
            className={inputClass}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        <p className="text-xs text-silver-500">
          {verified.find((h) => h.id === hostId)?.test
            ? t.wizard.testHost
            : t.wizard.workHost}
        </p>
        <Button
          variant="outline"
          disabled={
            busy ||
            !canEnable ||
            !verified.length ||
            (!view.risksAccepted && !(accepted && siteName.trim()))
          }
          onClick={() => void getLink()}
        >
          {t.wizard.link}
        </Button>
        {link && (
          <div className="space-y-1">
            <CopyField
              label={t.wizard.linkReady}
              value={link}
              copyLabel={dict.common.copy}
              copiedLabel={dict.common.copied}
            />
            <Button
              variant="outline"
              icon={<ExternalLink size={16} />}
              onClick={() => openExternal(link)}
            >
              {t.wizard.link}
            </Button>
          </div>
        )}
        {last && last.reportedAt && (
          <Button variant="ghost" onClick={() => void showReport()}>
            {t.wizard.report}
          </Button>
        )}
        {report?.report && (
          <ul className="text-xs space-y-1">
            <li>{fmt(t.wizard.attempts, { n: report.report.attempts })}</li>
            <li>
              {fmt(t.wizard.submits, { n: report.report.submitsBlocked })}
            </li>
            <li>
              {fmt(t.wizard.forbiddenLeak, {
                n: report.report.forbidden.filter((f) => !f.blocked).length,
              })}
            </li>
            {report.report.items
              .filter((x) => x.level !== 'ok')
              .map((x, i) => (
                <li key={i}>
                  {x.level === 'fail' ? '✗' : '!'} {x.code}
                </li>
              ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-silver-500">
        {fmt(t.metrics, {
          plans: m.plans,
          done: m.done,
          manual: m.manual,
          failed: m.failed,
          stopped: m.stopped,
          violations: m.violations,
        })}
      </p>
    </Card>
  );
}
