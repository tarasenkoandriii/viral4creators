import { useState } from 'react';
import { fmt } from '../../kit';
import { Alert, Button, Card, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  ENGAGEMENT_LIMITS,
  SCENARIO_ANSWER_TYPES,
  SCENARIO_FINALS,
  TRIGGER_KINDS,
  answerOf,
  conditionOf,
  defaultEngagement,
  engagementIssues,
  freeKey,
  newScenario,
  newTrigger,
  removeScenario,
  type EngagementConfig,
  type ScenarioConfig,
  type ScenarioFinal,
  type ScenarioStep,
  type TriggerConfig,
} from '../../lib/engagement-types';
import { fieldErrorLines } from '../../lib/e3-errors';
import { useE3ErrorText } from '../../lib/use-error-text';
import type { WidgetSettingsView } from '../../lib/widget-types';
import { ConfirmButton, NoticeBar, type Notice } from '../knowledge/parts';
import { MasksInput, TextsInput } from '../e3/parts';
import { Field, NumberInput, Select, Toggle } from './controls';

/**
 * Вкладка «Вовлечение» вида виджета (Э3, №41, №40, §5-тер.12): триггеры
 * MVP, лимиты навязчивости, сценарии. Хранится в черновике вида —
 * публикуется кнопкой на вкладке «Вид» вместе с ним.
 */
