/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/dictionaries/en.ts */
import type { Dictionary } from './ru';

/** Cabinet dictionary — English. Same keys as ru.ts. */
export const en: Dictionary = {
  common: {
    loading: 'Loading…',
    retry: 'Retry',
    back: 'Back',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    delete: 'Delete',
    error: 'Something went wrong',
    language: 'Language',
  },
  auth: {
    openInTelegram:
      'Open the app in Telegram — your workspace is tied to your Telegram account.',
    webTitle: 'Sign in to your account',
    webIntro:
      'Sign in with Telegram — it is the same account as in the Telegram app: the same sites and verifications.',
    webNoBot:
      'Telegram sign-in is not configured: the bot username is missing.',
    checking: 'Checking sign-in…',
    signingIn: 'Signing in…',
    loginFailed: 'Could not sign in with Telegram — please try again.',
    logout: 'Sign out',
    inviteWaiting:
      'After signing in you will join the account from the invitation.',
  },
  account: {
    label: 'Account',
    item: '{id} · {role}',
  },
  errors: {
    api: {
      ACCOUNT_REQUIRED: 'Account not found, or you are no longer a member.',
      ACCOUNT_ROLE_REQUIRED:
        'Not enough rights: only the account owner or a manager can do this.',
      PRODUCT_ROLE_REQUIRED:
        'No access to this section — ask the account owner to grant it.',
      SITE_NOT_FOUND: 'Site not found — it may have been deleted.',
      HOST_NOT_FOUND: 'Host not found — it may have been deleted.',
      HOST_INVALID:
        'This address does not fit: a public https address with a domain name on port 443 is required.',
      HOST_DUPLICATE:
        'This host is already in your account — open the existing one.',
      HOST_OPTED_OUT:
        'The owner of this domain has opted out of checks — it cannot be added.',
      HOST_BLOCKED:
        'The host owner revoked this verification — the host cannot be deleted until they lift the block.',
      HOST_NOT_VERIFIED:
        'Only the account that verified this host can do this. Verify ownership first.',
      METHOD_NOT_ALLOWED:
        'A host on a public platform can only be verified with a DNS record. If you have no DNS access, connect your own domain.',
      REVERIFY_BLOCKED:
        'The host owner revoked your account’s verification. Re-verification is unavailable until they lift the block.',
      INVITE_INVALID:
        'The invitation is invalid or already used — ask for a new one.',
      INVITE_ROLE_INVALID: 'You can only invite a manager or an operator.',
    },
    check: {
      VERIFIED: 'Ownership verified.',
      DNS_NOT_FOUND:
        'The record is not visible yet. DNS may take up to an hour — check the TXT record name and value and try again.',
      DNS_RESOLVERS_DISAGREE:
        'Not all DNS servers see the record yet — wait for it to propagate and try again.',
      DNS_UNAVAILABLE: 'Could not query DNS — try again in a few minutes.',
      FILE_NOT_FOUND:
        'Verification file not found — make sure it is at the given address in the site root.',
      TOKEN_MISMATCH:
        'The file was found, but its first line is not your account token.',
      META_NOT_FOUND: 'The home page has no meta tag with your account token.',
      HTTP_ERROR: 'The site responded with an error — try again later.',
      REDIRECT_OTHER_HOST:
        'The site redirects to another address. The check does not follow redirects to another host — verify this host via DNS or remove the redirect.',
      TOO_MANY_REDIRECTS: 'Too many redirects on the site.',
      BODY_TOO_LARGE:
        'The verification file is too large — it must contain only the token.',
      UNSAFE_URL:
        'Our server cannot open this address — make sure the site is reachable from the internet.',
      NETWORK_ERROR:
        'The site did not respond in time — try again in a few minutes.',
    },
    client: {
      network:
        'No connection to the server — check your internet and try again.',
      noIdentity: 'Could not identify your Telegram account — reopen the app.',
      unauthorized: 'Your session has expired — please sign in again.',
      rateLimited: 'Too many requests — wait a minute and try again.',
      server: 'The server is temporarily unavailable — try again a bit later.',
    },
  },
  nav: {
    sites: 'Sites',
    members: 'Members',
  },
  sites: {
    title: 'My sites',
    empty: 'No sites yet. Add your first one and verify ownership.',
    add: 'Add site',
    hosts: 'Hosts: {n}',
    verifiedOf: '{v} of {n} verified',
    open: 'Open',
  },
  addSite: {
    title: 'Add site',
    nameLabel: 'Site name',
    namePlaceholder: 'Store X',
    hostsLabel: 'Addresses (hosts)',
    hostPlaceholder: 'example.com',
    addHost: 'Another address',
    addTwin: 'Also add {host}',
    removeHost: 'Remove',
    submit: 'Create site',
    nameRequired: 'Enter the site name',
    hostsRequired: 'Add at least one address',
    duplicate: 'This address is already in the list',
    ruleTitle: 'Each address is verified separately',
    ruleApexWww:
      'example.com and www.example.com are different hosts: verify both if the site opens on both.',
    ruleSubdomains:
      'Subdomains do not inherit verification: shop.example.com is not verified by example.com. A subdomain may point to Shopify, Zendesk or Tilda — controlling the main domain’s DNS does not prove control of its content.',
    ruleHttps: 'Only https addresses on port 443 can be verified for now.',
    errors: {
      empty: 'Enter an address',
      invalid: 'This does not look like a website address',
      not_https: 'An https:// address is required',
      port: 'Only the standard port 443 is supported',
      ip: 'A domain name is required, not an IP address',
      single_label: 'A full domain name is required, e.g. example.com',
    },
  },
  site: {
    hosts: 'Hosts',
    addHost: 'Add host',
    verifyAll: 'Verify all',
    verifyAllDone: 'Checked: {ok} of {n} verified',
    nothingToVerify: 'All hosts are already verified',
    batchTitle: 'Add {n} TXT records',
    batchHint:
      'One workspace token for all hosts — only the record name changes. Add the records at your registrar or DNS panel, then tap “Verify all”.',
    suggestTitle: 'Subdomains found',
    suggestHint:
      'We found links to these addresses. Each is verified separately — add the ones you need.',
    suggestAdd: 'Add',
    suggestEmpty: 'No subdomains found yet.',
    deleteHostConfirm: 'Delete host {host}?',
    blocked: 'Blocked',
    readOnly: 'Only the account owner and managers can add and verify hosts.',
    verifyHost: 'Verify',
  },
  status: {
    pending: 'Awaiting verification',
    verified: 'Verified',
    failed: 'Check failed',
    expired: 'Expired',
    revoked: 'Revoked',
    verifiedUntil: 'Verified until {date}, then re-check',
    expiresSoon: 'Verification expires {date} — check again',
    expiredHint:
      '90 days have passed — check again: the record or file must stay in place.',
    revokedHint:
      'The token disappeared during an automatic re-check, or verification was revoked. Restore the record and check again.',
  },
  verify: {
    title: 'Verify ownership',
    intro:
      'Choose a method. Verification lasts 90 days and is shared by all our services for this workspace.',
    tokenLabel: 'Workspace token',
    methods: {
      dns: 'DNS TXT record',
      file: 'File on the site',
      meta: 'Meta tag on the home page',
    },
    methodHints: {
      dns: 'The main method. Works for any host.',
      file: 'Host root only.',
      meta: 'Host home page only.',
    },
    dnsSteps:
      'Open your domain’s DNS panel and add a TXT record. If the panel wants the name without the domain, enter the part before the main domain.',
    recordType: 'Type',
    recordName: 'Name',
    recordValue: 'Value',
    fileSteps:
      'Create a file at this address. Put the workspace token on the first line — nothing else is needed.',
    fileUrl: 'File URL',
    fileContent: 'Content',
    metaSteps: 'Paste the tag into the <head> of the home page.',
    metaPage: 'Page',
    metaTag: 'Tag',
    platformOnlyDns:
      'This is a public platform address — it can only be verified with a DNS record. If you cannot edit the platform’s DNS, connect your own domain.',
    tokenHidden:
      'The account token is visible to the owner and managers — they verify ownership.',
    blocked: 'Blocked by the host owner — re-verification is not allowed.',
    lastRecheck: 'Last automatic check: {date}',
    access: 'Who else verified this host',
    check: 'Check',
    checking: 'Checking…',
    success: 'Host verified',
    notFound:
      'The record is not visible yet (DNS can take up to an hour). The check does not follow redirects to another host.',
  },
  members: {
    title: 'Members and roles',
    onlyManagers:
      'The member list is visible to the account owner and managers.',
    telegramId: 'Telegram ID {id}',
    invite: 'Invite',
    you: 'You',
    roles: {
      owner: 'Owner',
      manager: 'Manager',
      operator: 'Operator',
    },
  },
  invite: {
    title: 'Invite a member',
    roleLabel: 'Account role',
    roleHints: {
      manager: 'Adds sites and hosts, verifies ownership, sees the members.',
      operator:
        'Sees the account’s sites; cannot add hosts or verify ownership.',
    },
    adminLabel: 'Access to the Assistant “Admin”',
    adminRoles: {
      none: 'None',
      employee: 'Employee — chat only',
      owner: 'Full',
    },
    create: 'Create invitation',
    tgLink: 'Link for Telegram',
    webLink: 'Link for the browser',
    noBot: 'The Telegram link will appear once the bot username is set.',
    expires: 'Single-use, valid until {date}.',
    once: 'The link is shown only once — copy it now and send it to the person.',
    agencyWarning:
      'The role applies to the whole account: the member will see all of its sites. Do not invite an agency’s end clients — handing a site over to a client comes later.',
    another: 'Create another',
    accepted: 'You have joined the account from the invitation.',
  },
  access: {
    title: 'Host access',
    intro:
      'Other accounts that added or verified this host. Your account verified it — you can revoke their verifications.',
    empty: 'No other accounts have this host.',
    other: 'Other account #{n}',
    blocked: 'Re-verification blocked',
    unblock: 'Lift the block',
    unblocked: 'Block lifted.',
    revokeAll: 'Revoke all others',
    revokeConfirm:
      'Revoke the verifications of all other accounts for {host} and forbid them to re-verify?',
    revoked: 'Verifications revoked: {n}.',
    markersTitle: 'Other accounts’ records are still in place',
    markersHint:
      'Remove them — otherwise their owners will see the verification revoked while DNS or the file still point to them.',
    dnsName: 'TXT records {name}',
    file: 'The verification file contains another account’s token',
    ownerOnly: 'Only the account owner can revoke and lift blocks.',
  },
  crawl: {
    status: {
      queued: 'Queued',
      running: 'Crawling',
      done: 'Crawl finished',
      failed: 'Crawl failed',
      cancelled: 'Crawl cancelled',
    },
    skip: {
      robots: 'Disallowed by robots.txt',
      noindex: 'Page is marked noindex',
      not_html: 'Not an HTML page',
      too_large: 'Page is too large',
      redirect_offsite: 'Redirects to another site',
      ssrf: 'Address points to an internal network',
      excluded: 'Excluded by you',
      limit: 'Over the page limit',
      http_4xx: 'Page not found or restricted (4xx)',
      http_5xx: 'The site’s server returned an error (5xx)',
      timeout: 'The site did not respond in time',
      empty: 'No text on the page',
      duplicate: 'Duplicate of another page',
      opted_out: 'The domain owner opted out of crawling',
      unverified_host: 'Address not verified — verify ownership',
      not_https: 'Not an https address',
      spa: 'Text is rendered by scripts — such pages are not read yet',
      other: 'Other reason',
    },
  },
};
