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
    ],
    noindex: 'The page is closed to search indexing. This reduces visibility in search but does not replace access protection.',
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
          'Their own consent to the recording and to the use of their voice and image. The narrator consent procedure is set out in the Story‑Tales rules — see the link in the footer; someone else’s recording cannot be used without consent.',
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
          'The recording will not go into a shared catalogue and will not become material for this page. Storage and deletion periods and how to request deletion are set out in the Story‑Tales rules — see the link in the footer.',
      },
    ],
  },
  final: {
    title: 'A gift that can be played again',
    text: 'While we prepare the launch, you can already set up a narrator profile in the app.',
    textNeutral: 'While we prepare the launch, this page explains how the gift will come together.',
  },
  access: {
    pilot: {
      metaDescription: 'An invitation-only pilot for up to 15 families: a personal message from someone close and an illustrated tale with the narrator you choose. An adult prepares it, the family receives it.',
      badge: 'Invitation-only pilot',
      status: 'Invitation-only pilot, up to 15 families',
      appNote: `Applications to join are made in the ${BRAND} section of the app. Once approved, the tale is created there too; this page collects no personal data.`,
      howBadge: 'The pilot participant’s path',
      howLead: 'This is how the tale builder works for pilot participants. Below is a description of the steps, not a form: everything happens in the app.',
      howAppLead: `Applications to join the pilot are made in the ${BRAND} section of the app.`,
      catalogStatus: 'Pilot catalogue',
      catalogText: 'The pilot includes only ready-made tales with verified rights to the edition. New tales and languages will be added based on the results of the pilot. Start with a ready-made tale from the library. YouTube is an optional reference-analysis prototype, not a required step or a way to reuse someone else’s footage or music.',
      available: [
        `Applying to join the pilot — in the ${BRAND} section of the app.`,
        'The tale builder for participants: choosing a tale, recording the message and checking the result.',
        'Narrator voice: a standard one or a clone of the adult narrator’s voice with their consent; a synthetic look — later.',
      ],
      availableNeutral: [
        'A description of the format and of the pilot participant’s path — on this page.',
      ],
      comingTitle: 'After the pilot',
      coming: [
        `Open access for adults — after the ${BRAND} rules have been checked.`,
        'New tales and catalogue languages.',
        'An approved example gift on this page.',
      ],
      note: 'Nothing is sold and no personal data is collected on this page: applying and paying happen only in the app.',
      finalText: 'You can apply to join the pilot in the app.',
      finalTextNeutral: 'On this page you can learn how the gift and the pilot participant’s path work.',
      faqLanguages: 'The tales and languages of the pilot are listed above, under “What the pilot offers”, and in the app. This page itself is available in Russian, Ukrainian, English, German and Spanish.',
      faqPrice: 'A tale is paid for with platform credits in the app. The price and timing are shown in the estimate before the build starts; nothing is charged without confirmation, and nothing is sold on this page.',
      capabilitiesTitle: 'What the pilot offers',
    },
    public: {
      metaDescription: 'A personal message from someone close and an illustrated tale with the narrator you choose. An adult prepares it, the family receives it.',
      badge: 'Open access',
      status: 'Open to adults',
      appNote: `Tales are created in the ${BRAND} section of the app — by adults, after accepting the ${BRAND} rules. This page collects no personal data.`,
      howBadge: 'The path in the app',
      howLead: 'This is how the tale builder works. Below is a description of the steps, not a form: everything happens in the app.',
      howAppLead: `The tale builder is in the ${BRAND} section of the app.`,
      catalogStatus: 'Catalogue',
      catalogText: 'The catalogue includes only tales with verified rights to the edition. Start with a ready-made tale from the library. YouTube is an optional reference-analysis prototype, not a required step or a way to reuse someone else’s footage or music.',
      available: [
        'The tale builder: choosing a tale, recording the message and checking the result.',
        'Narrator voice: a standard one or a clone of the adult narrator’s voice with their consent; a synthetic look — later.',
      ],
      availableNeutral: [
        'A description of the format and of the path in the app — on this page.',
      ],
      comingTitle: 'Coming later',
      coming: [
        'New tales and catalogue languages.',
        'An approved example gift on this page.',
      ],
      note: 'Nothing is sold and no personal data is collected on this page: ordering and paying happen only in the app.',
      finalText: 'The gift is prepared in the app.',
      finalTextNeutral: 'On this page you can learn how the gift works.',
      faqLanguages: 'The available tales and their languages are listed above, under “What is available”, and in the app. This page itself is available in Russian, Ukrainian, English, German and Spanish.',
      faqPrice: 'A tale is paid for with platform credits in the app. The price and timing are shown in the estimate before the build starts; nothing is charged without confirmation, and nothing is sold on this page.',
      capabilitiesTitle: 'What is available',
    },
  },
  opened: {
    narratorFamilyVoice: 'Available in the app in two ways: a clone of the adult narrator’s voice — only with their separate consent to cloning — or a live recording of the introduction without cloning. Someone else’s voice cannot be used without its owner’s consent.',
    faqVoice: 'The introduction sounds the way your loved one recorded it. The tale is read by the chosen standard narrator or — if the adult chooses — by a clone of the adult narrator’s voice, created with their consent.',
    faqLink: 'Anyone who has the link can open it, including someone it was forwarded to. You can unpublish the tale at any time in the app — the link stops opening; files already downloaded stay with the recipient.',
    privacyLink: 'You can unpublish the tale at any time in the app: the link stops opening. A file already downloaded to the recipient’s device cannot be removed from it.',
    faqLook: 'Not yet: a synthetic narrator look (photo or sketch) is not available to participants — later. The real recording of the introduction shows the person as they were recorded.',
    faqPreview: 'Yes. The adult checks the voiceover and the preview of the result and decides separately whether to publish the gift by link.',
    sketchText: 'A synthetic narrator look (photo or sketch) comes later: participants do not have it now. A sketch does not mean voice cloning and does not promise natural animation.',
    stepCheck: 'Checks the voiceover and the preview of the result.',
  },
  capabilities: {
    lead: 'The data comes from the app and updates automatically.',
    staticLead: 'The app did not respond just now — a general description is shown; the current list of tales is in the app.',
    languagesLabel: 'Tale languages',
    talesLabel: 'Tales',
    talesEmpty: 'The list of tales is in the app.',
    formatsLabel: 'Formats',
    priceLabel: 'Price',
    priceFrom: 'from {price} per build step; video is a separate step',
    priceNote: 'The exact price is in the estimate before the build starts; payment with platform credits in the app.',
    languageNames: { ru: 'Russian', uk: 'Ukrainian', en: 'English', de: 'German', es: 'Spanish' },
    formatNames: { audio: 'audio tale', video: 'video tale' },
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
    narratorConsent: `${BRAND} rules`,
    consentNote:
      'Separate Story‑Tales rules for narrators and family materials will be published before launch. For now, the platform’s general documents apply.',
    legalNoticeOtherLocale: 'The documents are currently available in Russian only.',
  },
};
