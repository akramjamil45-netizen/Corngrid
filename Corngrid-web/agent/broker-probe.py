"""Read-only MT5 login verification. Credentials are read locally, never via argv/logs."""
import configparser
import json
import sys
import os
import time
from pathlib import Path


def probe(root, request_id):
    result = {'ok': False, 'requestId': request_id}
    sys.path.insert(0, str(Path(os.environ.get('CORNGRID_AGENT_HOME', Path(__file__).parent)) / 'broker-python'))
    try:
        import MetaTrader5 as mt5
    except ImportError:
        return dict(result, error='MetaTrader5 Python package is missing. Install it with the configured 64-bit Windows Python; see the platform node installation guide.')
    config = configparser.ConfigParser(interpolation=None)
    config.read(root / 'config/broker-preflight.ini', encoding='utf-16')
    common = config['Common']
    expected_login = int(common['Login'])
    expected_server = common['Server']
    try:
        if not mt5.initialize(str(root / 'terminal64.exe'), portable=True, timeout=45000):
            return dict(result, error='MT5 IPC connection failed (code %s). Verify the node desktop/session and broker directory.' % mt5.last_error()[0])
        account = mt5.account_info()
        if not account or account.login != expected_login or account.server.casefold() != expected_server.casefold():
            if not mt5.login(expected_login, password=common['Password'], server=expected_server, timeout=45000):
                return dict(result, error='Broker login failed (code %s). Verify the assigned MT5 server and trading password.' % mt5.last_error()[0])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            terminal = mt5.terminal_info()
            account = mt5.account_info()
            symbols = mt5.symbols_get()
            if terminal and terminal.connected and account and symbols:
                if account.login != expected_login or account.server.casefold() != expected_server.casefold():
                    return dict(result, error='MT5 account/server identity mismatch. EA was not started.')
                return dict(result, ok=True, accountNumber=str(account.login), server=account.server,
                            connected=True, tradeAllowed=bool(account.trade_allowed),
                            symbols=[{'name': s.name, 'tradeMode': s.trade_mode, 'custom': s.custom} for s in symbols])
            time.sleep(1)
        return dict(result, error='MT5 did not synchronize with the broker before timeout. EA was not started.')
    finally:
        mt5.shutdown()


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--check':
        sys.path.insert(0, str(Path(os.environ.get('CORNGRID_AGENT_HOME', Path(__file__).parent)) / 'broker-python'))
        import MetaTrader5 as mt5
        print(json.dumps({'ready': callable(mt5.initialize), 'version': mt5.__version__}))
        sys.exit(0)
    directory = Path(sys.argv[1]).resolve()
    request_id = sys.argv[2]
    try:
        outcome = probe(directory, request_id)
    except Exception:
        outcome = {'ok': False, 'requestId': request_id, 'error': 'MT5 preflight failed. Check the node tools and local startup configuration.'}
    (directory / 'config/broker-preflight-result.json').write_text(json.dumps(outcome), encoding='utf-8')
