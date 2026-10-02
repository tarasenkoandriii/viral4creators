import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Breadcrumbs } from '../../../../../components/Breadcrumbs';
import { ClaimCard, ClaimSection } from '../../../../../components/Claim';
import { CodeBlock } from '../../../../../components/DocsArticle';
import { SiteChrome, StatusBanner } from '../../../../../components/SiteChrome';
import { assistEnv } from '../../../../../lib/assist-env';
import { claimStatus, isVisible } from '../../../../../lib/claims';
import { fmt } from '../../../../../lib/format';
import { getDictionary } from '../../../../../lib/get-dictionary';
import { locales, type Locale } from '../../../../../lib/i18n';
import { embedTag, goalCall, gtmHtml, nextScript, spaInject, wordpressHook, webhookNodeExample } from '../../../../../lib/install';
import { href, hrefLang, pageMetadata } from '../../../../../lib/pages';
import { PLATFORMS, platform, type InstallCode, type PlatformSlug } from '../../../../../lib/platforms';

/**
 * Страница платформы (Л5, §3.7): шаги, код (из `lib/install.ts`, сверен с
 * продуктом), подтверждение хоста (на хостах публичных платформ — только
 * DNS своего домена), CSP, как проверена инструкция. Плагин/пакет, которых
 * ещё нет в открытом доступе, — `soon` без кода и ссылок.
 */
export function generateStaticParams() {
  return locales.flatMap((locale) => PLATFORMS.map((p) => ({ locale, platform: p.slug })));
}
export const dynamicParams = false;

export function generateMetadata({ params }: { params: { locale: Locale; platform: string } }): Metadata {
  const p = platform(params.platform);
  if (!p) return {};
  return pageMetadata(`integrations-${p.slug as PlatformSlug}`, params.locale);
}

export default function PlatformPage({ params }: { params: { locale: Locale; platform: string } }) {
  const { locale } = params;
  const p = platform(params.platform);
  if (!p || claimStatus(p.claim) === 'hidden' || claimStatus('integrations') === 'hidden') notFound();
  const slug = p.slug as PlatformSlug;
  const dict = getDictionary(locale);
  const ui = dict.platformUi;
  const d = dict.platforms[slug];
  const env = assistEnv();
  const code: Record<InstallCode, string> = {
    embed: embedTag(env.widgetOrigin),
    gtm: gtmHtml(env.widgetOrigin),
    wordpress: wordpressHook(env.widgetOrigin),
    next: nextScript(env.widgetOrigin),
    spa: spaInject(env.widgetOrigin),
    goal: goalCall(),
    webhook: webhookNodeExample(`${env.apiOrigin}/assist/v1/sites/SITE_ID/goal-events`),
  };
  const codeClaim: Record<InstallCode, string> = {
    embed: 'install-snippet',
    gtm: 'install-guides',
    wordpress: 'install-guides',
    next: 'install-guides',
    spa: 'install-guides',
    goal: 'goal-stats',
    webhook: 'goal-webhook',
  };
  const key = `integrations-${slug}` as const;
  return (
    <SiteChrome locale={locale} path={`/assistant/integrations/${slug}`} current="integrations">
      <StatusBanner locale={locale} />
      <Breadcrumbs locale={locale} current={key} />
      <section className="hero wrap">
        <h1>{d.heading}</h1>
        <p className="lead">{fmt(d.lead)}</p>
        <p className="note" data-checked={p.checked}>
          {p.checked === 'stand' ? ui.checkedStand : ui.checkedDocs}
        </p>
      </section>

      <ClaimSection claim={p.claim} dict={dict} heading={ui.stepsHeading} headingId="pl-steps" className="section wrap">
        <ol className="steps-plain">
          {d.steps.map((s) => (
            <li key={s}>{fmt(s)}</li>
          ))}
        </ol>
        {p.code
          .filter((c) => isVisible(codeClaim[c] as Parameters<typeof isVisible>[0]))
          .map((c) => (
            <div key={c} className="code-group">
              <h3>{ui.code[c]}</h3>
              <CodeBlock code={code[c]} label={ui.code[c]} />
            </div>
          ))}
        <p className="note">{ui.keyNote}</p>
      </ClaimSection>

      <section className="section section-alt" aria-labelledby="pl-notes">
        <div className="wrap">
          <h2 id="pl-notes">{ui.notesHeading}</h2>
          <ul className="list-claims">
            <ClaimCard as="li" claim="ownership-verification" dict={dict} text={'publicSuffix' in p && p.publicSuffix ? fmt(ui.verifyDnsOnly, { suffix: p.publicSuffix }) : ui.verifyAny} />
            {d.notes.map((n) => (
              <ClaimCard key={n} as="li" claim={p.claim} dict={dict} text={fmt(n)} />
            ))}
            <ClaimCard as="li" claim="install-snippet" dict={dict} text={ui.csp} />
          </ul>
          {'extra' in p && p.extra && (
            <ClaimCard as="div" className="card" claim={p.extra} dict={dict} title={ui.extra[p.extra as 'wp-plugin' | 'npm-package'].title} text={ui.extra[p.extra as 'wp-plugin' | 'npm-package'].text} />
          )}
          {isVisible('docs') && (
            <p className="claim-cta">
              <a href={href(locale, 'docs')} hrefLang={hrefLang(locale, 'docs')} data-cta="docs">
                {ui.docsLink}
              </a>{' '}
              ·{' '}
              <a href={href(locale, 'integrations')}>{ui.back}</a>
            </p>
          )}
        </div>
      </section>
    </SiteChrome>
  );
}
