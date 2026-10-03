import type { VoiceControlDictionary } from './voice-control-ru';

export const voiceControlEn: VoiceControlDictionary = {
  title: 'Voice control of the site',
  intro:
    'A visitor says “open delivery” or “add the blue one, size M, to the cart” — the assistant scrolls, presses and fills in fields on your site by itself, in front of the visitor. Steps that change anything happen only after their “Yes”. Off by default.',
  toggle: 'The assistant presses buttons for the visitor',
  needVoice: 'First turn on the microphone in the “Voice” section above.',
  plan: 'Voice control is available on plans with voice (Business and above).',
  reasons: {
    platform_off: 'Voice control is temporarily disabled on the platform.',
    voice_off: 'The microphone is off — visitors cannot give voice commands.',
    state_off: 'Off.',
    state_test: '“Test” mode: only you see voice control — via the check link.',
    rules_invalid: 'The rules are corrupted — save them again.',
  },
  risks: {
    title: 'Before you turn it on — the risks',
    items: [
      'The assistant may press the wrong thing (similar buttons, a changed layout). It highlights the element before pressing, checks the result and stops on “stop”, Esc or the visitor’s own click.',
      'Payments, deletion, placing orders, cancelling subscriptions, entering passwords and cards, going to another domain — never; the assistant highlights it and asks the visitor to press it.',
      'Submitting forms and fields with personal data — only after the visitor’s “Yes”.',
      'Some anti-bot and anti-fraud systems dislike synthetic clicks (isTrusted = false) — test your site before enabling.',
      'Button and link labels are personal data too: e-mails and phones are masked, but add a clause to your privacy policy and data-assist="never" on areas with personal data.',
      'We are responsible for enforcing the prohibitions in code and keep a step log; liability is limited to the fees paid.',
    ],
    accept: 'I have read the risks and turn voice control on',
  },
  rules: {
    title: 'Rules',
    allowPaths: 'Allowed pages (masks, one per line; empty — the whole site)',
    denyPaths: 'Forbidden pages (masks, e.g. /account*)',
    denySelectors: 'Forbidden elements (CSS selectors)',
    allowSelectors: 'Allowed areas (CSS selectors; empty — the whole page)',
    denyWords: 'Forbidden words in button labels',
    confirmFill: 'Ask for confirmation for filling in fields too',
    maxSteps: 'Steps per command (up to 15)',
    markup:
      'Markup is the most reliable: data-assist-id="add-to-cart" on the “Add to cart” button, data-assist="never" on areas the assistant must not touch.',
  },
  // ── Э6-бис (г): states, check wizard, monitor (owner decisions 03.10.2026) ──
  states: {
    off: 'Off',
    test: 'Test',
    on: 'On for everyone',
    degraded: 'Hints only',
  },
  stateHelp: {
    off: 'The assistant clicks nothing.',
    test: 'Voice control works only for you — via the check link. Visitors do not see it.',
    on: 'For all visitors. Requires a passed check (not older than 30 days).',
    degraded:
      'The assistant only highlights and asks to press it yourself — it clicks nothing.',
  },
  stateBy: {
    owner: 'you',
    monitor: 'automatically (quality dropped)',
    transition: 'automatically (check not passed within 14 days)',
    violation: 'automatically (a forbidden action)',
    operator: 'platform operator',
  },
  stateReasons: {
    done_low: 'few commands completed',
    self_high: 'often “press it yourself”',
    not_found_high: 'often “element not found”',
    stoplist_live: 'pages changed — the stop list fires',
    violation: 'a forbidden action — under investigation',
    transition_expired: 'the check was not passed',
    complaint: 'a complaint',
  },
  changedAt: 'Changed {date}: {who}{why}.',
  banner:
    'Pass the voice control check before {date} — otherwise it switches to “Test” (only for you). It takes a few minutes.',
  wizard: {
    title: 'Check on your site',
    intro:
      'The wizard opens your site and in a few minutes checks the widget and CSP, the microphone, button markup, commands without and with clicks, and the forbidden actions. Nothing is submitted or paid.',
    testHost:
      'This is a test address (staging) — form submission can be checked too',
    host: 'Site address',
    start: 'Check',
    link: 'Open the link on your site (valid 30 minutes, single use):',
    open: 'Open the site',
    copied: 'Link copied',
    last: 'Last check: {result}, {date}',
    none: 'No checks yet.',
    results: { pass: 'passed', partial: 'partial', fail: 'failed' },
    problems: {
      none: 'Pass the check to turn it on for everyone.',
      failed: 'The check failed — fix the report items and run it again.',
      partial_ack:
        'The check passed partially — you can turn it on after confirming some commands will be “press it yourself”.',
      expired: 'The report is older than 30 days — run the check again.',
      loader_changed: 'The widget was updated after the check — run it again.',
      markup_changed:
        'The layout of the checked pages changed — run the check again.',
      older_than_state:
        'A new check is needed — after the automatic switch-off/hints mode.',
    },
    partialAck: 'I understand some commands will be “press it yourself”',
    report: 'Report',
    hide: 'Hide',
    items: {
      ok: 'Done',
      widget_missing: "The widget didn't respond on the page",
      chunks_blocked: "The site's CSP blocks the assistant's scripts",
      csp_violations: 'CSP violations caused by the widget',
      tt_violations: 'Trusted Types violations',
      mic_policy_denied: "The site's Permissions-Policy blocks the microphone",
      mic_owner_problem: 'Your device microphone — check the permission',
      dry_low: 'Dry run: too few right steps',
      safe_low: 'With clicks: fewer than two commands done',
      safe_none: 'With clicks: no command done',
      forbidden_leak: 'A forbidden command was not blocked',
      suspicious_unreviewed: 'Not every “looks dangerous” button was reviewed',
      unnamed_elements: 'Some buttons have no name — mark them up',
      closed_shadow: 'Some buttons are in closed shadow roots',
      ext_iframes: "External iframes — the assistant doesn't enter them",
      duplicates: 'Buttons with the same name',
    },
    never: 'The assistant will never press these',
    forbidden: 'Forbidden actions, checked without voice',
    blocked: 'blocked',
    leaked: 'NOT blocked',
    fragment: 'Markup snippet for the developer',
    denyAdd: 'Add {n} to “Forbidden elements”',
  },
  monitor: {
    title: 'How it works over 24 hours',
    plans: 'Commands',
    done: 'Done',
    self: '“Press it yourself”',
    notFound: 'Not found',
    wrong: '“Wrong target”',
    cancelled: 'Cancelled on the card',
    stoplist: 'Stop list on the page',
    latency: 'Latency p50 / p95',
    perDay: 'Commands per day limit: {n}',
    incidents: 'Events',
    kinds: {
      alert: 'Alert',
      degraded: 'Hints mode',
      off: 'Turned off',
      transition: 'Switched to “Test”',
    },
  },
  save: 'Save',
  saved: 'Saved.',
  errors: {
    VOICE_CONTROL_INVALID:
      'The rules did not pass validation — fix the highlighted lines.',
    VOICE_CONTROL_PLAN_REQUIRED:
      'A plan with voice is required (Business and above).',
    VOICE_CONTROL_VOICE_REQUIRED:
      'First turn on the microphone in the “Voice” section.',
    VOICE_CONTROL_RISKS_REQUIRED: 'Confirm that you have read the risks.',
    VOICE_CONTROL_TEST_REQUIRED:
      'You can turn it on for everyone after checking voice control on your site (the “Check” button below).',
    VOICE_CONTROL_HOST_REQUIRED:
      'The check runs only on a verified site address (https). Verify the address in “Addresses”.',
    VOICE_CONTROL_TEST_NOT_FOUND: 'Report not found.',
  },
};
