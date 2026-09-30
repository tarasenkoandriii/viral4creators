/**
 * Карточка «Голос отправителя» (фича №34) блока «Характер ролика».
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect } from 'react';
import { Mic } from 'lucide-react';
import { Card, CardHeader, Button, Alert } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import { errorMessage, listUserVoices } from '../../../services/projects-api';
import {
  getGreetingVoice,
  listGreetingPresetVoices,
  selectGreetingPresetVoice,
  selectGreetingSenderVoice,
} from '../../../services/greeting-api';
import { MyVoicesSection } from '../../brand/VoicePicker';
import type {
  GreetingVoiceView,
  GrokPresetVoice,
} from '../../../types/project';
import { HelpButton } from '../HelpSheet';
import {
  SESSION_VOICE_TARGETS,
  planVoiceChoice,
  refusalLines,
  saveEffect,
} from '../../../lib/voice-fields';
import { useFeature } from '../../../lib/plan-context';
import { useVoiceFieldApplier } from '../../voice/voice-commands';
import { voiceSummary } from '../../../lib/greeting-character';
import {
  useSessionVoiceTexts,
  describeSessionValue,
} from '../../voice/greeting-session-voice';

// ── Голос отправителя (фича №34) ─────────────────────────────────────────

/**
 * Чьим голосом прочитать уже написанный текст.
 *
 * Стоит после сценария и до рендера, потому что смысл у него ровно
 * такой: текст есть — осталось решить, чей это голос. Отдельной
 * ступенью в шагомере не становится: шаг можно пропустить целиком, и
 * ролик получится, просто с голосом по умолчанию.
 *
 * Список клонов, запись образца, согласие и лимит — `MyVoicesSection`
 * из редактора бренда: второй реализации у этой механики быть не
 * должно.
 */
