# CornGrid Web sebagai Windows Service

Service ini menjalankan backend `C:\Website\Website\Corngrid-web\server.js`.
Nama service: **CornGridWeb**. Nama paparan: **CornGrid Web Server**.
Ia bermula secara Automatic (Delayed Start), walaupun pengguna belum login,
dan restart selepas kegagalan proses. Akaun service lalai ialah LocalSystem.
Fail `.env` sedia ada digunakan; tiada kata laluan disalin ke konfigurasi service.

## Pemasangan

Cara paling mudah: jalankan arahan berikut dan pilih **Yes** pada UAC Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Website\Website\Corngrid-web\service\setup.ps1"
```

`setup.ps1` meminta hak Administrator, mengesan PID backend pada port 3000,
dan menyimpan keputusan di `service\install-result.json` serta `service\install.log`.
Semakan lanjut dibuat oleh installer sebelum proses sedia ada dihentikan.

Fail `CornGridWeb.exe` ialah WinSW.NET461 v2.12.0 daripada keluaran rasmi:
https://github.com/winsw/winsw/releases/tag/v2.12.0

SHA256 fail yang dibekalkan:
`B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F`

Buka **PowerShell > Run as administrator**. Semak PID backend:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 | Select-Object OwningProcess
```

Jalankan installer dengan PID tersebut, contohnya `12345`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Website\Website\Corngrid-web\service\install.ps1" -ExistingProcessId 12345
```

Jika tiada proses pada port 3000, abaikan `-ExistingProcessId`.
Installer mengesahkan port, PID dan health sebelum menggantikan proses biasa.
Jika pemasangan ditolak, backend biasa tidak dihentikan. Jika startup service gagal,
installer cuba menghidupkan semula backend sebagai proses biasa.
Port lain boleh ditetapkan melalui `-Port`; pastikan ia sama dengan konfigurasi IIS.

## Pengurusan selepas pemasangan

```powershell
Get-Service CornGridWeb
Restart-Service CornGridWeb
Stop-Service CornGridWeb
Start-Service CornGridWeb
Invoke-RestMethod http://localhost:3000/api/health
```

Selepas mengubah fail backend atau `.env`, gunakan `Restart-Service CornGridWeb`.
Jangan jalankan `node server.js` serentak kerana port akan bertembung.
Log disimpan di `service\logs`, dengan putaran log mengikut saiz.
Untuk membuang service, jalankan PowerShell Administrator:

```powershell
Stop-Service CornGridWeb
& 'C:\Website\Website\Corngrid-web\service\CornGridWeb.exe' uninstall
```

Service ini khusus untuk backend web. Sandbox Agent dan terminal MT5 kekal diurus
secara berasingan kerana terminal MT5 memerlukan pengendalian sesi desktop sendiri.
Pemasangan ini tidak mengubah IIS, akaun broker atau konfigurasi sandbox.

Rujukan konfigurasi: https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md
# Availability watchdog

Run `install-watchdog.ps1` as Administrator after deploying `watchdog.ps1` into this service directory. It checks local readiness and public health every minute. Three consecutive local readiness failures allow a website service recovery, limited to once per ten minutes. Tunnel recovery is independent: local readiness must be healthy and the public response must indicate a gateway/tunnel error (502/503/504/530), or Cloudflared must be stopped. DNS/internet failures alone never trigger tunnel restart.

Create `service/watchdog.pause` before intentional maintenance and remove it afterwards. `watchdog-state.json` records recent checks; recovery actions go into a bounded `watchdog.log`. `watchdog.ps1 -DryRun -StatePath <temporary-file>` tests decisions without restarting services. The watchdog cannot guarantee availability during power, ISP, database-provider or Cloudflare outages.
