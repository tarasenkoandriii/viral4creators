// Provider smoke, distinct from VAD, command execution and human/device acceptance.
const { test, expect } = require("@playwright/test");
const { randomUUID } = require("node:crypto");
function words(text) {
  return text
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, " ")
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
function edits(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length];
}
async function expectApiSuccess(response, phase, info) {
  const status = response.status();
  if (status !== 200) {
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      envelope = null;
    }
    const code = envelope?.error?.code;
    const requestId = envelope?.meta?.requestId;
    await info.attach(`api-failure-${phase}.json`, {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          phase,
          status,
          code:
            typeof code === "string" && /^[A-Z_]{1,48}$/.test(code)
              ? code
              : null,
          requestId:
            typeof requestId === "string" && /^[a-f0-9-]{36}$/i.test(requestId)
              ? requestId
              : null,
        }),
      ),
    });
  }
  expect(status, `${phase}: HTTP ${status}`).toBe(200);
}
// API traces can capture visitor credentials; keep only aggregate metrics.
test.use({ trace: "off" });
test.describe("live Soniox voice", () => {
  test.describe.configure({ retries: 0 });
  for (const lang of ["ru", "uk"]) {
    test(`[SBX-VOICE-${lang.toUpperCase()}] assistant TTS → STT → voice ticket (UI ${lang})`, async ({
      request,
    }, info) => {
      test.skip(
        info.project.name !== "desktop",
        "One provider smoke per language",
      );
      test.skip(
        process.env.ASSIST_SANDBOX_VOICE_QA !== "1",
        "Paid live QA is enabled only on the owned deployed sandbox",
      );
      test.setTimeout(285000);
      // Separate paid language scenarios by a full minute window; no retries.
      if (lang === "uk")
        await new Promise((resolve) => setTimeout(resolve, 65000));
      expect(
        process.env.ASSIST_SANDBOX_PUBLIC_KEY,
        "Sandbox public key must be configured",
      ).toBeTruthy();
      const api =
        process.env.ASSIST_API_URL || "https://assist-api.viral4creators.app";
      const parentOrigin = new URL(
        process.env.SANDBOX_URL || "https://sandbox.viral4creators.app",
      ).origin;
      expect(parentOrigin).toBe("https://sandbox.viral4creators.app");
      const origin = "https://assist-w.viral4creators.app";
      const sessionResponse = await request.post(api + "/widget/v1/session", {
        headers: { Origin: origin },
        data: { pk: process.env.ASSIST_SANDBOX_PUBLIC_KEY, parentOrigin },
      });
      expect(sessionResponse.status()).toBe(200);
      const token = (await sessionResponse.json()).data?.visitorToken;
      expect(Boolean(token)).toBe(true);
      const headers = {
        Origin: origin,
        Accept: "application/json",
        "X-Assist-Visitor": token,
      };
      const chat = async (question, voiceTicket) => {
        const response = await request.post(api + "/widget/v1/chat", {
          headers,
          timeout: 90000,
          data: {
            conversationId: null,
            clientRequestId: randomUUID(),
            question,
            ...(voiceTicket ? { voiceTicket } : {}),
            page: { url: parentOrigin + "/", title: "Sandbox voice QA" },
            context: null,
            uiLang: lang,
          },
        });
        await expectApiSuccess(
          response,
          voiceTicket ? "chat-followup" : "chat-seed",
          info,
        );
        const answer = (await response.json()).data;
        expect(answer.refused).toBe(false);
        expect(answer.streaming).toBe(false);
        expect(typeof answer.text).toBe("string");
        return answer;
      };
      const answer = await chat(
        lang === "uk"
          ? "Як надіслати тестову заявку? Відповідай українською одним коротким реченням."
          : "Как отправить тестовую заявку? Ответь по-русски одним коротким предложением.",
      );
      expect(answer.text.length).toBeGreaterThan(10);
      // Bound the paid request before synthesis; site budget remains authoritative.
      expect(answer.text.length).toBeLessThanOrEqual(1000);
      const tts = await request.post(api + "/widget/v1/tts", {
        headers,
        timeout: 90000,
        data: { messageId: answer.messageId },
      });
      await expectApiSuccess(tts, "tts", info);
      expect(tts.headers()["content-type"]).toMatch(/^audio\/mpeg/);
      const audio = await tts.body();
      expect(audio.length).toBeGreaterThan(100);
      const stt = await request.post(api + "/widget/v1/voice", {
        headers: {
          Origin: origin,
          "Content-Type": "audio/mpeg",
          "X-Assist-Visitor": token,
          "X-Assist-Lang": lang,
        },
        timeout: 90000,
        data: audio,
      });
      await expectApiSuccess(stt, "stt", info);
      const speech = (await stt.json()).data;
      expect(Boolean(speech?.voiceTicket)).toBe(true);
      expect(typeof speech?.text).toBe("string");
      const reference = words(answer.text),
        recognized = words(speech.text);
      const distance = edits(reference, recognized),
        wer = distance / reference.length;
      await info.attach("soniox-voice-metrics.json", {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({
            uiLanguage: lang,
            recognizedLanguage: speech.lang ?? speech.language ?? null,
            ttsBytes: audio.length,
            referenceWords: reference.length,
            recognizedWords: recognized.length,
            edits: distance,
            wer,
            threshold: 0.2,
            limitation:
              "Synthetic roundtrip; site language policy chooses content; UI language does not restrict STT; TTS may be cached; does not prove command execution or device audio playback",
          }),
        ),
      });
      expect(
        wer,
        "Synthetic TTS/STT regression exceeds 20% word error rate",
      ).toBeLessThanOrEqual(0.2);
      const followup = await chat(speech.text, speech.voiceTicket);
      expect(followup.text.length).toBeGreaterThan(0);
    });
  }
});
