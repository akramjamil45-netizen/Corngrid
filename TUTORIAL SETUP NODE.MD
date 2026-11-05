# TUTORIAL SETUP NODE CORNGRID

Panduan menambah komputer Windows lain untuk menjalankan sandbox MT5 dan menyambungkannya kepada CornGrid Web.

## 1. Faham dahulu: web server dan node server

Bayangkan CornGrid Web sebagai pusat kawalan, dan node sebagai komputer yang membuat kerja.

- **CornGrid Web**: tempat pengguna login, membuat langganan, memilih EA/pair dan menekan Activate Sandbox.
- **Node**: komputer Windows yang menjalankan CornGrid Agent dan terminal-terminal MT5 pengguna.
- **CornGrid Agent**: program kecil yang menerima arahan daripada web dan melaporkan keadaan node.

```text
Pengguna buka https://corngrid.com
                  |
          CornGrid Web Server
                  |
       Internet: HTTPS / WSS, port 443
                  |
        Komputer Node Windows
          |       |       |
        MT5 A   MT5 B   MT5 C
```

Komputer node tidak perlu menyimpan salinan database web atau menjalankan `server.js`. Anda tidak perlu memasang IIS atau PostgreSQL pada node hanya untuk hosting sandbox.

Agent membuat sambungan keluar ke CornGrid Web. Node tidak memerlukan IP awam atau port forwarding untuk menerima arahan agent. MT5 juga memerlukan sambungan keluar ke server broker masing-masing.

## 2. Apa yang perlu install atau copy?

| Perkara | Perlu? | Kegunaan |
| --- | --- | --- |
| Windows 64-bit yang disokong Node.js dan MT5 | Ya | Sistem operasi komputer node |
| Node.js LTS, Windows x64 Installer `.msi` | Ya | Menjalankan agent; projek memerlukan Node.js 20.17.0 atau lebih baharu |
| Folder program MetaTrader 5 lengkap | Ya | Menjadi terminal asas yang agent salin bagi setiap sandbox |
| Folder `agent` CornGrid | Ya | Menghubungkan node dengan web dan mengurus MT5 |
| `agent-config.json` baharu | Ya | Identiti node dan lokasi folder pada komputer ini |
| `metaeditor64.exe` | Untuk node ujian EA | Mengkompil source EA; biasanya disertakan bersama pemasangan MT5 |
| Seluruh folder Website, database web atau `.env` backend | Tidak diperlukan | Bahagian ini kekal pada server CornGrid Web |

