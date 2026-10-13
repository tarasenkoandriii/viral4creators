import { formatDate } from '@/lib/dict';

/** Ответственный редактор и даты публикации/существенного обновления (§8.2). */
export default function Byline({
  editor,
  publishedAt,
  updatedAt,
  labels,
}: {
  editor: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  labels: { editor: string; editorMissing: string; published: string; updated: string };
}) {
  const pub = formatDate(publishedAt);
  const upd = formatDate(updatedAt);
  return (
    <dl className="byline">
      <div>
        <dt>{labels.editor}</dt>
        <dd>{editor?.trim() || labels.editorMissing}</dd>
      </div>
      {pub ? (
        <div>
          <dt>{labels.published}</dt>
          <dd>
            <time dateTime={publishedAt ?? undefined}>{pub}</time>
          </dd>
        </div>
      ) : null}
      {upd ? (
        <div>
          <dt>{labels.updated}</dt>
          <dd>
            <time dateTime={updatedAt ?? undefined}>{upd}</time>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