export function SenderVoiceStep({
  sessionId,
  onSummary,
}: {
  sessionId: string;
  /** Значение для сводки блока «Характер ролика». */
  onSummary?: (value: string | null) => void;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [voice, setVoice] = useState<GreetingVoiceView>({
    senderVoice: null,
    presetVoiceId: null,
  });
  const [presets, setPresets] = useState<GrokPresetVoice[] | null>(null);
  // Прочитан ли выбор с сервера. Начальное `voice` выше — заглушка для
  // экрана («голос по умолчанию»), а не знание: до ответа и после
  // ошибки сводка о голосе молчит, иначе «по умолчанию» могло бы
  // оказаться неправдой про уже выбранный клон (аудит этапа D).
  const [voiceLoaded, setVoiceLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Роестр грузится вместе с выбором: он не стоит денег (обычный
    // GET у провайдера) и нужен сразу — без него второй вариант
    // выглядел бы пустым местом.
    void Promise.all([
      getGreetingVoice(sessionId).catch(() => null),
      listGreetingPresetVoices(sessionId).catch(() => [] as GrokPresetVoice[]),
    ]).then(([v, list]) => {
      if (!alive) return;
      if (v) {
        setVoice(v);
        setVoiceLoaded(true);
      }
      setPresets(list);
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  /** @returns ошибку, показанную на экране, или `null` — сохранено (K5). */
  const apply = async (
    fn: () => Promise<GreetingVoiceView>
  ): Promise<string | null> => {
    setBusy(true);
    setError(null);
    try {
      setVoice(await fn());
      // Ответ на выбор — тоже прочитанное состояние, даже если первое
      // чтение не прошло.
      setVoiceLoaded(true);
      return null;
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  const chosen = voice.senderVoice || voice.presetVoiceId;
  const presetName =
    presets?.find((p) => p.voiceId === voice.presetVoiceId)?.name ??
    voice.presetVoiceId;

  // Кнопки карточки и голос (K5) — одни и те же три обработчика.
  const clear = () =>
    apply(() =>
      voice.presetVoiceId
        ? selectGreetingPresetVoice(sessionId, null)
        : selectGreetingSenderVoice(sessionId, null)
    );
  const pickClone = (voiceId: string) =>
    apply(() => selectGreetingSenderVoice(sessionId, voiceId));
  const pickPreset = (voiceId: string) =>
    apply(() => selectGreetingPresetVoice(sessionId, voiceId));

  // Готовые клоны — тот же список, что показывает `MyVoicesSection` (и тот
  // же гейт тарифа): голос выбирает только клон, который виден на экране.
  // Перечитывается после каждого выбора — новый клон, дообученный рядом,
  // станет доступен голосу со следующей реплики.
  const cloning = useFeature('voiceCloning');
  const [clones, setClones] = useState<
    Array<{ voiceId: string; label: string }>
  >([]);
  useEffect(() => {
    if (!cloning.allowed) {
      setClones([]);
      return;
    }
    let alive = true;
    listUserVoices()
      .then(
        (list) =>
          alive &&
          setClones(
            list
              .filter((v) => v.status === 'ready' && v.resembleVoiceId)
              .map((v) => ({ voiceId: v.resembleVoiceId!, label: v.label }))
          )
      )
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cloning.allowed, voice]);

  const voiceTexts = useSessionVoiceTexts();
  const presetList = presets ?? [];
  useVoiceFieldApplier({
    targets: [
      SESSION_VOICE_TARGETS.voicePreset,
      SESSION_VOICE_TARGETS.voiceClone,
      SESSION_VOICE_TARGETS.voiceCustom,
    ],
    describe: (f) =>
      (f.target === SESSION_VOICE_TARGETS.voicePreset
        ? presetList.find((p) => p.voiceId === f.value)?.name
        : f.target === SESSION_VOICE_TARGETS.voiceClone
          ? clones.find((c) => c.voiceId === f.value)?.label
          : undefined) ?? describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      const plan = planVoiceChoice(
        {
          presets: presetList,
          clones,
          presetVoiceId: voice.presetVoiceId,
          cloneVoiceId: voice.senderVoice?.resembleVoiceId ?? null,
        },
        busy,
        fields
      );
      const a = plan.action;
      const refusals = refusalLines(plan.refused, fields, voiceTexts);
      const saving =
        a?.kind === 'clear'
          ? clear()
          : a?.kind === 'preset'
            ? pickPreset(a.voiceId)
            : a?.kind === 'clone'
              ? pickClone(a.voiceId)
              : null;
      if (!saving) return { refusals, effects: [] };
      // «Готово» — после ответа сервера, а не до него.
      return saving.then((err) => ({ refusals, effects: [saveEffect(err)] }));
    },
  });

  const summary = voiceSummary(
    voiceLoaded
      ? { senderLabel: voice.senderVoice?.label ?? null, presetName }
      : null,
    w
  );
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);

  return (
    <Card className="p-5" data-qa="greeting-voice-card">
      <CardHeader
        icon={<Mic size={18} />}
        title={w.senderVoiceHeading}
        hint={w.senderVoiceHint}
        action={
          <>
            <HelpButton cardHook="greeting-voice-card" />
            {chosen && (
              // Галочка «свой голос» (K5): «выключить» — эта же кнопка.
              <Button
                data-qa="greeting-voice-custom"
                size="sm"
                variant="ghost"
                loading={busy}
                onClick={() => void clear()}
              >
                {w.senderVoiceClear}
              </Button>
            )}
          </>
        }
      />

      {error && (
        <Alert tone="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <p className="text-xs text-silver-400">
        {voice.senderVoice
          ? w.senderVoicePicked.replace('{label}', voice.senderVoice.label)
          : voice.presetVoiceId
            ? w.presetVoicePicked.replace('{label}', presetName ?? '')
            : w.senderVoiceDefault}
      </p>

      <div className="mt-3" data-qa="greeting-voice-clone">
        <MyVoicesSection
          onPick={(voiceId) => void pickClone(voiceId)}
          disabled={busy}
          pickedVoiceId={voice.senderVoice?.resembleVoiceId ?? null}
        />
      </div>

      {/* Второй путь: реплику произносит сама модель. Ниже своих
          голосов, а не выше, потому что клон отправителя — то, ради
          чего эту карточку и открывают; пресет нужен тем, у кого
          клона нет. */}
      {presets !== null && presets.length > 0 && (
        <div className="mt-4 border-t border-silver-200/60 pt-3 dark:border-silver-800">
          <p className="text-sm font-medium">{w.presetVoiceHeading}</p>
          <p className="mt-0.5 text-xs text-silver-400">{w.presetVoiceHint}</p>
          {/* Оговорка про язык — не мелкий шрифт ради приличия:
              украинского нет в списке поддерживаемых языков xAI, а
              для этого продукта это основной язык половины
              аудитории. */}
          <p className="mt-1 text-xs text-silver-400">
            {w.presetVoiceLanguageNote}
          </p>
          <ul
            className="mt-2 flex flex-wrap gap-2"
            data-qa="greeting-voice-preset"
          >
            {presets.map((preset) => (
              <li key={preset.voiceId}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  active={voice.presetVoiceId === preset.voiceId}
                  onClick={() => void pickPreset(preset.voiceId)}
                >
                  {preset.name}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
