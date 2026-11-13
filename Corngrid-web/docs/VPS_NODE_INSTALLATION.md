# Pasang CornGrid Node pada VPS Windows baharu

Disemak pada **13 November 2026** mengikut agent dalam repository ini.

Node ialah VPS Windows yang menjalankan agent dan terminal MT5. Website, IIS,
database, Stripe keys dan `.env` backend kekal di server CornGrid utama. Agent
membuat sambungan keluar ke `https://corngrid.com` / WSS port 443; MT5 juga perlu
mencapai server broker. Tiada inbound port agent atau port forwarding diperlukan.

## 1. Keperluan VPS

| Perkara | Keperluan |
| --- | --- |
| OS | Windows x64 dengan Desktop Experience/RDP; broker discovery menggunakan tetingkap MT5 berbahasa English |
| Node.js | Node.js **24 LTS x64** sebagai baseline panduan; minimum kod 20.17.0 tidak bermaksud Node 20 masih disokong |
| Python | **Python 3.13 x64** dan pakej MetaTrader5 untuk semakan login serta simbol |
| MT5 | Folder program lengkap dan bersih, dengan `terminal64.exe`; test node compile turut memerlukan `metaeditor64.exe` |
| Network | HTTPS/WSS keluar ke CornGrid, internet broker serta DNS yang berfungsi |
| Akaun Windows | Gunakan akaun/sesi yang sama semasa setup MT5 dan menjalankan agent |

