import configparser
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / 'broker-python'))
import MetaTrader5 as mt5

root = Path('C:/CornGrid/Sandbox/Users/sbx_5d70f3b9d9a6c652b4')
result_path = Path(__file__).with_name('broker-python-result.json')
config = configparser.ConfigParser(interpolation=None)
config.read(root / 'config/sandbox-startup.ini', encoding='utf-16')
common = config['Common']
result = {'started': time.time()}
try:
    result['initialized'] = mt5.initialize(str(root / 'terminal64.exe'),
        login=int(common['Login']), password=common['Password'],
        server=common['Server'], timeout=60000, portable=True)
    result['error'] = mt5.last_error()
    if result['initialized']:
        terminal = mt5.terminal_info()
        account = mt5.account_info()
        result['terminal'] = {k: getattr(terminal, k, None) for k in ['connected', 'path', 'data_path', 'trade_allowed', 'ping_last']}
        result['account'] = {k: getattr(account, k, None) for k in ['login', 'server', 'balance', 'equity', 'trade_mode', 'trade_allowed']}
finally:
    mt5.shutdown()
    result['finished'] = time.time()
    result_path.write_text(json.dumps(result, indent=2), encoding='utf-8')
