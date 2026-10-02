import { billingEn } from './billing-en';
import type { AppDictionary } from './ru';
import { setupEn } from './setup-en';
import { e3En } from './e3-en';

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
      'Start with your site address: the Assistant reads a few pages and answers questions even before you verify ownership.',
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
  knowledge: {
    homeTitle: 'Knowledge',
    homeIntro:
      'Two separate bases: one is what the Assistant uses to answer site visitors, the other — staff in Admin mode. Nothing flows between them.',
    noSites: 'Add a site first.',
    siteMode: 'For visitors',
    adminMode: 'For staff',
    siteTitle: 'Knowledge for visitors',
    adminTitle: 'Knowledge for staff',
    siteIntro: 'The Assistant answers site visitors from this base.',
    adminIntro:
      'Only staff in Admin mode see this base. It never reaches site visitors.',
    noAccess:
      'No access to knowledge — ask the workspace owner to grant you Assistant manager rights.',
    noAdminAccess:
      'Staff knowledge is available only to the owner of Admin mode.',
    enable: 'Connect the Assistant',
    enableIntro:
      'The Assistant is not connected to this site yet. Once connected, it reads the verified addresses of the site and builds the knowledge base.',
    sandbox: 'Sandbox',
    confirm: 'Sure?',
    saved: 'Saved.',
    tabs: {
      overview: 'Overview',
      sources: 'Sources',
      faq: 'Answers',
      versions: 'Versions',
      exclusions: 'Exclusions',
      quarantine: 'Quarantine',
    },
    overview: {
      published: 'Published version {n}',
      noVersion: 'The base has not been built yet',
      pagesRead: 'Pages read: {n}',
      pagesSkipped: 'Skipped: {n}',
      skippedWhy: 'Why skipped',
      documents: 'Documents: {n}',
      chunks: 'Chunks: {n}',
      langs: 'Languages',
      lastCrawl: 'Last crawl',
      noCrawl: 'No crawl yet.',
      crawlStats:
        'Seen {seen}, changed {changed}, unchanged {unchanged}, skipped {skipped}, errors {failed}, removed {gone}',
      recrawl: 'Crawl now',
      recrawlStarted:
        'Crawl started — the overview will update when it finishes.',
      needVerified:
        'A full crawl covers verified addresses only. Verify that you own the site.',
      toSite: 'Go to verification',
      recrawlEvery: 'Recrawl',
      every: {
        manual: 'Manually',
        weekly: 'Weekly',
        daily: 'Daily',
      },
      nextCrawl: 'Next: {date}',
      held: 'New version {n} is on hold — visitors still get the previous one.',
      heldOpen: 'Open versions',
      quarantine: 'Chunks in quarantine: {n} — please review them.',
      quarantineOpen: 'Open quarantine',
      suggested: 'The Assistant now answers questions like',
      check: 'Check the answer',
      budget: 'Learning budget, {period}',
      budgetLine: 'Spent {spent} of {cap}',
      budgetOut:
        'This month’s learning budget is used up: changed pages will update next month. Hot pages, exclusions and deletion always work.',
      copyTitle: 'Public site in the staff base',
      copyPublic: 'Staff should know the public site too',
      copyPublicHint:
        'A copy of the public site crawl goes into a separate Admin base. Nothing flows back into the visitor base.',
      copyUgc: 'Include visitor reviews and comments',
      copyUgcHint:
        'Off by default: anyone can write them, and in Admin mode the Assistant has tools.',
    },
    sources: {
      empty: 'No sources yet.',
      kind: {
        crawl: 'Site crawl',
        public_copy: 'Public site copy',
        url: 'Individual pages',
        file: 'Document',
        faq: 'Verified answers',
        manual: 'Manual edits',
      },
      status: {
        pending_upload: 'Waiting for upload',
        processing: 'Processing',
        active: 'Active',
        failed: 'Error',
        disabled: 'Disabled',
      },
      docs: 'Documents: {n}',
      synced: 'Updated {date}',
      disable: 'Disable',
      enable: 'Enable',
      remove: 'Delete',
      removeHint:
        'The source’s documents leave the base in a new version; the file is deleted from storage.',
      removed: 'Source deleted.',
      addUrls: 'Add pages',
      urlsPlaceholder: 'https://example.com/delivery',
      urlsHint: 'One per line. Only https addresses of this site.',
      urlsInvalid: 'Not accepted: {list}',
      urlsTooMany: 'At most {n} addresses per source.',
      urlsAdded: 'Pages added — they will be read during the next crawl.',
      addFile: 'Upload a document',
      fileHint: 'PDF, DOCX, TXT, MD, CSV — up to 20 MB.',
      confirmPublic: 'All site visitors will see this file',
      confirmPublicRequired:
        'Confirm that the file’s contents may be shown to visitors.',
      adminFileHint: 'Only staff in Admin mode see this document.',
      chooseFile: 'Choose a file',
      uploading: 'Uploading… {pct}%',
      uploaded: 'File uploaded — it will be processed within a few minutes.',
      uploadFailed:
        'Could not upload the file — check your connection and try again.',
      showDocs: 'Documents',
      hideDocs: 'Hide documents',
    },
    documents: {
      status: {
        active: 'In the base',
        gone: 'Removed from the site',
        excluded: 'Excluded',
        failed: 'Error',
        skipped: 'Skipped',
      },
      all: 'All',
      empty: 'No documents.',
      chunks: 'Chunks: {n}',
      more: 'Show more',
      exclude: 'Exclude',
      excludeHint:
        'Chunks are deleted from all versions at once, and a rollback will not bring them back.',
      excluded: 'Excluded.',
      hot: 'Hot',
      makeHot: 'Mark as hot',
      unHot: 'Remove from hot',
      hotHint:
        'Hot pages (delivery, payment, prices) are checked daily. At most 10.',
    },
    faq: {
      intro:
        'Answers you confirmed yourself — the Assistant uses them first. Manual answer edits also land here.',
      empty: 'No verified answers yet.',
      add: 'Add an answer',
      question: 'Question',
      answer: 'Answer',
      variants: 'Other ways to ask — one per line',
      lang: 'Language',
      langAuto: 'Detect automatically',
      save: 'Save',
      edit: 'Edit',
      remove: 'Delete',
      removed: 'Answer deleted.',
      required: 'Fill in both the question and the answer.',
      origin: 'Origin: {origin}',
      status: {
        active: 'Published',
        needs_review: 'Needs review',
        archived: 'Archived',
      },
    },
    versions: {
      intro:
        'Every knowledge change is a new version. Visitors see only the published one.',
      empty: 'No versions yet.',
      number: 'Version {n}',
      status: {
        current: 'Published now',
        building: 'Building',
        checking: 'Checking',
        published: 'Previously published',
        held: 'On hold',
        discarded: 'Discarded',
      },
      trigger: {
        crawl: 'Recrawl',
        document: 'Document',
        faq: 'Verified answer',
        exclusion: 'Exclusion',
        quarantine: 'From quarantine',
        rollback: 'Rollback',
        manual: 'Manual',
      },
      stats: '+{added} −{removed} ~{changed} · chunks {chunks}',
      created: 'Created {date}',
      publishedAt: 'Published {date}',
      heldBecause: 'Why it is on hold',
      heldHint:
        'Visitors still get the previous version. If the site is fine, publish this one as is.',
      coldStart:
        'First version — nothing to compare with, gates were not checked.',
      gate: {
        gone_or_error_share:
          'Gone or failing: {value} pages (threshold {threshold})',
        identical_changed_share:
          'Changed pages became identical: {value} (threshold {threshold})',
        lang_shift:
          'Base language shifted by {value} p.p. (threshold {threshold})',
        quarantine_share: 'Suspicious chunks: {value} (threshold {threshold})',
        invariant_eval: 'Control questions failed: {value}',
      },
      publish: 'Publish as is',
      discard: 'Discard',
      rollback: 'Roll back to this version',
      rollbackHint:
        'A rollback creates a new version with this one’s content. Excluded content does not come back.',
      done: 'Done: version {n}.',
    },
    exclusions: {
      intro:
        '“Don’t know this”: an address or section is removed from the base at once, from all versions, and is no longer crawled.',
      empty: 'No exclusions.',
      kind: {
        url: 'Address',
        urlPrefix: 'Section',
        chunkHash: 'Chunk',
        document: 'Document',
      },
      kindHint: '“Section” — all addresses that start with the given one.',
      value: 'Address',
      reason: 'Reason (optional)',
      add: 'Exclude',
      invalid: 'An https address of the site is required.',
      added: 'Excluded, chunks deleted: {n}.',
      deleted: 'Chunks deleted: {n}',
      lift: 'Lift',
      liftHint: 'The page will return with the next crawl.',
      lifted: 'Exclusion lifted — the page will return with the next crawl.',
    },
    quarantine: {
      intro:
        'Chunks that look like an attempt to steer the Assistant (“ignore your instructions…”). They stay out of answers until you allow them yourself.',
      empty: 'Quarantine is empty.',
      reason: 'Why: {reason}',
      allow: 'Allow into the base',
      allowHint: 'The chunk will start appearing in answers.',
      allowed: 'Chunk allowed — version {n}.',
      exclude: 'Exclude the document',
    },
  },
  sandbox: {
    title: 'Try it right now',
    intro:
      'The Assistant reads a few pages of your site and answers from them. This is a sandbox: the widget code becomes available after you verify ownership.',
    queued: 'Sandbox is queued…',
    readingStart: 'Reading the site…',
    reading: 'Reading the site… {read} of {found} read',
    sitemap: 'Sitemap found',
    indexing: 'Preparing answers…',
    pages: 'Pages: {read} of {limit}',
    questionsLeft: 'Questions left: {n} of {limit}',
    expires: 'The sandbox is kept until {date}',
    fromKnowledge: 'Answers from the site’s published knowledge base',
    fromSandbox: 'Answers from the pages read in the sandbox',
    placeholder: 'Ask the way a visitor would',
    send: 'Ask',
    suggested: 'Try asking',
    sources: 'Sources',
    refused: 'The Assistant honestly declined: the pages read have no answer.',
    thinking: 'The Assistant is thinking…',
    exhausted:
      'The sandbox questions are used up. Verify ownership and the Assistant will read the whole site.',
    expired: 'The sandbox has expired. Create a new one.',
    failed: 'Could not read the site.',
    blocked: 'This site cannot be opened in the sandbox.',
    reason: 'Reason: {reason}',
    restart: 'Create again',
    start: 'Start the sandbox',
    verify: 'Verify ownership',
    knowledge: 'Knowledge',
    tooLong: 'The question is longer than {n} characters.',
  },
  onboarding: {
    step: 'Step {n} of 3',
    urlTitle: 'Your site address',
    urlLabel: 'Site address',
    urlPlaceholder: 'example.com',
    preview: 'Look it up',
    previewing: 'Looking at the site…',
    found: 'What we found',
    title: 'Title: {title}',
    noTitle: 'No title',
    lang: 'Language: {lang}',
    sitemapYes: 'Sitemap found',
    sitemapNo: 'No sitemap — we will follow links',
    tryIt: 'Try it on my site',
    creating: 'Preparing the sandbox…',
    rule: 'The sandbox reads up to 10 pages and answers 20 questions. If the site is never verified, its data is deleted after 7 days.',
    skip: 'Skip — verify ownership right away',
    existing: 'This address is already in the workspace — opening the site.',
  },
  transfer: {
    title: 'Sandbox from the website',
    intro:
      'You tried the Assistant on our website. Move that sandbox into your workspace? The site is added as unverified — then verify ownership and the Assistant will read it in full.',
    submit: 'Move to workspace',
    later: 'Not now',
    done: 'The sandbox has been moved to your workspace.',
    noAccess: 'Only the workspace owner or a manager can move the sandbox.',
  },
  siteCard: {
    title: 'Assistant',
    sandbox: 'Sandbox',
    siteKnowledge: 'Knowledge for visitors',
    adminKnowledge: 'Knowledge for staff',
  },
  errors: {
    URL_REJECTED:
      'This address is not accepted: a public https address with a domain name, no port and no login, is required.',
    OPTED_OUT: 'The owner of this domain has forbidden us to read it.',
    BLOCKED_CATEGORY: 'Sites of this category cannot be opened in the sandbox.',
    SANDBOX_DISABLED:
      'The sandbox is unavailable right now — leave a request and we will get in touch.',
    SANDBOX_LIMIT_IP:
      'Several sandboxes have already been created from your address today — try again tomorrow.',
    SANDBOX_BUDGET:
      'The sandbox is unavailable right now — leave a request and we will get in touch.',
    SANDBOX_QUESTIONS_EXHAUSTED:
      'The sandbox questions are used up. Verify site ownership to continue.',
    SANDBOX_EXPIRED: 'The sandbox has expired — create a new one.',
    KNOWLEDGE_SOURCE_LIMIT:
      'The source limit for this site is reached — delete the ones you do not need.',
    DOCUMENT_TOO_LARGE: 'The file is larger than 20 MB — split it into parts.',
    DOCUMENT_TYPE:
      'This file type is not supported: PDF, DOCX, TXT, MD or CSV is required.',
    DOCUMENT_NO_TEXT:
      'No text was found in the file — it may be a scan. Upload a version with text.',
    VERSION_NOT_ROLLBACKABLE:
      'You cannot roll back to this version: it is outside the rollback window (7 days or 5 publications).',
    VERSION_NOT_HELD:
      'This version is no longer on hold — refresh the list of versions.',
    HOT_PAGES_LIMIT: 'There can be at most 10 hot pages.',
    LEARNING_BUDGET_EXHAUSTED:
      'This month’s learning budget is used up — changes will apply next month.',
    URL_INVALID:
      'This does not look like an https address of a page on this site.',
    SANDBOX_LIMIT_ACCOUNT:
      'Many sandboxes have already been created in this workspace today — try again tomorrow.',
    SANDBOX_LIMIT_DOMAIN:
      'This site has already been read many times today — try again tomorrow.',
    SANDBOX_NOT_FOUND: 'Sandbox not found — create a new one.',
    SANDBOX_NOT_READY:
      'The sandbox is still reading the site — please wait a little.',
    SANDBOX_TRANSFERRED: 'This sandbox has already been moved to a workspace.',
    ORIGIN_FORBIDDEN: 'The request came from another site and was rejected.',
    ASSIST_NOT_ENABLED: 'The Assistant is not connected to this site yet.',
    SOURCE_NOT_FOUND: 'Source not found — it may have been deleted.',
    SOURCE_READONLY:
      'This source is managed automatically and cannot be changed this way.',
    DOCUMENT_NOT_UPLOADED:
      'The file has not been uploaded yet — upload it again.',
    PUBLIC_CONFIRM_REQUIRED:
      'Confirm that the file may be shown to site visitors.',
    FAQ_NOT_FOUND: 'Answer not found — it may have been deleted.',
    EXCLUSION_NOT_FOUND:
      'Exclusion not found — it may have been lifted already.',
    EXCLUSION_DUPLICATE: 'This exclusion already exists.',
    EXCLUSION_INVALID:
      'This exclusion is not valid: an https address of this site is required.',
    VERSION_NOT_FOUND: 'Version not found — refresh the list of versions.',
    CHUNK_NOT_FOUND: 'Chunk not found — it may have been removed already.',
    ANSWER_UNAVAILABLE:
      'The Assistant cannot answer right now — please try again.',
    KNOWLEDGE_BUSY:
      'The knowledge base is being updated right now — try again in a minute.',
  },
  notFound: 'Page not found',
  toSites: 'To sites',
  // Э2 (W4): виджет, персона, лиды, мастер, полнота, payload лендинга.
  setup: setupEn,
  // Э3 (T): диалоги, передача, вовлечение, статистика, цели, интеграции, обучение.
  e3: e3En,
  // Э4: тариф и оплата, Условия и DPA.
  billing: billingEn,
};