Install daripada [Node.js](https://nodejs.org/en/download),
[Python Windows](https://www.python.org/downloads/windows/) dan
[MetaTrader 5](https://www.metatrader5.com/en/download) atau laman rasmi broker.
Gunakan release LTS yang masih disokong. Menurut [jadual Node.js](https://nodejs.org/en/about/previous-releases)
yang disemak pada tarikh di atas, Node 20 sudah EOL. Linux/Wine dan Server Core
tidak disahkan untuk workflow broker discovery projek ini.

Mulakan kapasiti **1 sandbox** dan tambah selepas melihat CPU/RAM/disk sebenar.
Menambah nilai capacity tidak menambah CPU atau RAM VPS secara fizikal.

Semak sumber sebelum memasang dan sekali lagi selepas agent berjalan:

```powershell
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
    TotalRamMB = [math]::Round($os.TotalVisibleMemorySize / 1024)
    FreeRamMB = [math]::Round($os.FreePhysicalMemory / 1024)
    FreeDiskMB = [math]::Round(([IO.DriveInfo]'C:\').AvailableFreeSpace / 1MB)
}
```

Ruang mesti cukup untuk Windows, Python, terminal setiap sandbox, cache broker
serta versi agent semasa dan sebelumnya. Pemeriksaan ruang updater bukan ukuran
kapasiti hosting. VPS 1.5 GB yang diuji hanya berbaki sekitar 299 MB RAM dan
944 MB disk selepas pembersihan; agent boleh online tetapi node itu dikekalkan
**Pending** dan belum diuji dengan beban trading. Jangan menjanjikan dua sandbox
hanya berdasarkan jumlah RAM pada pelan VPS.

## 2. Gunakan ZIP semasa

Ambil `CornGrid-Node-Agent.zip` di root salinan projek. ZIP lama sebelum pembaikan
ini belum mengandungi `source-compiler.js` dan tidak sesuai dengan agent semasa.
Pakej baharu mempunyai 23 fail agent, lima dokumen dan `MANIFEST.json` dengan
SHA-256 setiap fail. Ia tidak mengandungi token, config sebenar, broker account,
EA executable pelanggan, `node_modules` atau runtime data.

Untuk membinanya semula selepas perubahan agent, jalankan dari root Website pada
komputer sumber:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Corngrid-web\scripts\build-node-agent.ps1'
```

ZIP hanya dibina daripada allowlist; jangan ZIP seluruh folder agent yang sedang
berjalan kerana folder itu mempunyai `agent-config.json` dan mungkin log/data sulit.

## 3. Sediakan folder VPS baharu

Copy ZIP ke Downloads VPS. Contoh arahan ini untuk pemasangan baharu sahaja:

```powershell
New-Item -ItemType Directory -Force -Path 'C:\CornGrid'
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\CornGrid-Node-Agent.zip" -DestinationPath 'C:\CornGrid'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\MT5'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\Users'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\AgentData'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\BrokerCaches'
```

Jika menggunakan RDP drive redirection (`\\tsclient\C\...`), salin ZIP dan skrip
ke disk tempatan VPS dahulu, kemudian jalankan dari situ. Sambungan RDP yang
terputus atau pemindahan ZIP yang perlahan boleh menyebabkan pemasangan tersangkut.
Jangan extract ZIP dengan `-Force` ke agent hidup atau menimpa config node lama.

Copy folder program MT5 yang lengkap, bersih dan English ke `Sandbox\MT5`.
Tutup terminal asas sebelum menyalin; jangan gunakan data folder pelanggan atau
terminal yang sedang trading. `MT5`, `Users`, `AgentData` dan `BrokerCaches` perlu
folder berasingan, bukan berada di dalam satu sama lain. Pastikan akaun agent
boleh membaca program MT5 dan menulis ke folder kerja.

## 4. Daftar identiti node baharu

Di **Admin → Sandbox Management → Add node**:

1. Isi nama VPS yang unik, contohnya `VPS-Hosting-02` dan capacity `1`.
2. Hosting pelanggan: biarkan **Test node** tidak ditanda.
3. Simpan Node ID dan token yang dipaparkan sekali sahaja.
4. Kekalkan **Pending** semasa menyediakan runtime, token, startup dan pemeriksaan
   sumber. Selepas semuanya lulus dan anda bersedia menguji satu sandbox demo,
   aktifkan node. `Active` ialah kebenaran admin; `Online` bermaksud heartbeat
   daripada agent diterima. Kedua-duanya diperlukan untuk penempatan sandbox.

Setiap VPS mesti mempunyai Node ID/token sendiri. Jangan menyalin identiti node
lama; dua agent dengan identiti sama boleh berebut sambungan dan arahan. Jika
token hilang, Rotate token untuk node tersebut dan kemas kini config pada VPS itu.

## 5. Dependency, Python dan konfigurasi

Pada VPS baharu:

```powershell
Set-Location -LiteralPath 'C:\CornGrid\agent'
node --version
npm.cmd --version
npm.cmd ci --omit=dev
Copy-Item -LiteralPath '.\agent-config.example.json' -Destination '.\agent-config.json'
```

Install alat broker dengan Python x64 yang dipasang pada VPS. Gantikan contoh
path dengan lokasi sebenar interpreter anda:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\setup-broker-tools.ps1' -PythonPath 'C:\Python313\python.exe'
notepad.exe '.\agent-config.json'
```

`setup-broker-tools.ps1` memasang pakej ke `agent\broker-python`. Jika pip tiada
wheel serasi, semak versi Python dan bahawa ia x64. Installer Python sendiri
tidak memasang pakej MetaTrader5.

Jika import NumPy melaporkan CPU tidak menyokong `X86_V2`, VPS menggunakan CPU
maya lama. NumPy 2.4 menaikkan baseline CPU Windows x64. Dalam direktori alat
broker ini sahaja, pasang versi serasi dan semak import sekali lagi:

```powershell
& 'C:\Python313\python.exe' -m pip install --upgrade --no-cache-dir --target '.\broker-python' 'MetaTrader5>=5.0,<6' 'numpy<2.4'
node .\check-installation.js --online
```

Gunakan interpreter sebenar pada VPS. Kekalkan constraint tersebut ketika
update sehingga CPU VPS ditukar dan diuji semula; jangan downgrade Python atau
dependency aplikasi lain secara global.

```json
{
  "backendUrl": "https://corngrid.com",
  "nodeUid": "GANTIKAN_DENGAN_NODE_ID_BAHARU",
  "nodeToken": "GANTIKAN_DENGAN_TOKEN_BAHARU",
  "mt5BaseDir": "C:\\CornGrid\\Sandbox\\MT5",
  "sandboxUsersDir": "C:\\CornGrid\\Sandbox\\Users",
  "agentDataDir": "C:\\CornGrid\\Sandbox\\AgentData",
  "brokerCacheDir": "C:\\CornGrid\\Sandbox\\BrokerCaches",
  "mt5PythonPath": "C:\\Python313\\python.exe",
  "heartbeatIntervalMs": 15000,
  "brokerSymbolMaps": {},
  "brokerAccountSymbolMaps": {}
}
```

Gunakan origin awam CornGrid, bukan `localhost:3000`: localhost bermaksud VPS
baharu itu sendiri. Pemboleh ubah `CORNGRID_*` pada Windows mengatasi config JSON;
semak jika pernah menyediakan environment daripada setup lama. Lindungi config
dengan ACL yang membenarkan hanya akaun agent, SYSTEM dan administrator yang
perlu mengaksesnya. Jangan hantar config/token dalam chat atau commit Git.

Contoh ACL, dijalankan sebagai administrator dalam akaun yang akan menjalankan
agent. Untuk akaun lain, gantikan SID pengguna dengan SID akaun task sebenar:

```powershell
$configPath = 'C:\CornGrid\agent\agent-config.json'
$agentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls.exe $configPath /inheritance:r /grant:r ('*' + $agentSid + ':F') '*S-1-5-18:F' '*S-1-5-32-544:F'
if ($LASTEXITCODE -ne 0) { throw 'Gagal melindungi konfigurasi agent.' }
```

## 6. Broker, WebRequest dan simbol

Agent memeriksa login broker menggunakan terminal preflight tanpa EA, kemudian
memilih simbol yang benar-benar tersedia pada akaun tersebut. Ia tidak menukar
server atau akaun secara tekaan. Nama server tepat dan password trading diperlukan.

Sediakan satu terminal profil berasingan pada VPS menggunakan akaun Windows yang
sama. Buka MT5 → **Tools → Options → Expert Advisors**, dan benarkan URL untuk EA:

```text
https://corngrid.com
https://control.corngrid.com
https://nfs.faireconomy.media
```

Ini URL yang digunakan CornGrid EA; EA partner mungkin mempunyai keperluan lain.
Tutup terminal selepas menyimpan. Gunakan **File → Open Data Folder** untuk
mengenal pasti data sebenar. Jangan menganggap data semestinya di folder program.

Contoh tambahan config, digabungkan ke objek JSON di atas:

```json
{
  "webRequestSettingsSource": "C:\\CornGrid\\BrokerProfiles\\LiteFinance\\config\\common.ini",
  "brokerServerDataDirs": {
    "LiteFinance-MT5-Demo": "C:\\CornGrid\\BrokerProfiles\\LiteFinance"
  },
  "brokerSymbolMaps": {
    "LiteFinance-MT5-Demo": { "XAUUSD": "XAUUSD_l" }
  }
}
```

Profil `BrokerProfiles\LiteFinance` ialah salinan MT5 berasingan yang anda sediakan
sendiri. Ubah path kepada Data Folder sebenar. Seed broker hanya menyalin
`config\servers.dat`, bukan akaun/password. Seed ini pilihan; discovery boleh
menyediakan cache. Agent menggunakan exact symbol atau varian unik. Pemetaan
manual diperlukan jika beberapa varian sepadan; `_l` di atas ialah contoh sahaja.
`brokerAccountSymbolMaps` boleh mengatasi mapping server untuk akaun tertentu.

## 7. Semak pemasangan dan jalankan manual dahulu

```powershell
Set-Location -LiteralPath 'C:\CornGrid\agent'
node .\check-installation.js --online
node .\agent-launcher.js --trust-update-key
node .\agent-launcher.js
```

Arahan trust dijalankan **sekali sahaja** selepas backend menyediakan signed
auto-update. Ia menulis `update-trust.pem` dan menolak penggantian kunci sedia
ada. Jika sudah dipasang, kekalkan pin itu dan langkau arahan trust; jangan padam
pin untuk mengatasi ralat. `agent.js` secara terus ialah mod diagnosis tanpa
supervisor dan tidak mengaktifkan release automatik.

Baiki semua `FAIL` dahulu. Checker memeriksa fail, config, folder, Python import,
HTTPS health dan token melalui endpoint baca sahaja. Ia tidak membuka MT5,
mengambil arahan, menghantar heartbeat atau mengambil alih WebSocket node hidup.
Ia juga tidak membuktikan broker login, WebRequest, ACL, trading atau WSS berfungsi.

Agent sebenar patut melaporkan MT5 base validated dan backend WebSocket connected.
Jika WSS gagal, HTTPS heartbeat/polling ialah fallback. Pastikan proxy/WAF tidak
mengenakan browser challenge pada `/api/sandbox/node/*` atau `/ws/sandbox/node`;
kekalkan pengesahan token. Dalam admin, tunggu heartbeat kira-kira 15 saat dan
semak CPU/RAM/last heartbeat. Selepas sekitar 90 saat tanpa heartbeat, node offline.

Hanya satu agent patut menggunakan satu Node ID. Hentikan manual dengan `Ctrl+C`
sebelum menghidupkan Scheduled Task.

## 8. Startup automatik — akaun interaktif disyorkan

Installer baharu menggunakan **Interactive** sebagai default supaya broker
discovery dan MT5 beroperasi dalam sesi Windows yang sama. Pada VPS, buka
PowerShell **Run as administrator** menggunakan akaun setup MT5:

```powershell
Set-Location -LiteralPath 'C:\CornGrid\agent'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\install-service.ps1' -Mode Interactive -TaskName CornGridSandboxManagedAgent
Get-ScheduledTask -TaskName 'CornGridSandboxManagedAgent'
Get-ScheduledTaskInfo -TaskName 'CornGridSandboxManagedAgent'
```

Contoh ini menggunakan nama `CornGridSandboxManagedAgent`; default installer
tanpa `-TaskName` ialah `CornGridSandboxAgent`. Gunakan nama task sebenar ketika
menyemak atau melakukan maintenance. Jika Windows melaporkan skrip disekat,
gunakan invocation `powershell.exe ... -ExecutionPolicy Bypass -File ...` di atas
untuk proses pemasangan itu sahaja; polisi mesin tidak perlu ditukar kekal.

Task bermula selepas akaun itu login, tiada execution time limit dan menggunakan
`IgnoreNew` untuk mengelakkan task kedua. Trigger tambahan setiap satu minit
memulihkan agent yang telah keluar, termasuk apabila Windows menganggap exit
code bukan sifar sebagai task selesai. Ia tidak menghentikan agent yang masih
Running atau terminal MT5. Disable task sebelum maintenance stop supaya trigger
tidak memulakannya semula. `-UserId
'NAMA-VPS\CornGridAgent'` memilih akaun lain yang sudah disediakan. Akaun itu
mesti mempunyai sesi login dan kebenaran folder. Selepas reboot, login dahulu;
RDP Disconnect dan Sign out ialah tindakan berbeza. Semak polisi VPS/RDP yang
mungkin menamatkan sesi yang disconnected. Jangan anggap mode ini berjalan
sebelum login atau selepas sign out. Uji pemulihan selepas reboot sebenar.

Installer menolak task sedia ada secara default dan tidak menghentikan task yang
Running. Untuk pembaharuan yang disengajakan selepas maintenance stop, gunakan
`-Replace`. `-NoStart` melangkau start serta-merta, tetapi trigger berjadual
masih aktif. `-WhatIf` tidak mendaftar atau memulakan
task. Installer tidak menukar task pada VPS lama secara automatik.

Mode SYSTEM ketika boot ialah pilihan lanjutan:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\install-service.ps1' -Mode System
```

SYSTEM/NSSM menggunakan konteks Windows yang berbeza. Ia boleh menunjukkan node
Online walaupun discovery broker, UI MT5 atau WebRequest terlindung gagal.
Gunakan hanya selepas ujian demo dalam konteks tersebut berjaya. Memasang NSSM
sahaja tidak menyelesaikan perbezaan sesi ini.

## 9. Ujian penerimaan pada node baharu

1. Pastikan Active, Online, bukan Test node dan mempunyai slot.
2. Gunakan akaun CornGrid berlangganan dan akaun broker **demo**.
3. Activate satu sandbox; semak **Assigned node**. Load balancing boleh memilih
   node lain, jadi jangan menganggap node baharu dipilih secara automatik.
4. Semak terminal, Journal/Experts, server, simbol, EA/preset dan heartbeat akaun.
5. Uji stop/start dan pemulihan selepas reboot dalam maintenance window.

`Node Online`, `Sandbox Running`, `Broker Connected` dan `EA telemetry` ialah
empat bukti berbeza. Proses terminal berjalan bukan bukti login atau EA trading.
EA partner menggunakan fail dan preset sendiri; telemetry CornGrid memerlukan
sokongan daripada kod EA itu. Menambah node tidak memindahkan sandbox lama.

## 10. Test node untuk review EA partner

Daftar node **berasingan** dengan Test node ditanda. Ia tidak menerima hosting
pengguna biasa. Letakkan MetaEditor dalam MT5 base dan jalankan:

```powershell
node .\check-installation.js --online --test-node
```

Admin boleh queue compile MQ5 melalui EA Submissions. Agent memerlukan
`ea-tester.js`, `source-compiler.js` dan `transport.js` versi sepadan. Ia memuat
naik EX5 hasil compile sebelum membersihkan workspace. ZIP project memerlukan
compile/review manual. Compile report tidak membuktikan prestasi atau runtime
trading; lihat dokumen Partner Publication dalam ZIP.

## 11. Update dan diagnosis

Untuk kemas kini kod agent biasa, gunakan signed auto-update di bahagian berikut.
Tidak perlu menyalin ZIP ke setiap VPS atau menghentikan MT5. Node.js, Python,
runtime MT5, trust anchor dan perubahan protokol bootstrap masih memerlukan
maintenance berasingan.

Jika pembaikan manual diperlukan, backup config VPS dahulu. Jadualkan maintenance
sebelum menghentikan task atau menukar akaun Windows; jangan anggap forced task
stop mengekalkan semua child process. Copy kod daripada ZIP baharu sambil
mengekalkan config/token node ini. Gunakan `npm.cmd ci --omit=dev` jika lockfile
berubah. Jalankan checker, hidupkan agent dan sahkan semula sandbox. Jangan padam
`Sandbox\Users` untuk update.

Semak log `agentDataDir\agent-updater.log`, `agent-active-release.json` dan
`agent-update-failure.json` serta versi pada Admin. Berjaya download sahaja belum
membuktikan activation; semak mesej healthy dan heartbeat selepas pertukaran.

| Masalah | Semakan |
| --- | --- |
| Cannot find module source-compiler / broker-resolution | ZIP lama atau fail tidak lengkap; gunakan bundle baharu |
| Node Online tetapi deploy gagal | Python x64/MetaTrader5, English MT5, sesi akaun Windows dan Deployment Logs |
| Login broker gagal | Nama server, password trading, capaian broker dan Journal; Online tidak membuktikan broker boleh dicapai |
| Manual berjaya, task gagal | Principal task/SYSTEM, session, ACL, Python path dan WebRequest template |
| WebRequest 4014 | Allowed URLs dan konteks EA; WebRequest tidak dijalankan dalam Strategy Tester |
| Tiada slot | Capacity node, status Active/Online dan had activation subscription ialah had berasingan |

## 12. Pembersihan VPS dan penerimaan hosting

Nyahpasang aplikasi yang tidak diperlukan menggunakan uninstaller vendor.
Pembuangan MT4 atau Firefox tidak memerlukan pemadaman profil/data akaun trading.
Tutup konsol pemasangan selepas selesai untuk membebaskan RAM. Browser background
mode boleh dimatikan; jangan mematikan antivirus, firewall, RDP, Task Scheduler,
servis rangkaian atau Windows Update untuk menjadikan VPS kelihatan lebih ringan.

Untuk cache, pilih folder sementara yang dikenal pasti, langkau fail digunakan
dan reparse points, dan sahkan absolute path sebelum memadam. Jangan padam
`WinSxS`, Windows Installer cache, `Sandbox\Users`, config broker atau credential
untuk mendapatkan ruang. Backup konfigurasi sebelum menukar servis pilihan;
mematikan Print Spooler mematikan printing dan WSearch mematikan indexing.

Selepas perubahan, semak semula checker, heartbeat, RAM/disk dan MT5 sedia ada.
Kekalkan Pending jika ruang tidak memadai, walaupun status Online. Aktifkan
hosting hanya selepas ujian demo dan pemulihan yang diterangkan di atas.

## Kemas kini agent automatik

Agent 1.2 menggunakan `agent-launcher.js` untuk menukar versi tanpa menamatkan
task induk. Sebelum memasang task baharu, jalankan
`node .\agent-launcher.js --trust-update-key` sekali untuk pin kunci awam server.
Server mesti sudah menyediakan release bertandatangan. Bagi task lama yang
sedang hosting, ikut prosedur handover dalam
[NODE_AUTO_UPDATES.md](NODE_AUTO_UPDATES.md); jangan force-stop proses MT5.
Selepas bootstrap, deploy kod dan `RELEASE.json` di server pusat sahaja. Node
mengambil release secara berkala, menyemak tandatangan/hash dan rollback apabila
agent baharu gagal pemeriksaan kesihatan. Konfigurasi, lesen dan data MT5 kekal.

## Rujukan rasmi

- [Microsoft Scheduled Task principal](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal)
- [Microsoft repetition duration](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-duration-repetitiontype-element)
- [NumPy 2.4 CPU baseline](https://numpy.org/doc/stable/release/2.4.0-notes.html)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
- [MT5 Python integration](https://www.mql5.com/en/docs/python_metatrader5)
- [MT5 portable/startup](https://www.metatrader5.com/en/terminal/help/start_advanced/start)
- [MQL5 WebRequest](https://www.mql5.com/en/docs/network/webrequest)
