import type { Metadata, Viewport } from 'next';
import './globals.css';
import { siteUrl } from '../lib/site-url';

// Корневой layout `<html>` не рисует — только пропускает детей (см.
// components/HtmlDocument.tsx). Здесь — общие для всех страниц стили,
// viewport и `metadataBase` (абсолютный адрес из SITE_URL).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1115' },
  ],
  colorScheme: 'light dark',
};

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
