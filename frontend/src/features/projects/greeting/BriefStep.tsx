/**
 * Шаг 1 мастера поздравления — бриф (повод, кому, от кого, тон, язык,
 * ведущий, качество), с голосовым заполнением полей.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useRef } from 'react';
import { Gift, Check, UserRound } from 'lucide-react';
import {
  Card,
  CardHeader,
  Field,
  Input,
  Textarea,
  Select,
  Pills,
  Alert,
  Button,
} from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import { errorMessage } from '../../../services/projects-api';
import {
  updateSessionGreetingBrief,
  updateGreetingBrief,
} from '../../../services/greeting-api';
import {
  sessionBriefPatch,
  startAfterSave,
} from '../../../lib/greeting-brief-diff';
import type { PlanId } from '../../../types';
import {
  type GreetingResetField,
  type GreetingBriefView,
  type BrandManifestSummaryView,
  type SessionBriefEditResult,
  type GreetingPresenterProvider,
  type GreetingResolution,
  type GreetingScriptLanguage,
  GREETING_SCRIPT_LANGUAGE_NAMES,
  type UpdateGreetingBriefInput,
  GREETING_SCRIPT_LANGUAGES,
  GREETING_RESOLUTIONS,
} from '../../../types/project';
import { GreetingOccasionFields } from '../GreetingOccasionFields';
import {
  type OccasionFieldsState,
  initialMood,
  effectiveServerRegister,
  occasionFieldsComplete,
  fieldsRegister,
  occasionRegisterField,
} from '../../../lib/greeting-occasion-fields';
import {
  useGreetingPolicy,
  useSessionSelections,
} from '../../../lib/useGreetingPolicy';
import {
  predictedSessionResets,
  type ToneChange,
} from '../../../lib/greeting-policy';
import { HelpButton } from '../HelpSheet';
import {
  BRIEF_VOICE_TARGETS,
  type BriefVoiceRefusal,
  BRIEF_VOICE_TARGET_LIST,
  applyBriefVoiceFields,
  type ToneCommand,
  toneForCommand,
  BRIEF_NAME_MAX,
  BRIEF_MESSAGE_MAX,
} from '../../../lib/voice-brief';
import type { VoiceField } from '../../../lib/voice-types';
import { needsSave } from '../../../lib/voice-fields';
import {
  useVoiceFieldApplier,
  useVoiceScreenValues,
  type VoiceCommandHandler,
  useVoiceCommand,
} from '../../voice/voice-commands';
import { briefVoiceMissing } from '../../../lib/brief-voice-missing';
import {
  type PresenterOption,
  hedraSketchConflict,
  parsePresenterKey,
  presenterBlockMode,
  presenterFromBrief,
  presenterKey,
  presenterOptionLabel,
  presenterOptions,
  shouldSendPresenter,
  withPresenterBody,
} from '../../../lib/persona-greeting';
import { usePersonaState } from '../../../lib/persona-greeting-api';
import { lookDisplayLabel } from '../../../lib/persona-flow';
import { navigate, routes } from '../../../lib/router';

// ── Шаг 1: бриф ──────────────────────────────────────────────────────────

function resetFieldLabel(
  w: {
    resetFieldSticker: string;
    resetFieldMusic: string;
    resetFieldScenes: string;
    resetFieldPhotos: string;
  },
  field: GreetingResetField
): string {
  switch (field) {
    case 'referenceImages':
      return w.resetFieldPhotos;
    case 'sticker':
      return w.resetFieldSticker;
    case 'musicTheme':
      return w.resetFieldMusic;
    case 'sceneCount':
      return w.resetFieldScenes;
  }
}

export function BriefStep({
  brief,
  manifests,
  plan,
  sessionId,
  onSaved,
  onSessionEdited,
  onStartSession,
}: {
  brief: GreetingBriefView;
  manifests: BrandManifestSummaryView[];
  plan: PlanId;
  /** Есть — правка идёт в сессию (этап C, §3.6), нет — в бриф проекта. */
  sessionId: string | null;
  onSaved: (brief: GreetingBriefView) => void;
  onSessionEdited: (result: SessionBriefEditResult) => Promise<void>;
  onStartSession: () => Promise<void>;
}) {
  const { dict, locale } = useI18n();
  const w = dict.greetingVideoWizard;
  const hasSession = !!sessionId;

  // Этап D (§3.4, §3.5): повод, настроение и тон — одним куском, его
  // правит общий с экраном создания блок `GreetingOccasionFields`.
  // Настроение — сохранённый ответ человека (сервер хранит его отдельно
  // от поднятого итога), см. `initialMood`; нет ответа — вопрос заново.
  const [occ, setOcc] = useState<OccasionFieldsState>(() => ({
    occasion: brief.occasion,
    customOccasionText: brief.customOccasionText ?? '',
    mood: initialMood(brief),
    tone: brief.tone,
  }));
  const { occasion, customOccasionText, tone } = occ;
  const policy = useGreetingPolicy();
  // Итог сервера из ПОСЛЕДНЕГО сохранения: `brief` обновляется после
  // каждой правки, так что строка «уточнено как …» не отстаёт. Переписал
  // человек описание — прежний итог уже не про этот текст и не держит
  // тоны (`effectiveServerRegister`).
  const serverRegister = effectiveServerRegister(brief, occ);
  const [recipientName, setRecipientName] = useState(brief.recipientName);
  const [senderName, setSenderName] = useState(brief.senderName ?? '');
  const [personalMessage, setPersonalMessage] = useState(
    brief.personalMessage ?? ''
  );
  const [presenterProvider, setPresenterProvider] =
    useState<GreetingPresenterProvider>(brief.presenterProvider);
  const [resolution, setResolution] = useState<GreetingResolution>(
    brief.resolution
  );
  // «Кто в кадре» (ТЗ Greeting 2.0 §4.1 п. 8, §4.8): ИИ-ведущий или
  // образ персоны (фото или скетч). В форме — ключом-строкой, чтобы
  // сравнение «было/стало» брифа работало как у остальных полей.
  const persona = usePersonaState();
  const pg = dict.personaGreeting;
  const [presenter, setPresenter] = useState(() =>
    presenterKey(presenterFromBrief(brief))
  );
  const presenterNow = parsePresenterKey(presenter) ?? { kind: 'ai' as const };
  const presenterMode = presenterBlockMode(persona, presenterNow);
  const presenterChoices = presenterOptions(persona, presenterNow);
  const presenterSelected = presenterChoices.find((o) => o.key === presenter);
  const presenterLabel = (o: PresenterOption): string =>
    presenterOptionLabel(
      o,
      {
        ai: pg.presenterAi,
        missing: pg.presenterMissing,
        pending: pg.presenterSelfPending,
        photo: pg.presenterSelfPhoto,
        sketch: pg.presenterSelfSketch,
      },
      (look) => lookDisplayLabel(look, dict.persona)
    );
  const [brandManifestId, setBrandManifestId] = useState(
    brief.brandManifestId ?? ''
  );
  const [occasionDate, setOccasionDate] = useState(brief.occasionDate ?? '');
  // Этап C (§3.8): по умолчанию — язык интерфейса автора.
  const [scriptLanguage, setScriptLanguage] = useState<GreetingScriptLanguage>(
    brief.scriptLanguage ?? locale
  );
  /** Что показать рядом с «Сохранено» после правки из сессии. */
  const [editResult, setEditResult] = useState<SessionBriefEditResult | null>(
    null
  );

  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * Счётчик удачных сохранений. Сохранение само сбрасывает несовместимое
   * в сессии и делает устаревшей строку «Тон: … → …», а регистр от него
   * может не поменяться — без счётчика предупреждение «сбросится …»
   * висело бы после уже случившегося сброса.
   */
  const [saveCount, setSaveCount] = useState(0);

  // У «Особого повода» без ответа о настроении сервер отвечает 400
  // (§3.4: «без ответа бриф не сохраняется») — кнопка гаснет раньше.
  const canSave =
    recipientName.trim().length > 0 && occasionFieldsComplete(occ);

  // Предупреждение ДО сохранения: что сбросится в уже начатой сессии при
  // новом поводе и регистре (музыка каталога зависит от повода).
  // Окончательный список всё равно назовёт сервер (`resetFields` рядом с
  // «Сохранено»); это — чтобы не удивлять.
  const registerNow = fieldsRegister(policy, occ, serverRegister);
  const selections = useSessionSelections(
    sessionId,
    occasion,
    registerNow,
    saveCount
  );
  const predictedResets = selections
    ? predictedSessionResets(policy, occasion, registerNow, selections)
    : [];

  // ── Голос (этап K3, ТЗ Greeting 2.0 §4А.2 п. 3–4) ─────────────────────
  // Карточка «я понял так» применяется сюда, в те же setState, что у
  // ручного ввода, и по тем же правилам (`applyBriefVoiceFields`): повод
  // — через сброс тона `applyOccasionPatch`, тон — только допустимый.
  const v = dict.voiceAssistant;
  const [voiceToneChange, setVoiceToneChange] = useState<{
    change: ToneChange | null;
    seq: number;
  }>({ change: null, seq: 0 });
  const describeVoiceField = (f: VoiceField): string => {
    if (typeof f.value === 'boolean') return f.value ? v.valueYes : v.valueNo;
    const T = BRIEF_VOICE_TARGETS;
    const names: Partial<Record<string, Record<string, string>>> = {
      [T.occasion]: w.occasion,
      [T.mood]: w.mood,
      [T.tone]: w.tone,
      [T.scriptLanguage]: GREETING_SCRIPT_LANGUAGE_NAMES,
      [T.presenter]: { grok: w.providerGrok, hedra: w.providerHedra },
    };
    return names[f.target]?.[f.value] ?? f.value;
  };
  const refusalReason = (reason: BriefVoiceRefusal): string =>
    reason === 'tone-unavailable'
      ? w.toneUnavailable
      : reason === 'not-other'
        ? v.refusedNotOther
        : v.refusedInvalid;
  useVoiceFieldApplier({
    targets: BRIEF_VOICE_TARGET_LIST,
    describe: describeVoiceField,
    apply: (fields) => {
      const r = applyBriefVoiceFields(policy, occ, fields, (next) =>
        effectiveServerRegister(brief, next)
      );
      if (r.occPatch) {
        const occPatch = r.occPatch;
        setOcc((prev) => ({ ...prev, ...occPatch }));
        setVoiceToneChange((prev) => ({
          change: r.toneChange,
          seq: prev.seq + 1,
        }));
      }
      const p = r.patch;
      if (p.recipientName !== undefined) setRecipientName(p.recipientName);
      if (p.senderName !== undefined) setSenderName(p.senderName);
      if (p.personalMessage !== undefined)
        setPersonalMessage(p.personalMessage);
      if (p.scriptLanguage !== undefined) setScriptLanguage(p.scriptLanguage);
      if (p.presenterProvider !== undefined)
        setPresenterProvider(p.presenterProvider);
      if (p.resolution !== undefined) setResolution(p.resolution);
      if (p.occasionDate !== undefined) setOccasionDate(p.occasionDate);
      const refusals = r.refused.map((x) =>
        v.refusedField
          .replace(
            '{field}',
            fields.find((f) => f.target === x.target)?.label ?? x.target
          )
          .replace('{reason}', refusalReason(x.reason))
      );
      // Бриф голос не сохраняет — строка после «Да» называет кнопку (K5).
      // Но кнопка погашена, пока бриф неполон (`canSave`): тогда строка
      // называет, чего не хватает, — так помощник и задаёт обязательный
      // вопрос о настроении «Особого повода» (аудит ветки K). Состояние —
      // то, что станет после этого «Да», а не до него.
      const missing = briefVoiceMissing(
        { ...occ, ...(r.occPatch ?? {}) },
        p.recipientName ?? recipientName
      );
      const vb = dict.voiceBrief;
      const missingText: Record<(typeof missing)[number], string> = {
        customOccasion: vb.missingCustomOccasion,
        mood: vb.missingMood,
        recipient: vb.missingRecipient,
      };
      return {
        refusals,
        effects:
          fields.length > refusals.length
            ? missing.length > 0
              ? [
                  {
                    kind: 'failed' as const,
                    reason: missing
                      .map((m) => missingText[m])
                      .join(vb.missingJoin),
                  },
                ]
              : [needsSave(w.editSubmitButton)]
            : [],
      };
    },
  });
  // Контракт P-раунда п. 1: разбор реплики видит бриф НА ЭКРАНЕ, а не
  // только сохранённый, — «исправь имя» и проверка тона против нового,
  // ещё не сохранённого повода идут от того, что человек видит.
  // Описание и настроение — как в запросе сохранения (`fieldsNow`):
  // только у «Особого повода».
  useVoiceScreenValues(() => ({
    occasion,
    customOccasionText: occasion === 'OTHER' ? customOccasionText : null,
    mood: occasionRegisterField(occ),
    tone,
    recipientName,
    senderName,
    personalMessage,
    scriptLanguage,
    presenterProvider,
    resolution,
    occasionDate,
  }));
  // «Серьёзнее», «легче», «без шуток» — не отдельное действие, а
  // предложенный тон на той же карточке «я понял так»: применится только
  // после «Да» и через те же правила регистра, что пилюля тона.
  const toneCommand = (command: ToneCommand): VoiceCommandHandler => ({
    propose: (args) => {
      const r = toneForCommand(
        command,
        tone,
        policy,
        occasion,
        registerNow,
        args?.tone
      );
      if ('tone' in r) {
        return {
          kind: 'propose',
          card: {
            kind: 'fill',
            fields: [
              {
                target: BRIEF_VOICE_TARGETS.tone,
                value: r.tone,
                label: w.toneLabel,
              },
            ],
          },
        };
      }
      // Сервер не назвал тон — своей шкалы у экрана нет (P2-API): «пока
      // руками», а не ложное «уже некуда».
      if (r.refusal === 'manual') return { kind: 'manual' };
      const lighter = command === 'tone-lighter';
      const text =
        r.refusal === 'unavailable'
          ? lighter
            ? v.toneLighterUnavailable
            : v.toneSeriousUnavailable
          : command === 'no-jokes'
            ? v.noJokesAlready
            : lighter
              ? v.toneLighterAlready
              : v.toneSeriousAlready;
      return { kind: 'refuse', text };
    },
  });
  useVoiceCommand('tone-serious', toneCommand('tone-serious'));
  useVoiceCommand('tone-lighter', toneCommand('tone-lighter'));
  useVoiceCommand('no-jokes', toneCommand('no-jokes'));

  const fieldsNow = () => ({
    occasion: occasion as string,
    customOccasionText: occasion === 'OTHER' ? customOccasionText.trim() : null,
    // Только у «Особого повода». После старта уходят лишь изменённые
    // поля, но ответ о настроении — ВСЕГДА (`sessionBriefPatch`): сервер
    // теперь помнит ответ сам, но у брифа, поднятого словами или
    // классификатором до отдельной колонки ответа, его там нет, и правка
    // без него получила бы 400 OTHER_MOOD_REQUIRED.
    occasionRegister: occasionRegisterField(occ) as string | null,
    scriptLanguage: scriptLanguage as string,
    recipientName: recipientName.trim(),
    senderName: senderName.trim() || null,
    tone: tone as string,
    personalMessage: personalMessage.trim() || null,
    presenterProvider: presenterProvider as string,
    presenter,
    resolution: resolution as string,
    occasionDate: occasionDate || null,
  });
  /** Что было на экране при открытии или после последнего сохранения. */
  const baseline = useRef<ReturnType<typeof fieldsNow> | null>(null);
  if (!baseline.current) baseline.current = fieldsNow();

  /** `true` — сохранено; ошибку показывает сам (`start` ждёт ответа). */
  const save = async (): Promise<boolean> => {
    if (!canSave) return false;
    setSaving(true);
    setError(null);
    setSaved(false);
    setEditResult(null);
    const fields = fieldsNow();
    // Ведущий-персона уходит объектом и только когда режим есть (или в
    // брифе уже стоит «я») — см. `shouldSendPresenter`.
    const sendPresenter = shouldSendPresenter(
      persona,
      parsePresenterKey(baseline.current!.presenter ?? '') ?? { kind: 'ai' },
      presenterNow
    );
    try {
      if (sessionId) {
        // Этап C (§3.6): после старта правка идёт в СЕССИЮ — сервер
        // обновит и её снимок, и бриф проекта. Раньше здесь был бриф
        // проекта, до сессии правка не доходила (Г-3), и этап A закрыл
        // поля целиком. Уходят только изменённые поля (и ответ о
        // настроении «Особого повода») — почему, см.
        // `lib/greeting-brief-diff.ts`.
        const result = await updateSessionGreetingBrief(
          sessionId,
          withPresenterBody(
            sessionBriefPatch(baseline.current!, fields),
            sendPresenter
          ) as UpdateGreetingBriefInput
        );
        baseline.current = fields;
        setEditResult(result);
        await onSessionEdited(result);
      } else {
        const updated = await updateGreetingBrief(brief.projectId, {
          ...(withPresenterBody(
            fields,
            sendPresenter
          ) as UpdateGreetingBriefInput),
          brandManifestId: brandManifestId || null,
        });
        baseline.current = fields;
        onSaved(updated);
      }
      setSaved(true);
      setSaveCount((n) => n + 1);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      // Бриф не сохранился (например, 400) — сессию не начинаем: она
      // собралась бы из СТАРОГО брифа, а ошибку `save` уже показал.
      await startAfterSave(save, onStartSession);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card className="p-5" data-qa="greeting-brief-card">
      <CardHeader
        icon={<Gift size={18} />}
        title={w.occasionLabel}
        hint={hasSession ? undefined : w.hint}
        action={<HelpButton cardHook="greeting-brief-card" />}
      />
      <div className="space-y-4">
        {/* Этап D (§3.5): повод → настроение → тон одной группой, тот же
            блок, что на экране создания, — сброс тона при смене повода
            и объяснение недоступного живут в нём, а не в двух копиях. */}
        <GreetingOccasionFields
          // Новый `key` после сохранения сбрасывает строку «Тон: … → …»:
          // она об изменении, которое уже сохранено.
          key={saveCount}
          value={occ}
          onChange={(patch) => setOcc((prev) => ({ ...prev, ...patch }))}
          policy={policy}
          serverRegister={serverRegister}
          serverRegisterFor={(next) => effectiveServerRegister(brief, next)}
          announcedToneChange={voiceToneChange}
        />

        <Field label={w.recipientNameLabel}>
          <Input
            data-qa={BRIEF_VOICE_TARGETS.recipient}
            value={recipientName}
            onChange={(e) =>
              setRecipientName(e.target.value.slice(0, BRIEF_NAME_MAX))
            }
            placeholder={w.recipientNamePlaceholder}
          />
        </Field>

        <Field label={w.senderNameLabel}>
          <Input
            data-qa={BRIEF_VOICE_TARGETS.sender}
            value={senderName}
            onChange={(e) =>
              setSenderName(e.target.value.slice(0, BRIEF_NAME_MAX))
            }
            placeholder={w.senderNamePlaceholder}
          />
        </Field>

        <Field
          label={w.personalMessageLabel}
          hint={w.personalMessageHint}
          counter={`${personalMessage.length}/${BRIEF_MESSAGE_MAX}`}
        >
          <Textarea
            data-qa={BRIEF_VOICE_TARGETS.message}
            rows={3}
            value={personalMessage}
            onChange={(e) =>
              setPersonalMessage(e.target.value.slice(0, BRIEF_MESSAGE_MAX))
            }
            placeholder={w.personalMessagePlaceholder}
          />
        </Field>

        <Field label={w.scriptLanguageLabel} hint={w.scriptLanguageHint}>
          <Select
            data-qa={BRIEF_VOICE_TARGETS.scriptLanguage}
            value={scriptLanguage}
            onChange={(e) =>
              setScriptLanguage(e.target.value as GreetingScriptLanguage)
            }
          >
            {GREETING_SCRIPT_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {GREETING_SCRIPT_LANGUAGE_NAMES[l]}
              </option>
            ))}
          </Select>
        </Field>

        <div data-qa={BRIEF_VOICE_TARGETS.presenter}>
          <span className="label">{w.presenterProviderLabel}</span>
          <Pills
            value={presenterProvider}
            onChange={setPresenterProvider}
            options={[
              { value: 'grok', label: w.providerGrok },
              {
                value: 'hedra',
                label: w.providerHedra,
                sub:
                  plan === 'PREMIUM' ? undefined : w.providerHedraPremiumOnly,
              },
            ]}
          />
          {presenterProvider === 'hedra' && (
            // Не предупреждение, а объяснение: аватару нужно лицо, и
            // узнать об этом лучше здесь, чем отказом на кнопке
            // генерации. Раньше на этом месте стояло «недоступно даже
            // на PREMIUM» — текст пилота, который решение владельца
            // продукта отменило.
            <Alert tone="info" className="mt-2">
              {w.providerHedraPortraitNotice}
            </Alert>
          )}
        </div>

        {/* «Кто в кадре» (§4.8). Режим выключен — ни слова о нём;
            персоны нет — только вход «Создать себя». data-qa здесь пока
            нет: шов check-docs требует пары с qa-hooks.ts сервера. */}
        {presenterMode === 'create' && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-silver-300 p-3 text-xs dark:border-silver-700">
            <UserRound size={14} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1 text-silver-400">
              {pg.createSelfHint}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(routes.persona())}
            >
              {pg.createSelf}
            </Button>
          </div>
        )}
        {presenterMode === 'choose' && (
          <div>
            <span className="label">{pg.presenterLabel}</span>
            <Pills
              value={presenter}
              onChange={setPresenter}
              ariaLabel={pg.presenterLabel}
              columns={2}
              options={presenterChoices.map((o) => ({
                value: o.key,
                label: presenterLabel(o),
              }))}
            />
            {presenterSelected?.thumbUrl && (
              <div className="mt-2 flex items-center gap-3">
                <img
                  src={presenterSelected.thumbUrl}
                  alt=""
                  data-qa-mask="presenter-look-thumbnail"
                  className="h-16 w-16 shrink-0 rounded-lg border border-silver-200/70 object-cover dark:border-silver-800"
                />
                <p className="text-xs text-silver-400">{pg.likenessNote}</p>
              </div>
            )}
            {presenterSelected?.missing && (
              <Alert tone="warning" className="mt-2">
                {pg.presenterMissingHint}
              </Alert>
            )}
            {hedraSketchConflict(presenterProvider, presenterNow) && (
              <Alert tone="warning" className="mt-2">
                {pg.hedraSketchWarning}
              </Alert>
            )}
          </div>
        )}

        <Field label={w.resolutionLabel}>
          <Select
            data-qa={BRIEF_VOICE_TARGETS.resolution}
            value={resolution}
            onChange={(e) =>
              setResolution(e.target.value as GreetingResolution)
            }
          >
            {GREETING_RESOLUTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={w.occasionDateLabel}>
          <Input
            data-qa={BRIEF_VOICE_TARGETS.date}
            type="date"
            value={occasionDate}
            onChange={(e) => setOccasionDate(e.target.value)}
          />
        </Field>

        <Field
          label={w.manifestLabel}
          hint={hasSession ? w.manifestSessionHint : undefined}
        >
          <Select
            value={brandManifestId}
            onChange={(e) => setBrandManifestId(e.target.value)}
            disabled={hasSession || manifests.length === 0}
          >
            <option value="">{w.noManifestOption}</option>
            {manifests.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </Field>

        {error && <Alert tone="error">{error}</Alert>}
        {saved && !error && (
          <Alert tone="success">
            <Check size={14} className="inline mr-1" />
            {w.editSubmitButton}
            {/* Этап C (§3.6): молча ничего не пропадает — сброшенное
                называется рядом с «Сохранено». */}
            {editResult && editResult.resetFields.length > 0 && (
              <span className="block">
                {w.savedResetPrefix}{' '}
                {editResult.resetFields
                  .map((f) => resetFieldLabel(w, f))
                  .join(', ')}
              </span>
            )}
            {editResult?.promptCleared && (
              <span className="block">{w.promptClearedNote}</span>
            )}
            {editResult?.newVersion && (
              <span className="block">{w.newVersionNote}</span>
            )}
          </Alert>
        )}

        {/* Этап C ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md
            (§3.6) снял временную блокировку этапа A: правка после старта
            идёт в сессию через `PATCH /sessions/:id/greeting-brief`. */}
        {hasSession && <Alert tone="info">{w.briefSessionHint}</Alert>}
        {/* Этап D (§3.5): несовместимое с новым регистром называется до
            нажатия, а не только после — «Сохранено» со списком снятого
            ниже остаётся окончательным ответом сервера. */}
        {hasSession && predictedResets.length > 0 && (
          <Alert tone="warning">
            {w.sessionResetWarning.replace(
              '{list}',
              predictedResets.map((f) => resetFieldLabel(w, f)).join(', ')
            )}
          </Alert>
        )}

        <div className="flex gap-2">
          <Button
            data-qa="greeting-brief-save"
            variant="outline"
            disabled={!canSave || saving || starting}
            loading={saving}
            onClick={() => void save()}
          >
            {w.editSubmitButton}
          </Button>
          {!hasSession && (
            <Button
              data-qa="greeting-start"
              disabled={!canSave || saving || starting}
              loading={starting}
              onClick={() => void start()}
            >
              {w.startSessionButton}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
