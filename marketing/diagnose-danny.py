import configparser,json,sys,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'broker-python'))
import MetaTrader5 as mt5
root=Path('C:/CornGrid/Sandbox/Users/sbx_4ee7c0937ec602a4a8')
config=configparser.ConfigParser(interpolation=None)
config.read(root/'config/sandbox-startup.ini',encoding='utf-16')
common=config['Common']
try:
    options={} if '--status' in sys.argv else {'login':int(common['Login']),'password':common['Password'],'server':common['Server']}
    initialized=mt5.initialize(str(root/'terminal64.exe'),timeout=45000,portable=True,**options)
    result={'initialized':initialized,'error':mt5.last_error()}
    if initialized:
        t=mt5.terminal_info(); a=mt5.account_info()
        result['terminal']={k:getattr(t,k,None) for k in ['connected','trade_allowed','path','data_path']}
        result['account']={k:getattr(a,k,None) for k in ['login','server','balance','equity','trade_allowed']}
        result['goldSymbols']=[s.name for s in (mt5.symbols_get() or []) if 'XAU' in s.name.upper() or 'GOLD' in s.name.upper()]
        symbol=mt5.symbol_info('XAUUSD');tick=mt5.symbol_info_tick('XAUUSD')
        result['chartSymbol']={k:getattr(symbol,k,None) for k in ['name','select','visible','trade_mode']}
        result['tick']={k:getattr(tick,k,None) for k in ['time','bid','ask']}
    print(json.dumps(result))
finally:mt5.shutdown()