export function EngagementTab({
  siteId,
  view,
  onView,
}: {
  siteId: string;
  view: WidgetSettingsView;
  onView: (v: WidgetSettingsView) => void;
}) {
  const { appDict, widget } = useAssist();
  const t = appDict.e3.engagement;
  const errText = useE3ErrorText();
  const [e, setE] = useState<EngagementConfig>(
    () => view.draft.engagement ?? defaultEngagement()
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const update = (next: EngagementConfig) => {
    setE(next);
    setDirty(true);
  };
  const issues = engagementIssues(e);
  const L = ENGAGEMENT_LIMITS;

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const v = await widget.saveEngagement(siteId, e);
      onView(v);
      setE(v.draft.engagement ?? defaultEngagement());
      setDirty(false);
      setNotice({ tone: 'success', text: t.saved });
    } catch (err) {
      setNotice({
        tone: 'danger',
        text: errText(err),
        lines: fieldErrorLines(err, appDict),
      });
    } finally {
      setBusy(false);
    }
  }

  const setTrigger = (i: number, tr: TriggerConfig) =>
    update({ ...e, triggers: e.triggers.map((x, j) => (j === i ? tr : x)) });
  const setScenario = (i: number, sc: ScenarioConfig) =>
    update({ ...e, scenarios: e.scenarios.map((x, j) => (j === i ? sc : x)) });

  return (
    <div className="space-y-4">
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />

      <Card className="space-y-3">
        <div className="font-semibold">
          {t.triggers} · {e.triggers.length}/{L.maxTriggers}
        </div>
        {e.triggers.map((tr, i) => (
          <TriggerEditor
            key={tr.key}
            value={tr}
            scenarios={e.scenarios}
            onChange={(x) => setTrigger(i, x)}
            onRemove={() =>
              update({ ...e, triggers: e.triggers.filter((_, j) => j !== i) })
            }
          />
        ))}
        {e.triggers.length < L.maxTriggers && (
          <Button
            variant="outline"
            onClick={() =>
              update({
                ...e,
                triggers: [
                  ...e.triggers,
                  newTrigger(e.triggers.map((x) => x.key)),
                ],
              })
            }
          >
            {t.addTrigger}
          </Button>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="font-semibold">{t.limits}</div>
        <Field label={t.perVisit}>
          <Select
            value={String(e.limits.perVisit) as '1' | '2'}
            options={['1', '2'] as const}
            labels={{ '1': '1', '2': '2' }}
            onChange={(v) =>
              update({
                ...e,
                limits: { ...e.limits, perVisit: v === '2' ? 2 : 1 },
              })
            }
          />
        </Field>
        <MasksInput
          label={t.excludedPaths}
          value={e.limits.excludedPaths}
          onChange={(excludedPaths) =>
            update({ ...e, limits: { ...e.limits, excludedPaths } })
          }
        />
        <Toggle
          checked
          disabled
          onChange={() => undefined}
          label={t.firstScreen}
        />
      </Card>

      <Card className="space-y-3">
        <div className="font-semibold">
          {t.scenarios} · {e.scenarios.length}/{L.maxScenarios}
        </div>
        {e.scenarios.map((sc, i) => (
          <ScenarioEditor
            key={sc.key}
            value={sc}
            onChange={(x) => setScenario(i, x)}
            onRemove={() => update(removeScenario(e, sc.key))}
          />
        ))}
        {e.scenarios.length < L.maxScenarios && (
          <Button
            variant="outline"
            onClick={() =>
              update({
                ...e,
                scenarios: [
                  ...e.scenarios,
                  newScenario(e.scenarios.map((x) => x.key)),
                ],
              })
            }
          >
            {t.addScenario}
          </Button>
        )}
      </Card>

      {issues.length > 0 && (
        <Alert tone="warning">{fmt(t.issues, { n: issues.length })}</Alert>
      )}
      <Button
        block
        loading={busy}
        disabled={!dirty}
        onClick={() => void save()}
      >
        {t.save}
      </Button>
    </div>
  );
}

function TriggerEditor({
  value: tr,
  scenarios,
  onChange,
  onRemove,
}: {
  value: TriggerConfig;
  scenarios: ScenarioConfig[];
  onChange: (t: TriggerConfig) => void;
  onRemove: () => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.e3.engagement;
  const L = ENGAGEMENT_LIMITS;
  const c = tr.condition;
  const acceptKinds =
    scenarios.length > 0
      ? (['open', 'prefill', 'scenario'] as const)
      : (['open', 'prefill'] as const);
  return (
    <div className="space-y-2 border-t border-silver-200 dark:border-silver-800 pt-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-silver-500 flex-1">
          {tr.key}
        </span>
        <Toggle
          checked={tr.enabled}
          onChange={(enabled) => onChange({ ...tr, enabled })}
          label={t.enabled}
        />
      </div>
      <Select
        value={c.kind}
        options={TRIGGER_KINDS}
        labels={t.kinds}
        onChange={(k) => onChange({ ...tr, condition: conditionOf(k) })}
      />
      {(c.kind === 'time_on_page' || c.kind === 'url_match') && (
        <Field label={t.seconds}>
          <NumberInput
            value={c.seconds}
            min={L.minDelaySeconds}
            max={L.maxDelaySeconds}
            onChange={(seconds) =>
              onChange({ ...tr, condition: { ...c, seconds } })
            }
          />
        </Field>
      )}
      {c.kind === 'scroll_depth' && (
        <Field label={t.percent}>
          <NumberInput
            value={c.percent}
            min={10}
            max={100}
            onChange={(percent) =>
              onChange({ ...tr, condition: { ...c, percent } })
            }
          />
        </Field>
      )}
      {c.kind === 'url_match' && (
        <Field label={t.pathMask}>
          <input
            className={inputClass}
            maxLength={200}
            value={c.pathMask}
            onChange={(ev) =>
              onChange({
                ...tr,
                condition: { ...c, pathMask: ev.target.value.trim() },
              })
            }
          />
        </Field>
      )}
      <MasksInput
        label={t.pathMasks}
        value={tr.pathMasks}
        onChange={(pathMasks) => onChange({ ...tr, pathMasks })}
      />
      <TextsInput
        label={(l) => fmt(t.text, { lang: l })}
        value={tr.text}
        max={L.triggerText}
        onChange={(text) => onChange({ ...tr, text })}
      />
      <Field label={t.onAccept}>
        <Select
          value={tr.onAccept.kind}
          options={acceptKinds}
          labels={t.accept}
          onChange={(k) =>
            onChange({
              ...tr,
              onAccept:
                k === 'prefill'
                  ? { kind: 'prefill', question: {} }
                  : k === 'scenario'
                    ? { kind: 'scenario', scenarioKey: scenarios[0]?.key ?? '' }
                    : { kind: 'open' },
            })
          }
        />
      </Field>
      {tr.onAccept.kind === 'prefill' && (
        <TextsInput
          label={(l) => fmt(t.question, { lang: l })}
          value={tr.onAccept.question}
          max={200}
          onChange={(question) =>
            onChange({ ...tr, onAccept: { kind: 'prefill', question } })
          }
        />
      )}
      {tr.onAccept.kind === 'scenario' && (
        <Field label={t.scenario}>
          <Select
            value={tr.onAccept.scenarioKey}
            options={scenarios.map((s) => s.key)}
            labels={Object.fromEntries(
              scenarios.map((s) => [
                s.key,
                s.title.uk ?? s.title.ru ?? s.title.en ?? s.key,
              ])
            )}
            onChange={(scenarioKey) =>
              onChange({ ...tr, onAccept: { kind: 'scenario', scenarioKey } })
            }
          />
        </Field>
      )}
      <ConfirmButton variant="ghost" onConfirm={onRemove}>
        {appDict.e3.common.remove}
      </ConfirmButton>
    </div>
  );
}

function StepEditor({
  value: st,
  onChange,
  onRemove,
}: {
  value: ScenarioStep;
  onChange: (s: ScenarioStep) => void;
  onRemove: () => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.e3.engagement;
  const L = ENGAGEMENT_LIMITS;
  const a = st.answer;
  return (
    <div className="space-y-2 rounded-lg border border-silver-200 dark:border-silver-800 p-2">
      <TextsInput
        label={(l) => fmt(t.question, { lang: l })}
        value={st.question}
        max={L.stepQuestion}
        onChange={(question) => onChange({ ...st, question })}
      />
      <Field label={t.answerType}>
        <Select
          value={a.type}
          options={SCENARIO_ANSWER_TYPES}
          labels={t.answerTypes}
          onChange={(type) => onChange({ ...st, answer: answerOf(type) })}
        />
      </Field>
      {a.type === 'text' && (
        <Field label={t.maxChars}>
          <NumberInput
            value={a.maxChars}
            min={1}
            max={500}
            onChange={(maxChars) =>
              onChange({ ...st, answer: { ...a, maxChars } })
            }
          />
        </Field>
      )}
      {a.type === 'number' && (
        <div className="grid grid-cols-2 gap-2">
          {(['min', 'max'] as const).map((k) => (
            <Field key={k} label={t[k]}>
              <input
                type="number"
                className={inputClass}
                value={a[k] ?? ''}
                onChange={(ev) => {
                  const n =
                    ev.target.value === ''
                      ? null
                      : Math.round(Number(ev.target.value));
                  onChange({
                    ...st,
                    answer: {
                      ...a,
                      [k]: n !== null && Number.isFinite(n) ? n : null,
                    },
                  });
                }}
              />
            </Field>
          ))}
        </div>
      )}
      {a.type === 'choice' && (
        <div className="space-y-2">
          <div className="text-sm font-medium">{t.options}</div>
          {a.options.map((o, i) => (
            <div key={o.key} className="flex items-end gap-2">
              <div className="flex-1">
                <TextsInput
                  label={(l) => fmt(t.option, { lang: l })}
                  value={o.label}
                  max={L.optionLabel}
                  onChange={(label) =>
                    onChange({
                      ...st,
                      answer: {
                        ...a,
                        options: a.options.map((x, j) =>
                          j === i ? { ...x, label } : x
                        ),
                      },
                    })
                  }
                />
              </div>
              <Button
                variant="ghost"
                aria-label={appDict.e3.common.remove}
                onClick={() =>
                  onChange({
                    ...st,
                    answer: {
                      ...a,
                      options: a.options.filter((_, j) => j !== i),
                    },
                  })
                }
              >
                ×
              </Button>
            </div>
          ))}
          {a.options.length < L.maxOptions && (
            <Button
              variant="outline"
              onClick={() =>
                onChange({
                  ...st,
                  answer: {
                    ...a,
                    options: [
                      ...a.options,
                      {
                        key: freeKey(
                          'option',
                          a.options.map((x) => x.key)
                        ),
                        label: {},
                      },
                    ],
                  },
                })
              }
            >
              {t.addOption}
            </Button>
          )}
        </div>
      )}
      <Button variant="ghost" onClick={onRemove}>
        {appDict.e3.common.remove}
      </Button>
    </div>
  );
}

function ScenarioEditor({
  value: sc,
  onChange,
  onRemove,
}: {
  value: ScenarioConfig;
  onChange: (s: ScenarioConfig) => void;
  onRemove: () => void;
}) {
  const { appDict } = useAssist();
  const t = appDict.e3.engagement;
  const L = ENGAGEMENT_LIMITS;
  const f = sc.final;
  const setFinal = (final: ScenarioFinal) => onChange({ ...sc, final });
  return (
    <div className="space-y-2 border-t border-silver-200 dark:border-silver-800 pt-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-silver-500 flex-1">
          {sc.key}
        </span>
        <Toggle
          checked={sc.enabled}
          onChange={(enabled) => onChange({ ...sc, enabled })}
          label={t.enabled}
        />
      </div>
      <TextsInput
        label={(l) => fmt(t.title, { lang: l })}
        value={sc.title}
        max={L.scenarioTitle}
        onChange={(title) => onChange({ ...sc, title })}
      />
      <Toggle
        checked={sc.showInGreeting}
        onChange={(showInGreeting) => onChange({ ...sc, showInGreeting })}
        label={t.showInGreeting}
      />
      <div className="text-sm font-medium">
        {t.steps} · {sc.steps.length}/{L.maxSteps}
      </div>
      {sc.steps.map((st, i) => (
        <StepEditor
          key={st.key}
          value={st}
          onChange={(x) =>
            onChange({
              ...sc,
              steps: sc.steps.map((y, j) => (j === i ? x : y)),
            })
          }
          onRemove={() =>
            onChange({ ...sc, steps: sc.steps.filter((_, j) => j !== i) })
          }
        />
      ))}
      {sc.steps.length < L.maxSteps && (
        <Button
          variant="outline"
          onClick={() =>
            onChange({
              ...sc,
              steps: [
                ...sc.steps,
                {
                  key: freeKey(
                    'step',
                    sc.steps.map((x) => x.key)
                  ),
                  question: {},
                  answer: answerOf('choice'),
                },
              ],
            })
          }
        >
          {t.addStep}
        </Button>
      )}
      <Field label={t.final}>
        <Select
          value={f.kind}
          options={SCENARIO_FINALS}
          labels={t.finals}
          onChange={(k) =>
            setFinal(
              k === 'link'
                ? { kind: 'link', url: 'https://', label: {} }
                : { kind: k }
            )
          }
        />
      </Field>
      {f.kind === 'link' && (
        <>
          <Field label={t.linkUrl}>
            <input
              className={inputClass}
              type="url"
              inputMode="url"
              maxLength={500}
              value={f.url}
              onChange={(ev) => setFinal({ ...f, url: ev.target.value.trim() })}
            />
          </Field>
          <TextsInput
            label={(l) => fmt(t.linkLabel, { lang: l })}
            value={f.label}
            max={L.optionLabel}
            onChange={(label) => setFinal({ ...f, label })}
          />
        </>
      )}
      <ConfirmButton variant="ghost" onConfirm={onRemove}>
        {appDict.e3.common.remove}
      </ConfirmButton>
    </div>
  );
}
