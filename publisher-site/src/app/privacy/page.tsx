import type { Metadata } from 'next';
import { getSiteConfig } from '@/lib/api';
import { dict, fmt } from '@/lib/dict';
import { Markdown } from '@/lib/markdown';
import { pageMetadata } from '@/lib/page-meta';
import { siteHost } from '@/lib/site-url';

/**
 * Уведомление о данных (§13.2): текст и версия — параметр
 * `data_notice_version` из site-config; не утверждён — пометка «чернетка»;
 * нет — честная строка. Текст не пишется в коде сайта.
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata('/privacy', dict.meta.privacyTitle, dict.meta.privacyDescription);
}

export default async function Privacy() {
  const cfg = await getSiteConfig();
  const n = cfg.dataNotice;
  const t = dict.privacy;
  return (
    <article className="page">
      <h1>{dict.meta.privacyTitle}</h1>
      {n?.text?.trim() ? (
        <>
          {n.version ? <p className="meta">{fmt(t.version, { version: n.version })}</p> : null}
          {!n.approved ? (
            <p className="badge" data-testid="notice-draft">
              {t.draft}
            </p>
          ) : null}
          <div className="prose">
            <Markdown source={n.text} options={{ siteHost: siteHost() }} />
          </div>
        </>
      ) : (
        <p className="pending">{t.missing}</p>
      )}
    </article>
  );
}
