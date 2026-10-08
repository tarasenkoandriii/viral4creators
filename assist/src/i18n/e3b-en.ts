import type { e3bRu } from './e3b-ru';

/** Stage E3-bis “AI analytics” texts (English). Parity — scripts/i18n.test.ts. */
export const e3bEn: typeof e3bRu = {
  tabs: {
    ai: 'AI scoring',
    insights: 'Insights',
    experiments: 'Experiments',
    behavior: 'Behavior',
  },
  plan: {
    needBusiness: 'Available on Business and Pro plans.',
    modelOff:
      'Model labeling is not enabled on the platform yet — showing code findings.',
  },
  ai: {
    intro:
      'Each closed dialog is labeled by an inexpensive model — using text with phones, e-mails and cards hidden. Lead scores are computed by code from features; they are hints — no automated decisions are made from them.',
    coverage: '{labeled} of {closed} closed dialogs labeled',
    pending: 'Waiting for labeling: {n}',
    failed: 'Could not label: {n}',
    injection:
      'Looks like an attempt to influence the score: {n} (model score ignored)',
    sampled: 'Monthly budget is almost used up — some estimates are sampled.',
    budget: 'Analytics budget this month: {spent} of {cap}',
    buckets: { hot: 'Hot', warm: 'Warm', cold: 'Cold' },
    hotNoLead: 'Hot dialogs without a lead or conversion: {n}',
    intents: 'What people ask about',
    stages: 'Funnel stage',
    failures: 'Why they did not buy',
    calibration: 'Probability calibrated: {n} known outcomes, AUC {auc}',
    calibrationNone:
      'Buckets for now. Probability — on Pro, after 50 known conversions and 200 labeled dialogs.',
    overridden: 'Corrected manually: {n}',
    dialogs: 'Labeled dialogs',
    all: 'All',
    why: 'Why this score',
    fix: 'Labeled wrong',
    fixIntent: 'Topic',
    fixBucket: 'Bucket',
    fixed: 'corrected',
    converted: 'conversion',
    lead: 'lead',
    handoff: 'handoff',
    score: 'score {n}',
    prob: 'probability {p}',
    more: 'Show more',
    empty: 'No labeled dialogs for this period yet.',
    features: {
      stage: 'Stage',
      signals: 'Buying signals',
      model: 'Model estimate',
      turns: 'Conversation length',
      assist_click: 'Clicked assistant button',
      page_product: 'Product page',
      page_cart: 'Cart or checkout',
      voice: 'Voice',
      repeat_visit: 'Repeat visit',
      intent: 'Topic',
    },
    intentNames: {
      product_info: 'Product info',
      price: 'Price',
      availability: 'Availability',
      delivery: 'Delivery',
      payment: 'Payment',
      returns: 'Returns',
      order_status: 'Order status',
      booking: 'Booking',
      how_to: 'How to use',
      complaint: 'Complaint',
      wholesale_partnership: 'Wholesale & partnership',
      job: 'Jobs',
      offtopic_spam: 'Off-topic',
      other: 'Other',
    },
    stageNames: {
      explore: 'Exploring',
      compare: 'Comparing',
      decide: 'Ready to order',
      post_purchase: 'After purchase',
      support: 'Support',
    },
    failureNames: {
      price_too_high: 'Too expensive',
      no_delivery_region: 'No delivery to region',
      out_of_stock: 'Out of stock',
      info_not_found: 'Information not found',
      product_mismatch: 'Wrong product',
      trust_doubt: 'Trust doubts',
      payment_method_missing: 'Payment method missing',
      operator_no_response: 'Operator did not reply',
      assistant_error: 'Assistant error',
      just_browsing: 'Just browsing',
      other: 'Other',
    },
  },
  insights: {
    intro:
      'Numbers are computed by code from rollups; the model only picks what matters and phrases it. Every number in model text is checked — if the check fails, the finding is shown as is.',
    empty: 'No findings this week — not enough data yet, or all is well.',
    week: 'Week of {d}',
    impact: { high: 'Important', medium: 'Notable', low: 'Minor' },
    done: 'Done',
    dismiss: 'Not relevant',
    reopen: 'Reopen',
    useful: 'Useful',
    useless: 'Not useful',
    followUp:
      '14 days after “Done”: was {before}, now {after} — a coincidence in time, not proof.',
    followUpNoData:
      '14 days after “Done”: not enough data to compare (detailed page views are kept for 7 days).',
    skipped: {
      plan: 'Model wording — on Business and Pro plans.',
      model: 'The model did not respond — showing the finding.',
      budget: 'Analytics budget used up — showing the finding.',
      numbers: 'Model text failed the number check — showing the finding.',
      links: 'Model text referred to other pages — showing the finding.',
      lang: 'No translation of this insight into your language — showing the finding.',
    },
    onPage: ' on {page}',
    dry: {
      N2: 'Unanswered: “{topic}” — asked by {n} different visitors',
      N3: 'Reason “{reason}”{page}: {x} of {n} dialogs without conversion ({share})',
      N4: 'Before buying people ask about “{topic}”: {x} of {n} conversions ({share})',
      N5: 'Form{page}: {x} of {n} abandon at field “{field}” ({share})',
      N6: 'Rage clicks{page}: {x} per {n} views ({share})',
      N7: 'JavaScript errors{page}: {value} this week per {n} views',
      N8: 'Slow{page}: {metric} p75 = {value}',
      N10: 'Hint “{trigger}” is dismissed {x} of {n} times ({share})',
      N1: 'Leaving after the answer{page}: after questions about “{topic}”, {x} of {n} leave the site within a minute ({share})',
      N9: 'Campaign “{campaign}”: {x} of {n} conversations are about the wrong product or off-topic ({share}); {value}% of views leave without scrolling',
      N11: 'After the page change on {date}{page}: chat is opened in {share} of views, was {base} — coincidence in time, not proof',
    },
  },
  experiments: {
    intro:
      'Only visitors who agreed to analytics in your site banner take part. The duration is fixed at launch and the result appears only after it ends — that keeps it honest.',
    needLinked:
      'First turn on linked mode (visitor consent) in the settings below.',
    ownerOnly: 'Only the account owner starts and stops experiments.',
    kinds: {
      holdout: 'Control group without the assistant',
      greeting: 'Greeting variant',
      suggestions: 'Suggestion variants',
    },
    goal: 'Goal',
    share: 'Control group share',
    horizon: 'Duration, days',
    variant: 'Variant B text ({lang})',
    variantList: 'Variant B suggestions ({lang}), one per line',
    preview: 'Calculate',
    power:
      'In {days} days the experiment will detect a difference from {mde} (base {base}, ≈ {perDay} consenting visitors per day).',
    reasons: {
      no_traffic: 'No consenting visitors yet — the experiment cannot start.',
      no_conversions:
        'Consenting visitors have not reached this goal yet — the experiment cannot start.',
      underpowered:
        'Your traffic is too small to measure a difference — look at direct conversions and dialogs closed without a human.',
    },
    start: 'Start',
    stop: 'Stop',
    running:
      'Runs until {d}. Result — after it ends. Participants now: A {a}, B {b}.',
    holdoutArms: 'A — with the assistant, B — without it.',
    variantArms: 'A — as now, B — the new variant.',
    invalid:
      'Experiment broken: group shares drifted from the set ones (usually cache or a blocker). No result.',
    stopped:
      'Stopped ({why}) — no result: an early conclusion would be dishonest.',
    stopWhy: {
      owner: 'manually',
      plan: 'plan changed',
      consent_off: 'linked mode turned off',
    },
    result:
      'Result: A {ra} ({xa} of {na}), B {rb} ({xb} of {nb}); difference {diff}, 95% interval {lo}…{hi}.',
    verdicts: {
      significant: 'The difference is statistically significant.',
      not_significant: 'No significant difference.',
      insufficient_sample:
        'Fewer participants than planned — no conclusion (this is not “no effect”).',
    },
    pageTrust:
      'Goal events during the experiment: {total}, of them from the page (not confirmed by the server): {share}. A visitor or competitor can inflate such conversions in one group — double-check the result.',
    goalHint:
      'For an honest result, make the main goal an order via the s2s webhook (assistRef) or an assistant lead: page events can be faked.',
    empty: 'No experiments yet.',
  },
  behavior: {
    intro:
      'Per-page aggregates — only from visitors who agreed to analytics. No session recordings, no typed values, no browser fingerprints.',
    needPlan: 'Page behavior — on Business and Pro plans.',
    needSettings:
      'Turn on linked mode and behavior in the settings below — without visitor consent there is no data.',
    quota: 'Views this month: {used} of {limit}',
    sampled:
      'Monthly quota used up — a {rate} sample of views is counted, totals are scaled to all traffic.',
    capped:
      'Views are twice the quota — behavior is not collected until the end of the month.',
    cols: {
      path: 'Page',
      views: 'Views',
      active: 'Active, s',
      scroll: 'Scroll',
      rage: 'Rage clicks',
      errors: 'JS errors',
      forms: 'Form abandons',
      field: 'Abandon field',
      lcp: 'LCP p75',
      inp: 'INP p75',
    },
    empty: 'No data for this period yet.',
  },
  settings: {
    title: 'AI analytics and consent',
    aiLabeling: 'Label dialogs with the model',
    vertical: 'Business type (for lead scoring)',
    verticals: {
      shop: 'Shop',
      services: 'Services',
      saas: 'SaaS',
      other: 'Other — from site summary',
    },
    linked: 'Linked mode: respect visitor consent from the site banner',
    linkedNote:
      'Without consent nothing is written to the visitor’s device. With consent — a 30-day visit key: a goal on another page is linked to the dialog, experiments and behavior work. “Do not track” (GPC/DNT) is always treated as no consent.',
    gcm: 'Also read consent from Google Consent Mode',
    window: 'Attribution window, days',
    windowMax: 'up to {n} on your plan',
    behavior: 'Collect page behavior (aggregates)',
    snippet: 'Add to your consent banner:',
    cmp: 'Your consent banner',
    cmps: {
      custom: 'Own banner',
      gcm: 'Google Consent Mode v2',
      cookiebot: 'Cookiebot',
      onetrust: 'OneTrust',
      cookieyes: 'CookieYes',
      complianz: 'Complianz (WordPress)',
    },
    cmpHints: {
      custom: 'Call it when the visitor decides in your banner:',
      gcm: 'No snippet needed: turn on “Also read consent from Google Consent Mode” above — Cookiebot, CookieYes, OneTrust, Usercentrics, Didomi, Complianz and other CMPs with Consent Mode v2 work this way.',
      cookiebot: 'Add after the Cookiebot script (Statistics category):',
      onetrust:
        'Add after OneTrust’s standard “function OptanonWrapper() {}”. C0002 is the default Performance category; replace it if your ID differs:',
      cookieyes: 'Add after the CookieYes script (Analytics category):',
      complianz:
        'Add in Complianz “Scripts” or your theme (Statistics category):',
    },
    ownerOnly: 'Only the account owner changes linked mode and behavior.',
    save: 'Save',
    saved: 'Saved.',
  },
};
