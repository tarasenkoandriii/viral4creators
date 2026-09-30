/**
 * Шаг 3 мастера поздравления — сценарий: сборка и правка текста.
 *
 * Вынесено из `GreetingVideoWizard.tsx` (файл перерос 3700 строк):
 * мастер держит только общий экран, степпер и загрузку сессии, а
 * каждый шаг живёт в своём файле, чтобы правка одного шага не
 * требовала листать остальные. Поведение и `data-qa` — без изменений.
 */

import { useState, useEffect } from 'react';
import { Check, Pencil, RefreshCw } from 'lucide-react';
import {
  Card,
  CardHeader,
  Alert,
  Field,
  Textarea,
  Button,
} from '../../../components/ui';
import { useI18n } from '../../../lib/i18n-context';
import { errorMessage } from '../../../services/projects-api';
import {
  updateGreetingScript,
  generateGreetingPrompt,
} from '../../../services/greeting-api';
import { type GenerationPrompt, ModerationStatus } from '../../../types';
import type { SessionScriptEditResult } from '../../../types/project';
import { HelpButton } from '../HelpSheet';
import {
  SESSION_VOICE_TARGETS,
  planScriptVoice,
  refusalLines,
  needsSave,
} from '../../../lib/voice-fields';
import {
  useVoiceFieldApplier,
  useVoiceCommand,
} from '../../voice/voice-commands';
import { useSessionVoiceTexts } from '../../voice/greeting-session-voice';

// ── Шаг 3: сценарий ───────────────────────────────────────────────────────

export function ScriptStep({
  sessionId,
  prompt,
  onGenerated,
  onEdited,
  videoDone,
}: {
  sessionId: string;
  prompt: GenerationPrompt | undefined;
  onGenerated: (p: GenerationPrompt) => void;
  onEdited: (r: SessionScriptEditResult) => void;
  /**
   * Ролик готов — «Пересобрать» скрыта: сценарий готового ролика на
   * месте не переписывается (сервер ответил бы 409). Правка текста при
   * этом доступна — она заводит новую версию.
   */
  videoDone: boolean;
}) {
  const { dict } = useI18n();
  const w = dict.greetingVideoWizard;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Этап C (§3.6 п.3): текст сообщения правится здесь же. Уходит только
   * реплика — сцену сервер пересобирает из неё сам, поэтому сцена и
   * озвучка не расходятся (Г-4).
   */
  const current = prompt?.finalVoiceoverScript ?? prompt?.voiceoverScript ?? '';
  const [text, setText] = useState(current);
  const [savingText, setSavingText] = useState(false);
  const [savedText, setSavedText] = useState(false);
  const [warning, setWarning] = useState(false);
  useEffect(() => {
    setText(current);
  }, [current]);

  const saveText = async () => {
    setSavingText(true);
    setError(null);
    setSavedText(false);
    setWarning(false);
    try {
      const r = await updateGreetingScript(sessionId, text.trim());
      // Своё переведённое предупреждение, а не русская строка сервера.
      setWarning(r.registerMismatch);
      setSavedText(true);
      onEdited(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSavingText(false);
    }
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      onGenerated(await generateGreetingPrompt(sessionId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  // Голос в поле правки (K5): ПОЛНЫЙ текст в то же поле, что `onChange`,
  // с тем же потолком; сохраняет человек той же кнопкой — сервер
  // проверит текст тем же путём правки (модерация, регистр, версия).
  // Во время пересборки — отказ: ответ сервера перезапишет поле.
  const voiceTexts = useSessionVoiceTexts();
  useVoiceFieldApplier({
    targets: [SESSION_VOICE_TARGETS.scriptText],
    describe: (f) => String(f.value),
    apply: (fields) => {
      const plan = planScriptVoice(!!prompt, loading || savingText, fields);
      if (plan.text !== undefined) {
        setText(plan.text);
        setSavedText(false);
      }
      return {
        refusals: refusalLines(plan.refused, fields, voiceTexts),
        effects: plan.text !== undefined ? [needsSave(w.saveScriptButton)] : [],
      };
    },
  });

  // Голосом «пересобери сценарий» (этап K3) — та же кнопка, что на
  // экране: карточка «я понял так» с действием, по «Да» — `generate`.
  // Сборка платная, поэтому молча не запускается. У готового ролика
  // кнопки нет — нет и команды (сервер ответил бы 409).
  useVoiceCommand(
    'regenerate-script',
    videoDone || loading
      ? null
      : {
          propose: () => ({
            kind: 'propose',
            card: {
              kind: 'action',
              command: 'regenerate-script',
              label: prompt ? w.regenerateScriptButton : w.generateScriptButton,
            },
          }),
          run: () => void generate(),
        }
  );

  return (
    <Card className="p-5" data-qa="greeting-script-card">
      <CardHeader
        title={w.scriptHeading}
        action={<HelpButton cardHook="greeting-script-card" />}
      />
      {error && <Alert tone="error">{error}</Alert>}
      {prompt ? (
        <div className="space-y-3">
          <Field
            label={w.editScriptLabel}
            hint={w.editScriptHint}
            counter={`${text.length}/2000`}
          >
            <Textarea
              data-qa="greeting-script-edit"
              rows={4}
              value={text}
              onChange={(e) => {
                setText(e.target.value.slice(0, 2000));
                setSavedText(false);
              }}
            />
          </Field>
          {prompt.moderationStatus === ModerationStatus.FLAGGED && (
            <Alert tone="error">{w.scriptFlaggedNote}</Alert>
          )}
          {warning && <Alert tone="warning">{w.scriptRegisterWarning}</Alert>}
          {savedText && !warning && (
            <Alert tone="success">
              <Check size={14} className="inline mr-1" />
              {w.scriptSavedNote}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={<Pencil size={14} />}
              loading={savingText}
              disabled={
                !text.trim() || text.trim() === current.trim() || loading
              }
              onClick={() => void saveText()}
            >
              {w.saveScriptButton}
            </Button>
            {!videoDone && (
              <Button
                variant="outline"
                size="sm"
                icon={<RefreshCw size={14} />}
                loading={loading}
                disabled={savingText}
                onClick={() => void generate()}
              >
                {w.regenerateScriptButton}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-silver-400">{w.scriptEmpty}</p>
          <Button
            data-qa="greeting-script-generate"
            loading={loading}
            onClick={() => void generate()}
          >
            {w.generateScriptButton}
          </Button>
        </div>
      )}
    </Card>
  );
}
