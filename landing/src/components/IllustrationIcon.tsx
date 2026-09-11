import Image from 'next/image';

/**
 * Общий line-art SVG icon-chip для лендинга — этап 79 ввёл его для
 * блок-схемы «Как это работает», следующий шаг того же стиля вынес его
 * в отдельный компонент, чтобы `#features` переиспользовал ровно то же
 * самое, а не завёл свою копию. Файлы — `landing/public/illustrations/
 * <name>.svg` (`feature-1`…`feature-9`, `how-step-1`…`how-step-9`, часть
 * имён физически совпадает по содержимому — см. `doc/LANDING-
 * ILLUSTRATIONS-BRIEF.md` §2–§3).
 *
 * `unoptimized` — Next.js image-оптимизатор по умолчанию отказывается
 * отдавать SVG без `dangerouslyAllowSVG` в `next.config.js`; заводить
 * это ради полутора десятков маленьких иконок избыточно, точечный обход
 * на уровне конкретной картинки — рекомендованный Next.js путь именно
 * для локальных статических SVG.
 */
export function IllustrationIcon({ name, size }: { name: string; size: number }) {
  return (
    <Image src={`/illustrations/${name}.svg`} alt="" width={size} height={size} unoptimized />
  );
}
