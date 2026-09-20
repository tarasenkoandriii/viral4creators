import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Витрина исполнителей — viral4creators',
  description:
    'Каталог creators и agencies, портфолио UGC-роликов и бриф на рекламу товара без тендера — Этап 0 маркетплейса viral4creators.',
};

/**
 * Минимальный корневой layout — только html/body и общие стили. Шапка с
 * навигацией живёт в [locale]/layout.tsx, а не здесь: встраиваемый виджет
 * портфолио (ТЗ §20 №5, src/app/embed/[id]/page.tsx) намеренно лежит ВНЕ
 * группы [locale] и должен рендериться без чужой шапки поверх iframe —
 * и без локали вообще (ТЗ §20 №15, см. lib/i18n.ts).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
