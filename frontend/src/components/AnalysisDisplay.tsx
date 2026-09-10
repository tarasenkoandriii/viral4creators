import { useState, useEffect } from 'react';
import { ScanSearch, X } from 'lucide-react';
import { Badge, Busy, Button, Card, CardHeader, Textarea } from './ui';
import { hasMatches, highlightLines } from '../lib/highlight';
import { useI18n } from '../lib/i18n-context';

interface AnalysisDisplayProps {
  analysisText: string;
  isAnalyzing: boolean;
  /** Сохраняет правку на сервере; сам переводит мастер на следующий шаг. */
  onEdit: (editedText: string) => Promise<void>;
  onSave: () => void;
  /**
   * Активный фильтр из чипов персонажей / сцен / массовки (spec §19):
   * его строки подсвечиваются, остальные приглушаются.
   */
  highlight?: {
    label: string;
    terms: string[];
    exact: string[];
    onClear: () => void;
  } | null;
  /** Разбор пришёл из библиотеки, а не свежим вызовом Gemini (§21). */
  fromLibrary?: boolean;
}

/**
 * AnalysisDisplay Component
 *
 * Displays video analysis results with editing capability
 */
export function AnalysisDisplay({
  analysisText,
  isAnalyzing,
  onEdit,
  onSave,
  highlight = null,
  fromLibrary = false,
}: AnalysisDisplayProps) {
  const { dict } = useI18n();
  const [editedText, setEditedText] = useState(analysisText);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditedText(analysisText);
  }, [analysisText]);

  // Этап 48 (В-5.4): раньше правка уходила без await, а мастер
  // переключался на следующий шаг сразу — при отказе сервера пользователь
  // был уже на «Товаре», правки не было нигде, и генерация шла по
  // неотредактированному разбору. Ждём ответа; шаг переключает сам
  // `onEdit` — только после успеха.
  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onEdit(editedText);
      setIsEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setEditedText(analysisText);
    setIsEditing(false);
  };

  const text =
    typeof analysisText === 'string'
      ? analysisText
      : JSON.stringify(analysisText, null, 2);
  const lines = highlight
    ? highlightLines(text, highlight.terms, highlight.exact)
    : [];
  const matched = hasMatches(lines);

  if (isAnalyzing) {
    return (
      <Card className="p-5">
        <CardHeader
          icon={<ScanSearch size={18} className="text-accent" />}
          title={dict.analysisDisplay.title}
        />
        <Busy
          title={dict.analysisDisplay.analyzing}
          hint={dict.analysisDisplay.analyzingHint}
        />
      </Card>
    );
  }

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<ScanSearch size={18} className="text-accent" />}
        title={dict.analysisDisplay.title}
        hint={
          fromLibrary
            ? dict.analysisDisplay.hintFromLibrary
            : dict.analysisDisplay.hint
        }
        action={
          !isEditing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsEditing(true)}
            >
              {dict.analysisDisplay.edit}
            </Button>
          )
        }
      />

      {isEditing ? (
        <div className="space-y-3">
          <Textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            className="font-mono text-xs h-80"
            placeholder={dict.analysisDisplay.placeholder}
            aria-label={dict.analysisDisplay.placeholder}
            disabled={saving}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={handleCancel} disabled={saving}>
              {dict.analysisDisplay.cancel}
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {dict.analysisDisplay.save}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {highlight && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone="accent">{dict.analysisDisplay.filter}</Badge>
              <span className="min-w-0 truncate font-medium">
                {highlight.label}
              </span>
              {!matched && (
                <span className="text-silver-400">
                  — {dict.analysisDisplay.noMatches}
                </span>
              )}
              <button
                type="button"
                onClick={highlight.onClear}
                aria-label={dict.analysisDisplay.clearFilterLabel}
                className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-silver-400 hover:text-accent"
              >
                <X size={12} /> {dict.analysisDisplay.clearFilter}
              </button>
            </div>
          )}
          <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl border border-silver-200/60 dark:border-silver-800 bg-silver-100/60 dark:bg-silver-950/60 p-4 text-left font-mono text-xs leading-relaxed text-silver-700 dark:text-silver-300">
            {highlight && matched
              ? lines.map((line, i) => (
                  <span
                    key={i}
                    className={
                      line.match
                        ? 'block rounded bg-accent/15 px-1 text-silver-900 dark:text-silver-100'
                        : 'block px-1 opacity-40'
                    }
                  >
                    {line.text || '\u00a0'}
                  </span>
                ))
              : text}
          </pre>
          {!isAnalyzing && analysisText && (
            <Button block onClick={onSave}>
              {dict.analysisDisplay.next}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
