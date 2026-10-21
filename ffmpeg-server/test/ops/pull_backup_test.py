import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'pull_backup', Path(__file__).parents[2] / 'scripts/pull-canary-backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
REAL_POPEN = subprocess.Popen


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.body = b'synthetic snapshot bytes'
        self.name = 'ffmpeg-server-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.db'
        self.hash = hashlib.sha256(self.body).hexdigest()
        self.integrity = 'ok'
        self.root_patch = patch.object(backup, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def remote(self, command):
        if 'node -e' in command:
            return self.name
        if ' verify ' in command:
            return json.dumps({'integrity': self.integrity, 'jobs': 24})
        if 'sha256sum' in command:
            return self.hash + ' file'
        if 'stat -c' in command:
            return str(len(self.body))
        self.fail('Unexpected command')

    def transfer(self, *args, **kwargs):
        return REAL_POPEN([sys.executable, '-c',
                          'import sys;sys.stdout.buffer.write(bytes.fromhex("' + self.body.hex() + '"))'],
                         **kwargs)

    def run_backup(self):
        with patch.object(backup, 'remote', side_effect=self.remote), \
             patch.object(backup.subprocess, 'Popen', side_effect=self.transfer) as transfer, \
             contextlib.redirect_stdout(io.StringIO()):
            backup.main()
            return transfer.call_count

    def test_verified_copy_and_repeat_without_duplicate_transfer(self):
        self.assertEqual(self.run_backup(), 1)
        self.assertEqual(self.run_backup(), 0)
        self.assertEqual((self.root / self.name).read_bytes(), self.body)
        self.assertEqual((self.root / self.name).stat().st_mode & 0o777, 0o600)
        self.assertTrue(json.loads((self.root / 'status.json').read_text())['ok'])

    def test_corrupted_existing_copy_is_replaced_only_after_verified_transfer(self):
        (self.root / self.name).write_bytes(b'corrupt')
        self.assertEqual(self.run_backup(), 1)
        self.assertEqual((self.root / self.name).read_bytes(), self.body)

    def test_bad_hash_leaves_no_completed_or_partial_copy(self):
        self.hash = '0' * 64
        with self.assertRaises(RuntimeError):
            self.run_backup()
        self.assertFalse((self.root / self.name).exists())
        self.assertFalse(list(self.root.glob('*.partial')))

    def test_invalid_source_name_is_rejected(self):
        self.name = '../../credentials.json'
        with self.assertRaises(RuntimeError):
            self.run_backup()

    def test_stale_snapshot_is_rejected(self):
        self.name = 'ffmpeg-server-20200101T000000Z.db'
        with self.assertRaises(RuntimeError):
            self.run_backup()

    def test_bad_integrity_is_rejected(self):
        self.integrity = 'corrupt'
        with self.assertRaises(RuntimeError):
            self.run_backup()

    def test_size_budget_is_enforced(self):
        with patch.object(backup, 'MAX_SNAPSHOT_BYTES', 1):
            with self.assertRaises(RuntimeError):
                self.run_backup()

    def test_retention_keeps_newest_and_unrelated_files(self):
        old = self.root / 'ffmpeg-server-20200101T000000Z.db'
        newest = self.root / 'ffmpeg-server-20200102T000000Z.db'
        unrelated = self.root / 'notes.txt'
        for file in (old, newest, unrelated):
            file.write_bytes(b'keep unless eligible')
        backup.prune_snapshots(self.root / self.name)
        self.assertFalse(old.exists())
        self.assertTrue(newest.exists())
        self.assertTrue(unrelated.exists())


if __name__ == '__main__':
    unittest.main()
