/** Authenticated lookup; failures deliberately force a full CI run. */
export async function lastSuccessfulSha(env = process.env, fetcher = fetch) {
  const { GITHUB_REPOSITORY: repo, GITHUB_REF_NAME: branch, GH_TOKEN: token } = env;
  if (!repo || !branch || !token) return null;
  try {
    const response = await fetcher(`https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(branch)}&status=success&per_page=1`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const sha = data?.workflow_runs?.[0]?.head_sha;
    return typeof sha === 'string' && /^[a-f0-9]{40}$/i.test(sha) ? sha : null;
  } catch {
    // Never log credentials or API response bodies.
    return null;
  }
}
