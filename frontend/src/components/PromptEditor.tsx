import React, { useState, useEffect } from 'react';
import { CheckCircle2, Mic, Wand2 } from 'lucide-react';
import { GenerationPrompt } from '../types';
import { Alert, Badge, Button, Card, CardHeader, Field, Textarea } from './ui';
import { useI18n } from '../lib/i18n-context';

interface PromptEditorProps {
  prompt: GenerationPrompt | null;
  /**
   * Возвращает промис — и он ОБЯЗАН быть дождан перед утверждением:
   * правка и утверждение это два read-modify-write по одной сессии, и
   * параллельно они либо теряют правку, либо сбрасывают утверждение
   * (этап 37, А-2.4).
   */
  onUpdate: (
    editedText: string,
    voiceoverScript?: string
  ) => void | Promise<void>;
  onApprove: () => void | Promise<void>;
  isUpdating: boolean;
  isApproving: boolean;
  /**
   * Озвучиваем ли мы сами (§15.1). От этого зависит, показывать ли поле
   * с репликами: в режиме голоса Veo текст никуда не уходит, и лишнее
   * поле на экране только сбивает.
   */
  ownVoice?: boolean;
}

const MAX_PROMPT_LENGTH = 5000;
const MAX_SCRIPT_LENGTH = 5000;

/**
 * Восемь секунд — длина ролика, ~14 символов в секунду — темп спокойной
 * начитки. Предупреждение, а не запрет: пользователь вправе написать
 * длиннее, просто конец не поместится, и он должен об этом знать ДО
 * генерации, а не услышать обрезанную фразу после.
 */
const SPOKEN_CHARS_PER_SECOND = 14;
const CLIP_SECONDS = 8;

/**
 * PromptEditor — review/edit the generated Veo prompt. Spec §11 («Экран после генерации») reuses
 * this same editor for the post-generation audit's suggested fixes.
 */
