import { useState } from 'react';
import { Save } from 'lucide-react';
import { fmt, useAsync, useKit } from '../../kit';
import {
  Alert,
  Button,
  Card,
  ScreenTitle,
  Spinner,
  inputClass,
} from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import { canManageWidget, linesToList } from '../../lib/widget-view';
import {
  PERSONA_LANG,
  PERSONA_LIMITS,
  PERSONA_TONES,
  type PersonaConfig,
  type PersonaSettingsView,
} from '../../lib/widget-types';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { Field, HistoryList, Select } from './controls';
import { VoiceSection } from './VoiceSection';
import { VoiceControlSection } from './VoiceControlSection';

/** «Характер помощника» (§3.5): тон, языки, запреты, стоп-фразы, примеры. */
export function PersonaScreen({ siteId }: { siteId: string }) {
  const { account, dict } = useKit();
  const { appDict, persona } = useAssist();
  const ok = canManageWidget(account.me);
  const loaded = useAsync(
    () => (ok ? persona.get(siteId) : Promise.resolve(null)),
    [persona, siteId, ok]
  );
  if (!ok) return <Alert tone="warning">{appDict.setup.common.noAccess}</Alert>;
  if (loaded.loading && !loaded.data)
    return <Spinner label={dict.common.loading} />;
  if (!loaded.data)
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  return <PersonaForm siteId={siteId} initial={loaded.data} />;
}

type ListKey =
  'forbiddenTopics' | 'stopPhrases' | 'examples' | 'handoffTriggers';
const LIST_MAX: Record<ListKey, number> = {
  forbiddenTopics: PERSONA_LIMITS.forbiddenTopics,
  stopPhrases: PERSONA_LIMITS.stopPhrases,
  examples: PERSONA_LIMITS.examples,
  handoffTriggers: PERSONA_LIMITS.handoffTriggers,
};
const ITEM_MAX: Record<ListKey, number> = {
  forbiddenTopics: PERSONA_LIMITS.forbiddenTopic,
  stopPhrases: PERSONA_LIMITS.stopPhrase,
  examples: PERSONA_LIMITS.example,
  handoffTriggers: PERSONA_LIMITS.handoffTrigger,
};

