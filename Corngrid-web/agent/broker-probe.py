"""Read-only MT5 login verification. Credentials are read locally, never via argv/logs."""
import configparser
import json
import sys
import os
import time
from pathlib import Path


def _shutdown(mt5):
    try:
        mt5.shutdown()
    except Exception:
        pass


def _login_error(code):
    # MetaQuotes defines -10005 as an internal/IPC timeout, not proof of an
    # incorrect password: https://www.mql5.com/en/docs/python_metatrader5/mt5lasterror_py
    if code == -10005:
        return ('MT5 IPC timed out (code -10005). Check the probe terminal, broker '
                'connectivity and Windows session. EA was not started.')
    if code == -6:
        return 'Broker authorization failed (code -6). Verify the MT5 server and trading password. EA was not started.'
    return 'Broker login failed (code %s). Verify the assigned MT5 server and trading password.' % code


def probe(root, request_id, terminal_root=None):
    result = {'ok': False, 'requestId': request_id}
    sys.path.insert(0, str(Path(os.environ.get('CORNGRID_AGENT_HOME', Path(__file__).parent)) / 'broker-python'))
    try:
        import MetaTrader5 as mt5
    except ImportError:
        return dict(result, error='MetaTrader5 Python package is missing. Run agent/setup-broker-tools.ps1 on this node.')
    # Credentials still live in the instance directory. The terminal that anchors
    # the IPC pipe may be the dedicated probe keeper, which is outside every
    # sandbox: only one terminal can own port 22346, so a preflight must reuse
    # whichever one already owns it instead of starting a competing terminal.
    terminal = Path(terminal_root).resolve() if terminal_root else root
    config = configparser.ConfigParser(interpolation=None)
    config.read(root / 'config/broker-preflight.ini', encoding='utf-16')
    common = config['Common']
    expected_login = int(common['Login'])
    expected_server = common['Server']
    password = common['Password']
    try:
        # initialize() with credentials performs the login itself and creates the
        # account record the terminal needs. A bare initialize() on a fresh copy
        # never answers on the IPC pipe (code -10005), which blocked every new
        # sandbox until the login was supplied here.
        connected = False
        last_code = 0
        for attempt in range(3):
            if mt5.initialize(str(terminal / 'terminal64.exe'), portable=True,
                              login=expected_login, password=password,
                              server=expected_server, timeout=90000):
                connected = True
                break
            last_code = mt5.last_error()[0]
            _shutdown(mt5)
            if last_code not in (-10000, -10001, -10002, -10003, -10004, -10005):
                break
            if attempt < 2:
                time.sleep(3)
        if not connected:
            return dict(result, error=_login_error(last_code))
        account = mt5.account_info()
        # A terminal that was already running can still hold another account.
        if not account or account.login != expected_login or account.server.casefold() != expected_server.casefold():
            if not mt5.login(expected_login, password=password, server=expected_server, timeout=45000):
                return dict(result, error=_login_error(mt5.last_error()[0]))
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
        _shutdown(mt5)


if __name__ == '__main__':
    if len(sys.argv) == 2 and sys.argv[1] == '--check':
        sys.path.insert(0, str(Path(os.environ.get('CORNGRID_AGENT_HOME', Path(__file__).parent)) / 'broker-python'))
        import MetaTrader5 as mt5
        print(json.dumps({'ready': callable(mt5.initialize), 'version': mt5.__version__}))
        sys.exit(0)
    directory = Path(sys.argv[1]).resolve()
    request_id = sys.argv[2]
    terminal_root = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    try:
        outcome = probe(directory, request_id, terminal_root)
    except Exception:
        outcome = {'ok': False, 'requestId': request_id, 'error': 'MT5 preflight failed. Check the node tools and local startup configuration.'}
    (directory / 'config/broker-preflight-result.json').write_text(json.dumps(outcome), encoding='utf-8')
