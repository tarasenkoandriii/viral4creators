import Link from 'next/link';
import { listGreetingShowcase } from '../lib/shared-video-api';
import { headingOf } from '../lib/shared-video-heading';
import { SITE_NAME, SITE_URL } from '../lib/content';
import { jsonLdScript } from '../lib/json-ld';
import type { Dictionary } from '../lib/get-dictionary';

/**
 * Витрина примеров (§5 docs-tz/TZ-Greeting-Video-Landing.md).
 *
 * Показывает ТОЛЬКО ролики, отмеченные оператором в витрину (этап 1:
 * `showcasedAt` на `SharedVideoPage`, эндпоинт
 * `GET /shared-video/showcase`). Не «всё опубликованное»: у человека,
 * опубликовавшего личное поздравление ссылкой, оно не должно оказаться
 * на маркетинговой странице без отдельного решения.
 *
 * Пустое состояние — секции нет вовсе, ни рамки, ни «скоро здесь
 * появятся примеры». Это требование §5 ТЗ и оно же — единственный
 * способ выполнить приёмку честно: страница выходит раньше, чем
 * оператор успеет что-то отобрать, и заглушка в этот промежуток была бы
 * обещанием, за которым ничего нет.
 *
 * Серверный компонент: `listGreetingShowcase` ходит в API только с
 * сервера и гасит сетевой сбой пустым списком — тогда секция просто не
 * отрендерится, а страница останется целой.
 */
export async function GreetingSampleGallery({
  dict,
  title,
  lead,
}: {
  dict: Dictionary;
  title: string;
  lead: string;
}) {
  const items = await listGreetingShowcase({ pageSize: 9 });
  if (items.length === 0) return null;

  // ItemList из VideoObject (§5 ТЗ) — разметка на СЕКЦИЮ, а не только на
  // страницу отдельного ролика, где она уже есть: даёт поисковику шанс
  // показать карточки прямо по запросу категории повода.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      item: {
        '@type': 'VideoObject',
        // Тот же заголовок, что и на карточке: у поздравления без
        // своего названия в `title` лежит КОД повода (`BIRTHDAY`), и
        // без подмены он уезжал бы и в разметку для поисковика.
        name: headingOf(item, dict),
        description: headingOf(item, dict),
        uploadDate: item.createdAt,
        contentUrl: item.videoUrl,
        // Google требует превью у VideoObject; до постера его здесь не
        // было ни у одной карточки витрины.
        thumbnailUrl: item.posterUrl ?? undefined,
        embedUrl: `${SITE_URL}/video/${item.id}`,
        publisher: { '@type': 'Organization', name: SITE_NAME },
      },
    })),
  };

  return (
    <section className="samples" id="samples">
      <div className="wrap">
        <h2>{title}</h2>
        <p className="section-lead">{lead}</p>
        <ul className="sample-grid">
          {items.map((item) => (
            <li key={item.id}>
              {/* Ведёт на уже существующую публичную страницу ролика —
                  ту самую, которую этап 1 научил обходиться без товара. */}
              <Link className="sample-card" href={`/video/${item.id}`}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- пользовательский ролик без дорожки субтитров, как и у остальных плееров проекта */}
                {/* `preload="metadata"` показывает первый кадр не
                    сразу, а на мобильных — зачастую вовсе серый
                    прямоугольник, и так по всей сетке. Постер снят при
                    публикации и рисуется мгновенно; его отсутствие —
                    нормальное состояние старых страниц. */}
                <video
                  src={item.videoUrl}
                  poster={item.posterUrl ?? undefined}
                  preload="metadata"
                  muted
                  playsInline
                />
                <span className="sample-card-title">
                  {headingOf(item, dict)}
                </span>
                {item.occasion && (
                  <span className="sample-card-occasion">
                    {dict.sharedVideo.occasion[item.occasion]}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {/* eslint-disable-next-line react/no-danger */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
    </section>
  );
}
