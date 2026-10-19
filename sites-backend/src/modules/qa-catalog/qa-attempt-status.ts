/** Keep the recorded result intact; an unsuccessful runner cannot certify acceptance. */
export function acceptanceStatus(attempt: {
  status: string;
  origin?: string;
  sourceMetadata?: unknown;
}): string {
  const meta = attempt.sourceMetadata;
  if (
    attempt.status === 'passed' &&
    attempt.origin === 'automated' &&
    (!meta ||
      typeof meta !== 'object' ||
      !('runnerStatus' in meta) ||
      meta.runnerStatus !== 'passed')
  )
    return 'blocked';
  return attempt.status;
}
