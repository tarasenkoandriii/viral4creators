import { listTutorialDemos, type DemoScenario } from '../lib/tutorial-demo-api';
import type { Locale } from '../lib/i18n';
import type { Dictionary } from '../lib/get-dictionary';
import { TutorialDemoPlayer } from './TutorialDemoPlayer';

export async function TutorialDemoGallery({ scenario, locale, dict }: {
  scenario: DemoScenario; locale: Locale; dict: Dictionary;
}) {
  const items = await listTutorialDemos(scenario, locale);
  if (items.length === 0 && scenario === 'greetings') return null;
  return (
    <section className="demo" id="demo">
      <div className="wrap">
        <h2>{dict.demo.title}</h2>
        <p className="section-lead">{items.length ? dict.demo.lead : dict.demo.unavailable}</p>
        {items.length ? <TutorialDemoPlayer items={items} openVideo={dict.demo.openVideo} chooseTopic={dict.demo.chooseTopic} /> :
          <p className="demo-link"><a href="#how">{dict.demo.viewSteps}</a></p>}
      </div>
    </section>
  );
}
