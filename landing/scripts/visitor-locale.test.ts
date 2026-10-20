import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {visitorLocale,LOCALE_COOKIE} from '../src/lib/i18n';
import {middleware} from '../src/middleware';
for(const [header,expected] of [['uk-UA,uk;q=0.9','uk'],['ru-RU','ru'],['de-DE','de'],['es-MX','es'],['en-US','en'],['fr-FR','en'],['ru;q=0,uk;q=0.7','uk'],['ru;q=0.2,de;q=0.9','de'],['ru;q=9,es;q=0.5','es']] as const) {
 assert.equal(visitorLocale(undefined,header),expected);
 const res=middleware(new NextRequest('https://tutorial.viral4creators.app/',{headers:{host:'tutorial.viral4creators.app','accept-language':header}}));
 assert.equal(new URL(res.headers.get('location')!).pathname,'/'+expected);
 assert.equal(res.headers.get('cache-control'),'private, no-store');
 assert.equal(res.headers.get('vary'),'Accept-Language, Cookie, X-Vercel-IP-Country');
}
assert.equal(visitorLocale('es','uk-UA'),'es');
assert.equal(visitorLocale('invalid',null),'en');
const explicit=middleware(new NextRequest('https://tutorial.viral4creators.app/de',{headers:{host:'tutorial.viral4creators.app','accept-language':'uk'}}));
assert.equal(explicit.headers.get('location'),null);
const saved=middleware(new NextRequest('https://tutorial.viral4creators.app/',{headers:{host:'tutorial.viral4creators.app',cookie:`${LOCALE_COOKIE}=es`,'accept-language':'uk'}}));
assert.equal(new URL(saved.headers.get('location')!).pathname,'/es');
console.log('visitor locale: browser quality/regions, cookie precedence, explicit URL and private redirects passed');
