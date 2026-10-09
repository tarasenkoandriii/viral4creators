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
  // data-scroll-behavior: в globals.css у <html> плавная прокрутка; с этим
  // атрибутом Next 15.5+ по-прежнему выключает её на время переходов между
  // маршрутами (без него — предупреждение, а в Next 16 — перестанет).
  return (
    <html lang="ru" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
