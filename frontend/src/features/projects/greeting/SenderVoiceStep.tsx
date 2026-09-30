/**
 * Карточка «Голос отправителя» (фича №34) блока «Характер ролика».
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect, useCallback } from 'react';
import { Mic, Volume2 } from 'lucide-react';
import { Card, CardHeader, Button, Alert } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import {
  getVoices,
  listUserVoices,
  previewVoice,
  type VoiceCatalogue,
} from '../../../services/projects-api';
import {
  getGreetingVoice,
  listGreetingPresetVoices,
  selectGreetingPresetVoice,
  selectGreetingSenderVoice,
  selectGreetingSonioxVoice,
  greetingErrorMessage,
} from '../../../services/greeting-api';
import {
  sonioxPreviewText,
  type SonioxGreetingLanguage,
} from '../../../lib/tts-provider-choice';
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
import {
  voiceSummary,
  lockedFieldRefusals,
  senderVoiceKind,
  type SenderVoiceKind,
} from '../../../lib/greeting-character';
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
  language,
  onSummary,
  onVoiceKind,
  lockText = null,
}: {
  sessionId: string;
  /**
   * Язык поздравления (S2): по нему фильтруется каталог Soniox — тот же
   * фильтр, что у сервера при сверке голосом, — и на нём звучит проба.
   */
  language: SonioxGreetingLanguage;
  /** Значение для сводки блока «Характер ролика». */
  onSummary?: (value: string | null) => void;
  /**
   * Вид выбранного голоса (аудит S2) — шагу «Видео», чтобы отличить
   * немой ролик от штатного «озвучка пропущена». `null` — не прочитан.
   */
  onVoiceKind?: (kind: SenderVoiceKind | null) => void;
  /**
   * Карточка заперта (ролик готов или снимается): причина для голоса —
   * тот же отказ, что подпись на экране (`CharacterBlock`).
   */
  lockText?: string | null;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const s2 = dict.greetingSoniox;
  const [voice, setVoice] = useState<GreetingVoiceView>({
    senderVoice: null,
    presetVoiceId: null,
    sonioxVoice: null,
  });
  const [presets, setPresets] = useState<GrokPresetVoice[] | null>(null);
  // Прочитан ли выбор с сервера. Начальное `voice` выше — заглушка для
  // экрана («голос по умолчанию»), а не знание: до ответа и после
  // ошибки сводка о голосе молчит, иначе «по умолчанию» могло бы
  // оказаться неправдой про уже выбранный клон (аудит этапа D).
  const [voiceLoaded, setVoiceLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Выбор не прочитан — строка причины и «Повторить» (CONTRACT6 G-FE
   * п. 10). Раньше карточка молча показывала «голос по умолчанию», хотя
   * клон мог быть уже выбран.
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    // Роестр грузится вместе с выбором: он не стоит денег (обычный
    // GET у провайдера) и нужен сразу — без него второй вариант
    // выглядел бы пустым местом.
    void Promise.all([
      getGreetingVoice(sessionId).catch((e: unknown) => ({ failed: e })),
      listGreetingPresetVoices(sessionId).catch(() => [] as GrokPresetVoice[]),
    ]).then(([v, list]) => {
      if (!alive) return;
      if ('failed' in v) {
        setLoadError(greetingErrorMessage(v.failed, dict));
      } else {
        setVoice(v);
        setVoiceLoaded(true);
      }
      setPresets(list);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- словарь: текст ошибки на момент сбоя
  }, [sessionId, attempt]);

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
      setLoadError(null);
      return null;
    } catch (e) {
      const message = greetingErrorMessage(e, dict);
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  const kind = senderVoiceKind(voice);
  const chosen = kind !== 'default';
  const sonioxVoice = voice.sonioxVoice ?? null;
  const presetName =
    presets?.find((p) => p.voiceId === voice.presetVoiceId)?.name ??
    voice.presetVoiceId;

  // Кнопки карточки и голос (K5) — одни и те же обработчики. Снятие гасит
  // только своё поле (S2-API), поэтому ключ — по тому, что выбрано.
  const clear = () =>
    apply(() =>
      kind === 'soniox'
        ? selectGreetingSonioxVoice(sessionId, null)
        : kind === 'preset'
          ? selectGreetingPresetVoice(sessionId, null)
          : selectGreetingSenderVoice(sessionId, null)
    );
  const pickClone = (voiceId: string) =>
    apply(() => selectGreetingSenderVoice(sessionId, voiceId));
  const pickPreset = (voiceId: string) =>
    apply(() => selectGreetingPresetVoice(sessionId, voiceId));
  /** `null` — «Голос Soniox по умолчанию» (выбран, но без голоса каталога). */
  const pickSoniox = (voiceId: string | null) =>
    apply(() => selectGreetingSonioxVoice(sessionId, { voiceId }));

  // ── Голоса Soniox (S2) ──
  // Каталог — отдельный запрос, а не часть `Promise.all` выше: его сбой не
  // должен гасить карточку, а голос по умолчанию выбирается и без списка.
  // `configured: false` — ключа Soniox на стенде нет: раздела нет вовсе
  // (так же объявлен хук `greeting-voice-soniox` — `absentWhen`).
  const [soniox, setSoniox] = useState<VoiceCatalogue | 'failed' | null>(null);
  useEffect(() => {
    let alive = true;
    setSoniox(null);
    getVoices(language, 'soniox')
      .then((c) => alive && setSoniox(c))
      .catch(() => alive && setSoniox('failed'));
    return () => {
      alive = false;
    };
  }, [language]);
  const sonioxList =
    soniox && soniox !== 'failed' && !soniox.error ? soniox.voices : [];
  const sonioxShown =
    soniox === 'failed' || (soniox !== null && soniox.configured);
  const sonioxNote =
    soniox === 'failed' || (soniox && soniox.error)
      ? s2.catalogFailed
      : soniox && sonioxList.length === 0
        ? s2.catalogEmpty
        : null;

  // Проба стоит денег и ограничена числом в сутки — по нажатию, как в
  // `VoicePicker`. Текст — короткая фраза на языке поздравления.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewAudio, setPreviewAudio] = useState<string | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const listen = async (voiceId: string | null) => {
    const key = voiceId ?? '';
    setPreviewing(key);
    setPreviewAudio(null);
    setPreviewNote(null);
    try {
      const r = await previewVoice(sonioxPreviewText(language), voiceId, {
        provider: 'soniox',
        language,
      });
      if (r.ok && r.audio) {
        setPreviewAudio(r.audio);
        setPreviewNote(
          s2.previewCount
            .replace('{used}', String(r.used))
            .replace('{limit}', String(r.limit))
        );
      } else {
        setPreviewNote(r.reason ?? s2.previewFailed);
      }
    } catch (e) {
      setPreviewNote(greetingErrorMessage(e, dict) || s2.previewFailed);
    } finally {
      setPreviewing(null);
    }
  };

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
      SESSION_VOICE_TARGETS.voiceSoniox,
      SESSION_VOICE_TARGETS.voiceCustom,
    ],
    describe: (f) =>
      (f.target === SESSION_VOICE_TARGETS.voicePreset
        ? presetList.find((p) => p.voiceId === f.value)?.name
        : f.target === SESSION_VOICE_TARGETS.voiceClone
          ? clones.find((c) => c.voiceId === f.value)?.label
          : f.target === SESSION_VOICE_TARGETS.voiceSoniox
            ? sonioxList.find((v) => v.voiceId === f.value)?.name
            : undefined) ?? describeSessionValue(f.value, dict.voiceFields),
    apply: (fields) => {
      if (lockText)
        return lockedFieldRefusals(fields, voiceTexts.refusedField, lockText);
      const plan = planVoiceChoice(
        {
          presets: presetList,
          clones,
          presetVoiceId: voice.presetVoiceId,
          cloneVoiceId: voice.senderVoice?.resembleVoiceId ?? null,
          // Голосом выбирается только голос, видимый в разделе Soniox.
          soniox: sonioxShown
            ? sonioxList.map((v) => ({ voiceId: v.voiceId, name: v.name }))
            : [],
          sonioxSelected: sonioxVoice !== null,
          sonioxVoiceId: sonioxVoice?.voiceId ?? null,
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
              : a?.kind === 'soniox'
                ? pickSoniox(a.voiceId)
                : null;
      if (!saving) return { refusals, effects: [] };
      // «Готово» — после ответа сервера, а не до него.
      return saving.then((err) => ({ refusals, effects: [saveEffect(err)] }));
    },
  });

  const summary = voiceSummary(
    voiceLoaded
      ? {
          senderLabel: voice.senderVoice?.label ?? null,
          presetName,
          soniox: sonioxVoice,
        }
      : null,
    w,
    s2
  );
  useEffect(() => {
    onSummary?.(summary);
  }, [onSummary, summary]);
  const reportedKind = voiceLoaded ? kind : null;
  useEffect(() => {
    onVoiceKind?.(reportedKind);
  }, [onVoiceKind, reportedKind]);

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
      {loadError && (
        <Alert tone="error" title={dict.greetingUi.cardLoadFailed}>
          <div className="flex items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button size="sm" variant="outline" onClick={retry}>
              {dict.greetingUi.cardRetryButton}
            </Button>
          </div>
        </Alert>
      )}

      <p
        className="text-xs text-silver-400"
        // Подпись своего голоса даёт человек («голос мамы») — маска
        // только тогда: строка по умолчанию — текст продукта, и
        // размывать её на кадре лендинга незачем.
        data-qa-mask={voice.senderVoice ? 'personal-voice-label' : undefined}
      >
        {voice.senderVoice
          ? w.senderVoicePicked.replace('{label}', voice.senderVoice.label)
          : voice.presetVoiceId
            ? w.presetVoicePicked.replace('{label}', presetName ?? '')
            : sonioxVoice
              ? sonioxVoice.voiceId
                ? s2.picked.replace(
                    '{label}',
                    sonioxVoice.label || sonioxVoice.voiceId
                  )
                : s2.pickedDefault
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

      {/* Третий путь (S2): голос каталога Soniox — путь как у клона, но
          без записи образца; ниже пресетов, потому что он для тех, кому
          не подошли ни свой голос, ни голоса модели. */}
      {sonioxShown && (
        <div className="mt-4 border-t border-silver-200/60 pt-3 dark:border-silver-800">
          <p className="text-sm font-medium">{s2.heading}</p>
          <p className="mt-0.5 text-xs text-silver-400">{s2.hint}</p>
          <ul
            className="mt-2 flex flex-wrap gap-2"
            data-qa="greeting-voice-soniox"
          >
            {[
              { voiceId: null, name: s2.defaultVoice },
              ...sonioxList.map((v) => ({
                voiceId: v.voiceId as string | null,
                name: v.accent ? `${v.name} · ${v.accent}` : v.name,
              })),
            ].map((v) => {
              const active =
                sonioxVoice !== null &&
                (sonioxVoice.voiceId ?? null) === v.voiceId;
              return (
                <li key={v.voiceId ?? ''} className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    active={active}
                    onClick={() => void pickSoniox(v.voiceId)}
                  >
                    {v.name}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Volume2 size={14} />}
                    aria-label={
                      v.voiceId
                        ? s2.listen.replace('{label}', v.name)
                        : s2.listenDefault
                    }
                    title={
                      v.voiceId
                        ? s2.listen.replace('{label}', v.name)
                        : s2.listenDefault
                    }
                    loading={previewing === (v.voiceId ?? '')}
                    disabled={previewing !== null}
                    onClick={() => void listen(v.voiceId)}
                  />
                </li>
              );
            })}
          </ul>
          {sonioxNote && (
            <p className="mt-1 text-xs text-silver-400">{sonioxNote}</p>
          )}
          {previewAudio && (
            <audio
              className="mt-2 w-full"
              controls
              autoPlay
              src={previewAudio}
            />
          )}
          {previewNote && (
            <p className="mt-1 text-xs text-silver-400">{previewNote}</p>
          )}
          {/* Пометка о субтитрах — под выбором Soniox, как в `VoicePicker`:
              пословного тайминга у Soniox нет, и титры встанут
              приблизительно. */}
          {sonioxVoice && (
            <p className="mt-1 text-xs text-silver-400">{s2.noWordTiming}</p>
          )}
        </div>
      )}
    </Card>
  );
}
