import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import AltContact from '@/components/AltContact';
import Track from '@/components/Track';
import { PUBLISHER_BRAND } from '@/brand';
import { altContactOf, getSiteConfig } from '@/lib/api';
import { dict, fmt } from '@/lib/dict';
import { publisherEnv } from '@/lib/server-env';
import { siteUrl } from '@/lib/site-url';
import './globals.css';

/**
 * Каркас (§13.1): `<html lang="uk">`, шапка «кто оказывает услугу»,
 * подвал с уведомлением о данных и альтернативным контактом, трекер.
 * Режим `test` честно помечен баннером. Виджета помощника и сторонней
 * аналитики нет (P0).
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(siteUrl()),
    title: {
      default: `${PUBLISHER_BRAND.name} — ${PUBLISHER_BRAND.positioning}`,
      template: `%s — ${PUBLISHER_BRAND.name}`,
    },
    description: dict.meta.homeDescription,
    applicationName: PUBLISHER_BRAND.name,
    formatDetection: { telephone: false, email: false, address: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cfg = await getSiteConfig();
  const env = publisherEnv();
  const c = dict.chrome;
  const alt = altContactOf(cfg.altContact);
  return (
    <html lang={PUBLISHER_BRAND.lang}>
      <body>
        <a className="skip" href="#main">
          {c.skip}
        </a>
        <header className="site-header">
          <div className="wrap header-row">
            <p className="brand">
              <Link href="/">{PUBLISHER_BRAND.name}</Link>
              <span className="tagline">{PUBLISHER_BRAND.positioning}</span>
            </p>
            <nav aria-label={c.nav}>
              <ul>
                <li>
                  <Link href="/materials">{c.materials}</Link>
                </li>
                <li>
                  <Link href="/contact">{c.contact}</Link>
                </li>
              </ul>
            </nav>
          </div>
        </header>
        {cfg.mode !== 'live' ? (
          <p className="mode-banner" data-testid="mode-banner">
            <span className="wrap">{cfg.mode === 'test' ? c.testMode : c.closedMode}</span>
          </p>
        ) : null}
        <main id="main" className="wrap" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <div className="wrap">
            <p>
              {fmt(c.provider, { name: PUBLISHER_BRAND.name, positioning: PUBLISHER_BRAND.positioning.toLowerCase() })}
            </p>
            <AltContact value={alt} label={c.altContact} missing={c.altContactMissing} />
            <p>
              <Link href="/privacy">{c.dataNotice}</Link>
            </p>
          </div>
        </footer>
        <Track
          visits={{
            enabled: process.env.VERCEL_ENV === 'production',
            endpoint: 'https://backend-iota-ruddy-57.vercel.app/api/public/landing-visits',
            locale: PUBLISHER_BRAND.lang,
          }}
          apiOrigin={env.apiOrigin}
          publicKey={env.publicKey}
          analyticsStorage={cfg.analyticsStorage}
          consentState={cfg.consentState}
        />
      </body>
    </html>
  );
}
