import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'observe', Path(__file__).parents[2] / 'scripts/observe-canary.py')
observe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observe)


class TtlVerdictTests(unittest.TestCase):
    def job(self, **changes):
        return dict({'http': 200, 'expiresAt': '2026-10-22T00:00:00Z',
                     'status': 'failed', 'errorCode': 'OUTPUT_EXPIRED',
                     'executionStatus': 'succeeded', 'files': 0}, **changes)

    def test_expired_job_retains_successful_execution_history(self):
        result = observe.ttl_verdict([self.job()], 1792627600)
        self.assertEqual(result['publicExpiry'], 'passed')
        self.assertEqual(result['physicalDeletionAndIdempotency'],
                         'requires_separate_verification')

    def test_not_yet_due_including_cleanup_grace(self):
        self.assertEqual(observe.ttl_verdict([self.job()], 1792627300)['publicExpiry'], 'waiting')

    def test_no_samples_is_not_a_pass(self):
        self.assertEqual(observe.ttl_verdict([], 1792627600)['publicExpiry'], 'waiting')

    def test_missing_history_retained_links_and_lost_execution_fail(self):
        for change in ({'http': 404}, {'files': 1}, {'executionStatus': None},
                       {'expiresAt': None}, {'expiresAt': 'not-a-date'},
                       {'status': 'succeeded'}, {'errorCode': 'OTHER'}):
            with self.subTest(change=change):
                self.assertEqual(observe.ttl_verdict([self.job(**change)], 1792627600)['publicExpiry'], 'failed')

    def test_failure_wins_over_waiting(self):
        jobs = [self.job(expiresAt='2026-10-23T00:00:00Z'), self.job(http=404)]
        self.assertEqual(observe.ttl_verdict(jobs, 1792627600)['publicExpiry'], 'failed')
