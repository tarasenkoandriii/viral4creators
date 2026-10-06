import { loadTutorialDemos, type DemoScenario, type TutorialDemoFeed } from '../lib/tutorial-demo-api';
import type { Locale } from '../lib/i18n';
import type { Dictionary } from '../lib/get-dictionary';
import { TutorialDemoPlayer } from './TutorialDemoPlayer';

/** Тексты секции — по умолчанию `dict.demo` главной страницы. */
export type DemoGalleryTexts = Dictionary['demo'];

/**
 * `feed` — если страница уже загрузила ленту (главной она нужна и для
 * кнопки «Смотреть демо», и для футера), второй раз в API не ходим.
 *
 * `texts` — свой набор подписей (обучающий лендинг: «скоро» вместо «видео
 * для этого языка нет», ссылка на схему выше). `note` — честная подпись
 * под плеером, только когда ролики есть («сайт в роликах — наш
 * полигон»).
 */
export async function TutorialDemoGallery({ scenario, locale, dict, feed, texts, note }: {
  scenario: DemoScenario; locale: Locale; dict: Dictionary; feed?: TutorialDemoFeed;
  texts?: DemoGalleryTexts; note?: string;
}) {
  const t = texts ?? dict.demo;
  const { items, failed } = feed ?? await loadTutorialDemos(scenario, locale);
  if (items.length === 0 && scenario === 'greetings') return null;
  return (
    <section className="demo" id="demo">
      <div className="wrap">
        <h2>{t.title}</h2>
        <p className="section-lead">{items.length ? t.lead : failed ? t.loadFailed : t.unavailable}</p>
        {items.length ? <TutorialDemoPlayer items={items} openVideo={t.openVideo} chooseTopic={t.chooseTopic} play={t.play} /> :
          <p className="demo-link"><a href="#how">{t.viewSteps}</a></p>}
        {items.length && note ? <p className="demo-note">{note}</p> : null}
      </div>
    </section>
  );
}
