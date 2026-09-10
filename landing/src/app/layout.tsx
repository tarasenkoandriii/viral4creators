import './globals.css';

// Настоящий корневой layout (единственный <html>/<body> на всё
// приложение — так требует App Router). После этапа 55 он намеренно
// минимален: заголовок/описание/OG переехали в app/[locale]/layout.tsx
// (там они зависят от языка), а /legal/* и другие пути вне [locale]
// используют этот же корень напрямую, с русским `lang` по умолчанию —
// правовые документы (см. middleware.ts) остаются на одном языке
// независимо от локали интерфейса.
export const viewport = {
  themeColor: '#0b0b0d',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
