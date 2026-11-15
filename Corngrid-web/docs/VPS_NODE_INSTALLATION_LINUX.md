# Pemasangan node Sandbox — Linux / Ubuntu VPS

Panduan ini berasingan daripada [Windows VPS](VPS_NODE_INSTALLATION_WINDOWS.md). Node Linux menggunakan **Node.js native Linux + MetaTrader 5 Windows melalui Wine + Xvfb + systemd**. MT5 bukan aplikasi native Linux. Kod ini menyediakan laluan Linux; ujian MT5/broker/EA sebenar pada Ubuntu masih wajib sebelum hosting production. Jangan pindahkan sandbox pelanggan yang sedang berjalan untuk mencuba pemasangan ini.

## 1. Keperluan

- VPS **x86-64**, systemd dan akses sudo. Baseline panduan: Ubuntu 24.04 LTS. ARM, Alpine, container tanpa systemd dan Wine 32-bit sahaja tidak disokong.
- Wine 64-bit yang serasi dengan build MT5/broker, Xvfb, Xauthority, user systemd bus. Linux lain dengan systemd boleh menggunakan pemasang yang sama selepas memasang dependency mengikut distro; `--install-deps` hanya Ubuntu/Debian melalui apt.
- Node.js 24 LTS disyorkan. Pemasang boleh mendapatkan versi v24 LTS terkini daripada nodejs.org dan mengesahkan SHA-256. Node 22/26 LTS juga diterima jika sudah dipasang.
- Windows Python **x64** dengan pakej Windows `MetaTrader5`, dijalankan melalui Wine. Native Linux `pip install MetaTrader5` bukan pengganti IPC Windows ini.
- Salinan lengkap MT5 yang bersih dan sah daripada broker/MetaQuotes; MetaEditor diperlukan hanya untuk node ujian compilation. Jangan salin folder MT5 yang mengandungi login, password, akaun atau lesen pelanggan.
- Ruang untuk satu salinan MT5 **dan satu Wine prefix bagi setiap sandbox**, termasuk log dan kemas kini. Kapasiti bergantung pada EA, chart, CPU, RAM dan disk sebenar. Mulakan kapasiti **1**, ukur dahulu; jangan menganggap VPS 1 GB sesuai untuk dua terminal hanya kerana agent boleh hidup.
- Sambungan keluar HTTPS/WSS ke CornGrid dan rangkaian broker. Pemasang tidak membuka port awam, VNC atau RDP.

Wine prefix memisahkan registry/data aplikasi, **bukan VM atau sempadan keselamatan OS**. Semua terminal berjalan sebagai pengguna Unix `corngrid`. Kekalkan proses review executable EA sedia ada; gunakan mesin/VM berasingan untuk kod yang belum dipercayai.

## 2. Bina dan pindahkan pakej

Pada workstation repository:

```powershell
node Corngrid-web/scripts/build-linux-node-agent.js
```

Hasil: `CornGrid-Node-Agent-Linux.tar.gz` dan `.sha256`. ZIP Windows menggunakan pemasang yang berbeza. Pakej Linux tidak mengandungi token sebenar, `.env`, MT5, Python, node_modules atau akaun pelanggan. Pindahkan kedua-dua fail melalui SCP/SFTP, kemudian pada VPS:

```bash
mkdir -p ~/corngrid-node-package
cd ~/corngrid-node-package
# Letakkan kedua-dua fail di sini dahulu.
sha256sum -c CornGrid-Node-Agent-Linux.tar.gz.sha256
tar -xzf CornGrid-Node-Agent-Linux.tar.gz
bash agent/install-service.sh --dry-run
```

Checksum mengesan fail rosak; dapatkan pakej dan checksum melalui saluran pentadbir yang dipercayai. Semak sumber pemasang sebelum sudo.

## 3. Daftar node dan konfigurasi

Dalam Admin → Sandbox Management → Nodes, daftar **node baharu** untuk VPS ini. Gunakan ID/token unik dan kapasiti kecil. Jangan guna token node Windows atau node VPS lain. Pemasangan node tidak menambah entitlement pengguna atau had activation MT5.

```bash
sudo install -m 600 agent/agent-config.linux.example.json /root/corngrid-node.json
sudo nano /root/corngrid-node.json
```

Isi `backendUrl` dengan origin HTTPS CornGrid, `nodeUid`, `nodeToken`, dan kekalkan `linuxWineEnabled: true`. Gunakan path standard dalam contoh untuk pemasangan pertama. Jangan letak secret dalam command line, tiket sokongan atau chat. Contoh ringkas medan tambahan:

