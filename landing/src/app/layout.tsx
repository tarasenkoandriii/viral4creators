import './globals.css';

// Корневой layout (его требует App Router) — НЕ рисует `<html>`/`<body>`,
// только пропускает детей. Язык документа ему неизвестен: сегмента
// `[locale]` у корня нет, а чтение заголовка от middleware (`headers()`)
// сделало бы динамическими все статические страницы лендинга. `<html>`
// рисуют layout'ы, которые язык знают, — через `components/HtmlDocument`
// (там же список, кто именно). Любая новая страница вне `[locale]` обязана
// попасть под один из них — это стережёт `scripts/html-lang.test.ts`.
//
// Заголовок/описание/OG — в app/[locale]/layout.tsx (они зависят от
// языка). Здесь остаются только общие для всех страниц стили и viewport.
export const viewport = {
  themeColor: '#0b0b0d',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
