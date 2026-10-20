import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import {
  loadSiteQaReport,
  siteQaReportText,
  type SiteQaReport,
} from '../src/lib/qa-site-report';
import {
  renderSiteQaPdf,
  collectReportImages,
} from '../src/lib/qa-site-report-pdf';
import type { Finding } from '../src/lib/qa-findings-api';
const f: Finding = {
  id: 'one',
  title: 'Проверка',
  revision: 1,
  severity: 'P1',
  status: 'confirmed',
  createdAt: 'now',
  updatedAt: 'now',
  payload: {
    title: 'Українська та русский текст',
    category: 'logic',
    severity: 'P1',
    status: 'confirmed',
    url: 'https://secret.test/',
    context: 'viewer',
    steps: 'Open',
    expected: 'Read',
    actual: 'Denied',
    impact: 'Blocked',
    evidence: ['https://signed.test/?secret=token'],
    deployedSha: null,
    observedAt: 'now',
    verification: null,
  },
};
const api = {
  list: async (_site: string, before?: string) => ({
    items: before ? [] : [f],
    nextBeforeId: before ? null : 'next',
  }),
  get: async () => f,
  artifacts: async () => [],
};
const report = await loadSiteQaReport(api, 'site');
assert.equal(report.entries.length, 1);
assert.ok(siteQaReportText(report).includes('P1: 1'));
assert.ok(!siteQaReportText(report).includes('secret.test'));
assert.ok(!siteQaReportText(report).includes('signed.test'));
let reads = 0;
await assert.rejects(
  loadSiteQaReport(
    {
      ...api,
      list: async () => ({
        items: [{ ...f, revision: ++reads }],
        nextBeforeId: null,
      }),
    },
    'site'
  )
);
await assert.rejects(
  loadSiteQaReport(
    { ...api, list: async () => ({ items: [f], nextBeforeId: 'same' }) },
    'site'
  )
);
await assert.rejects(
  loadSiteQaReport(
    {
      ...api,
      artifacts: async () => {
        throw new Error('denied');
      },
    },
    'site'
  )
);
const empty = await loadSiteQaReport(
  { ...api, list: async () => ({ items: [], nextBeforeId: null }) },
  'site'
);
assert.ok(siteQaReportText(empty).includes('Замечаний: 0'));
const long: SiteQaReport = {
  ...report,
  entries: Array.from({ length: 4 }, () => ({
    finding: {
      ...f,
      payload: { ...f.payload, steps: 'Длинный текст '.repeat(180) },
    },
    artifacts: [],
  })),
};
const font = new Uint8Array(
  readFileSync(new URL('../public/fonts/qa-report.ttf', import.meta.url))
);
const bytes = await renderSiteQaPdf(long, font);
const pdf = await PDFDocument.load(bytes);
assert.ok(pdf.getPageCount() > 2);
assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
console.log(
  'Site QA report: pagination, concurrent revisions, errors, privacy, Cyrillic multipage PDF passed'
);

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
);
const sha = Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', png)),
  (b) => b.toString(16).padStart(2, '0')
).join('');
const imageReport: SiteQaReport = {
  ...report,
  entries: [
    {
      finding: f,
      artifacts: [
        {
          id: 'png',
          findingRevision: 1,
          sha256: sha,
          bytes: png.length,
          contentType: 'image/png',
          expiresAt: 'later',
          createdAt: 'now',
        },
      ],
    },
  ],
};
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(png);
  const images = await collectReportImages(imageReport, async () => ({
    url: 'https://private.blob.vercel-storage.com/proof',
  }));
  assert.equal(images.length, 1);
  assert.ok(
    (
      await PDFDocument.load(await renderSiteQaPdf(report, font, images))
    ).getPageCount() > 1
  );
  await assert.rejects(
    collectReportImages(
      {
        ...imageReport,
        entries: [
          {
            finding: f,
            artifacts: [
              {
                ...imageReport.entries[0].artifacts[0],
                sha256: '0'.repeat(64),
              },
            ],
          },
        ],
      },
      async () => ({ url: 'https://private.blob.vercel-storage.com/proof' })
    )
  );
  globalThis.fetch = async () => new Response('', { status: 403 });
  await assert.rejects(
    collectReportImages(imageReport, async () => ({
      url: 'https://private.blob.vercel-storage.com/proof',
    }))
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  'Private PNG inclusion: verified hash, appended image page, denied/mismatch abort passed'
);
