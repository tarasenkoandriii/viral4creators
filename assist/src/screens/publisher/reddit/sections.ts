/**
 * Раздел P-R «Reddit» для реестра оболочки (`../registry.ts`, блок
 * `── P-R ──`: одна строка). Виден при `product.features.reddit` (env-флаг
 * сервера) и `reddit.read` — подсказка; решает сервер (404 при выключенном
 * флаге, 403 без роли).
 */
import { MessagesSquare } from 'lucide-react';
import type { Locale } from '../../../kit';
import { getRedditDict } from '../../../lib/publisher/reddit-view';
import type { PublisherSection } from '../registry';
import { RedditSection } from './RedditScreen';

export const redditSections = {
  reddit: {
    key: 'reddit',
    owner: 'P-R',
    group: 'content',
    order: 55,
    icon: MessagesSquare,
    label: (l: Locale) => getRedditDict(l).nav,
    actions: ['reddit.read'],
    feature: 'reddit',
    Screen: RedditSection,
  },
} as const satisfies Record<string, PublisherSection>;
