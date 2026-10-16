import { BRAND, type StoriesCopy } from './types';

/**
 * English edition — the same meaning as the Russian source, with no new
 * promises (decision of 16.10: five locales with equal completeness).
 * Comments stay in Russian, as elsewhere in the project.
 */
export const en: StoriesCopy = {
  meta: {
    title: `${BRAND} — a fairy tale with a message from someone close`,
    description:
      'Launching soon: a personal message from someone close and an illustrated fairy tale read by the narrator you choose. Made by an adult, received by the family.',
  },
  tagline: 'All the best for children',
  skipLink: 'Skip to content',
  header: {
    navAriaLabel: 'Page sections',
    brandHome: `${BRAND} — back to the top`,
    how: 'How it works',
    example: 'Example',
    faq: 'Questions',
    languageLabel: 'Language',
  },
  cta: {
    how: 'How it works',
    example: 'See an example',
    lead: 'Learn about the launch',
    telegram: 'Open in Telegram',
    app: 'Open the app',
    create: 'Create a tale',
  },
  hero: {
    badge: 'Launching soon',
    title: 'Give a fairy tale with a message from someone close',
    subtitle:
      'Record a few warm words. They lead into an illustrated fairy tale read by the narrator you choose — a small gift that can be played again and again.',
    micro: 'Made by an adult · Received by the family · No chat for children',
    appNote:
      'In the app you can already set up a narrator profile — a look (photo or sketch) and a voice. Creating a tale will come later.',
    illustrationCaption: 'Format illustration',
    illustrationAlt:
      'Drawing: on the left, a separate card with an adult narrator; on the right, a fairy-tale scene with a little house, trees and the moon, joined by a dotted line.',
    narratorCardLabel: 'Message',
    taleCardLabel: 'Fairy tale',
  },
  example: {
    title: 'What the gift looks like',
    lead: 'The gift is three parts of one consistent example.',
    schemeLabel: 'Three-part gift outline',
    parts: [
      {
        title: 'Personal message',
        text: 'A short recording by an adult: a few warm words in their own voice.',
      },
      {
        title: 'Fairy tale',
        text: 'An illustrated story read by the narrator you choose.',
      },
      {
        title: 'Ending',
        text: 'A short closing, after which the gift can be played again.',
      },
    ],
    caption:
      'An example will appear once a recording is approved. Next to it we will state who is speaking, whether it is a real recording, which voice reads the tale, and whether it is the full story or an excerpt — with its length.',
  },
  audience: {
    title: 'Who it is for',
    resultLabel: 'What you get',
    items: [
      {
        title: 'A parent away from home',
        situation:
          'Mum or dad is travelling or on duty and wants to leave a familiar message and a story for the evening.',
        result: 'A recording from the parent and a tale the family can play whenever it suits them.',
      },
      {
        title: 'Grandparents far away',
        situation:
          'Loved ones live in another city or country and want to give their greeting or reading.',
        result: 'A greeting in a familiar voice and an illustrated story from them.',
      },
      {
        title: 'A small personal gift',
        situation: 'An adult is preparing a gift for a birthday or simply for no particular reason.',
        result: 'A tale with a personal message that can be played again.',
      },
    ],
  },
  how: {
    title: 'How it works',
    plannedBadge: 'Planned path',
    lead: 'This is how the tale builder will work. It is still being prepared: below is a description of the steps, not a working form.',
    steps: [
      'An adult chooses a story and a language from the available catalogue.',
      'They record a message or choose a permitted narrator profile.',
      'They check the look, the voice-over and a preview of the result.',
      'They receive the finished gift and decide separately whether to publish it by link.',
    ],
    appLead: `The app already has a ${BRAND} section: a description of the format and narrator settings. The tale builder is not there yet.`,
    appLink: 'View the section in the app',
    telegramLink: 'Open in Telegram',
  },
  narrator: {
    title: 'Who reads the tale',
    lead: 'These are three different things, and we keep them apart.',
    items: [
      {
        title: 'A real recording of the opening',
        text: 'Keeps the person’s voice and image exactly as they were recorded. Choosing a voice for the tale does not re-voice it.',
      },
      {
        title: 'A standard narrator',
        text: 'Reads the text of the tale in a chosen available voice. It is not the voice of your loved one.',
      },
      {
        title: 'A synthetic family voice',
        text: 'Will appear only once the feature is separately ready and the owner of the voice has consented. It does not exist yet.',
      },
    ],
    sketch: {
      title: 'Photo or sketch',
      text: 'A photo or a sketch is how the narrator is drawn. A sketch does not mean voice cloning and does not promise natural-looking animation. In the builder, the original and the applied version will be shown separately.',
    },
  },
  catalog: {
    title: 'Stories and languages',
    status: 'Catalogue in preparation',
    text: 'The page will list only the editions, languages and lengths that are actually available. There are none yet — the catalogue is being prepared.',
    points: [
      'Each story will name its specific edition and its source.',
      'Each card will show the language, the edition’s age recommendation, the length and its availability.',
      'A classic plot does not mean unrestricted rights to any translation, illustration or recording, so the catalogue is built around rights, not titles.',
    ],
  },
  privacy: {
    title: 'Adult control and privacy',
    items: [
      'An adult will check the result before publishing and decide whether to share it.',
      'The recording and the personal voice will not become part of a shared catalogue.',
      'Anyone who receives a family link can forward it: this is not closed access.',
      'Access by link will be revocable to the extent the product provides. A file already downloaded to the recipient’s device cannot be removed from it.',
      'The page is closed to search indexing. This reduces visibility in search but does not replace access protection.',
    ],
  },
  launch: {
    title: 'Launch',
    statusLabel: 'Status',
    status: 'Soon',
    availableTitle: 'Available now',
    available: [
      'The Story‑Tales section in the app with a description of the format.',
      'A narrator profile: a look (photo or sketch) and a voice.',
    ],
    availableNeutral: [
      'A description of the format and the planned path — on this page.',
    ],
    comingTitle: 'Coming at launch',
    coming: [
      'The tale builder: choosing a story, recording a message and checking the result.',
      'A catalogue of stories with their editions and languages stated.',
      'An approved example of the gift on this page.',
      'Price and timing — in full, before any work starts.',
    ],
    note: 'Nothing is sold and nothing is charged on this page right now.',
  },
  faq: {
    title: 'Questions',
    items: [
      {
        question: 'Can I use a real recording without cloning?',
        answer:
          'Yes: the first format will start with a real recording of the opening, followed by an illustrated fairy tale read by the narrator you choose. Voice cloning will not be needed for this.',
      },
      {
        question: 'Which voice reads the whole tale, and which the opening?',
        answer:
          'The opening will sound exactly as your loved one recorded it. The tale will be read by the standard narrator you choose. Reading the whole tale in a family voice will appear only once the feature is separately ready and the owner of the voice has consented.',
      },
      {
        question: 'Can I choose a photo or a sketch?',
        answer:
          'Yes, the builder will let you choose a photo or a sketch for the narrator’s look. It is styling only: it does not clone a voice and does not promise natural-looking animation.',
      },
      {
        question: 'What is needed if the narrator is another adult?',
        answer:
          'Their own consent to the recording and to the use of their voice and image. The narrator consent rules will be published before launch; someone else’s recording cannot be used without consent.',
      },
      {
        question: 'Does the child need an account?',
        answer:
          'No. An adult will prepare the gift and the family will receive the finished result. The child will need neither an account nor a chat with AI.',
      },
      {
        question: 'Who can open the link, and can it be revoked?',
        answer:
          'Anyone who has the link can open it, including someone it was forwarded to. Access by link will be revocable to the extent the product provides; files already downloaded stay with the recipient.',
      },
      {
        question: 'Which languages and stories are available now?',
        answer:
          'None yet: the catalogue is being prepared. This page is available in Russian, Ukrainian, English, German and Spanish; the languages of the stories themselves will appear in the catalogue along with the editions.',
      },
      {
        question: 'Can I see the result before it is published?',
        answer:
          'Yes. The adult will check the look, the voice-over and a preview of the result, and decide separately whether to publish the gift by link.',
      },
      {
        question: 'How much does it cost and how long does it take?',
        answer:
          'The price will be announced at launch; nothing is sold or charged right now. Preparation time will be stated together with the price, before any work starts.',
      },
      {
        question: 'What happens to the original recording, and how do I request deletion?',
        answer:
          'The recording will not go into a shared catalogue and will not become material for this page. Storage and deletion rules for Story‑Tales will be described before launch; for now, the platform’s general Terms of Use apply — see the link in the footer.',
      },
    ],
  },
  final: {
    title: 'A gift that can be played again',
    text: 'While we prepare the launch, you can already set up a narrator profile in the app.',
    textNeutral: 'While we prepare the launch, this page explains how the gift will come together.',
  },
  footer: {
    navAriaLabel: 'Documents',
    platform: 'The viral4creators platform',
    operatorLabel: 'Service operator',
    operator: 'FOP Tarasenko Andrii Yevheniiovych (ФОП Тарасенко Андрій Євгенійович), Kyiv.',
    contactLabel: 'Contact',
    contactBot: 'the platform’s Telegram bot',
    offer: 'Public offer',
    terms: 'Terms of use',
    privacy: 'Data and privacy',
    termsAndPrivacy: 'Terms of use, data and privacy',
    narratorConsent: 'Narrator consent rules',
    consentNote:
      'Separate Story‑Tales rules for narrators and family materials will be published before launch. For now, the platform’s general documents apply.',
    legalNoticeOtherLocale: 'The documents are currently available in Russian only.',
  },
};
