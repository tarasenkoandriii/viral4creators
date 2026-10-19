import {
  STORY_EDITIONS,
  storyEditionBlocker,
  type StoryEdition,
  type StoryEditionStatus,
  type StoryLegalStatus,
} from './story-editions';
/**
 * Wizard catalogue derived from the editorial registry (story-editions.ts).
 * Only approved editions with confirmed rights and a matching text hash are
 * offered; ids and the response shape stay backward compatible.
 */
export const STORY_VOICE = 'a9fc5a41'; // Approved Nova: never substitute silently.
export interface StoryCatalogEntry {
  id: string;
  locale: string;
  title: string;
  revision: string;
  ageBand: string;
  rights: string;
  countries: string[];
  targetSeconds: number;
  kind: 'classic' | 'adaptation' | 'original';
  /** «классика» / «адаптация» / «авторская» — explicit label for UI and API. */
  kindLabel: string;
  sourceUrl?: string;
  sourceEdition?: {
    author: string;
    edition: string;
    pages: string;
    verifiedAt: string;
    changes: string;
    textSha256: string;
  };
  editionStatus: StoryEditionStatus;
  legal: { status: StoryLegalStatus; basis: string; checkedAt: string };
  textSha256: string;
  /** Present only for adaptations: what differs from the classic/plot source. */
  adaptation?: {
    classicEditionId: string | null;
    plotSourceTitle: string;
    plotSourceUrl: string;
    changes: string[];
  };
  chapters: { title: string; scene: string; text: string }[];
}
export function storyCatalogEntry(e: StoryEdition): StoryCatalogEntry {
  const sourceUrl =
    e.kind === 'adaptation'
      ? (e.adaptation?.plotSourceUrl ?? e.source.plotUrl)
      : e.source.textUrl;
  return {
    id: e.id,
    locale: e.locale,
    title: e.title,
    revision: e.revision,
    ageBand: e.ageBand,
    rights: e.rightsSummary,
    countries: [...e.countries],
    targetSeconds: e.targetSeconds,
    kind: e.kind,
    kindLabel:
      e.kind === 'classic'
        ? 'классика'
        : e.kind === 'adaptation'
          ? 'адаптация'
          : 'авторская',
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(e.kind === 'classic' && e.publication && e.textVerification
      ? {
          sourceEdition: {
            author: e.author ?? '',
            edition: e.publication.citation,
            pages: e.publication.pages ?? '',
            verifiedAt: e.textVerification.verifiedAt,
            changes: e.textVerification.normalization,
            textSha256: e.textSha256,
          },
        }
      : {}),
    editionStatus: e.status,
    legal: { ...e.legal },
    textSha256: e.textSha256,
    ...(e.adaptation
      ? {
          adaptation: {
            ...e.adaptation,
            changes: [...e.adaptation.changes],
          },
        }
      : {}),
    chapters: e.chapters.map((c) => ({ ...c })),
  };
}
export const STORY_CATALOG: StoryCatalogEntry[] = STORY_EDITIONS.filter(
  (e) => storyEditionBlocker(e) === null,
).map(storyCatalogEntry);
export function storyText(catalogId = 'little-lantern-ru-v1') {
  const story = STORY_EDITIONS.find((s) => s.id === catalogId);
  if (!story) throw new Error('Unknown story revision');
  return `${story.title}.\n\n${story.chapters.map((c) => c.text).join('\n\n')}`;
}
export function escapeStoryHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
/** Shared by the catalogue, owner preview and public gift; no external images. */
export function storyIllustration(scene: string): string {
  if (scene === 'turnip')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Большая репка на грядке"><rect width="640" height="360" rx="24" fill="#d8e9e0"/><circle cx="530" cy="65" r="35" fill="#ffe29a"/><path d="M0 245Q320 195 640 245V360H0" fill="#8ca97c"/><path d="M0 295Q320 250 640 295V360H0" fill="#946f56"/><path d="M310 205Q245 120 280 80Q330 100 324 175Q340 80 390 75Q415 130 340 210" fill="#538759"/><path d="M270 200Q325 165 380 200Q430 250 325 325Q230 270 270 200Z" fill="#f1d09b"/><path d="M300 225Q325 245 350 225" fill="none" stroke="#b4936b" stroke-width="4"/><path d="M325 325L305 345" stroke="#f1d09b" stroke-width="6"/></svg>`;
  if (scene === 'mitten')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Рукавичка в зимнем лесу"><rect width="640" height="360" rx="24" fill="#dcebf0"/><path d="M0 285Q160 220 320 280T640 255V360H0" fill="#f9fcfc"/><path d="M55 260L120 65L185 260ZM460 270L530 80L605 270Z" fill="#4f7774"/><path d="M270 285V175Q270 145 300 145H330Q360 145 360 175V205L380 185Q403 170 416 190Q425 210 405 230L360 280V300H270Z" fill="#cd745d"/><path d="M270 277H360V304H270Z" fill="#efc18d"/><circle cx="250" cy="299" r="16" fill="#a6adb7"/><circle cx="240" cy="285" r="8" fill="#c8cdd2"/><circle cx="260" cy="285" r="8" fill="#c8cdd2"/><circle cx="248" cy="298" r="2"/></svg>`;
  if (scene === 'pigs')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Три поросёнка у кирпичного дома"><rect width="640" height="360" rx="24" fill="#cfe5e5"/><path d="M0 265Q320 190 640 250V360H0" fill="#86a986"/><path d="M360 135L465 55L570 135" fill="#936b5d"/><rect x="375" y="135" width="180" height="145" rx="8" fill="#ca8d72"/><rect x="440" y="205" width="42" height="75" fill="#6d7769"/>${[120, 210, 300].map((x) => `<ellipse cx="${x}" cy="275" rx="34" ry="29" fill="#e6aba2"/><path d="M${x - 22} 238L${x - 24} 211L${x - 3} 233L${x + 22} 211L${x + 24} 238" fill="#e6aba2"/><circle cx="${x}" cy="248" r="28" fill="#f4c2b7"/><ellipse cx="${x}" cy="257" rx="15" ry="10" fill="#d79890"/><circle cx="${x - 6}" cy="257" r="2"/><circle cx="${x + 6}" cy="257" r="2"/><circle cx="${x - 10}" cy="242" r="2"/><circle cx="${x + 10}" cy="242" r="2"/>`).join('')}</svg>`;
  const stars = scene === 'stars';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Иллюстрация лесной сказки"><rect width="640" height="360" rx="24" fill="${stars ? '#162340' : '#274c54'}"/><circle cx="505" cy="72" r="35" fill="#ffdf9d"/><path d="M0 260 Q150 170 320 265 T640 240 V360 H0Z" fill="#376554"/><path d="M60 275L120 90L180 275Z M465 290L535 115L610 290Z" fill="#143f39"/><path d="M230 360Q350 240 420 360" fill="#648779"/><ellipse cx="315" cy="292" rx="51" ry="27" fill="#dd995c"/><path d="M280 276L278 214L302 234L327 215L341 278Z" fill="#e5a56b"/><path d="M289 259L310 279L333 254" fill="#ffe4bb"/><circle cx="296" cy="251" r="3"/><circle cx="323" cy="251" r="3"/><circle cx="374" cy="267" r="39" fill="#ffde9a" opacity=".2"/><rect x="361" y="252" width="26" height="34" rx="6" fill="#ffdf92"/><path d="M365 252V244Q374 230 383 244V252" fill="none" stroke="#e1b46b" stroke-width="4"/>${stars ? '<path d="M230 55l4 10 11 1-9 7 3 11-9-6-9 6 3-11-9-7 11-1Z" fill="#ffedbb"/>' : ''}</svg>`;
}
