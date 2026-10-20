import './stories.css';

/**
 * Layout страницы Story‑Tales — ради одного: подключить `stories.css`
 * только сюда. Светлая «книжная» палитра не должна попасть в CSS
 * главной, поздравлений и обучалки (`globals.css` один на все площадки).
 *
 * `<html lang>` здесь НЕ рисуется: его рисует `[locale]/layout.tsx`
 * через `HtmlDocument` — тот же документ, что у остальных поддоменов
 * (`scripts/html-lang.test.ts`).
 *
 * Отдельный файл, а не импорт CSS в `page.tsx`, ещё и для тестов: страница
 * рендерится в `scripts/stories-page.test.ts` через `tsx`, которому
 * `.css` импортировать нечем.
 */
export default function StoriesLayout({ children }: { children: React.ReactNode }) {
  return children;
}
