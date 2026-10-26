# Tutorial / FFmpeg: обновление профиля 26.10.2026

API-only update for commit `653c6c617a1059cacbc96958bcabfed8ddfc1648`:
`maxInputs` remains 20. Oversized valid Tutorial plans now return
`422 UNSUPPORTED_COMMAND` before admission, enabling the existing backend
hosted fallback. A malformed request is still a 400; resource ceilings,
source validation and idempotency reconciliation are unchanged.

On the first VPS, the existing precision API image
`sha256:679ad6ed9e231a469ca15c9d2b5a1de7ef988560830dee6ea37acba840d89408`
was retained as rollback. The derived immutable API image is
`sha256:e080f5947533592e30000ff44c93b92091c22796126886794310b5e30d45b1c2`.
Only compiled `dist/command/parse.js` was replaced; the previous precision
handling of decimal durations was verified and retained. Build context,
probe and deployment receipt are under
`/opt/v4c-ffmpeg-canary/tutorial-inputs-653c6c61/`; they contain no credentials.
Credentials remain in their existing protected location.

Deployment: empty queue verified → pause (revision checked) → SQLite backup →
compose API image updated → existing `start-canary.sh` mount/disk guard →
readiness → resume. The executor and live-login relay were not restarted.
Compose rollback copy:
`compose.canary.json.before-tutorial-653c6c61` next to the active compose.
A rollback must preserve the same queue/readiness checks and start guard.

Verification in isolated Linux candidate container: 2/20 inputs accepted by
parser; 21/31/62 inputs rejected as unsupported. Public HTTPS production
probe with 31 synthetic input URLs returned 422 with `X-FFmpeg-Server: 1`;
lookup by the probe's idempotency key returned 404 `NOT_FOUND`, proving no
job was admitted. `/api/ready` remained true. No input was downloaded and
no paid render was requested. Actual hosted submission is covered by the
backend HTTP-mock regression, not a paid production render.
