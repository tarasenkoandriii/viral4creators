/**
 * AI Publisher (P-R, M2) — части студии: ошибка M2 словами
 * (`describeStudioError`), безопасный предпросмотр подмножества Reddit-
 * markdown (React-узлы из дерева `parseMarkdownSubset` — без HTML, ссылок и
 * картинок; пометка «приблизительно»), счётчик слов, блок копирования
 * ровно переданной строки (`copyText` кита: Clipboard API или запасной путь
 * WebView Telegram).
 */
import { useState, type ReactNode } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { copyText } from '../../../kit';
import { Alert, Button } from '../../../kit/ui';
import {
  describeStudioError,
  parseMarkdownSubset,
  wordCount,
  type MdInline,
} from '../../../lib/publisher/reddit-studio-view';
import { fmtText } from '../../../lib/publisher/view';
import { useReddit } from './reddit-hooks';

export function StudioErrorAlert({
  error,
  onReload,
  statusLabels,
}: {
  error: unknown;
  onReload?: () => void;
  statusLabels?: Record<string, string>;
}) {
  const { t, r } = useReddit();
  if (!error) return null;
  const v = describeStudioError(error, t, r, statusLabels);
  return (
    <Alert tone={v.conflict ? 'warning' : 'danger'} title={v.title}>
      {v.lines.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5">
          {v.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {v.conflict && (
        <div className="mt-2">
          <Button
            variant="outline"
            icon={<RefreshCw size={16} />}
            onClick={onReload ?? (() => window.location.reload())}
          >
            {t.common.reload}
          </Button>
        </div>
      )}
    </Alert>
  );
}

function Inline({ c }: { c: MdInline[] }) {
  return (
    <>
      {c.map((x, i) =>
        x.t === 'strong' ? (
          <strong key={i}>{x.v}</strong>
        ) : x.t === 'em' ? (
          <em key={i}>{x.v}</em>
        ) : x.t === 'code' ? (
          <code
            key={i}
            className="rounded bg-silver-100 dark:bg-silver-900 px-1 text-[0.85em]"
          >
            {x.v}
          </code>
        ) : (
          <span key={i}>{x.v}</span>
        )
      )}
    </>
  );
}

/**
 * Предпросмотр: только React-текст (никакого `dangerouslySetInnerHTML`),
 * ссылки/картинки/HTML остаются буквальным текстом.
 */
export function MarkdownPreview({ text }: { text: string }) {
  const { r } = useReddit();
  const blocks = parseMarkdownSubset(text);
  return (
    <div className="space-y-1">
      <div className="text-xs text-silver-500">{r.studio.preview.note}</div>
      <div
        data-reddit-preview=""
        tabIndex={0}
        role="region"
        aria-label={r.studio.preview.title}
        className="rounded-lg border border-silver-200 dark:border-silver-800 px-3 py-2 text-sm space-y-2 break-words max-h-96 overflow-auto whitespace-pre-wrap"
      >
        {blocks.map((b, i) =>
          b.t === 'p' ? (
            <p key={i}>
              <Inline c={b.c} />
            </p>
          ) : b.t === 'quote' ? (
            <blockquote
              key={i}
              className="border-l-4 border-silver-300 dark:border-silver-700 pl-3 text-silver-600 dark:text-silver-300"
            >
              <Inline c={b.c} />
            </blockquote>
          ) : b.t === 'ul' ? (
            <ul key={i} className="list-disc pl-5">
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline c={it} />
                </li>
              ))}
            </ul>
          ) : (
            <ol key={i} className="list-decimal pl-5">
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline c={it} />
                </li>
              ))}
            </ol>
          )
        )}
      </div>
    </div>
  );
}

export function WordCount({ text }: { text: string }) {
  const { r } = useReddit();
  const w = wordCount(text);
  return (
    <div className="text-xs text-silver-500" aria-live="polite">
      {fmtText(r.studio.draft.words, { words: w.words, chars: w.chars })}
    </div>
  );
}

/** Текст как есть (`<pre>`) + кнопка, копирующая РОВНО эту строку. */
export function CopyBlock({
  label,
  text,
  buttonLabel,
}: {
  label: ReactNode;
  text: string;
  buttonLabel: string;
}) {
  const { r } = useReddit();
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-silver-500 flex-1 min-w-0">{label}</span>
        <Button
          variant="outline"
          icon={state === 'ok' ? <Check size={16} /> : <Copy size={16} />}
          onClick={async () => setState((await copyText(text)) ? 'ok' : 'fail')}
        >
          {state === 'ok' ? r.studio.copy.copied : buttonLabel}
        </Button>
      </div>
      {state === 'fail' && <Alert tone="warning">{r.studio.copy.failed}</Alert>}
      <pre
        data-reddit-approved=""
        tabIndex={0}
        role="region"
        aria-label={typeof label === 'string' ? label : r.common.textRegion}
        className="text-sm whitespace-pre-wrap break-words font-sans rounded-lg bg-silver-100 dark:bg-silver-950 px-3 py-2 max-h-96 overflow-auto select-all"
      >
        {text}
      </pre>
    </div>
  );
}
