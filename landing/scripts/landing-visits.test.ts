import { landingVisitsConfig } from '../src/lib/landing-visits';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { landingFor, sendLandingVisit } from '../src/components/LandingVisits';
assert.equal(landingFor('tutorial.viral4creators.app','/uk',landingVisitsConfig.landingsByHost),'tutorial');
assert.equal(landingFor('welcome.viral4creators.app','/en/greetings',landingVisitsConfig.landingsByHost),'greeting');
assert.equal(landingFor('welcome.viral4creators.app','/de',landingVisitsConfig.landingsByHost),'main');
assert.equal(landingFor('ai-publisher.org','/',{'ai-publisher.org':'publisher'}),'publisher');
assert.equal(landingFor('assist.viral4creators.app','/en/pricing',{'assist.viral4creators.app':'assistant'}),'assistant');
assert.equal(landingFor('story-tales.viral4creators.app','/ru',landingVisitsConfig.landingsByHost),null);
assert.equal(landingFor('welcome.viral4creators.app','/ru/stories',landingVisitsConfig.landingsByHost),null);
assert.equal(landingFor('preview.vercel.app','/ru',landingVisitsConfig.landingsByHost),null);
const canonical=readFileSync(resolve('src/components/LandingVisits.tsx'),'utf8');
for(const app of ['sites-landing','publisher-site']) assert.equal(readFileSync(resolve('../'+app+'/src/components/LandingVisits.tsx'),'utf8'),canonical);
assert.ok(canonical.includes("referrerPolicy: 'no-referrer'"));
assert.ok(!canonical.includes('document.referrer') && !canonical.includes('location.search') && !canonical.includes('localStorage') && !canonical.includes('sessionStorage'));
console.log('landing-visits: product classification, closed Story, production hosts, source-free transport and client parity checked');

const originalFetch = globalThis.fetch;
const sent: Array<{url: string; options: RequestInit}> = [];
globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
 sent.push({url:String(url),options:options??{}});
 return Promise.resolve(new Response(null,{status:202}));
}) as typeof fetch;
try {
 sendLandingVisit('https://collector.example.test/visits','tutorial','uk');
 assert.deepEqual(Object.keys(JSON.parse(String(sent[0].options.body))).sort(),['eventId','landing','locale']);
 assert.equal(sent[0].options.referrerPolicy,'no-referrer');
 assert.notEqual(sent[0].options.credentials,'include');
 assert.equal(sent[0].options.keepalive,true);
} finally { globalThis.fetch = originalFetch; }
