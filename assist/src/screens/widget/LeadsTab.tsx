import { useState } from 'react';
import { Save } from 'lucide-react';
import { useAsync, useKit } from '../../kit';
import { Alert, Button, Card, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  LEAD_FIELDS,
  LEADS_CONSENT_MAX,
  type LeadsConfig,
} from '../../lib/widget-types';
import {
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { Field, Toggle } from './controls';

/** «Заявки» (§3.6 п.6): поля формы, текст согласия, канал (Э2 — бот). Действует сразу. */
export function LeadsTab({ siteId }: { siteId: string }) {
  const { dict } = useKit();
  const { appDict, persona } = useAssist();
  const loaded = useAsync(() => persona.getLeads(siteId), [persona, siteId]);
  if (loaded.loading && !loaded.data)
    return <Spinner label={dict.common.loading} />;
  if (!loaded.data)
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  return (
    <LeadsForm
      siteId={siteId}
      initial={loaded.data.config}
      t={appDict.setup.widget.leads}
      langs={appDict.setup.widget.look.langs}
    />
  );
}

function LeadsForm({
  siteId,
  initial,
  t,
  langs,
}: {
  siteId: string;
  initial: LeadsConfig;
  t: ReturnType<typeof useAssist>['appDict']['setup']['widget']['leads'];
  langs: Record<'uk' | 'ru' | 'en', string>;
}) {
  const { persona } = useAssist();
  const errText = useSetupErrorText();
  const [config, setConfig] = useState<LeadsConfig>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const has = (f: string) => config.fields.find((x) => x.field === f);
  const contactOk = !!has('phone') || !!has('email');

  const setField = (
    field: (typeof LEAD_FIELDS)[number],
    show: boolean,
    required: boolean
  ) =>
    setConfig((c) => {
      const rest = c.fields.filter((x) => x.field !== field);
      const fields = show ? [...rest, { field, required }] : rest;
      // Порядок полей — как в перечне (форма у посетителя).
      fields.sort(
        (a, b) => LEAD_FIELDS.indexOf(a.field) - LEAD_FIELDS.indexOf(b.field)
      );
      return { ...c, fields };
    });

  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />
      <p className="text-sm text-silver-500">{t.intro}</p>
      <Card className="space-y-2 text-sm">
        {LEAD_FIELDS.map((f) => {
          const cur = has(f);
          return (
            <div key={f} className="flex flex-wrap items-center gap-4">
              <span className="w-32 font-medium">{t.fields[f]}</span>
              <Toggle
                checked={!!cur}
                onChange={(on) => setField(f, on, cur?.required ?? false)}
                label={t.show}
              />
              <Toggle
                checked={!!cur?.required}
                disabled={!cur}
                onChange={(req) => setField(f, true, req)}
                label={t.required}
              />
            </div>
          );
        })}
        {!contactOk && <Alert tone="warning">{t.contactRequired}</Alert>}
      </Card>
      <Card className="space-y-3">
        <div className="font-semibold text-sm">{t.consent}</div>
        {(['uk', 'ru', 'en'] as const).map((l) => (
          <Field key={l} label={langs[l]} htmlFor={`consent-${l}`}>
            <textarea
              id={`consent-${l}`}
              className={textareaClass}
              maxLength={LEADS_CONSENT_MAX}
              value={config.consentText[l] ?? ''}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  consentText: { ...c.consentText, [l]: e.target.value },
                }))
              }
            />
          </Field>
        ))}
        <div className="text-xs text-silver-500">{t.consentHint}</div>
      </Card>
      <Card className="text-sm">
        <div className="font-semibold">{t.channel}</div>
        <div className="text-silver-500">{t.channelBot}</div>
      </Card>
      <Button
        icon={<Save size={16} />}
        loading={busy}
        disabled={!contactOk}
        onClick={async () => {
          setBusy(true);
          setNotice(null);
          try {
            const v = await persona.saveLeads(siteId, config);
            setConfig(v.config);
            setNotice({ tone: 'success', text: t.saved });
          } catch (e) {
            setNotice({ tone: 'danger', text: errText(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {t.save}
      </Button>
    </div>
  );
}