```json
{
  "brokerServerDataDirs": {
    "Exact-Broker-Demo-Server": "/var/lib/corngrid/broker-seeds/demo"
  },
  "brokerSymbolMaps": {
    "Exact-Broker-Demo-Server": { "XAUUSD": "XAUUSDc" }
  }
}
```

Gunakan nama server/symbol yang benar daripada akaun demo. Jangan meneka suffix atau memetakan akaun cent kepada USD secara manual. Mekanisme broker dan currency sedia ada tetap digunakan.

## 4. Jalankan pemasang

```bash
sudo bash agent/install-service.sh --install-deps --install-node --config /root/corngrid-node.json
```

Omit `--install-deps` / `--install-node` jika dependency dan Node sudah disediakan. Wine sedia ada dikekalkan; pemasang tidak menggantikan WineHQ yang sudah dipasang. Pastikan versi Wine anda disokong oleh build MT5 semasa. Pemasang menolak config berlainan yang cuba menimpa config sedia ada dan menolak pemasangan semula semasa agent hidup.

Pemasang menyediakan:

| Lokasi | Tujuan |
| --- | --- |
| `/opt/corngrid/agent` | Kod agent/launcher, milik root |
| `/etc/corngrid/agent-config.json` | Config root:corngrid, mode 640 |
| `/etc/corngrid/xauthority` | Cookie X11 private, mode 640 |
| `/opt/corngrid/mt5` | Template program MT5 bersih |
| `/opt/corngrid/windows-python` | Windows Python x64 |
| `/var/lib/corngrid/instances` | Data terminal per sandbox |
| `/var/lib/corngrid/wine-template` | Wine prefix template bersih |
| `/var/lib/corngrid/wine-prefixes` | Prefix per sandbox |
| `/var/lib/corngrid/agent-data` | State dan signed agent releases |
| `/var/lib/corngrid/broker-caches` | Cache broker sedia ada |

Ia mencipta pengguna tanpa login `corngrid`, mengaktifkan linger/user bus dan menulis `corngrid-display.service` serta `corngrid-agent.service`. **Hosting dan display belum dimulakan.** Salinan kod/unit lama disimpan dalam `/var/backups/corngrid-agent-<UTC>` jika pemasangan diulang. Jangan salin config private ke folder web/download.

## 5. Sediakan display dan Wine template

Mulakan display sahaja:

```bash
sudo systemctl start corngrid-display.service
sudo systemctl status corngrid-display.service --no-pager
```

Gunakan helper berikut dalam shell pentadbir untuk semua langkah seterusnya. Ia menghantar persekitaran yang sama seperti servis tanpa memberi akses root kepada Wine:

```bash
cg_uid=$(id -u corngrid)
cg_run() {
  sudo -u corngrid env HOME=/var/lib/corngrid \
    XDG_RUNTIME_DIR=/run/user/"$cg_uid" \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/"$cg_uid"/bus \
    DISPLAY=:99 XAUTHORITY=/etc/corngrid/xauthority \
    WINEPREFIX=/var/lib/corngrid/wine-template WINEARCH=win64 WINEDEBUG=-all \
    CORNGRID_AGENT_HOME=/opt/corngrid/agent \
    CORNGRID_AGENT_CONFIG_FILE=/etc/corngrid/agent-config.json "$@"
}
cg_run xdpyinfo -display :99 >/dev/null
cg_run wineboot --init
cg_run wineserver --wait
```

Selesaikan persediaan Wine Mono/Gecko jika diminta oleh distro. Xvfb tiada desktop interaktif: gunakan sesi pentadbir yang dilindungi untuk persediaan GUI jika diperlukan. Jangan gunakan `xhost +`, display tanpa auth atau expose VNC/X11 ke internet.

## 6. Sediakan Windows Python dan SDK

Dapatkan installer Python Windows x64 daripada python.org, sahkan sumber/checksum rasmi, dan letak sementara pada path yang boleh dibaca oleh `corngrid`. Contoh berikut menggunakan **Python 3.13 x64**; pilih patch yang serasi dengan wheel MetaTrader5 semasa:

