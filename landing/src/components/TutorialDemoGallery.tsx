import { loadTutorialDemos, type DemoScenario, type TutorialDemoFeed } from '../lib/tutorial-demo-api';
import type { Locale } from '../lib/i18n';
import type { Dictionary } from '../lib/get-dictionary';
import { TutorialDemoPlayer } from './TutorialDemoPlayer';

/**
 * `feed` — если страница уже загрузила ленту (главной она нужна и для
 * кнопки «Смотреть демо», и для футера), второй раз в API не ходим.
 */
export async function TutorialDemoGallery({ scenario, locale, dict, feed }: {
  scenario: DemoScenario; locale: Locale; dict: Dictionary; feed?: TutorialDemoFeed;
}) {
  const { items, failed } = feed ?? await loadTutorialDemos(scenario, locale);
  if (items.length === 0 && scenario === 'greetings') return null;
  return (
    <section className="demo" id="demo">
      <div className="wrap">
        <h2>{dict.demo.title}</h2>
        <p className="section-lead">{items.length ? dict.demo.lead : failed ? dict.demo.loadFailed : dict.demo.unavailable}</p>
        {items.length ? <TutorialDemoPlayer items={items} openVideo={dict.demo.openVideo} chooseTopic={dict.demo.chooseTopic} play={dict.demo.play} /> :
          <p className="demo-link"><a href="#how">{dict.demo.viewSteps}</a></p>}
      </div>
    </section>
  );
}
