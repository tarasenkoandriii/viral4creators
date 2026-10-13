/** Keep raw SDK messages (potential prompts/credentials) out of diagnostics. */
export function providerErrorStatus(error: unknown): string {
  const status =
    error && typeof error === 'object'
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
    ? String(status)
    : 'unknown';
}
