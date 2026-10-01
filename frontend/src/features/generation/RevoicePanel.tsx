/**
 * RevoicePanel — переозвучить уже готовый ролик БЕЗ повторного платного
 * рендера у Veo/Grok (доп. запрос владельца продукта, этап 87: «в
 * постпродакшене переозвучить готовый ролик без перегенерации»).
 * Показывается на экране готового ролика, рядом с ExportPanel.
 *
 * Меняет то же самое, что уже было в мастере ДО генерации — текст реплик
 * (тот же смысл, что поле в PromptEditor) и голос (тот же VoicePicker,
 * что в BrandSnapshotEditor) — но здесь это применяется к уже снятому
 * ролику: сервер пересобирает крой+голос+субтитры одной задачей ffmpeg
 * заново от НЕОБРАБОТАННОГО исходника (`renderedUrl`), не трогая сам
 * Veo/Grok рендер.
 *
 * Своего опроса статуса не заводит: `useWorkflow.reVoice()` уже
 * запускает общий `startVideoPolling` (тот же канал, что опрашивает
 * рендер и первую постобработку) — как только `postStatus` вернётся к
 * `'complete'`/`'failed'`, это придёт сюда обычным пропом `video`.
 *
 * Этап 91 (доп. запрос владельца продукта): «кнопку пред-прослушать по
 * выбранным параметрам — причём способ переозвучки можно выбрать явно —
 * veo или eleven labs или resemble, и только если человеку подходит
 * тогда он жмёт переозвучить». Из трёх названных вариантов реальный
 * платный выбор — только `elevenlabs`/`resemble` (`ExplicitTtsProviderKey`
 * на бэкенде): `veo` там означает не провайдер синтеза, а «не озвучивать
 * вовсе» — гарантированный отказ у уже готового `voiceover`/`dub`
 * ролика, а не «оставить голос как есть» (переозвучка всегда пересобирает
 * дорожку заново из НЕОБРАБОТАННОГО исходника, слоя поверх старой
 * дорожки нет — см. шапку файла и `postprod.service.ts`). «Оставить как
 * есть» здесь — третий пункт селектора ниже (`providerCurrent`), который
 * просто НЕ передаёт явный провайдер: тогда всё ведёт себя так же, как
 * до этого этапа (свой клон → всегда Resemble, иначе — активный на
 * стенде провайдер, см. `applySnapshotEdit`).
 *
 * Явный выбор ElevenLabs/Resemble передаётся насквозь — в каталог и
 * пробу голоса (`VoicePicker`'s `providerOverride`, тот же приём, что
 * уже даёт бэкенд `/tts/voices`/`/tts/preview`), в само сохранение тега
 * (`updateBrandSnapshot`'s `ttsProvider`, новое поле DTO) и, значит, в
 * РЕАЛЬНЫЙ платный синтез при нажатии «Переозвучить»
 * (`postprod.service.ts` теперь зовёт именно тегированный провайдер, а
 * не сверяет его с платформенным дефолтом) — предпрослушка ниже
 * показывает ровно то, что получится после оплаты, а не другой голос.
 *
 * Контракт S-FE (Soniox): Soniox — третий явный провайдер, и ему голос
 * выбирать не обязательно — пустой voiceId сохраняется как
 * `ttsProvider: 'soniox', ttsVoiceId: null` («голос Soniox по
 * умолчанию») и так же прослушивается (`hasSynthesisVoice`).
 *
 * Поздравление (`greetingVoice` не `null`, см. lib/revoice-greeting-voice):
 * брендбука у него нет, и `PATCH brand-manifest` отвечал 404 на любую
 * смену голоса. Голос поздравления живёт в снимке брифа и меняется в
 * мастере поздравления — поэтому здесь ни провайдера, ни голоса не
 * выбираем: подпись текущего голоса, ссылка в мастер и переозвучка тем
 * же голосом (реплики править можно — `reVoice()` их принимает).
 */

import { useState } from 'react';
import { ArrowRight, Mic2, Volume2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Field,
  Select,
  Textarea,
} from '../../components/ui';
import { VoicePicker } from '../brand/VoicePicker';
import {
  errorMessage,
  previewVoice,
  updateBrandSnapshot,
} from '../../services/projects-api';
import type { RevoiceBlock } from '../../lib/revoice-eligibility';
import {
  greetingVoiceCaption,
  type GreetingRevoiceVoice,
} from '../../lib/revoice-greeting-voice';
import { navigate } from '../../lib/router';
import { revoiceSnapshotPatch } from '../../lib/revoice-snapshot-patch';
import { useI18n } from '../../lib/i18n-context';
import type { BrandManifestSnapshot, VoiceMode } from '../../types';
import type { GeneratedVideo } from '../../services/api';
import {
  effectiveProvider as resolveEffectiveProvider,
  hasSynthesisVoice,
  type ExplicitTtsProvider,
} from '../../lib/tts-provider-choice';

