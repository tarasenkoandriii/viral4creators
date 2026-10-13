import type { PublicContent } from '@/lib/api-types';

/**
 * Источники материала (§8.2): открытые — ссылкой (только https,
 * `rel="nofollow noopener"`), закрытые — строкой без ссылки.
 */
export default function Sources({
  sources,
  labels,
}: {
  sources: PublicContent['sources'];
  labels: { privateSource: string; untitled: string };
}) {
  return (
    <ol className="sources">
      {sources.map((s, i) => {
        if ('private' in s) return <li key={i}>{labels.privateSource}</li>;
        const title = s.title?.trim() || labels.untitled;
        const url = s.url && /^https:\/\/[^\s]+$/.test(s.url) ? s.url : null;
        return (
          <li key={i}>
            {url ? (
              <a href={url} rel="nofollow noopener">
                {title}
              </a>
            ) : (
              title
            )}
          </li>
        );
      })}
    </ol>
  );
}
