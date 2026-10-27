import assert from 'node:assert/strict';
import React, { createElement } from 'react';
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from 'react-dom/server';
import AltContact from '../src/components/AltContact';

const render = (value: { label: string; href: string | null } | null) =>
  renderToStaticMarkup(createElement(AltContact, { value, label: 'Контакт', missing: 'Не задано' }));
assert.match(render(null), /href="https:\/\/t\.me\/ConscienceUkraine"/);
assert.doesNotMatch(render(null), /Не задано/);
assert.match(render({ label: 'Configured', href: 'mailto:team@example.org' }), /href="mailto:team@example.org"/);
assert.doesNotMatch(render({ label: 'Configured', href: 'mailto:team@example.org' }), /ConscienceUkraine/);
assert.doesNotMatch(render({ label: 'Phone', href: null }), /href=/);
console.log('ok contact: approved fallback, configured contact preserved, text-only contact stays text');
