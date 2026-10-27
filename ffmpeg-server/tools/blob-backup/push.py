#!/usr/bin/env python3
"""Trusted host timer: copy only a completed SQLite snapshot into a scoped Blob uploader."""
import fcntl
import json
from pathlib import Path
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone

ROOT = Path('/opt/v4c-ffmpeg-blob-backup')
API = 'v4c-ffmpeg-canary-api-1'
NAME = re.compile(r'^ffmpeg-server-(\d{8}T\d{6}Z)\.db$')


def run():
    with (ROOT / 'run.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        select = ('const fs=require("fs");console.log(fs.readdirSync("/backup")'
                  '.filter(n=>/^ffmpeg-server-[0-9]{8}T[0-9]{6}Z\\.db$/.test(n)).sort().at(-1)||"")')
        name = subprocess.check_output(['docker', 'exec', API, 'node', '-e', select], timeout=10, text=True).strip()
        match = NAME.fullmatch(name)
        if not match:
            raise RuntimeError('snapshot_name')
        created = datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp()
        if not -60 <= time.time() - created <= 1800:
            raise RuntimeError('stale_snapshot')
        size = int(subprocess.check_output(['docker', 'exec', API, 'stat', '-c', '%s', '/backup/' + name], timeout=10))
        if not 0 < size <= 8 * 1024**2:
            raise RuntimeError('snapshot_size_limit')
        snapshot = ROOT / 'spool' / name
        transfer = 'v4c-ffmpeg-blob-transfer-' + uuid.uuid4().hex
        try:
            subprocess.run(['docker', 'cp', API + ':/backup/' + name, str(snapshot)], check=True, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            snapshot.chmod(0o600)
            image = (ROOT / 'image-id').read_text().strip()
            if not re.fullmatch(r'sha256:[a-f0-9]{64}', image):
                raise RuntimeError('image_id')
            subprocess.run(['docker', 'run', '--rm', '--name', transfer, '--network', 'bridge', '--read-only',
                            '--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                            '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '64',
                            '--tmpfs', '/tmp:size=32m,mode=1777',
                            '-v', str(ROOT / 'spool') + ':/backup:ro',
                            '-v', str(ROOT / 'state') + ':/state:rw',
                            '-v', str(ROOT / 'blob-token') + ':/run/blob-token:ro',
                            '--entrypoint', 'node', image, '/app/blob-backup/sync.cjs', name], check=True, timeout=100)
        finally:
            subprocess.run(['docker', 'rm', '--force', transfer], timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            snapshot.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        # No raw subprocess/SDK errors, credentials, or signed URLs in journal.
        print(json.dumps({'ok': False, 'at': time.time(), 'error': 'backup_push_failed'}))
        raise SystemExit(1)