Install Node.js daripada [laman rasmi Node.js](https://nodejs.org/en/download). Pilih **Windows**, **x64**, **LTS** dan installer `.msi`. Gunakan versi LTS yang masih disokong dan memenuhi syarat projek, bukan semestinya versi minimum 20.17.0.

Dapatkan MT5 daripada broker yang digunakan, atau [laman rasmi MetaTrader 5](https://www.metatrader5.com/en/download). Anda perlu mempunyai fail program MT5 lengkap, bukan `terminal64.exe` sahaja.

Selepas install Node.js, buka PowerShell baharu dan semak:

```powershell
node --version
npm.cmd --version
```

`npm.cmd` digunakan dalam panduan ini supaya tidak bergantung pada kebenaran menjalankan skrip `npm.ps1`.

## 3. Pakej yang disediakan

Fail **CornGrid-Node-Agent.zip** disediakan bersama tutorial ini dalam salinan projek Desktop.

Kandungannya:

```text
CornGrid-Node-Agent.zip
  agent/
    agent.js
    config.js
    transport.js
    system-monitor.js
    mt5-manager.js
    mt5-startup.js
    broker-server-cache.js
    ea-tester.js
    package.json
    package-lock.json
    agent-config.example.json
    install-service.ps1
    uninstall-service.ps1
  TUTORIAL SETUP NODE.MD
```

Pakej ini tidak mengandungi `agent-config.json` sebenar, token node, password, log atau `node_modules`.

Jika mahu copy sendiri, ambil 13 fail dalam folder ini pada komputer sumber:

```text
C:\Website\Website\Corngrid-web\agent
```

atau daripada salinan Desktop:

```text
C:\Users\mohamad akram\Desktop\CornGrid EA\CornGrid EA\Website\Corngrid-web\agent
```

**Jangan copy `agent-config.json` komputer lama sebagai identiti komputer baharu. Setiap komputer mesti mempunyai Node ID dan token sendiri.**

## 4. Sediakan folder pada komputer NODE BAHARU

Copy ZIP ke komputer baharu, contohnya ke folder Downloads. Buka PowerShell dan jalankan:

```powershell
New-Item -ItemType Directory -Force -Path 'C:\CornGrid'
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\CornGrid-Node-Agent.zip" -DestinationPath 'C:\CornGrid'

New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\MT5'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\Users'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\Sandbox\AgentData'
New-Item -ItemType Directory -Force -Path 'C:\CornGrid\BrokerProfiles\LiteFinance'
```

Jika ZIP berada di USB atau folder lain, ubah path ZIP dalam arahan `Expand-Archive`.

Susunan akhir yang digunakan dalam contoh:

```text
C:\CornGrid\
  agent\                       <- fail agent CornGrid
  Sandbox\
    MT5\                       <- program MT5 asas yang bersih
      terminal64.exe
      metaeditor64.exe
      ... fail program MT5 lain
    Users\                     <- dicipta/diurus oleh agent untuk sandbox pengguna
    AgentData\                 <- ruang kerja agent dan EA testing
  BrokerProfiles\
    LiteFinance\               <- terminal khas untuk sediakan server broker dan WebRequest
```

Mula dengan kapasiti **1 sandbox**. Tambah kapasiti selepas anda melihat penggunaan CPU, RAM dan disk sebenar. Kapasiti tidak boleh ditentukan hanya berdasarkan jumlah RAM.

Pastikan komputer kekal hidup, mempunyai internet stabil dan tidak masuk Sleep ketika hosting sandbox.

## 5. Sediakan MT5 asas dan profil broker

### A. Terminal asas yang bersih

1. Sediakan pemasangan MT5 khas untuk node.
2. Tutup terminal itu sebelum menyalin fail programnya.
3. Copy folder program lengkap ke `C:\CornGrid\Sandbox\MT5`.
4. Pastikan fail ini wujud:

```powershell
Test-Path -LiteralPath 'C:\CornGrid\Sandbox\MT5\terminal64.exe'
```

Jawapan sepatutnya `True`.

Gunakan folder asas tanpa akaun peribadi, terminal pengguna lain atau EA yang sudah berjalan pada chart. Agent menyalin folder asas ini untuk membuat sandbox.

### B. Profil broker berasingan

Untuk mengelakkan MT5 tersekat ketika mencari server, sediakan satu terminal khas untuk broker berkenaan di `C:\CornGrid\BrokerProfiles\LiteFinance`.

1. Letakkan salinan program MT5 lengkap dalam folder profil ini.
2. Buka melalui PowerShell:

```powershell
Start-Process -FilePath 'C:\CornGrid\BrokerProfiles\LiteFinance\terminal64.exe' -ArgumentList '/portable' -WorkingDirectory 'C:\CornGrid\BrokerProfiles\LiteFinance'
```

3. Dalam MT5, cari broker dan pastikan server yang diperlukan tersenarai, contohnya `LiteFinance-MT5-Demo`.
4. Jika perlu, gunakan akaun demo ujian untuk mengesahkan sambungan broker.
5. Buka **File -> Open Data Folder** dan catat folder yang dibuka.

**Gunakan lokasi data sebenar yang ditunjukkan oleh MT5.** Jika MT5 membuka folder dalam AppData, gunakan folder AppData itu dalam konfigurasi, bukannya menganggap data sentiasa berada dalam folder pemasangan.

Contoh lokasi data yang mungkin ditunjukkan:

```text
C:\CornGrid\BrokerProfiles\LiteFinance
```

atau:

```text
C:\Users\NAMA_WINDOWS\AppData\Roaming\MetaQuotes\Terminal\TERMINAL_ID
```

Agent hanya mengambil `config\servers.dat` daripada profil broker untuk menyediakan senarai server sandbox. Ia tidak mengambil `accounts.dat` daripada profil broker melalui fungsi ini.

## 6. Setup WebRequest pada komputer baharu

Buat langkah ini dalam terminal profil broker yang disediakan pada langkah 5B:

1. Buka **Tools -> Options -> Expert Advisors**.
2. Tandakan **Allow WebRequest for listed URL**.
3. Tambah tiga URL berikut:

```text
https://corngrid.com
https://control.corngrid.com
https://nfs.faireconomy.media
```

4. Klik **OK**.
5. Tutup MT5 dengan betul supaya tetapan disimpan.
6. Pastikan `config\common.ini` wujud dalam lokasi data sebenar yang dicatat tadi.

Kegunaan URL:

| URL | Kegunaan CornGrid EA |
| --- | --- |
| `https://corngrid.com` | Lesen, sync akaun dan data dashboard |
| `https://control.corngrid.com` | Master Control EA |
| `https://nfs.faireconomy.media` | Kalendar berita |

Konfigurasi agent menyediakan `webRequestSettingsSource` untuk mengambil tetapan WebRequest daripada terminal profil ini. Tetapan tersebut perlu disediakan pada komputer baharu, bukan menganggap konfigurasi terlindung daripada komputer lama boleh terus digunakan.

Sediakan profil MT5 dan uji agent menggunakan akaun Windows yang sama. Jika kemudian menukar agent kepada akaun servis/SYSTEM, uji semula WebRequest dalam konteks akaun itu.

## 7. Daftar node di CORNGRID WEB

Bahagian ini dibuat dalam browser, menggunakan akaun administrator CornGrid.

1. Buka `https://corngrid.com/admin` dan login sebagai admin.
2. Pilih **Sandbox Management**.
3. Dalam **Sandbox Nodes**, tekan **Add node**.
4. Isi nama yang mudah dikenali, contohnya `Node-PC-Rumah-02`.
5. Isi **Max instances = 1** untuk permulaan.
6. **Jangan tandakan Test node** jika komputer ini untuk hosting sandbox pengguna biasa. Test node dikhaskan untuk ujian EA dan tidak dipilih untuk hosting pengguna.
7. Tekan **Create node**.
8. Simpan **Node ID** dan **Authentication token** yang dipaparkan.
9. Token ditunjukkan sekali sahaja. Jika hilang, gunakan **Rotate token** untuk node tersebut dan masukkan token baharu dalam konfigurasi komputer ini.
10. Pastikan node berstatus **Active**. Jika masih pending, tekan **Activate** pada baris node.

Dua perkara berbeza:

- **Active**: admin membenarkan node menerima sandbox.
- **Online**: agent sedang bersambung dan menghantar heartbeat.

Node perlu Active, Online dan mempunyai slot kosong untuk dipilih bagi pengaktifan sandbox.

## 8. Buat agent-config.json pada NODE BAHARU

Dalam PowerShell pada komputer baharu:

```powershell
Set-Location -LiteralPath 'C:\CornGrid\agent'
npm.cmd ci --omit=dev
Copy-Item -LiteralPath '.\agent-config.example.json' -Destination '.\agent-config.json'
notepad.exe '.\agent-config.json'
```

`npm ci` memasang dependency berdasarkan `package-lock.json`. Tidak perlu menyalin `node_modules` daripada komputer lama.

Contoh konfigurasi lengkap untuk LiteFinance dengan simbol berakhiran `_l`:

```json
{
  "backendUrl": "https://corngrid.com",
  "nodeUid": "MASUKKAN_NODE_ID_BAHARU",
  "nodeToken": "MASUKKAN_TOKEN_BAHARU",
  "mt5BaseDir": "C:\\CornGrid\\Sandbox\\MT5",
  "sandboxUsersDir": "C:\\CornGrid\\Sandbox\\Users",
  "agentDataDir": "C:\\CornGrid\\Sandbox\\AgentData",
  "heartbeatIntervalMs": 15000,
  "brokerServerDataDirs": {
    "LiteFinance-MT5-Demo": "C:\\CornGrid\\BrokerProfiles\\LiteFinance"
  },
  "brokerSymbolMaps": {
    "LiteFinance-MT5-Demo": {
      "XAUUSD": "XAUUSD_l",
      "EURUSD": "EURUSD_l",
      "GBPUSD": "GBPUSD_l",
      "USDJPY": "USDJPY_l"
    }
  },
  "webRequestSettingsSource": "C:\\CornGrid\\BrokerProfiles\\LiteFinance\\config\\common.ini"
}
```

Ubah perkara ini sebelum menyimpan:

- Gantikan `nodeUid` dan `nodeToken` dengan nilai node yang BARU didaftarkan.
- Jika **Open Data Folder** menunjukkan AppData, gantikan path `brokerServerDataDirs` dan `webRequestSettingsSource` menggunakan lokasi data sebenar.
- Nama kunci `LiteFinance-MT5-Demo` mesti sama dengan nama server broker yang digunakan pengguna.
- Contoh `_l` di atas ialah untuk simbol yang telah digunakan dalam setup CornGrid ini. Akaun/broker lain mungkin menggunakan `_h`, `m`, atau tiada akhiran. Semak Market Watch dan gunakan nama sebenar.
- `brokerSymbolMaps` ialah konfigurasi pada node, mengikut nama broker. Ia bukan pengesanan automatik untuk semua jenis akaun.
- Untuk broker tambahan, sediakan profil broker berkenaan dan tambah entry dalam `brokerServerDataDirs` serta pemetaan simbol yang diperlukan.

**Pada komputer lain, gunakan `https://corngrid.com`. Jangan gunakan `http://localhost:3000` untuk menyambung ke server web utama: localhost bermaksud komputer node itu sendiri.**

Jangan masukkan token dalam screenshot, Git atau mesej kepada pengguna.

Untuk menyemak JSON tanpa memaparkan token:

```powershell
Get-Content -LiteralPath 'C:\CornGrid\agent\agent-config.json' -Raw | ConvertFrom-Json | Out-Null
```

Jika tiada ralat, sintaks JSON boleh dibaca. Ini belum mengesahkan token dan semua path itu betul.

## 9. Uji sambungan dan jalankan agent secara manual

Dalam PowerShell pada komputer baharu:

```powershell
Test-NetConnection corngrid.com -Port 443
Invoke-RestMethod -Uri 'https://corngrid.com/api/health'

Set-Location -LiteralPath 'C:\CornGrid\agent'
node .\agent.js
```

`TcpTestSucceeded: True` menunjukkan port 443 boleh dicapai. Respons health yang sihat biasanya mempunyai `status: ok`.

Kemudian lihat log agent. Dua mesej penting ialah:

```text
MT5 base validated: C:\CornGrid\Sandbox\MT5\terminal64.exe
Connected to the CornGrid backend (WebSocket).
```

Agent menghubungi `wss://corngrid.com/ws/sandbox/node`. Jika WebSocket terputus, kod agent mempunyai fallback HTTPS untuk heartbeat dan arahan.

Biarkan PowerShell ini terbuka semasa ujian. Jika agent dihentikan, komputer tidak lagi melaporkan status atau menerima arahan baru.

**Jalankan satu agent sahaja bagi satu Node ID.** Jangan biarkan agent manual dan Scheduled Task menggunakan konfigurasi yang sama pada masa yang sama.

## 10. Sahkan di panel admin

Kembali ke **Admin -> Sandbox Management -> Sandbox Nodes**:

1. Cari nama node baharu.
2. Tunggu sekitar 15-30 saat untuk heartbeat pertama dan refresh paparan jika perlu.
3. Pastikan status **Online**.
4. Pastikan CPU/RAM dan last heartbeat dikemas kini.
5. Pastikan status operasi **Active**.
6. Pastikan node bukan Test node dan mempunyai slot kosong.

Jika node tidak menghantar heartbeat selama sekitar 90 saat, backend menganggapnya offline.

Pada server web utama, `APP_BASE_URL` backend patut menggunakan origin awam yang betul, contohnya `https://corngrid.com`, supaya URL yang dihantar kepada EA boleh dicapai dari node lain. Tetapan backend ini berada pada server web, bukan dalam `.env` yang disalin ke node.

## 11. Uji satu sandbox pengguna

1. Gunakan akaun pengguna CornGrid dengan langganan aktif.
2. Buka **Sandbox** dan pilih CornGrid EA serta pair yang disokong.
3. Isi nama server broker, nombor akaun dan password MT5 yang betul.
4. Tekan **Activate Sandbox** sekali.
5. Semak **Assigned node** pada butiran sandbox atau **User Instances** dalam admin.
6. Pastikan sandbox benar-benar ditempatkan pada node baharu yang hendak diuji.

Jika beberapa node tersedia, sistem memilih node yang layak berdasarkan slot kosong dan keadaan node. Ia tidak semestinya memilih node yang baru ditambah.

Selepas deployment:

- Agent menyalin terminal asas ke `C:\CornGrid\Sandbox\Users\sbx_...`.
- Agent mendapatkan fail EA yang diterbitkan melalui backend.
- Untuk CornGrid EA, preset rasmi dipilih mengikut pair: XAUUSD v2.60, atau EURUSD/GBPUSD/USDJPY M1 v2.00.
- Untuk EA partner, preset milik EA dan pair tersebut digunakan. Preset CornGrid tidak diberikan kepada EA partner.
- Agent menjana startup MT5, memilih simbol broker dan memuatkan EA serta preset.

Ada beberapa tahap yang perlu diperiksa secara berasingan:

| Tahap | Apa maksudnya |
| --- | --- |
| Node Online | Agent boleh menghubungi web |
| Sandbox Running | Proses terminal MT5 berjalan |
| Broker Connected | MT5 berjaya login ke broker dan menerima harga |
| EA menghantar data | Heartbeat akaun sampai ke backend dan dashboard boleh menunjukkan Online |

Jangan gunakan status Running sahaja sebagai bukti EA sudah berfungsi. Semak harga chart, tab **Journal/Experts**, WebRequest dan heartbeat akaun.

Untuk EA partner, data dashboard juga bergantung pada sokongan telemetry EA itu sendiri. Menjalankan EA pihak lain tidak secara automatik menambahkan protokol sync CornGrid kepada kod EA tersebut.

Menambah node tidak memindahkan sandbox lama secara automatik. Sandbox sedia ada kekal pada node asal; panduan ini menerangkan penambahan kapasiti untuk deployment baharu.

## 12. Jadikan agent berjalan automatik

### Pilihan A: mula selepas login Windows — sesuai untuk setup awal MT5

Cara ini mengekalkan akaun Windows yang sama dengan yang digunakan semasa menyediakan broker dan WebRequest.

1. Hentikan agent manual dengan `Ctrl + C` sebelum menghidupkan task.
2. Buka **Task Scheduler -> Create Task** pada komputer node.
3. Namakan task `CornGridSandboxAgent`.
4. Pilih akaun Windows yang digunakan untuk menyediakan MT5.
5. Pilih **Run only when user is logged on**. Aktifkan **Run with highest privileges** jika diperlukan oleh kebenaran folder/MT5.
6. Di **Triggers**, tambah **At log on** untuk akaun tersebut.
7. Di **Actions**, pilih **Start a program** dan isi:

```text
Program/script:
C:\Program Files\nodejs\node.exe

Add arguments:
"C:\CornGrid\agent\agent.js"

Start in:
C:\CornGrid\agent
```

8. Di **Settings**, tetapkan restart apabila gagal dan **Do not start a new instance** jika task sudah berjalan.
9. Jika terdapat pilihan had masa yang akan menghentikan task selepas beberapa hari, nyahaktifkan had tersebut untuk agent yang perlu berjalan berterusan.
10. Simpan dan tekan **Run**.
11. Pastikan task Running dan node Online dalam admin.

Dengan pilihan ini, selepas reboot anda perlu login Windows supaya agent bermula. Boleh lock screen selepas login; jangan sign out jika mahu task interaktif itu kekal berjalan. Jika menggunakan RDP, bezakan Disconnect daripada Sign out.

### Pilihan B: script sedia ada bermula semasa boot sebagai SYSTEM

Projek menyediakan `install-service.ps1`. Script semasa mendaftarkan Scheduled Task yang berjalan sebagai **SYSTEM**, bukan akaun Windows interaktif anda.

Gunakan selepas ujian manual berjaya dan selepas memastikan akaun SYSTEM boleh membaca folder program, profil broker dan konfigurasi yang dirujuk.

Buka **PowerShell -> Run as administrator**:

```powershell
Set-Location -LiteralPath 'C:\CornGrid\agent'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\install-service.ps1'

Get-ScheduledTask -TaskName 'CornGridSandboxAgent'
Get-ScheduledTaskInfo -TaskName 'CornGridSandboxAgent'
```

`ExecutionPolicy Bypass` di atas hanya untuk proses PowerShell yang menjalankan script tersebut; panduan ini tidak menukar execution policy global.

Semak kewujudan task, State, last run result dan status Online dalam web. Jangan bergantung pada mesej pemasangan sahaja jika ada ralat `Access is denied`.

**Penting:** task SYSTEM berjalan dalam konteks Windows yang berbeza. Popup MT5 mungkin tidak kelihatan pada desktop pengguna. Tetapan WebRequest yang terlindung dan path AppData pengguna juga perlu diuji semula. Jika manual berjaya tetapi task gagal, gunakan akaun Windows yang sama seperti pilihan A, atau sediakan akaun servis dan profil MT5 khusus dengan kebenaran yang betul.

Semasa boot, task ini menjalankan agent. Ia tidak menjamin semua terminal yang telah terhenti akan dimulakan semula secara automatik selepas reboot. Semak sandbox pengguna dan gunakan Start/Restart melalui dashboard jika diperlukan.

## 13. Jika terdapat masalah

| Masalah | Semakan yang perlu dibuat |
| --- | --- |
| Node Offline | Agent berjalan? URL backend betul? Internet/443 boleh dicapai? Token dan Node ID sepadan? |
| Node Online tetapi No capacity | Node perlu Active, bukan Test node dan slot tidak penuh. |
| HTTP 401 / Invalid node credentials | Semak `nodeUid` dan token untuk node itu. Jika token di-rotate, kemas kini fail config. |
| MT5 terminal not found | Semak `mt5BaseDir` dan kewujudan `terminal64.exe`. |
| MT5 loading atau tiada server | Semak nama broker tepat dan `brokerServerDataDirs` menunjuk ke folder data yang mempunyai `config\servers.dat` yang betul. |
| Chart kosong | Semak nama simbol sebenar, contohnya XAUUSD_l. Pemetaan pair mesti sesuai dengan akaun broker. |
| WebRequest error 4014 | Pastikan URL dibenarkan dalam MT5 yang sedang menjalankan EA. Semak sumber WebRequest pada komputer ini dan akaun Windows yang menjalankan agent. |
| WebRequest source has no allowed URL list | Tetapkan Allow WebRequest dalam terminal profil, tutup dengan betul dan semak path `common.ini` sebenar. |
| EA Waiting for data | Semak EA dimuatkan, broker login, WebRequest, URL API dan credential sync. Node Online tidak sama dengan EA Online. |
| Access is denied semasa install task | Jalankan PowerShell sebagai administrator. Semak task benar-benar wujud selepas pemasangan. |
| Manual berjaya, Scheduled Task gagal | Bandingkan Windows user/SYSTEM, Start in, path AppData, kebenaran folder dan WebRequest. |
| Dua agent menggunakan Node ID sama | Hentikan salah satu proses dan pastikan setiap komputer didaftarkan sebagai node berasingan. |
| Preset tidak tersedia untuk EA partner | Partner perlu menyediakan preset untuk EA/pair itu dan mendapat kelulusan/penerbitan admin. |

Mesej 4014 juga boleh berlaku jika WebRequest dipanggil dari konteks yang tidak dibenarkan. Dalam setup hosting ini, uji EA dalam terminal broker sebenar; WebRequest tidak berjalan dalam MT5 Strategy Tester.

## 14. Cara update agent pada masa hadapan

1. Hentikan task agent atau agent manual. Jangan jalankan dua salinan.
2. Backup `agent-config.json` komputer node itu.
3. Copy versi baharu fail agent daripada projek.
4. Kekalkan Node ID, token dan path tempatan dalam `agent-config.json` node ini.
5. Jalankan `npm.cmd ci --omit=dev` jika package/lockfile dikemas kini.
6. Hidupkan semula agent.
7. Semak node Online dan terminal pengguna dipantau semula.

Jangan padam folder `Sandbox\Users` untuk update biasa; ia menyimpan instance pengguna. Menghentikan agent dengan baik mengekalkan terminal MT5, dan agent mempunyai fungsi mengambil alih pemantauan terminal yang masih berjalan selepas agent restart.

## 15. Checklist sebelum terima pengguna

- [ ] Node.js tersedia dan `npm.cmd ci --omit=dev` berjaya.
- [ ] MT5 asas lengkap dan `terminal64.exe` ditemui.
- [ ] Profil broker disediakan pada komputer baharu.
- [ ] Data Folder sebenar dan `servers.dat` telah dikenal pasti.
- [ ] WebRequest mengandungi tiga domain CornGrid yang diperlukan.
- [ ] Pair dipetakan kepada simbol broker yang betul.
- [ ] Node ID/token baharu disimpan dalam `agent-config.json`.
- [ ] Backend URL menggunakan `https://corngrid.com`.
- [ ] Node Active, Online, bukan Test node dan mempunyai slot kosong.
- [ ] Satu sandbox demo telah diuji pada node ini.
- [ ] Login broker, chart, preset dan heartbeat EA disahkan.
- [ ] Startup automatik telah diuji dalam konteks akaun Windows sebenar.
- [ ] Selepas reboot, status agent dan sandbox telah diperiksa semula.

## Rujukan

- Kod projek: `Corngrid-web/agent/config.js`, `mt5-manager.js`, `mt5-startup.js`, `broker-server-cache.js`, `transport.js` dan `install-service.ps1`.
- [Muat turun Node.js rasmi](https://nodejs.org/en/download).
- [Muat turun MetaTrader 5 rasmi](https://www.metatrader5.com/en/download).
- [MT5: portable mode, lokasi data dan startup configuration](https://www.metatrader5.com/en/terminal/help/start_advanced/start).
- [MQL5: syarat penggunaan WebRequest dan senarai URL](https://www.mql5.com/en/docs/network/webrequest).