param([string]$PythonPath='python.exe')
$ErrorActionPreference='Stop'
$target=Join-Path $PSScriptRoot 'broker-python'
& $PythonPath -m pip install --upgrade --target $target 'MetaTrader5>=5.0,<6'
if($LASTEXITCODE -ne 0){throw 'MetaTrader5 Python dependency installation failed'}
Write-Host 'Broker verification tools installed. Set mt5PythonPath in agent-config.json to this Python executable.'
