/**
 * Формы API сайта (`src/lib/api-types.ts`) ↔ замороженные контракты
 * sites-backend (`contracts/public-api.ts` — P-D, `contracts/content-api.ts`
 * — P-B1, `contracts/lead-validation.ts` — P-A1). Сайт держит КОПИИ типов
 * (у Vercel-проекта свой корень) — расхождение ловит компилятор:
 * взаимная присваиваемость ответа сервера и нашей копии, тело события и
 * заявки — присваиваемость нашего серверному. Плюс пути маршрутов, которые
 * зовёт сайт, — по тексту контрактов.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

const REPO = path.resolve(__dirname, '..', '..');
const C = path.join(REPO, 'sites-backend/src/modules/publisher/contracts');
const OURS = path.resolve(__dirname, '..', 'src/lib/api-types');
const noExt = (p: string) => p.replace(/\.ts$/, '');

const src = `
import type * as P from ${JSON.stringify(noExt(path.join(C, 'public-api.ts')))};
import type * as K from ${JSON.stringify(noExt(path.join(C, 'content-api.ts')))};
import type * as L from ${JSON.stringify(noExt(path.join(C, 'lead-validation.ts')))};
import type * as S from ${JSON.stringify(OURS)};
import type { buildBody } from ${JSON.stringify(path.resolve(__dirname, '..', 'src/lib/lead-form'))};
import type { buildEvent } from ${JSON.stringify(path.resolve(__dirname, '..', 'src/lib/track'))};
declare const p1: P.SiteConfigView; declare const s1: S.SiteConfigView;
export const a1: S.SiteConfigView = p1; export const b1: P.SiteConfigView = s1;
declare const p2: K.PublicContent; declare const s2: S.PublicContent;
export const a2: S.PublicContent = p2; export const b2: K.PublicContent = s2;
declare const p3: K.PublicContentListItem; declare const s3: S.PublicContentListItem;
export const a3: S.PublicContentListItem = p3; export const b3: K.PublicContentListItem = s3;
declare const p4: P.LeadAccepted; declare const s4: S.LeadAccepted;
export const a4: S.LeadAccepted = p4; export const b4: P.LeadAccepted = s4;
declare const s5: S.EventBody; declare const p5: P.EventBody;
export const b5: P.EventBody = s5; export const a5: S.EventBody = p5;
declare const p6: P.RateLimitedDetails; export const a6: S.RateLimitedDetails = p6;
declare const p7: P.FormClosedDetails; export const a7: S.FormClosedDetails = p7;
export const body: L.LeadBody = null as unknown as ReturnType<typeof buildBody>;
export const ev: P.EventBody = null as unknown as ReturnType<typeof buildEvent>;
export const names: readonly P.ClientEventName[] = null as unknown as readonly S.ClientEventName[];
export const names2: readonly S.ClientEventName[] = null as unknown as readonly P.ClientEventName[];
`;

const file = path.join(os.tmpdir(), `pubf-contract-${process.pid}.ts`);
fs.writeFileSync(file, src);
try {
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.Preserve,
    baseUrl: path.resolve(__dirname, '..'),
    paths: { '@/*': ['src/*'] },
    types: [],
  });
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file || !d.file);
  const text = diags.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(text, [], `типы сайта разошлись с контрактами sites-backend:\n${text.join('\n')}`);
} finally {
  fs.rmSync(file, { force: true });
}

// Пути маршрутов, которые зовёт сайт.
const pub = fs.readFileSync(path.join(C, 'public-api.ts'), 'utf8');
const content = fs.readFileSync(path.join(C, 'content-api.ts'), 'utf8');
for (const p of ['/site-config', '/leads', '/events'])
  assert.ok(pub.includes(`path: \`\${PUBLIC_PREFIX}${p}\``), `public-api.ts: нет маршрута ${p}`);
for (const p of ['/contents', '/contents/:slug'])
  assert.ok(content.includes(`path: \`\${PUBLIC}${p}\``), `content-api.ts: нет маршрута ${p}`);
assert.ok(/status: 201/.test(pub.slice(pub.indexOf('submitLead'))), 'POST /leads — 201');
assert.ok(/status: 202/.test(pub.slice(pub.indexOf('trackEvent'))), 'POST /events — 202');
console.log(
  'ok   api-contract: SiteConfigView, PublicContent(+ListItem), LeadAccepted, EventBody, детали 429/503, тело заявки и события ≡ контрактам sites-backend (tsc); маршруты site-config/leads/events/contents есть',
);
