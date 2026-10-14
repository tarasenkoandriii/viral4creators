/**
 * AI Publisher (P-R, Reddit Manual MVP, M1 Research + M2 Content Studio) —
 * раздел «Reddit» (reddit-manual-mvp-adapted.md §M1.2, §M2, §7): вкладки
 * Проекты · Сообщества · Правила · Возможности · Запросы · Брифы ·
 * Публикации; студия материала — `reddit/<cid>?tab=studio`. Маршруты:
 *   `reddit?tab=<вкладка>[&projectId=…&communityId=…&status=…]` — список;
 *   `reddit/<id>?tab=<вкладка>` — карточка (для «Правил» id — сообщество).
 * Раздел виден только при `product.features.reddit` и `reddit.read`
 * (оболочка); выключенный флаг сервер подтверждает 404 на всех маршрутах.
 * Кабинет не обращается к Reddit (Р-RD-0).
 */
import { Alert, ScreenTitle, Tabs } from '../../../kit/ui';
import type { PublisherSectionProps } from '../registry';
import { REDDIT_TABS, useReddit, type RedditTab } from './reddit-hooks';
import { ProjectsTab } from './ProjectsTab';
import { CommunitiesTab } from './CommunitiesTab';
import { RulesTab } from './RulesTab';
import { OpportunitiesTab } from './OpportunitiesTab';
import { KeywordsTab } from './KeywordsTab';
import { BriefsTab } from './BriefsTab';
import { StudioTab } from './StudioTab';
import { PublicationsTab } from './PublicationsTab';

export function RedditSection({ id, query }: PublisherSectionProps) {
  const { r, t, go, product } = useReddit();
  if (!product.features.reddit) {
    return <Alert tone="warning">{t.nav.sectionNotFound}</Alert>;
  }
  // Студия материала — карточка внутри «Брифов» (`reddit/<cid>?tab=studio`).
  const studio = query.tab === 'studio';
  const tab: RedditTab = studio
    ? 'briefs'
    : (REDDIT_TABS as readonly string[]).includes(query.tab ?? '')
      ? (query.tab as RedditTab)
      : 'projects';
  // Фильтр проекта переносится между вкладками; прочие — у своей вкладки.
  const switchTo = (k: RedditTab) => {
    const q: Record<string, string> = { tab: k };
    if (query.projectId) q.projectId = query.projectId;
    go('reddit', null, q);
  };
  return (
    <div className="space-y-4">
      <ScreenTitle>{r.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{r.intro}</p>
      <Tabs
        label={r.nav}
        tabs={REDDIT_TABS.map((k) => ({ key: k, label: r.tabs[k] }))}
        active={tab}
        onChange={switchTo}
      />
      {tab === 'projects' && <ProjectsTab id={id} query={query} />}
      {tab === 'communities' && <CommunitiesTab id={id} query={query} />}
      {tab === 'rules' && <RulesTab id={id} query={query} />}
      {tab === 'opportunities' && <OpportunitiesTab id={id} query={query} />}
      {tab === 'keywords' && <KeywordsTab query={query} />}
      {studio ? (
        <StudioTab id={id} query={query} />
      ) : (
        tab === 'briefs' && <BriefsTab id={id} query={query} />
      )}
      {tab === 'publications' && <PublicationsTab query={query} />}
    </div>
  );
}
