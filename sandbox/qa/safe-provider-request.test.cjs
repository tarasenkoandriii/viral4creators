const { test } = require("node:test");
const assert = require("node:assert/strict");
const { safeProviderPost } = require("./safe-provider-request.cjs");
test("transport error omits credentials, provider message and cause", async () => {
  await assert.rejects(
    safeProviderPost(
      {
        post: async () => {
          throw new Error(
            "X-Assist-Visitor: SECRET; cookie: PRIVATE; read ETIMEDOUT",
          );
        },
      },
      "https://example.invalid",
      {},
      "chat",
    ),
    (error) => {
      assert.equal(
        error.message,
        "chat: transport failure (request details withheld)",
      );
      assert.doesNotMatch(error.stack, /SECRET|PRIVATE|ETIMEDOUT/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});
test("successful response is preserved", async () => {
  const response = { status: () => 200 };
  assert.equal(
    await safeProviderPost({ post: async () => response }, "", {}, "tts"),
    response,
  );
});
