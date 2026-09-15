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
 */

import { useState } from 'react';
import { Mic2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Field,
  Textarea,
} from '../../components/ui';
import { VoicePicker } from '../brand/VoicePicker';
import { errorMessage, updateBrandSnapshot } from '../../services/projects-api';
import { usesOwnVoice } from '../../lib/voice-mode';
import { useI18n } from '../../lib/i18n-context';
import type { BrandManifestSnapshot } from '../../types';
import type { GeneratedVideo } from '../../services/api';

const MAX_SCRIPT_LENGTH = 5000;

export function RevoicePanel({
  sessionId,
  video,
  voiceoverScript,
  snapshot,
  onReVoice,
  onBrandUpdated,
}: {
  sessionId: string;
  video: GeneratedVideo;
  /** Текущий текст реплик — из `prompt.finalVoiceoverScript`/`voiceoverScript` на экране мастера. */
  voiceoverScript: string;
  snapshot: BrandManifestSnapshot | null;
  onReVoice: (voiceoverScript?: string) => Promise<GeneratedVideo>;
  onBrandUpdated: (s: BrandManifestSnapshot) => void;
}) {
  const { dict } = useI18n();
  const [script, setScript] = useState(voiceoverScript);
  const [ttsVoiceId, setTtsVoiceId] = useState(snapshot?.ttsVoiceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // §15.1: у Veo своей звуковой дорожки нет — голос вшит в сам рендер,
  // переозвучить без перегенерации нечего.
  if (!usesOwnVoice(video.voiceMode)) return null;
  // Постобработка (в т.ч. предыдущая переозвучка) уже идёт — новый запрос
  // лёг бы поверх неё же; кнопка вернётся, как только текущий проход
  // закончится (см. доккомментарий выше про общий опрос).
  if (video.postStatus === 'pending') return null;

  const onSubmit = async () => {
    if (!script.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const voiceChanged =
        ttsVoiceId.trim() !== (snapshot?.ttsVoiceId ?? '').trim();
      if (voiceChanged) {
        // Голос — своя, независимая правка снимка бренда (тот же
        // маршрут, что BrandSnapshotEditor), сохраняется первой: если
        // она провалится (например чужой клон), переозвучка со старым
        // голосом не запустится вовсе — не платим за то, что придётся
        // тут же переделывать.
        const nextSnapshot = await updateBrandSnapshot(sessionId, {
          ttsVoiceId: ttsVoiceId.trim() || null,
        });
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

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Mic2 size={18} className="text-accent" />}
        title={dict.revoicePanel.panelTitle}
        hint={dict.revoicePanel.panelHint}
      />

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

      <div className="mt-3">
        <VoicePicker
          value={ttsVoiceId}
          onChange={setTtsVoiceId}
          disabled={busy}
          voiceProvider={snapshot?.ttsProvider}
          sessionId={sessionId}
        />
      </div>

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
    </Card>
  );
}
