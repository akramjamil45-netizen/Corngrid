# Tutorial setup CornGrid Node pada VPS lain

**Pilih sistem operasi terlebih dahulu:** [Windows VPS](Corngrid-web/docs/VPS_NODE_INSTALLATION_WINDOWS.md) atau [Linux / Ubuntu VPS](Corngrid-web/docs/VPS_NODE_INSTALLATION_LINUX.md). Linux menggunakan pakej `CornGrid-Node-Agent-Linux.tar.gz`, Wine, Xvfb dan systemd. Langkah ringkas di bawah khusus **Windows**; jangan gunakan PowerShell/NSSM untuk node Linux.

Panduan disemak semula pada **13 November 2026**. Panduan penuh yang menggantikan
langkah pemasangan lama berada di
[VPS_NODE_INSTALLATION.md](Corngrid-web/docs/VPS_NODE_INSTALLATION.md).
Dalam ZIP, buka dokumen bernama **VPS_NODE_INSTALLATION.md** di sebelah tutorial ini.

Aliran pemasangan:

1. Sediakan VPS Windows x64 dengan Desktop Experience/RDP, Node.js 24 LTS,
   Python 3.13 x64 dan program MT5 lengkap berbahasa English.
2. Extract **CornGrid-Node-Agent.zip** terkini ke C:\CornGrid. Pakej merangkumi
   semua modul broker/compiler semasa, checker dan manifest hash; tiada secret.
3. Di Admin > Sandbox Management, daftar node baharu dengan capacity awal 1 dan
   kekalkan Pending semasa setup. Gunakan Node ID/token berasingan setiap VPS.
4. Dalam C:\CornGrid\agent, jalankan npm.cmd ci --omit=dev dan
   setup-broker-tools.ps1 menggunakan Python x64 yang sama seperti mt5PythonPath.
5. Sediakan agent-config.json daripada contoh. Gunakan https://corngrid.com,
   path tempatan VPS dan Node ID/token baharu. Sediakan WebRequest dan profil broker.
6. Jalankan node .\check-installation.js --online; baiki semua FAIL.
7. Pin kunci awam pusat sekali dengan node .\agent-launcher.js --trust-update-key,
   kemudian jalankan node .\agent-launcher.js dan sahkan Online dalam admin.
   Semak RAM/disk selepas agent berjalan sebelum mengaktifkan hosting.
8. Jika sumber mencukupi, aktifkan node dan uji satu sandbox demo pada Assigned
   node yang betul. Semak broker, EA, preset
   dan telemetry; status proses Running sahaja bukan bukti semuanya berfungsi.
9. Hentikan agent manual, kemudian pasang task dengan -Mode Interactive dalam
   akaun Windows yang sama dengan setup MT5. Selepas reboot akaun perlu login;
   disconnect RDP dan sign out bukan tindakan yang sama.
10. Semak semula task dan sandbox selepas reboot sebelum menerima pelanggan.

**Perubahan daripada installer lama:** Interactive kini default. SYSTEM memerlukan
-Mode System dan ujian berasingan untuk discovery broker/WebRequest dalam sesi itu.
Installer menolak task sedia ada dan tidak menghentikan task Running. Jangan
memasang agent kedua menggunakan identiti VPS lama.

Membina semula ZIP daripada kod repository (jalankan dari root Website):

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Corngrid-web\scripts\build-node-agent.ps1'

Menambah VPS tidak memindahkan sandbox sedia ada atau menambah had lesen pengguna.
Langkah dan konfigurasi lengkap: lihat panduan penuh di atas.

Salin ZIP/skrip RDP ke disk tempatan VPS sebelum menjalankannya. Gunakan
`-ExecutionPolicy Bypass -File` untuk proses installer sahaja jika skrip disekat.
Contoh task baharu dalam panduan penuh bernama **CornGridSandboxManagedAgent**;
default installer tanpa `-TaskName` masih **CornGridSandboxAgent**. Kekalkan node
Pending jika RAM/disk terlalu terhad; nombor capacity bukan jaminan sumber fizikal.

Agent 1.2.1 dan seterusnya menyokong signed auto-update. Selepas bootstrap sekali,
deploy menggunakan .\marketing\publish-node-update.ps1 pada server pusat sahaja.
Node menyemak release sekitar lima minit sekali, menyimpan konfigurasi/MT5 dan
rollback jika agent baharu gagal. Baca **NODE_AUTO_UPDATES.md** di dalam ZIP untuk
handover task lama dan arahan penerbitan release. Migrasi daripada agent lama
yang melancarkan MT5 secara attached perlu dibuat dalam waktu penyelenggaraan.