```bash
# /var/lib/corngrid/setup/python-amd64.exe ialah installer rasmi yang anda sediakan.
cg_run wine /var/lib/corngrid/setup/python-amd64.exe /quiet \
  InstallAllUsers=0 'TargetDir=Z:\opt\corngrid\windows-python' \
  Include_launcher=0 Include_test=0 Include_doc=0 PrependPath=0
cg_run wine /opt/corngrid/windows-python/python.exe -m pip install --upgrade pip
cg_run wine /opt/corngrid/windows-python/python.exe -m pip install MetaTrader5
cg_run wine /opt/corngrid/windows-python/python.exe \
  'Z:\opt\corngrid\agent\broker-probe.py' --check
```

`--check` hanya mengimport SDK; ia tidak login broker, membuka order atau membuktikan MT5 IPC berfungsi. Python tidak boleh diganti dengan Python native Linux. Sediakan Windows VC runtime jika diminta oleh Python/SDK. Rekod versi Wine, Python, MT5 dan wheel yang lulus ujian demo untuk node anda.

## 7. Sediakan MT5, broker seeds dan WebRequest

Salin **keseluruhan program MT5 bersih** ke `/opt/corngrid/mt5`, termasuk `terminal64.exe`, MQL5 dan config; pastikan pengguna `corngrid` boleh membacanya. Tiada symlink dalam template MT5; elakkan dua folder seperti `Config` dan `config` serentak. Agent menormalkan nama folder yang digunakan pada filesystem Linux.

Gunakan template Wine yang sama untuk menyediakan MT5 dalam `/portable` dan membenarkan URL HTTPS CornGrid di Tools → Options → Expert Advisors → WebRequest. Tutup terminal template selepas konfigurasi. Tetapkan `webRequestSettingsSource` kepada `/opt/corngrid/mt5/config/common.ini`. Jangan sertakan akaun sebenar, password, `accounts.dat` atau EA aktif dalam template. WebRequest yang dipindah daripada mesin Windows mungkin tidak berfungsi di Wine; sahkan heartbeat menggunakan EA demo sebenar.

**Linux tidak menjalankan broker-discovery GUI PowerShell Windows.** Setiap broker yang dihoskan perlu `config/servers.dat` yang disediakan terlebih dahulu. Letakkan seed bersih pada `/var/lib/corngrid/broker-seeds/<broker>/config/servers.dat`, kemudian isi `brokerServerDataDirs` mengikut nama server tepat. Seed tidak boleh mengandungi password/login. Pastikan root broker-seeds dan isinya private dan boleh dibaca oleh `corngrid`.

Sebelum membenarkan clone prefix, tutup semua proses template:

```bash
# Hanya prefix template yang belum digunakan untuk pelanggan.
cg_run wineserver -k 15
cg_run wineserver --wait
```

Jangan hentikan wineserver global atau prefix sandbox pelanggan. Template `wine-template` mesti mempunyai `system.reg` dan `drive_c`; agent akan mengklonnya ke prefix private bagi setiap instance. Jangan ubah template ketika sandbox sedang disediakan.

## 8. Diagnostics dan signed updates

```bash
# Jika menggunakan Node yang dipasang melalui --install-node:
cg_run /opt/corngrid/node/bin/node /opt/corngrid/agent/check-installation.js --online
```

Jika menggunakan Node distro, gantikan path Node dengan `ExecStart` pada unit servis. Diagnostics tidak menghantar heartbeat, mengambil alih WebSocket atau memulakan MT5. Semua FAIL perlu diselesaikan. WARN SDK memerlukan import check dan demo sebenar, bukan sekadar fail wujud.

Pin public key kemas kini daripada saluran pentadbir dipercayai; fingerprint mesti sama dengan backend. Lihat [Signed automatic updates](NODE_AUTO_UPDATES.md). Jalankan pin sebagai root kerana kod bootstrap tidak boleh ditulis oleh servis:

```bash
sudo env CORNGRID_AGENT_CONFIG_FILE=/etc/corngrid/agent-config.json \
  /opt/corngrid/node/bin/node /opt/corngrid/agent/agent-launcher.js --trust-update-key
sudo chown root:corngrid /opt/corngrid/agent/update-trust.pem
sudo chmod 640 /opt/corngrid/agent/update-trust.pem
```

