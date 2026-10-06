import type { VoiceMapDictionary } from './voice-map-ru';

export const voiceMapEn: VoiceMapDictionary = {
  title: 'Voice map — editor on your site',
  intro:
    'Open your site with the editor on top: hover a button to see how the assistant understands it; name it in three languages, add synonyms, raise the risk or deny it. Test with a command right there. The map is a hint, not a permission: prohibitions (payment, deletion, checkout) are never lifted.',
  open: 'Open the editor on the site',
  linkHint:
    'One-time link, 10 minutes; opens on a verified site address in a regular browser. The site CSP needs a frame-src directive for the editor panel.',
  published: 'Published: v{v}',
  none: 'No map published yet — the assistant works from the page snapshot and the model.',
  draft: 'Draft: {t} targets, {d} denied, {s} templates, {f} fragile',
  dirty: 'There are unpublished changes.',
  build: 'Build a version',
  versions: 'Versions',
  status: {
    building: 'building',
    checking: 'awaiting publishing',
    published: 'published',
    held: 'held',
    discarded: 'discarded',
  },
  viaEditor: 'requested from the editor',
  diff: '+{a} ~{c} −{r}',
  gatesOk: 'Gates: green',
  gatesBad: 'Gates: {n} problems',
  gates: {
    risk_lowered: 'Risk below the code decision',
    never_named: 'A “never” target has a name (deny only)',
    never_attr: 'Element under data-assist="never" is not denied',
    phrase_conflict: 'One phrase leads to two targets',
    memo_phrase: 'The phrase is taken by a memo',
    text: 'Text failed validation',
    not_found: 'Over 30% of targets not found on samples',
    empty: 'The map has no targets',
  },
  publish: 'Publish',
  discard: 'Discard',
  rollback: 'Restore this version',
  sessions: 'Active editor sessions: {n}',
  revoke: 'End all sessions',
  revoked: 'Sessions ended.',
  platformWoo: 'WooCommerce template',
  platformAdded:
    'The template added {n} targets to the draft. Review and publish.',
  export: 'Export JSON',
  import: 'Import JSON',
  imported: 'Import: accepted {a}, rejected {r}{s}',
  importSigned: ' (our unmodified file)',
  templates: 'Similar pages — template candidates: {list}',
  publishedOk:
    'Version v{n} published — the assistant picks it up within 5 minutes.',
  errors: {
    VOICE_MAP_CONFLICT:
      'The map was changed in another tab — refresh the screen.',
    VOICE_MAP_INVALID: 'The change failed validation.',
    VOICE_MAP_HOST_REQUIRED:
      'The editor opens only on a verified site address (https, not the admin area).',
    VOICE_MAP_VERSION_NOT_FOUND: 'Version not found.',
    VOICE_MAP_VERSION_STATE: 'Not possible for a version in this status.',
    VOICE_MAP_HELD: 'Gates failed — the version is held.',
    VOICE_MAP_PHRASE_TAKEN: 'A map phrase is taken by a memo — rename it.',
    VOICE_MAP_IMPORT_KIND:
      'This is an admin-area map file — not allowed in the site map.',
    VOICE_MAP_IMPORT_FORMAT: 'This is not a voice map file.',
    VOICE_MAP_SNAPSHOT_NOT_FOUND:
      'Snapshot not found or expired (kept for 24 h).',
    VOICE_MAP_CHECK_NOT_FOUND: 'This version has not been checked yet.',
  },
};
