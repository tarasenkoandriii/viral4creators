#!/usr/bin/env python3
"""Read-only, bounded 25-hour observation of synthetic canary operations."""
import json
from pathlib import Path
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path('/opt/v4c-ffmpeg-canary')


def main():
    now = time.time()
    state = ROOT / 'observation-state.json'
    if not state.exists():
        state.write_text(json.dumps({'startedAt': now, 'finishAfter': now + 25 * 3600}))
    window = json.loads(state.read_text())
    key = json.loads((ROOT / 'credentials.json').read_text())['ops']

    def get(path):
        request = Request('http://127.0.0.1:18090' + path,
                          headers={'Authorization': 'Bearer ' + key})
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, {}

    ids = []
    for name in ('batch-result.json', 'probe-result.json', 'load-result.json',
                 'trace-result.json'):
        path = ROOT / name
        if not path.exists():
            continue
        records = json.loads(path.read_text())
        if isinstance(records, list):
            ids.extend(record['id'] for record in records)
        else:
            ids.append(records['id'])

    row = {'at': now, 'elapsedHours': round((now - window['startedAt']) / 3600, 3)}
    try:
        row['health'] = get('/api/health')[0]
        status, response = get('/api/ready')
        row['readiness'] = {'http': status, **response.get('data', {})}
        jobs = []
        for job_id in dict.fromkeys(ids):
            status, response = get('/api/jobs/' + job_id)
            job = response.get('data', {})
            # Do not persist output URLs, signatures, commands or credentials.
            jobs.append({'id': job_id, 'http': status, 'status': job.get('status'),
                         'errorCode': job.get('error_code'),
                         'expiresAt': job.get('expires_at'),
                         'files': len(job.get('output_files', {}))})
        row['jobs'] = jobs
    except Exception as error:
        # Avoid logging an exception message that could contain request details.
        row['errorType'] = type(error).__name__

    log = ROOT / 'observation.jsonl'
    lines = log.read_text().splitlines()[-299:] if log.exists() else []
    lines.append(json.dumps(row))
    log.write_text('\n'.join(lines) + '\n')
    log.chmod(0o600)
    finished = now >= window['finishAfter']
    if finished:
        (ROOT / 'observation-finished.json').write_text(json.dumps(row, indent=2))
        subprocess.run(['systemctl', 'disable', '--now', 'v4c-ffmpeg-observe.timer'],
                       check=True)
    print(json.dumps({'health': row.get('health'), 'samples': len(lines),
                      'finished': finished}))


if __name__ == '__main__':
    main()
