import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { LOCALES, fmt, formatDate, useAsync, useKit } from '../../kit';
import { Badge, Button, Card, Spinner, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { FaqInput, ModeKnowledgeClient } from '../../lib/knowledge-api';
import type { FaqView } from '../../lib/knowledge-types';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  textareaClass,
  type Notice,
} from './parts';
import { useErrorText } from '../../lib/use-error-text';

const STATUS_TONE = {
  active: 'success',
  needs_review: 'warning',
  archived: 'neutral',
} as const;

/**
 * Проверенные ответы режима (FAQ «Сайта» и FAQ «Админки» — разные
 * таблицы, §3.4). Ручные правки ответов из диалогов попадают сюда же
 * (их `origin` виден в карточке); в Э1 диалогов нет — правка = ответ,
 * добавленный или исправленный здесь.
 */
export function FaqTab({ client }: { client: ModeKnowledgeClient }) {
  const { dict, locale } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.faq;
  const errText = useErrorText();
  const faq = useAsync(() => client.faq(), [client]);
  const [editing, setEditing] = useState<FaqView | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function remove(f: FaqView) {
    setBusy(f.id);
    setNotice(null);
    try {
      await client.deleteFaq(f.id);
      setNotice({ tone: 'success', text: t.removed });
      faq.reload();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {editing ? (
        <FaqForm
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === 'new') await client.createFaq(input);
            else await client.patchFaq(editing.id, input);
            setEditing(null);
            setNotice({ tone: 'success', text: appDict.knowledge.saved });
            faq.reload();
          }}
        />
      ) : (
        <Button
          variant="outline"
          icon={<Plus size={16} />}
          onClick={() => setEditing('new')}
        >
          {t.add}
        </Button>
      )}
      {faq.loading && !faq.data ? (
        <Spinner label={dict.common.loading} />
      ) : !faq.data ? (
        <LoadError error={faq.error} onRetry={faq.reload} />
      ) : faq.data.length === 0 ? (
        <Card className="text-sm text-silver-500">{t.empty}</Card>
      ) : (
        <div className="space-y-2">
          {faq.data.map((f) => (
            <Card key={f.id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-start gap-2">
                <span className="font-semibold flex-1 min-w-0">
                  {f.question}
                </span>
                <Badge tone={STATUS_TONE[f.status]}>{t.status[f.status]}</Badge>
              </div>
              <div className="whitespace-pre-wrap">{f.answer}</div>
              {f.variants.length > 0 && (
                <div className="text-xs text-silver-500">
                  {f.variants.join(' · ')}
                </div>
              )}
              <div className="text-xs text-silver-500">
                {[
                  f.lang,
                  f.origin && fmt(t.origin, { origin: f.origin }),
                  formatDate(f.updatedAt, locale),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  icon={<Pencil size={16} />}
                  onClick={() => setEditing(f)}
                >
                  {t.edit}
                </Button>
                <ConfirmButton
                  variant="ghost"
                  loading={busy === f.id}
                  onConfirm={() => remove(f)}
                >
                  {t.remove}
                </ConfirmButton>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function FaqForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: FaqView | null;
  onSave: (input: FaqInput) => Promise<void>;
  onCancel: () => void;
}) {
  const { dict } = useKit();
  const { appDict } = useAssist();
  const t = appDict.knowledge.faq;
  const errText = useErrorText();
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [answer, setAnswer] = useState(initial?.answer ?? '');
  const [variants, setVariants] = useState(
    (initial?.variants ?? []).join('\n')
  );
  const [lang, setLang] = useState(initial?.lang ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function submit() {
    if (!question.trim() || !answer.trim()) {
      setNotice({ tone: 'warning', text: t.required });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await onSave({
        question: question.trim(),
        answer: answer.trim(),
        variants: variants
          .split('\n')
          .map((v) => v.trim())
          .filter(Boolean)
          // Не больше 10 формулировок (CreateFaqDto у K3).
          .slice(0, 10),
        lang: lang || null,
      });
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 text-sm">
      <NoticeBar notice={notice} />
      <label className="block space-y-1">
        <span className="font-medium">{t.question}</span>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="font-medium">{t.answer}</span>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={5000}
          className={textareaClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="font-medium">{t.variants}</span>
        <textarea
          value={variants}
          onChange={(e) => setVariants(e.target.value)}
          className={textareaClass}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="font-medium">{t.lang}</span>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          className="rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-2 py-1 min-h-[36px]"
        >
          <option value="">{t.langAuto}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button loading={busy} onClick={submit}>
          {t.save}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {dict.common.cancel}
        </Button>
      </div>
    </Card>
  );
}
