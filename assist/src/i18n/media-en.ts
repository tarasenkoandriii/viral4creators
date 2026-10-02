import type { MediaDictionary } from './media-ru';

export const mediaEn: MediaDictionary = {
  title: 'Videos and “show on screen”',
  intro:
    'The assistant can offer visitors a short video about your site and highlight the right button on the page. Videos are recorded in the tutorial tool and shown only after a moderator approves them.',
  record: 'Record a new tutorial',
  recordHint:
    'The tutorial tool opens: record the steps on your site — once approved, the video appears here.',
  noLink: 'The tutorial link is not configured — please contact support.',
  empty: 'No approved videos for this site yet.',
  show: 'Show in the widget',
  loginOnly:
    'Recorded behind a login or not on a verified address — never shown to visitors.',
  plan: 'Videos in answers are available on Business and above.',
  saved: 'Saved.',
  duration: 'Duration: {d}',
  map: {
    title: 'Page map for highlighting',
    pages: 'Pages in the map: {n}',
    stale:
      'The layout changed on {n} page(s) — the map updates on the next crawl.',
    empty: 'The map appears after the site is crawled.',
  },
  errors: {
    SITE_NOT_FOUND: 'Site not found.',
    VIDEO_NOT_FOUND: 'Video not found — refresh the screen.',
    VIDEO_PATCH_INVALID: 'Could not save.',
    VIDEO_REQUIRES_LOGIN:
      'This video was recorded behind a login — it cannot be shown to visitors.',
    VIDEO_PLAN_REQUIRED:
      'Videos in answers are available on Business and above.',
  },
};
