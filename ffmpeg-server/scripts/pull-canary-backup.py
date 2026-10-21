#!/usr/bin/env python3
"""Pull verified SQLite snapshots over existing SSH; never copies media or keys."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shlex
import threading
import subprocess
import time

ROOT = Path.home() / 'Library/Application Support/viral4creators/ffmpeg-backups'
NAME = re.compile(r'^ffmpeg-server-(\d{8}T\d{6}Z)\.db$')
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'relay']
CONTAINER = 'v4c-ffmpeg-canary-api-1'
MAX_SNAPSHOT_BYTES = 512 * 1024**2
MAX_LOCAL_BYTES = 2 * 1024**3


def remote(command):
    return subprocess.check_output(SSH + [command], timeout=30, stderr=subprocess.DEVNULL).decode().strip()


def prune_snapshots(keep):
    snapshots = [path for path in ROOT.iterdir() if NAME.fullmatch(path.name)]
    newest = max(snapshots, key=lambda path: path.name, default=None)
    cutoff = time.time() - 7 * 86400
    for path in snapshots:
        if path in (keep, newest):
            continue
        stamp = datetime.strptime(NAME.fullmatch(path.name)[1], '%Y%m%dT%H%M%SZ')
        if stamp.replace(tzinfo=timezone.utc).timestamp() < cutoff:
            path.unlink()


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    ROOT.chmod(0o700)
    selector = ('const fs=require("node:fs");console.log(fs.readdirSync("/backup")'
                '.filter(n=>/^ffmpeg-server-[0-9]{8}T[0-9]{6}Z\\.db$/.test(n))'
                '.sort().at(-1)||"")')
    name = remote('docker exec ' + CONTAINER + ' node -e ' + shlex.quote(selector))
    match = NAME.fullmatch(name)
    if not match:
        raise RuntimeError('No valid completed backup')
    created = datetime.strptime(match[1], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).timestamp()
    if time.time() - created > 1800:
        raise RuntimeError('Remote backup older than 30 minutes')
    source = '/backup/' + name
    verification = json.loads(remote('docker exec ' + CONTAINER + ' node dist/ops/cli.js verify ' + source))
    if verification.get('integrity') != 'ok':
        raise RuntimeError('Remote backup integrity failed')
    target = ROOT / name
    prune_snapshots(target)
    expected = remote('docker exec ' + CONTAINER + ' sha256sum ' + source).split()[0]
    if not target.exists() or file_digest(target) != expected:
        total = sum(p.stat().st_size for p in ROOT.iterdir() if NAME.fullmatch(p.name))
        expected_size = int(remote('docker exec ' + CONTAINER + ' stat -c %s ' + source))
        if expected_size > MAX_SNAPSHOT_BYTES or total + expected_size > MAX_LOCAL_BYTES:
            raise RuntimeError('Local backup budget needs operator attention')
        temporary = ROOT / (name + '.partial')
        digest = hashlib.sha256()
        try:
            with temporary.open('wb') as out:
                temporary.chmod(0o600)
                process = subprocess.Popen(SSH + ['docker exec ' + CONTAINER + ' cat ' + source],
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                timer = threading.Timer(60, process.kill)
                timer.start()
                size = 0
                try:
                    while chunk := process.stdout.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_SNAPSHOT_BYTES:
                            raise RuntimeError('Snapshot exceeds local safety limit')
                        digest.update(chunk)
                        out.write(chunk)
                    if process.wait(timeout=30) != 0 or digest.hexdigest() != expected:
                        raise RuntimeError('Snapshot transfer verification failed')
                finally:
                    timer.cancel()
                    process.stdout.close()
                    if process.poll() is None:
                        process.kill()
                        process.wait()
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    prune_snapshots(target)
    status = {'ok': True, 'lastSuccessAt': time.time(), 'snapshotCreatedAt': created,
              'snapshot': name, 'bytes': target.stat().st_size,
              'integrity': verification['integrity'], 'jobs': verification['jobs']}
    save_status(status)
    print(json.dumps(status))


def save_status(status):
    path = ROOT / 'status.json'
    path.write_text(json.dumps(status, indent=2))
    path.chmod(0o600)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No SSH diagnostics, credentials or source URLs in persistent logs.
        ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        save_status({'ok': False, 'at': time.time(), 'errorType': type(error).__name__})
        raise SystemExit(1)