export const PromptEditor: React.FC<PromptEditorProps> = ({
  prompt,
  onUpdate,
  onApprove,
  isUpdating,
  isApproving,
  ownVoice = false,
}) => {
  const { dict } = useI18n();
  const [editedText, setEditedText] = useState('');
  const [script, setScript] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [scriptChanged, setScriptChanged] = useState(false);

  // Initialize edited text when prompt loads
  useEffect(() => {
    if (prompt) {
      setEditedText(prompt.finalText);
      setScript(prompt.finalVoiceoverScript ?? '');
      setHasChanges(false);
      setScriptChanged(false);
    }
  }, [prompt]);

  if (!prompt) {
    return null;
  }

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value.length <= MAX_PROMPT_LENGTH) {
      setEditedText(value);
      setHasChanges(value !== prompt.finalText);
    }
  };

  const dirty = hasChanges || scriptChanged;

  const handleUpdate = async () => {
    if (editedText.trim() && dirty) {
      await onUpdate(editedText, scriptChanged ? script : undefined);
      setHasChanges(false);
      setScriptChanged(false);
    }
  };

  const handleApprove = async () => {
    // Сначала сохранить правку, ДОЖДАТЬСЯ её, и только потом утверждать.
    //
    // До этапа 37 оба вызова уходили параллельно, и оба переписывали всю
    // сессию по прочитанному состоянию. Исходов было два, и оба плохие:
    // либо в Veo уходил старый текст и правка пропадала молча, либо
    // сохранение записывалось последним и сбрасывало `approvedAt` — при
    // том, что интерфейс уже показал «Утверждён» и увёл на шаг
    // генерации, где кнопки «утвердить» нет. Тупик без выхода.
    if (dirty && editedText.trim()) {
      await onUpdate(editedText, scriptChanged ? script : undefined);
      setHasChanges(false);
      setScriptChanged(false);
    }
    await onApprove();
  };

  const spokenSeconds =
    Math.round((script.trim().length / SPOKEN_CHARS_PER_SECOND) * 10) / 10;

  const isFlagged = prompt.moderationStatus === 'flagged';
  const isApproved = prompt.approvedAt !== undefined;

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<Wand2 size={18} className="text-accent" />}
        title={dict.promptEditor.title}
        hint={dict.promptEditor.hint}
        action={
          isApproved && (
            <Badge tone="success">
              <CheckCircle2 size={10} /> {dict.promptEditor.approvedBadge}
            </Badge>
          )
        }
      />

      {isFlagged && (
        <Alert
          tone="warning"
          title={dict.promptEditor.moderationTitle}
          className="mb-4"
        >
          <p>{dict.promptEditor.moderationBody}</p>
          <ul className="mt-1 list-inside list-disc">
            {prompt.moderationFlags?.map((flag, index) => (
              <li key={index} className="capitalize">
                {flag.replace('-', ' ')}
              </li>
            ))}
          </ul>
          <p className="mt-1">{dict.promptEditor.moderationHint}</p>
        </Alert>
      )}

      <Field
        label={dict.promptEditor.promptLabel}
        htmlFor="promptText"
        hint={editedText.trim() ? undefined : dict.promptEditor.promptEmpty}
        counter={`${editedText.length}/${MAX_PROMPT_LENGTH}`}
      >
        <Textarea
          id="promptText"
          value={editedText}
          onChange={handleTextChange}
          disabled={isUpdating || isApproving}
          rows={9}
          className="font-mono text-xs"
          placeholder={dict.promptEditor.promptPlaceholder}
        />
      </Field>

      {/* §15.2: реплики — отдельный текст для отдельного читателя.
          Показываем только когда озвучиваем мы: в режиме голоса Veo это
          поле никуда не ведёт. */}
      {ownVoice && (
        <div className="mt-4">
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                <Mic size={13} className="text-accent" />{' '}
                {dict.promptEditor.voiceoverLabel}
              </span>
            }
            htmlFor="voiceoverScript"
            hint={
              script.trim()
                ? spokenSeconds > CLIP_SECONDS
                  ? dict.promptEditor.voiceoverTooLong
                      .replace('{{seconds}}', String(spokenSeconds))
                      .replace('{{clipSeconds}}', String(CLIP_SECONDS))
                  : dict.promptEditor.voiceoverFits
                      .replace('{{seconds}}', String(spokenSeconds))
                      .replace('{{clipSeconds}}', String(CLIP_SECONDS))
                : dict.promptEditor.voiceoverHintEmpty
            }
            counter={`${script.length}/${MAX_SCRIPT_LENGTH}`}
          >
            <Textarea
              id="voiceoverScript"
              value={script}
              onChange={(e) => {
                const value = e.target.value;
                if (value.length <= MAX_SCRIPT_LENGTH) {
                  setScript(value);
                  setScriptChanged(
                    value !== (prompt.finalVoiceoverScript ?? '')
                  );
                }
              }}
              disabled={isUpdating || isApproving}
              rows={4}
              placeholder={dict.promptEditor.voiceoverPlaceholder}
            />
          </Field>
          {prompt.voiceoverScriptSource === 'dialogue' && (
            <p className="mt-1 text-xs text-silver-400">
              {dict.promptEditor.voiceoverFromDialogue}
            </p>
          )}
        </div>
      )}

      {prompt.userEditedText && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-accent hover:underline">
            {dict.promptEditor.showOriginal}
          </summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-silver-200/60 dark:border-silver-800 bg-silver-100/60 dark:bg-silver-950/60 p-3 font-mono text-xs text-silver-600 dark:text-silver-300">
            {prompt.generatedText}
          </pre>
        </details>
      )}

      <div className="mt-4 flex gap-2">
        {dirty && (
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => void handleUpdate()}
            loading={isUpdating}
            disabled={isUpdating || !editedText.trim() || isApproving}
          >
            {dict.promptEditor.saveEdits}
          </Button>
        )}
        <Button
          className="flex-1"
          onClick={() => void handleApprove()}
          loading={isApproving}
          disabled={isApproving || isUpdating || !editedText.trim()}
        >
          {isFlagged
            ? dict.promptEditor.approveAnyway
            : isApproved && !dirty
              ? // Вернулись на этот шаг по степперу (этап 52, В-1.5) на
                // уже утверждённый, без правок промпт — раньше кнопка тут
                // становилась disabled с той же надписью, что и бейдж
                // «Утверждён», и продолжить со шага можно было только
                // малозаметным кликом по кружку степпера дальше
                // (Stepper.tsx красит его как обычный будущий шаг, хотя
                // он уже кликабелен). Теперь кнопка остаётся рабочей:
                // повторное утверждение бесплатно и идемпотентно
                // (PromptService.approvePrompt — только новый
                // `approvedAt`), и уводит на шаг генерации ролика тем же
                // путём, что и первое утверждение.
                dict.promptEditor.continueApproved
              : dict.promptEditor.approve}
        </Button>
      </div>

      <p className="mt-3 text-center text-xs text-silver-400">
        {dict.promptEditor.footerNote}
      </p>
    </Card>
  );
};
