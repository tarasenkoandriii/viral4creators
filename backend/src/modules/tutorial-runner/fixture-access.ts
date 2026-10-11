/** Check the deployed API with the executor's actual runtime secret before recording. */
export async function checkFixtureAccess(
  apiOrigin: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const response = await request(
    new URL('/api/sessions/fixture-tutorial-session', apiOrigin),
    {
      headers: { 'x-fixture-token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    },
  );
  // Never include response bodies or tokens in cron diagnostics.
  if (response.status !== 200) {
    throw new Error(`Tutorial fixture API HTTP ${response.status}`);
  }
  await response.body?.cancel();
}
