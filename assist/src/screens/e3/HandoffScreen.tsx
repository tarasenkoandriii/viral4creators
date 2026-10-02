import { useState } from 'react';
import { fmt, useAsync, useKit } from '../../kit';
import {
  Alert,
  Badge,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { fieldErrorLines } from '../../lib/e3-errors';
import { canSeeStats } from '../../lib/e3-view';
import { freeKey } from '../../lib/engagement-types';
import {
  ESCALATION_KINDS,
  HANDOFF_LIMITS,
  OPERATOR_LANGS,
  WEEKDAYS,
  type HandoffConfig,
  type HandoffSettingsView,
  type Weekday,
} from '../../lib/handoff-types';
import { navigate } from '../../lib/router';
import { useE3ErrorText } from '../../lib/use-error-text';
import {
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { Field, NumberInput, Select, Toggle } from '../widget/controls';
import { ManagerOnly, TextsInput } from './parts';

/** Настройки передачи человеку (§3.7): часы, ожидание, шаблоны, перевод, операторы. */
export function HandoffScreen({ siteId }: { siteId: string }) {
  const { account, dict } = useKit();
  const { appDict, handoff, stats } = useAssist();
  const t = appDict.e3.handoff;
  const errText = useE3ErrorText();
  const ok = canSeeStats(account.me);
  const loaded = useAsync(
    () => (ok ? handoff.settings(siteId) : Promise.resolve(null)),
    [handoff, siteId, ok]
  );
  // Пояс сайта — из настроек аналитики (A); нет ответа — пояс по умолчанию.
  const tz = useAsync(
    () =>
      ok
        ? stats.analyticsSettings(siteId).then(
            (a) => a.timezone,
            () => 'Europe/Kyiv'
          )
        : Promise.resolve('Europe/Kyiv'),
    [stats, siteId, ok]
  );
  const [view, setView] = useState<HandoffSettingsView | null>(null);
  const [draft, setDraft] = useState<HandoffConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (!ok) return <ManagerOnly />;
  const v = view ?? loaded.data;
  if (loaded.loading && !v) return <Spinner label={dict.common.loading} />;
  if (!v) return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  const c = draft ?? v.config;
  const set = (patch: Partial<HandoffConfig>) => setDraft({ ...c, ...patch });

  const setDay = (d: Weekday, list: Array<{ from: string; to: string }>) => {
    const hours = { ...c.hours };
    if (list.length) hours[d] = list;
    else delete hours[d];
    set({ hours });
  };

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const next = await handoff.saveSettings(siteId, c);
      setView(next);
      setDraft(null);
      setNotice({ tone: 'success', text: appDict.e3.common.saved });
    } catch (e) {
      setNotice({
        tone: 'danger',
        text: errText(e),
        lines: fieldErrorLines(e, appDict),
      });
    } finally {
      setBusy(false);
    }
  }

  const L = HANDOFF_LIMITS;
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      <Alert tone={v.availableNow ? 'success' : 'warning'}>
        {v.availableNow
          ? t.availableNow
          : v.unavailableReason
            ? t.unavailable[v.unavailableReason]
            : t.unavailable.disabled}
        <div className="text-xs mt-1">
          {v.etaMinutes !== null ? fmt(t.eta, { n: v.etaMinutes }) : t.etaNone}
        </div>
      </Alert>

      <Card className="space-y-3">
        <Toggle
          checked={c.enabled}
          onChange={(x) => set({ enabled: x })}
          label={t.enabled}
        />
        <div className="space-y-2">
          <div className="text-sm font-medium">{t.hours}</div>
          <div className="text-xs text-silver-500">
            {fmt(t.hoursHint, { tz: tz.data ?? 'Europe/Kyiv' })}
          </div>
          {WEEKDAYS.map((d) => {
            const list = c.hours[d] ?? [];
            return (
              <div
                key={d}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span className="w-8 font-medium">{t.weekdays[d]}</span>
                {list.length === 0 && (
                  <span className="text-silver-500">{t.dayOff}</span>
                )}
                {list.map((iv, i) => (
                  <span key={i} className="inline-flex items-center gap-1">
                    <input
                      type="time"
                      aria-label={`${t.weekdays[d]} ${i + 1}`}
                      className="rounded border border-silver-300 dark:border-silver-700 bg-transparent px-1"
                      value={iv.from}
                      onChange={(e) =>
                        setDay(
                          d,
                          list.map((x, j) =>
                            j === i ? { ...x, from: e.target.value } : x
                          )
                        )
                      }
                    />
                    –
                    <input
                      type="time"
                      aria-label={`${t.weekdays[d]} ${i + 1}`}
                      className="rounded border border-silver-300 dark:border-silver-700 bg-transparent px-1"
                      value={iv.to}
                      onChange={(e) =>
                        setDay(
                          d,
                          list.map((x, j) =>
                            j === i ? { ...x, to: e.target.value } : x
                          )
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label={appDict.e3.common.remove}
                      className="text-silver-500 px-1"
                      onClick={() =>
                        setDay(
                          d,
                          list.filter((_, j) => j !== i)
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {list.length < L.intervalsPerDay && (
                  <button
                    type="button"
                    className="text-xs underline text-silver-500"
                    onClick={() =>
                      setDay(d, [...list, { from: '09:00', to: '18:00' }])
                    }
                  >
                    {t.addInterval}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <Field label={t.waitMinutes}>
          <NumberInput
            value={c.waitMinutes}
            min={L.waitMinutes.min}
            max={L.waitMinutes.max}
            onChange={(n) => set({ waitMinutes: n })}
          />
        </Field>
        <Field label={t.remindAfter}>
          <NumberInput
            value={c.remindAfterMinutes}
            min={L.remindAfterMinutes.min}
            max={L.remindAfterMinutes.max}
            onChange={(n) => set({ remindAfterMinutes: n })}
          />
        </Field>
        <Field label={t.maxReminders}>
          <NumberInput
            value={c.maxReminders}
            min={L.maxReminders.min}
            max={L.maxReminders.max}
            onChange={(n) => set({ maxReminders: n })}
          />
        </Field>
        <Field label={t.idleClose}>
          <NumberInput
            value={c.idleCloseHours}
            min={L.idleCloseHours.min}
            max={L.idleCloseHours.max}
            onChange={(n) => set({ idleCloseHours: n })}
          />
        </Field>
        <TextsInput
          label={(l) => fmt(t.etaText, { lang: l })}
          value={c.etaText}
          max={L.etaText}
          onChange={(etaText) => set({ etaText })}
        />
      </Card>

      <Card className="space-y-3">
        <Field label={t.operatorLang}>
          <Select
            value={c.operatorLang}
            options={OPERATOR_LANGS}
            labels={appDict.e3.common.langs}
            onChange={(operatorLang) => set({ operatorLang })}
          />
        </Field>
        <Toggle
          checked={c.translate}
          onChange={(x) => set({ translate: x })}
          label={t.translate}
        />
        <Toggle
          checked={c.draft}
          onChange={(x) => set({ draft: x })}
          label={t.draft}
        />
        <div className="space-y-1">
          <div className="text-sm font-medium">{t.escalation}</div>
          {ESCALATION_KINDS.map((k) => (
            <Toggle
              key={k}
              checked={c.escalation[k]}
              onChange={(x) => set({ escalation: { ...c.escalation, [k]: x } })}
              label={appDict.e3.dialogs.escalation[k]}
            />
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="text-sm font-medium">{t.templates}</div>
        {c.templates.map((tpl, i) => (
          <div
            key={tpl.id}
            className="space-y-1 border-t border-silver-200 dark:border-silver-800 pt-2"
          >
            <input
              aria-label={t.templateTitle}
              placeholder={t.templateTitle}
              className={inputClass}
              maxLength={60}
              value={tpl.title}
              onChange={(e) =>
                set({
                  templates: c.templates.map((x, j) =>
                    j === i ? { ...x, title: e.target.value } : x
                  ),
                })
              }
            />
            <textarea
              aria-label={t.templateText}
              placeholder={t.templateText}
              className={textareaClass}
              maxLength={L.templateText}
              value={tpl.text}
              onChange={(e) =>
                set({
                  templates: c.templates.map((x, j) =>
                    j === i ? { ...x, text: e.target.value } : x
                  ),
                })
              }
            />
            <Button
              variant="ghost"
              onClick={() =>
                set({ templates: c.templates.filter((_, j) => j !== i) })
              }
            >
              {appDict.e3.common.remove}
            </Button>
          </div>
        ))}
        {c.templates.length < L.templates && (
          <Button
            variant="outline"
            onClick={() =>
              set({
                templates: [
                  ...c.templates,
                  {
                    id: freeKey(
                      'tpl',
                      c.templates.map((x) => x.id)
                    ),
                    title: '',
                    text: '',
                  },
                ],
              })
            }
          >
            {t.addTemplate}
          </Button>
        )}
      </Card>

      <Button
        block
        loading={busy}
        disabled={!draft}
        onClick={() => void save()}
      >
        {appDict.e3.common.save}
      </Button>

      <Card className="space-y-2">
        <div className="text-sm font-medium">{t.operators}</div>
        <div className="text-xs text-silver-500">{t.operatorsHint}</div>
        <ul className="divide-y divide-silver-200 dark:divide-silver-800">
          {v.operators.map((o) => (
            <li
              key={o.memberId}
              className="py-2 flex flex-wrap items-center gap-2 text-sm"
            >
              <span className="flex-1 min-w-0 truncate">
                {fmt(dict.members.telegramId, { id: o.telegramId })}
                {o.isMe && (
                  <span className="text-silver-500"> · {dict.members.you}</span>
                )}
              </span>
              <span className="text-xs text-silver-500">
                {t.assistRoles[o.assist]}
              </span>
              <Badge
                tone={
                  o.botBlocked ? 'danger' : o.botStarted ? 'success' : 'warning'
                }
              >
                {o.botBlocked
                  ? t.botBlocked
                  : o.botStarted
                    ? t.botStarted
                    : t.botNotStarted}
              </Badge>
            </li>
          ))}
        </ul>
        <Button variant="outline" onClick={() => navigate({ name: 'members' })}>
          {t.members}
        </Button>
      </Card>
    </div>
  );
}
