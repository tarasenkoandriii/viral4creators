// Do not let Playwright transport errors print visitor headers/cookies in CI.
async function safeProviderPost(request, url, options, phase) {
  try {
    return await request.post(url, options);
  } catch {
    throw new Error(`${phase}: transport failure (request details withheld)`);
  }
}
module.exports = { safeProviderPost };
