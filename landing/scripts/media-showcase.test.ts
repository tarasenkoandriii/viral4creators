import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaShowcase } from '../src/components/MediaShowcase';
(globalThis as { React?: typeof React }).React = React;
for (const locale of ['ru','uk','en','de','es'] as const) {
 for (const product of ['ads','greetings','stories','tutorial']) {
  const html=renderToStaticMarkup(React.createElement(MediaShowcase,{locale,product}));
  assert.ok(!html.includes('<video'), 'no video element or media request before click');
  assert.ok(!html.includes('autoplay'));
  assert.match(html,/loading="lazy"/);
  for (const src of Array.from(html.matchAll(/(?:src|href)="(\/media\/[^\"]+)"/g),m=>m[1])) {
   const file=path.join(process.cwd(),'public',src);assert.ok(fs.statSync(file).size>0,src);
  }
 }
}
console.log('media: five locales, real local files, poster-only initial render');