const MAX_SCRIPT_LENGTH = 5000;

type ExplicitProvider = ExplicitTtsProvider;

export function RevoicePanel({
  sessionId,
  video,
  voiceoverScript,
  snapshot,
  onReVoice,
  onBrandUpdated,
  block,
  greetingVoice = null,
  greetingWizardRoute = null,
}: {
  sessionId: string;
  video: GeneratedVideo;
  /** Текущий текст реплик — из `prompt.finalVoiceoverScript`/`voiceoverScript` на экране мастера. */
  voiceoverScript: string;
  snapshot: BrandManifestSnapshot | null;
  onReVoice: (voiceoverScript?: string) => Promise<GeneratedVideo>;
  onBrandUpdated: (s: BrandManifestSnapshot) => void;
  /** Почему переозвучка невозможна — `revoiceBlock()` (lib/revoice-eligibility),
   * тем же правилом отказывает сервер. Считает экран: панель не знает
   * про снимок брифа поздравления. */
  block: RevoiceBlock | null;
  /** Голос поздравления — `greetingRevoiceVoice()`; `null` — обычный ролик
   * с брендбуком, выбор провайдера и голоса как раньше. */
  greetingVoice?: GreetingRevoiceVoice | null;
  /** Маршрут мастера поздравления проекта (`routes.greetingVideo`);
   * `null` — проекта у сессии нет, ссылку заменяет подсказка. */
  greetingWizardRoute?: string | null;
}) {
  const { dict } = useI18n();
  const [script, setScript] = useState(voiceoverScript);
  const [ttsVoiceId, setTtsVoiceId] = useState(snapshot?.ttsVoiceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Этап 91: `null` — «как сейчас» (прежнее поведение, ничего не
  // переопределяет). Селектор ниже и «выбрать клон» в VoicePicker —
  // единственные два места, что его меняют.
  const [providerOverride, setProviderOverride] =
    useState<ExplicitProvider | null>(null);
  const [prelistenAudio, setPrelistenAudio] = useState<string | null>(null);
  const [prelistening, setPrelistening] = useState(false);
  const [prelistenNote, setPrelistenNote] = useState<string | null>(null);
  // Режим звука при переозвучке (01.10.2026, первая публикация в TikTok):
  // ролик Grok в режиме `voiceover` вышел с двумя голосами — модель
  // заговорила своим, а наш лёг поверх приглушённой дорожки. Режим жил
  // только в мастере ДО рендера, и у готового ролика исправить это было
  // нечем, кроме новой генерации. Здесь — тот же выбор, применяемый к
  // уже снятому ролику: `dub` заменяет голос модели, фон остаётся.
  const [voiceMode, setVoiceMode] = useState<VoiceMode>(
    snapshot?.voiceMode === 'dub' ? 'dub' : 'voiceover'
  );

  // §15.1: у Veo своей звуковой дорожки нет — голос вшит в сам рендер,
  // переозвучить без перегенерации нечего; панель не показываем вовсе,
  // как и раньше.
  if (block === 'veo-voice') return null;
  // П-8: без снимка брендбука выбор голоса некуда сохранить — раньше
  // человек выбирал провайдера и голос и только потом получал 404.
  // Гасим кнопку сразу и говорим почему, а не прячем панель молча:
  // иначе непонятно, куда пропала переозвучка у соседнего ролика.
  if (block === 'no-voice-settings') {
    return (
      <Card className="p-5 animate-fadeIn" data-qa="revoice-panel">
        <CardHeader
          icon={<Mic2 size={18} className="text-accent" />}
          title={dict.revoicePanel.panelTitle}
        />
        <Alert tone="info" className="mb-3">
          {dict.revoicePanel.blockedNoBrandSnapshot}
        </Alert>
        <Button block variant="solid" disabled icon={<Mic2 size={14} />}>
          {dict.revoicePanel.submitCta}
        </Button>
      </Card>
    );
  }
  // Постобработка (в т.ч. предыдущая переозвучка) уже идёт — новый запрос
  // лёг бы поверх неё же; кнопка вернётся, как только текущий проход
  // закончится (см. доккомментарий выше про общий опрос).
  if (video.postStatus === 'pending') return null;

  // Селектор сменил провайдера явно — старый voiceId принадлежал ДРУГОМУ
  // каталогу и после смены каталога ниже станет чужим идентификатором;
  // сброс форсирует выбрать голос заново из нового каталога. «Выбрать
  // клон» в VoicePicker намеренно НЕ ходит через эту функцию — там
  // voiceId и провайдер одним жестом синхронизируются сразу оба.
  const onProviderSelect = (p: ExplicitProvider | '') => {
    setProviderOverride(p || null);
    setTtsVoiceId('');
    setPrelistenAudio(null);
    setPrelistenNote(null);
  };

  // Этап 91: провайдер, который РЕАЛЬНО применится к этой переозвучке —
  // явный выбор, если он есть, иначе уже сохранённый на голосе тег
  // (тот же смысл, что читает `postprod.service.ts` при синтезе).
  // Именно им, не платформенным дефолтом, идёт предпрослушка ниже —
  // иначе она показывала бы не тот голос, что получится после оплаты.
  // Тот же провайдер получает и VoicePicker ниже (аудит S-FE).
  const effectiveProvider =
    resolveEffectiveProvider(providerOverride, snapshot?.ttsProvider) ??
    undefined;
  // Контракт S-FE: у Soniox свой голос по умолчанию — предпрослушка и
  // переозвучка без выбранного voiceId для него законны.
  const canPrelisten = hasSynthesisVoice(ttsVoiceId, effectiveProvider);

  const prelisten = async () => {
    if (!script.trim() || !canPrelisten || prelistening) return;
    setPrelistening(true);
    setPrelistenNote(null);
    setPrelistenAudio(null);
    try {
      const r = await previewVoice(script.trim(), ttsVoiceId.trim(), {
        provider: effectiveProvider,
      });
      if (r.ok && r.audio) {
        setPrelistenAudio(r.audio);
        setPrelistenNote(
          dict.voicePicker.previewCount
            .replace('{{used}}', String(r.used))
            .replace('{{limit}}', String(r.limit))
        );
      } else {
        setPrelistenNote(r.reason ?? dict.voicePicker.previewFailed);
      }
    } catch (e) {
      setPrelistenNote(errorMessage(e));
    } finally {
      setPrelistening(false);
    }
  };

  const onSubmit = async () => {
    if (!script.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Голос и режим звука — своя, независимая правка снимка бренда (тот
      // же маршрут, что BrandSnapshotEditor), сохраняется первой: если она
      // провалится (чужой клон, дубляж не по тарифу), переозвучка со
      // старыми настройками не запустится вовсе — не платим за то, что
      // придётся тут же переделывать. Этап 91: явный выбор провайдера
      // едет тем же запросом — без него сервер вывел бы тег сам (клон →
      // resemble, иначе активный на стенде). Поздравление: снимка бренда
      // нет — патча тоже (он и давал 404).
      const patch = revoiceSnapshotPatch({
        isGreeting: !!greetingVoice,
        snapshot,
        ttsVoiceId,
        providerOverride,
        voiceMode,
      });
      if (patch) {
        const nextSnapshot = await updateBrandSnapshot(sessionId, patch);
        onBrandUpdated(nextSnapshot);
      }
      await onReVoice(
        script.trim() !== voiceoverScript.trim() ? script.trim() : undefined
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const errorAlerts = (
    <>
      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {video.postStatus === 'failed' && video.postError && (
        <Alert tone="warning" className="mb-3">
          {video.postError}
        </Alert>
      )}
    </>
  );

  const scriptField = (
    <Field
      label={dict.revoicePanel.scriptLabel}
      htmlFor="revoice-script"
      counter={`${script.length}/${MAX_SCRIPT_LENGTH}`}
    >
      <Textarea
        id="revoice-script"
        value={script}
        onChange={(e) => {
          const value = e.target.value;
          if (value.length <= MAX_SCRIPT_LENGTH) setScript(value);
        }}
        disabled={busy}
        rows={4}
      />
    </Field>
  );

  const submitButton = (
    <>
      <Button
        block
        className="mt-3"
        variant="solid"
        loading={busy}
        disabled={busy || !script.trim()}
        icon={<Mic2 size={14} />}
        onClick={() => void onSubmit()}
      >
        {dict.revoicePanel.submitCta}
      </Button>
      <p className="mt-2 text-xs text-silver-400">
        {dict.revoicePanel.footerNote}
      </p>
    </>
  );

  // Поздравление: голос только называем и ведём в мастер, где он
  // выбирается; предпрослушки тоже нет — она прослушивает голос,
  // выбранный здесь, а выбирать здесь нечего.
  if (greetingVoice) {
    return (
      <Card className="p-5 animate-fadeIn" data-qa="revoice-panel">
        <CardHeader
          icon={<Mic2 size={18} className="text-accent" />}
          title={dict.revoicePanel.panelTitle}
          hint={dict.revoicePanel.panelHint}
        />
        {errorAlerts}
        {scriptField}
        <div className="mt-3 space-y-2">
          <p
            className="text-sm"
            // Подпись клона даёт человек («голос мамы») — маскируем только
            // её, как на шаге голоса в мастере поздравления.
            data-qa-mask={
              greetingVoice.kind === 'clone'
                ? 'personal-voice-label'
                : undefined
            }
          >
            {greetingVoiceCaption(greetingVoice, dict.revoicePanel)}
          </p>
          <p className="text-xs text-silver-400">
            {dict.revoicePanel.greetingVoiceHint}
          </p>
          {greetingWizardRoute ? (
            <Button
              block
              variant="outline"
              disabled={busy}
              icon={<ArrowRight size={14} />}
              onClick={() => navigate(greetingWizardRoute)}
            >
              {dict.revoicePanel.greetingChangeVoiceCta}
            </Button>
          ) : (
            <p className="text-xs text-silver-400">
              {dict.revoicePanel.greetingNoProjectHint}
            </p>
          )}
        </div>
        {submitButton}
      </Card>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn" data-qa="revoice-panel">
      <CardHeader
        icon={<Mic2 size={18} className="text-accent" />}
        title={dict.revoicePanel.panelTitle}
        hint={dict.revoicePanel.panelHint}
      />
      {errorAlerts}
      {scriptField}

      <Field
        label={dict.revoicePanel.modeLabel}
        htmlFor="revoice-mode"
        hint={
          voiceMode === 'dub'
            ? dict.voiceMode.hints.dub
            : dict.revoicePanel.modeVoiceoverHint
        }
      >
        <Select
          id="revoice-mode"
          value={voiceMode}
          onChange={(e) => setVoiceMode(e.target.value as VoiceMode)}
          disabled={busy}
        >
          <option value="voiceover">{dict.revoicePanel.modeVoiceover}</option>
          <option value="dub">{dict.revoicePanel.modeDub}</option>
        </Select>
      </Field>

      <Field
        label={dict.revoicePanel.providerLabel}
        htmlFor="revoice-provider"
        hint={dict.revoicePanel.providerHint}
      >
        <Select
          id="revoice-provider"
          value={providerOverride ?? ''}
          onChange={(e) =>
            onProviderSelect(e.target.value as ExplicitProvider | '')
          }
          disabled={busy}
        >
          <option value="">{dict.revoicePanel.providerCurrent}</option>
          <option value="elevenlabs">
            {dict.revoicePanel.providerElevenlabs}
          </option>
          <option value="resemble">{dict.revoicePanel.providerResemble}</option>
          <option value="soniox">{dict.revoicePanel.providerSoniox}</option>
        </Select>
      </Field>

      <div className="mt-3">
        <VoicePicker
          value={ttsVoiceId}
          onChange={(v) => {
            setTtsVoiceId(v);
            setPrelistenAudio(null);
            setPrelistenNote(null);
          }}
          disabled={busy}
          voiceProvider={snapshot?.ttsProvider}
          sessionId={sessionId}
          // Действующий провайдер, а не только явный выбор: сохранённый
          // тег снимка (например Soniox без голоса) должен определять
          // каталог, пункт «голос по умолчанию» и пометку о тайминге.
          providerOverride={effectiveProvider}
          onProviderOverrideChange={(p) =>
            setProviderOverride(p as ExplicitProvider | null)
          }
        />
      </div>

      <div className="mt-3 space-y-2">
        <Button
          block
          variant="outline"
          loading={prelistening}
          disabled={prelistening || !script.trim() || !canPrelisten}
          icon={<Volume2 size={14} />}
          onClick={() => void prelisten()}
        >
          {dict.revoicePanel.prelistenCta}
        </Button>
        {!canPrelisten && (
          <p className="text-xs text-silver-400">
            {dict.revoicePanel.prelistenHint}
          </p>
        )}
        {prelistenAudio && (
          <audio className="w-full" controls autoPlay src={prelistenAudio} />
        )}
        {prelistenNote && (
          <p className="text-xs text-silver-400">{prelistenNote}</p>
        )}
      </div>

      {submitButton}
    </Card>
  );
}
