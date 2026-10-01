import type { AppDictionary } from './ru';

export const appEn: AppDictionary = {
  nav: {
    sites: 'Sites',
    knowledge: 'Knowledge',
    widget: 'Widget',
    dialogs: 'Dialogs',
    members: 'Members',
  },
  welcome: {
    title: 'The Assistant answers your website visitors',
    cards: [
      {
        title: 'Answers from your site',
        text: 'Answers from your site’s pages and documents, with links to the source.',
      },
      {
        title: 'Shows where it is',
        text: 'Points to the right page or section of your site.',
      },
      {
        title: 'Leads to Telegram',
        text: 'Collects requests and calls a person when a live answer is needed.',
      },
    ],
    exampleQ: 'Do you deliver to Lviv?',
    exampleA:
      'Yes, by Nova Poshta in 1–2 days. Terms are on the “Delivery” page.',
    connect: 'Connect a site',
    firstStep:
      'First step: add your site and verify that it is yours. Without this the Assistant will not work on the site.',
    created: 'Workspace created.',
  },
  section: {
    stagePlate: 'Coming in stage {stage}',
    knowledge: {
      title: 'Knowledge',
      text: 'Site crawl, documents and FAQ — the base the Assistant uses to answer visitors.',
      stage: '1',
    },
    widget: {
      title: 'Widget',
      text: 'Look, placement and install code of the widget on the verified site addresses.',
      stage: '2',
    },
    dialogs: {
      title: 'Dialogs',
      text: 'Visitor conversations and hand-off to a person in Telegram.',
      stage: '3',
    },
  },
  notFound: 'Page not found',
  toSites: 'To sites',
};
