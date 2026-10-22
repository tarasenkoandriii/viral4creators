import assert from "node:assert/strict";
import React from "react";
(globalThis as { React?: typeof React }).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import VoicePage from "../src/app/[locale]/hands-free/page";
import QaPage from "../src/app/[locale]/qa/page";
import { middleware } from "../src/middleware";
import { locales } from "../src/lib/i18n";
import { PRODUCT_LINKS } from "../src/brand";
import { getDictionary } from "../src/lib/get-dictionary";

async function run() {
  process.env.SITE_URL = "https://assist.example.com";
  process.env.PILOT_TELEGRAM_BOT_TOKEN = "mock-not-a-secret";
  process.env.PILOT_TELEGRAM_CHAT_ID = "mock-channel";
  for (const locale of locales) {
    const params = Promise.resolve({ locale });
    const d = getDictionary(locale);
    const voice = renderToStaticMarkup(await VoicePage({ params }));
    const qa = renderToStaticMarkup(await QaPage({ params }));
    assert.ok(voice.includes(d.voiceLanding.title));
    assert.ok(voice.includes(d.voiceLanding.limits));
    assert.ok(voice.includes(d.voiceLanding.safety));
    assert.ok(voice.includes(PRODUCT_LINKS.sandbox));
    assert.match(voice, /action="\/api\/pilot"/);
    assert.match(voice, /name="consent"/);
    assert.ok(voice.includes(d.voiceLanding.task));
    assert.ok(voice.includes(d.voiceLanding.exampleLabel));
    assert.ok(voice.includes(d.voiceLanding.exampleNote));
    assert.equal((voice.match(/<details>/g) ?? []).length, 4);
    assert.ok(voice.includes(d.voiceLanding.pilotNote));
    assert.ok(!voice.includes("<audio"), "the example must not activate voice");
    assert.ok(qa.includes(d.home.qa.privacy));
    assert.ok(qa.includes(d.home.qa.limits));
    assert.ok(qa.includes(d.voiceLanding.beta));
    assert.ok(qa.includes("qa-form-capture.zip"));
  }
  delete process.env.PILOT_TELEGRAM_BOT_TOKEN;
  delete process.env.PILOT_TELEGRAM_CHAT_ID;
  const unavailable = renderToStaticMarkup(
    await VoicePage({ params: Promise.resolve({ locale: "en" }) }),
  );
  assert.ok(unavailable.includes(PRODUCT_LINKS.contact));
  assert.ok(
    unavailable.includes(getDictionary("en").voiceLanding.contactUnavailable),
  );
  assert.ok(!unavailable.includes('action="/api/pilot"'));
  for (const [path, browser, expected] of [
    ["/", "uk-UA", "uk"],
    ["/en", "ru-RU", "en"],
    ["/ru/", "en", "ru"],
  ]) {
    const req = new NextRequest(
      `https://${PRODUCT_LINKS.voiceHost}${path}?utm_source=linkedin`,
      { headers: { "accept-language": browser } },
    );
    const result = middleware(req);
    assert.equal(result.status, 307);
    assert.equal(
      result.headers.get("location"),
      `https://assist.example.com/${expected}/hands-free?utm_source=linkedin`,
    );
    assert.equal(result.headers.get("cache-control"), "private, no-store");
  }
  const other = middleware(new NextRequest("https://assist.example.com/uk/qa"));
  assert.equal(
    other.headers.get("location"),
    null,
    "normal product routes must not loop",
  );
  console.log(
    "product landings: RU/UK/EN pilot, privacy, limits and language-aware campaign redirect passed",
  );
}
void run();