function PersonaForm({
  siteId,
  initial,
}: {
  siteId: string;
  initial: PersonaSettingsView;
}) {
  const { appDict, persona } = useAssist();
  const t = appDict.setup.persona;
  const tc = appDict.setup.common;
  const errText = useSetupErrorText();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<PersonaConfig>(initial.draft);
  // Списки правятся текстом «по строке» — разбор при сохранении.
  const [lists, setLists] = useState<Record<ListKey, string>>(() => ({
    forbiddenTopics: initial.draft.forbiddenTopics.join('\n'),
    stopPhrases: initial.draft.stopPhrases.join('\n'),
    examples: initial.draft.examples.join('\n'),
    handoffTriggers: initial.draft.handoffTriggers.join('\n'),
  }));
  const [allowed, setAllowed] = useState(
    initial.draft.languages.allowed.join(', ')
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const allowedList = allowed
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const langsOk =
    allowedList.length > 0 &&
    allowedList.length <= PERSONA_LIMITS.allowedLangs &&
    allowedList.every((x) => PERSONA_LANG.test(x)) &&
    allowedList.includes(draft.languages.default);

  const current = (): PersonaConfig => ({
    ...draft,
    languages: { ...draft.languages, allowed: [...new Set(allowedList)] },
    forbiddenTopics: linesToList(
      lists.forbiddenTopics,
      LIST_MAX.forbiddenTopics
    ).map((s) => s.slice(0, ITEM_MAX.forbiddenTopics)),
    stopPhrases: linesToList(lists.stopPhrases, LIST_MAX.stopPhrases).map((s) =>
      s.slice(0, ITEM_MAX.stopPhrases)
    ),
    examples: linesToList(lists.examples, LIST_MAX.examples).map((s) =>
      s.slice(0, ITEM_MAX.examples)
    ),
    handoffTriggers: linesToList(
      lists.handoffTriggers,
      LIST_MAX.handoffTriggers
    ).map((s) => s.slice(0, ITEM_MAX.handoffTriggers)),
    // Э3 №19: незаполненные процедуры не отправляем (сервер: required).
    procedures: (draft.procedures ?? [])
      .map((p) => ({ when: p.when.trim(), steps: p.steps.trim() }))
      .filter((p) => p.when && p.steps),
  });

  const accept = (v: PersonaSettingsView) => {
    setView(v);
    setDraft(v.draft);
    setAllowed(v.draft.languages.allowed.join(', '));
    setLists({
      forbiddenTopics: v.draft.forbiddenTopics.join('\n'),
      stopPhrases: v.draft.stopPhrases.join('\n'),
      examples: v.draft.examples.join('\n'),
      handoffTriggers: v.draft.handoffTriggers.join('\n'),
    });
  };

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const gate = view.lastGate;
  const listField = (key: ListKey, label: string, hint: string) => (
    <Field label={label} hint={hint} htmlFor={`p-${key}`}>
      <textarea
        id={`p-${key}`}
        className={textareaClass}
        value={lists[key]}
        onChange={(e) => setLists((l) => ({ ...l, [key]: e.target.value }))}
      />
    </Field>
  );

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {view.configVersion > 0 ? (
        <div className="text-sm text-silver-500">
          {fmt(tc.publishedLabel, { n: view.configVersion })}
        </div>
      ) : (
        <Alert tone="neutral">{tc.notPublished}</Alert>
      )}
      <Card className="space-y-3">
        <Field label={t.tone}>
          <Select
            value={draft.tone}
            options={PERSONA_TONES}
            labels={t.tones}
            onChange={(tone) => setDraft((d) => ({ ...d, tone }))}
          />
        </Field>
        <Field label={t.style} hint={t.styleHint} htmlFor="p-style">
          <textarea
            id="p-style"
            className={textareaClass}
            maxLength={PERSONA_LIMITS.style}
            value={draft.style}
            onChange={(e) => setDraft((d) => ({ ...d, style: e.target.value }))}
          />
        </Field>
      </Card>
      <Card className="space-y-3">
        <div className="font-semibold text-sm">{t.languages}</div>
        <Field label={t.langMode}>
          <Select
            value={draft.languages.mode}
            options={['auto', 'fixed'] as const}
            labels={t.langModes}
            onChange={(mode) =>
              setDraft((d) => ({ ...d, languages: { ...d.languages, mode } }))
            }
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.allowed} hint={t.allowedHint} htmlFor="p-allowed">
            <input
              id="p-allowed"
              className={inputClass}
              value={allowed}
              onChange={(e) => setAllowed(e.target.value)}
            />
          </Field>
          <Field label={t.defaultLang} htmlFor="p-default">
            <input
              id="p-default"
              className={inputClass}
              maxLength={2}
              value={draft.languages.default}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  languages: {
                    ...d.languages,
                    default: e.target.value.trim().toLowerCase(),
                  },
                }))
              }
            />
          </Field>
        </div>
        {!langsOk && (
          <div className="text-xs text-rose-500">{t.langInvalid}</div>
        )}
      </Card>
      <Card className="space-y-3">
        {listField('forbiddenTopics', t.forbidden, t.forbiddenHint)}
        {listField('stopPhrases', t.stopPhrases, t.stopHint)}
        {listField('examples', t.examples, t.examplesHint)}
        {listField('handoffTriggers', t.handoff, t.handoffHint)}
      </Card>
      <VoiceSection
        siteId={siteId}
        lang={
          (['uk', 'ru', 'en'] as const).find(
            (l) => l === draft.languages.default
          ) ?? 'uk'
        }
      />
      <VoiceControlSection siteId={siteId} />
      <ProceduresCard
        value={draft.procedures ?? []}
        onChange={(procedures) => setDraft({ ...draft, procedures })}
      />
      {gate && (
        <Alert
          tone={
            gate.blocked
              ? 'danger'
              : gate.notes.length || !gate.ran
                ? 'warning'
                : 'success'
          }
        >
          {gate.blocked
            ? t.gate.blocked
            : !gate.ran
              ? t.gate.notRan
              : gate.notes.length
                ? t.gate.warn
                : t.gate.ok}
          {gate.notes.length > 0 && (
            <ul className="list-disc pl-5">
              {gate.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          icon={<Save size={16} />}
          loading={busy === 'save'}
          disabled={!langsOk}
          onClick={() =>
            run('save', async () => {
              accept(await persona.saveDraft(siteId, current()));
              setNotice({ tone: 'success', text: tc.saved });
            })
          }
        >
          {tc.save}
        </Button>
        <ConfirmButton
          variant="outline"
          hint={t.publishHint}
          disabled={!langsOk}
          loading={busy === 'publish'}
          onConfirm={() =>
            run('publish', async () => {
              await persona.saveDraft(siteId, current());
              const v = await persona.publish(siteId);
              accept(v);
              setNotice({
                tone: 'success',
                text: fmt(tc.published, { n: v.configVersion }),
              });
            })
          }
        >
          {tc.publish}
        </ConfirmButton>
      </div>
      <HistoryList
        history={view.history}
        current={view.configVersion}
        busy={busy?.startsWith('rb:') ? Number(busy.slice(3)) : null}
        onRollback={(ver) =>
          run(`rb:${ver}`, async () => {
            const v = await persona.rollback(siteId, ver);
            accept(v);
            setNotice({
              tone: 'success',
              text: fmt(tc.rolledBack, { n: ver, m: v.configVersion }),
            });
          })
        }
      />
    </div>
  );
}

/**
 * Э3 №19: текстовые процедуры «когда — сделай» (до 10). Данные для
 * промпта персоны: новых действий модели не дают (только ссылка, заявка,
 * передача человеку). Пустая строка не уходит (сервер ответил бы required).
 */
function ProceduresCard({
  value,
  onChange,
}: {
  value: Array<{ when: string; steps: string }>;
  onChange: (v: Array<{ when: string; steps: string }>) => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.e3.procedures;
  const set = (i: number, patch: Partial<{ when: string; steps: string }>) =>
    onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Card className="space-y-3">
      <div className="font-semibold">{t.title}</div>
      <div className="text-xs text-silver-500">{t.hint}</div>
      {value.map((p, i) => (
        <div
          key={i}
          className="space-y-1 border-t border-silver-200 dark:border-silver-800 pt-2"
        >
          <input
            aria-label={t.when}
            placeholder={t.when}
            className={inputClass}
            maxLength={PERSONA_LIMITS.procedureWhen}
            value={p.when}
            onChange={(e) => set(i, { when: e.target.value })}
          />
          <textarea
            aria-label={t.steps}
            placeholder={t.steps}
            className={textareaClass}
            maxLength={PERSONA_LIMITS.procedureSteps}
            value={p.steps}
            onChange={(e) => set(i, { steps: e.target.value })}
          />
          <Button
            variant="ghost"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            {appDict.e3.common.remove}
          </Button>
        </div>
      ))}
      {value.length < PERSONA_LIMITS.procedures && (
        <Button
          variant="outline"
          onClick={() => onChange([...value, { when: '', steps: '' }])}
        >
          {t.add}
        </Button>
      )}
    </Card>
  );
}