Arahan ini mengambil **public key** melalui endpoint HTTPS node yang diautentikasi; bandingkan fingerprint fail `update-trust.pem` dengan rekod pentadbir melalui saluran berasingan sebelum start. Jika public key sudah dibekalkan secara selamat, pasangkannya terus dengan `sudo install -o root -g corngrid -m 640 /root/corngrid-update-public.pem /opt/corngrid/agent/update-trust.pem` sebagai alternatif. Jangan salin private signing key ke node. Linux menolak release lama yang tidak menyatakan sokongan Linux/tiada `linux-runtime.js`; guna release agent 1.3.0 atau lebih baharu yang lulus ujian Linux. Pemasang, launcher dan servis bootstrap tidak dikemas kini oleh pertukaran child agent; perubahan bootstrap perlu pemasangan tersendiri yang disemak.

## 9. Mulakan node dan ujian penerimaan demo

```bash
sudo systemctl enable corngrid-display.service corngrid-agent.service
sudo systemctl start corngrid-agent.service
sudo systemctl status corngrid-agent.service --no-pager
sudo journalctl -u corngrid-agent.service -n 80 --no-pager
cg_run systemctl --user list-units 'corngrid-*.service' --all
```

Admin perlu melihat node online dengan identiti unik. Servis MT5 ialah unit user `corngrid-mt5-sbx_<id>.service`; preflight dan compile menggunakan unit berlainan. Restart agent tidak menghentikan unit MT5 tersebut. Semua unit menggunakan `KillMode=control-group`; stop sandbox hanya menyasarkan unit/prefix instance itu.

Sebelum production, sahkan pada **akaun demo**:

1. Login broker, server dan symbol sebenar disahkan sebelum EA dilancarkan. Password salah, broker seed tiada dan symbol ambiguous mesti gagal tanpa EA.
2. Deployment menggunakan strategy/executable yang sudah diluluskan; langganan, lesen dan had activation sedia ada tetap dikuatkuasakan backend.
3. EA heartbeat, WebRequest, status connected, data currency termasuk cent dan chart/symbol tepat. Import Python atau status node online sahaja tidak mencukupi.
4. Start/stop/restart satu sandbox, dua sandbox berasingan jika sumber cukup, dan destroy sandbox demo; instance lain kekal hidup. Pastikan tiada credential dalam journal.
5. Restart agent dan signed update mengekalkan PID terminal; reconnect memulihkan status tanpa terminal berganda. Reboot VPS memulihkan sandbox melalui recovery sedia ada. Ukur RAM/disk/CPU sebelum menambah kapasiti.
6. Jika node ditanda test node: compile MQ5 melalui Wine MetaEditor, periksa EX5 dan keputusan **compile-only**. Kelulusan runtime tetap memerlukan review/test sedia ada.

**Status pengesahan repository:** ujian automatik menguji pengurusan unit/prefix, path, paket, update dan regresi Windows dengan proses simulasi. Tiada VPS Ubuntu/Wine/broker disambungkan semasa pembangunan ini; demo acceptance di atas belum dijalankan dan bukan jaminan keserasian setiap broker/EA.

## 10. Troubleshooting dan uninstall

- User bus gagal: semak `loginctl show-user corngrid`, `user@<uid>.service`, XDG/DBUS environment dan linger.
- Wine tidak membuka MT5: semak display service/Xauthority, Wine x64, program lengkap dan unit journal private. Jangan tambah password kepada argv/log.
- Preflight gagal: semak Windows Python import, broker seed, server tepat dan trading password melalui aliran sedia ada; jangan bypass pengesahan broker.
- Jangan guna `pkill wine`, `killall wineserver` atau stop `user@...` semasa sandbox berjalan. Hentikan sandbox melalui CornGrid dahulu.
- Pemasangan semula: stop agent secara sengaja, kekalkan data/config/trust. Gunakan signed updates untuk perubahan kod biasa.

```bash
# Selepas semua sandbox/demo dihentikan melalui CornGrid:
sudo bash /opt/corngrid/agent/uninstall-service.sh
```

Uninstaller menolak jika unit sandbox masih hidup. Ia membuang dua root service sahaja; data, config, Wine prefixes, akaun Unix dan kod dikekalkan. Tiada purge automatik atau pembatalan subscription.

## Rujukan rasmi

- [MetaQuotes: MT5 on Linux melalui Wine](https://www.metatrader5.com/en/terminal/help/start_advanced/install_linux)
- [MetaQuotes: Python integration](https://www.mql5.com/en/docs/python_metatrader5)
- [MetaQuotes: initialize dan portable mode](https://www.mql5.com/en/docs/python_metatrader5/mt5initialize_py)
- [systemd: process termination dan control groups](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
- [Node.js official downloads](https://nodejs.org/en/download)
