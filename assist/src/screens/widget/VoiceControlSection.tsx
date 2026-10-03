/**
 * Раздел «Голосовое управление сайтом» (Э6-бис (а), ТЗ §5-бис.2, §5-бис.8,
 * §5-бис.11): переключатель (выкл/вкл — `test` и авто-`degraded` — часть
 * (г)), правила (зоны, запреты, подтверждение заполнения, лимит шагов),
 * экран рисков перед включением (версия текста — на сервер). Доступно только
 * при включённом голосе сайта (тариф Business+, микрофон) — как у голоса;
 * выключить — всегда.
 */
import { useState } from 'react';
import { Save } from 'lucide-react';
import { useAsync } from '../../kit';
import { Alert, Button, Card, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  lines,
  voiceControlErrorCode,
  type VoiceControlRules,
  type VoiceControlSettingsView,
} from '../../lib/voice-control-api';
import { NoticeBar, type Notice } from '../knowledge/parts';
import { Field, Toggle } from './controls';

export function VoiceControlSection({ siteId }: { siteId: string }) {
  const { voiceControl } = useAssist();
  const loaded = useAsync(
    () => voiceControl.get(siteId),
    [voiceControl, siteId]
  );
  if (!loaded.data) return null;
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
  const t = appDict.voiceControl;
  const errText = useSetupErrorText();
  const [view, setView] = useState(initial);
  const [on, setOn] = useState(
    initial.state === 'on' || initial.state === 'degraded'
  );
  const [rules, setRules] = useState<VoiceControlRules>(initial.rules);
  const [texts, setTexts] = useState<Record<ListKey, string>>(() => {
    const o = {} as Record<ListKey, string>;
    for (const k of LISTS) o[k] = initial.rules[k].join('\n');
    return o;
  });
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const wasOn = view.state === 'on' || view.state === 'degraded';
  const turningOn = on && !wasOn;

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const next: VoiceControlRules = { ...rules };
      for (const k of LISTS) next[k] = lines(texts[k]);
      const v = await voiceControl.save(siteId, {
        state: on ? 'on' : 'off',
        rules: next,
        ...(turningOn
          ? { risksVersion: accepted ? view.risksVersion : '' }
          : {}),
      });
      setView(v);
      setRules(v.rules);
      setOn(v.state === 'on' || v.state === 'degraded');
      setAccepted(false);
      setNotice({ tone: 'success', text: t.saved });
    } catch (e) {
      const code = voiceControlErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      <div className="font-semibold text-sm">{t.title}</div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {!view.available && !wasOn && (
        <Alert tone="neutral">
          {view.reason === 'voice_off' ? t.needVoice : t.plan}
        </Alert>
      )}
      {wasOn && view.reason && view.reason !== 'state_off' && (
        <Alert tone="neutral">{t.reasons[view.reason]}</Alert>
      )}
      <NoticeBar notice={notice} />
      <Toggle
        checked={on}
        disabled={!view.available && !wasOn}
        label={t.toggle}
        onChange={setOn}
      />
      {turningOn && (
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
        disabled={busy || (turningOn && !accepted)}
        onClick={() => void save()}
      >
        {t.save}
      </Button>
    </Card>
  );
}
