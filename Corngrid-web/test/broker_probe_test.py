import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('broker_probe', Path(__file__).parents[1] / 'agent/broker-probe.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class BrokerProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cg-probe-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'config').mkdir()
        (self.root / 'config/broker-preflight.ini').write_text('[Common]\nLogin=123456\nServer=JustMarkets-DEMO6\nPassword=fixture-only\n', encoding='utf-16')

    def fake(self, **changes):
        account = types.SimpleNamespace(login=123456, server='JustMarkets-Demo6', trade_allowed=True)
        symbol = types.SimpleNamespace(name='XAUUSD.c', trade_mode=4, custom=False)
        values = dict(initialize=lambda *a, **kw: True, shutdown=lambda: None,
                      login=lambda *a, **kw: False, last_error=lambda: (-6, 'Authentication failed'),
                      account_info=lambda: account, terminal_info=lambda: types.SimpleNamespace(connected=True),
                      symbols_get=lambda: [symbol])
        values.update(changes)
        return types.SimpleNamespace(**values)

    def test_success_only_reads_account_and_symbols(self):
        with patch.dict(sys.modules, MetaTrader5=self.fake()):
            result = worker.probe(self.root, 'nonce')
        self.assertTrue(result['ok'])
        self.assertEqual(result['server'], 'JustMarkets-Demo6')
        self.assertEqual(result['symbols'][0]['name'], 'XAUUSD.c')
        self.assertNotIn('fixture-only', str(result))

    def test_ipc_failure_has_no_password(self):
        with patch.dict(sys.modules, MetaTrader5=self.fake(initialize=lambda *a, **kw: False,
                        last_error=lambda: (-10005, 'timeout'))), patch.object(worker.time, 'sleep'):
            result = worker.probe(self.root, 'nonce')
        self.assertFalse(result['ok'])
        self.assertIn('IPC', result['error'])
        self.assertNotIn('fixture-only', str(result))

    def test_wrong_account_cannot_be_reported_as_success(self):
        fake = self.fake(account_info=lambda: types.SimpleNamespace(login=999, server='Other-Live', trade_allowed=True))
        with patch.dict(sys.modules, MetaTrader5=fake):
            result = worker.probe(self.root, 'nonce')
        self.assertFalse(result['ok'])
        self.assertIn('authorization failed', result['error'])

    def test_investor_password_is_identified_for_agent_to_reject(self):
        fake = self.fake(account_info=lambda: types.SimpleNamespace(login=123456, server='JustMarkets-Demo6', trade_allowed=False))
        with patch.dict(sys.modules, MetaTrader5=fake):
            result = worker.probe(self.root, 'nonce')
        self.assertFalse(result['tradeAllowed'])

    def test_fresh_install_passes_credentials_to_initialize_on_the_keeper(self):
        received = []
        def initialize(*args, **kwargs):
            received.append((args, kwargs))
            return kwargs.get('login') == 123456 and kwargs.get('password') == 'fixture-only'
        keeper = self.root / 'keeper'
        with patch.dict(sys.modules, MetaTrader5=self.fake(initialize=initialize)):
            result = worker.probe(self.root, 'nonce', keeper)
        self.assertTrue(result['ok'])
        self.assertEqual(received[0][0][0], str(keeper.resolve() / 'terminal64.exe'))
        self.assertEqual(received[0][1]['server'], 'JustMarkets-DEMO6')

    def test_transient_ipc_timeout_retries_but_wrong_password_does_not(self):
        for code, count in [(-10005, 3), (-6, 1)]:
            calls = []
            def initialize(*args, **kwargs):
                calls.append(kwargs)
                return False
            with patch.dict(sys.modules, MetaTrader5=self.fake(initialize=initialize,
                            last_error=lambda: (code, 'fixture'))), patch.object(worker.time, 'sleep'):
                result = worker.probe(self.root, 'nonce')
            self.assertFalse(result['ok'])
            self.assertEqual(len(calls), count)
            self.assertNotIn('fixture-only', str(result))

    def test_transient_failure_can_recover_and_revalidates_identity(self):
        outcomes = iter([False, True])
        with patch.dict(sys.modules, MetaTrader5=self.fake(initialize=lambda *a, **kw: next(outcomes),
                        last_error=lambda: (-10005, 'timeout'))), patch.object(worker.time, 'sleep'):
            result = worker.probe(self.root, 'nonce')
        self.assertTrue(result['ok'])


if __name__ == '__main__':
    unittest.main()
