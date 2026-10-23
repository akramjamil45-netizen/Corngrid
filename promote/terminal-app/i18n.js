/* =========================================
   CornGrid — Trading Terminal & Android App (Promotional page)
   Multi-language switcher (English / Bahasa Melayu)

   Uses the SAME localStorage key as the main website ("selectedLang")
   so the visitor's language choice follows them across the site.
   ========================================= */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'selectedLang';
    var SUPPORTED = ['en', 'bm'];
    var DEFAULT_LANG = 'en';

    var promoTranslations = {
        en: {
            /* --- Page & navigation --- */
            promo_page_title: "CornGrid Trading Terminal &amp; Android App",
            promo_page_desc: "The CornGrid Trading Terminal Portal and Android App are now available. Connect your CornGrid EA, follow live market activity, monitor your trading accounts, and stay connected to your trading community from one platform.",
            promo_nav_home: "Home",
            promo_nav_terminal: "Terminal",
            promo_nav_android: "Android App",
            promo_nav_features: "Features",
            promo_nav_get_started: "Get Started",
            promo_nav_portfolios: "Portfolios",
            promo_nav_login: "Sign in",
            promo_aria_open_nav: "Open navigation",
            promo_aria_close_nav: "Close navigation",

            /* --- Hero --- */
            promo_hero_badge: "New Release &middot; Terminal Portal &amp; Android App",
            promo_hero_title: 'Your Trading. <span class="highlight-gold">One Connected Experience.</span>',
            promo_hero_desc: "Meet the CornGrid Trading Terminal and Android App. Stay connected to your trading activity, explore live market information, and access the CornGrid community &mdash; through one unified platform.",
            promo_btn_create_account: '<i class="fas fa-user-plus"></i> Create Your Account',
            promo_btn_open_terminal: '<i class="fas fa-desktop"></i> Open Trading Terminal',
            promo_trust_1: "No installation &mdash; runs in your browser",
            promo_trust_2: "Android APK available",
            promo_trust_3: "Live markets &amp; community feed",
            promo_float_1_title: "Live Market Feed",
            promo_float_1_sub: "Real-time price action",
            promo_float_2_title: "EA Connected",
            promo_float_2_sub: "Account status online",
            promo_window_title: "corngrid.com &bull; Trading Terminal",
            promo_visual_caption: "CornGrid Trading Terminal Portal and Android App &mdash; actual product screenshots.",

            /* --- Section B: Trading Terminal Portal --- */
            promo_badge_terminal: "Trading Terminal Portal",
            promo_terminal_title: 'Your Trading Terminal, <span class="highlight-gold">Connected.</span>',
            promo_terminal_lead: "Access the CornGrid Trading Terminal Portal from any supported web browser &mdash; no installation required. Sign in to your CornGrid account to view your connected MT5 environment.",
            promo_terminal_h3: "Connect your CornGrid EA",
            promo_terminal_p: "Pair your MetaTrader 5 installation with the portal using a single-use connection code. Once linked, your EA heartbeat keeps your account status online in the terminal.",
            promo_terminal_li1: "Connect CornGrid EA using a connection code",
            promo_terminal_li2: "View live market feeds and market overview",
            promo_terminal_li3: "Monitor connected trading accounts",
            promo_terminal_li4: "View open trading positions and trading history",
            promo_terminal_li5: "Participate in live feed discussions and chat",
            promo_terminal_li6: "Access from any supported web browser",
            promo_cap_feed: "Live feed &amp; official announcements",
            promo_cap_chat: "Terminal chat with support",
            promo_cap_overview: "Trading overview &amp; performance",

            /* --- Section C: CornGrid Android App --- */
            promo_badge_android: "CornGrid Android App",
            promo_android_title: 'Your Trading Dashboard. <span class="highlight-gold">In Your Pocket.</span>',
            promo_android_lead: "Stay connected to your CornGrid trading environment wherever you go. The Android App wraps the live CornGrid platform in a native Android shell &mdash; same accounts, same markets, same community, in your hand.",
            promo_cap_account: "Account overview",
            promo_cap_livefeed: "Live feed &amp; community",
            promo_cap_mt5: "MT5 account linking",
            promo_android_cap1_title: "Trade on Android",
            promo_android_cap1_desc: "Access the CornGrid platform from your Android phone or tablet.",
            promo_android_cap2_title: "Market updates",
            promo_android_cap2_desc: "Follow live market feeds and market overview on the go.",
            promo_android_cap3_title: "Account information",
            promo_android_cap3_desc: "Check connected trading account details from your device.",
            promo_android_cap4_title: "Positions &amp; history",
            promo_android_cap4_desc: "View open positions and trading history anytime.",
            promo_android_cap5_title: "Community chat",
            promo_android_cap5_desc: "Join live feed discussions and community updates.",
            promo_beta_label: "Beta release:",
            promo_beta_note: "The Android app is currently distributed as an APK and is not yet available through the Google Play Store. Download and install only if you trust the source.",
            promo_btn_download_apk: '<i class="fab fa-android"></i> Download for Android (APK)',

            /* --- Section D: Feature highlights --- */
            promo_badge_ecosystem: "CornGrid Ecosystem",
            promo_features_title: 'Built for <span class="highlight-gold">Connected Trading</span>',
            promo_features_lead: "Everything you need to stay in control of your CornGrid trading environment.",
            promo_feat1_title: "Connected Trading",
            promo_feat1_desc: "Link your CornGrid EA to the terminal portal using a connection code.",
            promo_feat2_title: "Live Market Overview",
            promo_feat2_desc: "Explore market information and live activity available through the platform.",
            promo_feat3_title: "Account Monitoring",
            promo_feat3_desc: "Review available account details, open positions, and trading history.",
            promo_feat4_title: "Live Feed &amp; Community",
            promo_feat4_desc: "Stay connected through discussions, comments, and live feed updates.",
            promo_feat5_title: "Cross-Platform Access",
            promo_feat5_desc: "Access the terminal through a supported browser and the Android app.",
            promo_feat6_title: "Secure Account Access",
            promo_feat6_desc: "Register and sign in to your CornGrid account to access the terminal and app.",

            /* --- Section E: Screenshot showcase --- */
            promo_badge_gallery: "Product Gallery",
            promo_showcase_title: "See It in Action",
            promo_showcase_lead: "Real screenshots from the CornGrid Trading Terminal Portal and Android App, shown at their original proportions.",
            promo_group_desktop: "Trading Terminal Portal &mdash; Desktop",
            promo_group_mobile: "CornGrid Android App &mdash; Mobile",
            promo_showcase_cap1: "Market overview with live charts",
            promo_showcase_cap2: "Open positions with live P/L",
            promo_showcase_cap3: "EA monitoring &amp; system health",
            promo_showcase_cap4: "MT5 accounts &amp; pairing codes",
            promo_showcase_cap5: "Settings, profile &amp; preferences",
            promo_showcase_cap6: "Open positions",
            promo_showcase_cap7: "Trade history",
            promo_showcase_cap8: "Terminal chat",

            /* --- Section F: Getting started --- */
            promo_badge_start: "Getting Started",
            promo_steps_title: 'Connected in <span class="highlight-gold">Four Steps</span>',
            promo_steps_lead: "From a fresh account to a live terminal in minutes. The web portal needs no installation &mdash; only the Android app is downloaded separately.",
            promo_step1_title: "Create your CornGrid account",
            promo_step1_desc: "Register once to unlock the Trading Terminal Portal, the Android app and the CornGrid community feed. It is the same account on every device.",
            promo_step2_title: "Generate a pairing code",
            promo_step2_desc: 'Open <strong>MT5 Accounts</strong> in the terminal and generate a one-time pairing code. Codes expire after 10 minutes and can only be used once.',
            promo_step3_title: "Link your CornGrid EA",
            promo_step3_desc: 'Paste the code into the <code>InpDashboardPairingCode</code> parameter of CornGrid EA in MetaTrader 5, then allow WebRequest for <code>https://corngrid.com</code> under <strong>Tools &rarr; Options &rarr; Expert Advisors</strong>.',
            promo_step4_title: "Trade from any device",
            promo_step4_desc: "Your account turns online in the terminal after the first heartbeat. Install the Android app to follow the same dashboard, positions and feed in your pocket.",

            /* --- Section G: Registration & download CTA --- */
            promo_badge_cta: "Get Started",
            promo_cta_title: "Ready to Connect with CornGrid?",
            promo_cta_lead: "Create your account, connect your trading environment, and explore the new CornGrid terminal and Android experience.",
            promo_btn_apk: '<i class="fab fa-android"></i> Download Android APK',

            /* --- Footer --- */
            promo_footer_about: "CornGrid provides automated trading technology for MetaTrader 5 and the CornGrid Trading Terminal Portal, connecting traders to their accounts, the markets, and their community.",
            promo_footer_status: "Terminal Portal &amp; Android App &mdash; Now Live",
            promo_footer_beta_label: "Android beta:",
            promo_footer_beta: "The CornGrid Android App is distributed as an APK and is not yet available on the Google Play Store. Download and install only if you trust the source.",
            promo_footer_platform: "Platform",
            promo_footer_main: "Main Website",
            promo_footer_terminal: "Trading Terminal Portal",
            promo_footer_register: "Sign In",
            promo_footer_apk: "Download Android APK",
            promo_footer_support: "Support",
            promo_footer_tg_helpdesk: "@CornGridSupportbot",
            promo_footer_trader_net: "@CornGridGroup",
            promo_footer_whatsapp: "+60 17-566 0753",
            promo_footer_email: "support@corngrid.com",
            promo_footer_tiktok: "@corngrid",
            promo_footer_legal: "Legal",
            promo_footer_risk: "Risk Policy",
            promo_footer_terms: "Terms of Deployment",
            promo_footer_copyright: "&copy; 2026 <strong>CornGrid Technologies</strong>. All Rights Reserved.",
            promo_footer_motto: "Trade Smart. Recover Smarter.",

            /* --- Floating support widget --- */
            promo_support_title: "CornGrid Support Desk",
            promo_support_sub: "Institutional Client Support",
            promo_support_tg_title: "Telegram Helpdesk",
            promo_support_tg_sub: "@CornGridSupportbot",
            promo_support_tn_title: "Trader Network",
            promo_support_tn_sub: "Join Official Community",
            promo_support_wa_title: "Direct Client Line",
            promo_support_wa_sub: "Chat via WhatsApp",
            promo_support_email_title: "Corporate Relations",
            promo_support_email_sub: "support@corngrid.com",
            promo_support_aria_open: "Open CornGrid Support",
            promo_support_aria_close: "Close CornGrid Support",

            /* --- Image alt text --- */
            promo_alt_hero_terminal: "CornGrid Trading Terminal Portal &mdash; trade history table of imported MT5 deals with net profit per trade",
            promo_alt_hero_mobile: "CornGrid Android App &mdash; account overview with balance, equity and floating profit",
            promo_alt_terminal_01: "CornGrid Trading Terminal Portal &mdash; live feed with official CornGrid announcements and community posts",
            promo_alt_terminal_02: "CornGrid Trading Terminal Portal &mdash; Terminal Chat with CornGrid support and other traders",
            promo_alt_terminal_03: "CornGrid Trading Terminal Portal &mdash; trading overview with balance, equity, net profit and win rate",
            promo_alt_mobile_01: "CornGrid Android App &mdash; account overview with balance, equity, floating P/L and win rate",
            promo_alt_mobile_02: "CornGrid Android App &mdash; live community feed with official announcements",
            promo_alt_mobile_03: "CornGrid Android App &mdash; MT5 accounts with pairing code and linked CornGrid EA installations",
            promo_alt_showcase_01: "CornGrid Trading Terminal Portal &mdash; market overview with live candlestick charts for gold and major currencies",
            promo_alt_showcase_02: "CornGrid Trading Terminal Portal &mdash; open positions with live floating profit and loss",
            promo_alt_showcase_03: "CornGrid Trading Terminal Portal &mdash; EA monitoring showing heartbeat and synchronization status",
            promo_alt_showcase_04: "CornGrid Trading Terminal Portal &mdash; MT5 accounts, pairing codes and linked CornGrid EA installations",
            promo_alt_showcase_05: "CornGrid Trading Terminal Portal &mdash; settings and profile with display preferences and the Android install helper",
            promo_alt_showcase_mobile_01: "CornGrid Android App &mdash; open positions on a smartphone",
            promo_alt_showcase_mobile_02: "CornGrid Android App &mdash; trade history with net profit per deal on a smartphone",
            promo_alt_showcase_mobile_03: "CornGrid Android App &mdash; Terminal Chat with CornGrid support on a smartphone"
        },

        bm: {
            /* --- Page & navigation --- */
            promo_page_title: "Terminal Trading CornGrid &amp; Aplikasi Android",
            promo_page_desc: "Portal Terminal Trading CornGrid dan Aplikasi Android kini telah tersedia. Sambungkan CornGrid EA anda, ikuti aktiviti pasaran langsung, pantau akaun trading anda, dan kekal berhubung dengan komuniti trading anda melalui satu platform.",
            promo_nav_home: "Laman Utama",
            promo_nav_terminal: "Terminal",
            promo_nav_android: "Aplikasi Android",
            promo_nav_features: "Ciri-Ciri",
            promo_nav_get_started: "Mula Sekarang",
            promo_nav_portfolios: "Portfolio",
            promo_nav_login: "Daftar masuk",
            promo_aria_open_nav: "Buka navigasi",
            promo_aria_close_nav: "Tutup navigasi",

            /* --- Hero --- */
            promo_hero_badge: "Keluaran Baharu &middot; Portal Terminal &amp; Aplikasi Android",
            promo_hero_title: 'Trading Anda. <span class="highlight-gold">Satu Pengalaman Bersambung.</span>',
            promo_hero_desc: "Temui Terminal Trading CornGrid dan Aplikasi Android. Kekal berhubung dengan aktiviti trading anda, terokapi informasi pasaran langsung, dan mengakses komuniti CornGrid &mdash; melalui satu platform bersatu.",
            promo_btn_create_account: '<i class="fas fa-user-plus"></i> Cipta Akaun Anda',
            promo_btn_open_terminal: '<i class="fas fa-desktop"></i> Buka Terminal Trading',
            promo_trust_1: "Tiada pemasangan &mdash; terus berjalan dalam pelayar anda",
            promo_trust_2: "APK Android disediakan",
            promo_trust_3: "Pasaran langsung &amp; suapan komuniti",
            promo_float_1_title: "Suapan Pasaran Langsung",
            promo_float_1_sub: "Tindakan harga masa nyata",
            promo_float_2_title: "EA Berhubung",
            promo_float_2_sub: "Status akaun dalam talian",
            promo_window_title: "corngrid.com &bull; Terminal Trading",
            promo_visual_caption: "Portal Terminal Trading CornGrid dan Aplikasi Android &mdash; tangkapan skrin produk sebenar.",

            /* --- Section B: Trading Terminal Portal --- */
            promo_badge_terminal: "Portal Terminal Trading",
            promo_terminal_title: 'Terminal Trading Anda, <span class="highlight-gold">Bersambung.</span>',
            promo_terminal_lead: "Akses Portal Terminal Trading CornGrid dari mana-mana pelayar web yang disokong &mdash; tiada pemasangan diperlukan. Log masuk ke akaun CornGrid anda untuk melihat persekitaran MT5 yang bersambung.",
            promo_terminal_h3: "Sambungkan CornGrid EA anda",
            promo_terminal_p: "Pasangkan pemasangan MetaTrader 5 anda dengan portal menggunakan kod sambungan sekali guna. Setelah berpaut, denyut jantung EA memastikan status akaun anda kekal dalam talian di terminal.",
            promo_terminal_li1: "Sambungkan CornGrid EA menggunakan kod sambungan",
            promo_terminal_li2: "Lihat suapan pasaran langsung dan ringkasan pasaran",
            promo_terminal_li3: "Pantau akaun trading yang bersambung",
            promo_terminal_li4: "Lihat posisi trading terbuka dan sejarah trading",
            promo_terminal_li5: "Sertai perbincangan suapan langsung dan sembang",
            promo_terminal_li6: "Akses dari mana-mana pelayar web yang disokong",
            promo_cap_feed: "Suapan langsung &amp; pengumuman rasmi",
            promo_cap_chat: "Sembang terminal dengan sokongan",
            promo_cap_overview: "Ringkasan trading &amp; prestasi",

            /* --- Section C: CornGrid Android App --- */
            promo_badge_android: "Aplikasi Android CornGrid",
            promo_android_title: 'Papan Pemuka Trading Anda. <span class="highlight-gold">Dalam Tangan Anda.</span>',
            promo_android_lead: "Kekal berhubung dengan persekitaran trading CornGrid anda ke mana-mana sahaja. Aplikasi Android membalut platform CornGrid langsung dalam shell Android asal &mdash; akaun sama, pasaran sama, komuniti sama, dalam tangan anda.",
            promo_cap_account: "Ringkasan akaun",
            promo_cap_livefeed: "Suapan langsung &amp; komuniti",
            promo_cap_mt5: "Pautan akaun MT5",
            promo_android_cap1_title: "Trade pada Android",
            promo_android_cap1_desc: "Akses platform CornGrid dari telefon atau tablet Android anda.",
            promo_android_cap2_title: "Kemas kini pasaran",
            promo_android_cap2_desc: "Ikuti suapan pasaran langsung dan ringkasan pasaran semasa dalam perjalanan.",
            promo_android_cap3_title: "Maklumat akaun",
            promo_android_cap3_desc: "Semak butiran akaun trading bersambung anda dari peranti anda.",
            promo_android_cap4_title: "Posisi &amp; sejarah",
            promo_android_cap4_desc: "Lihat posisi terbuka dan sejarah trading pada bila-bila masa.",
            promo_android_cap5_title: "Sembang komuniti",
            promo_android_cap5_desc: "Sertai perbincangan suapan langsung dan kemas kini komuniti.",
            promo_beta_label: "Keluaran beta:",
            promo_beta_note: "Aplikasi Android kini diedarkan sebagai APK dan belum lagi tersedia melalui Google Play Store. Muat turun dan pasang hanya jika anda mempercayai sumber ini.",
            promo_btn_download_apk: '<i class="fab fa-android"></i> Muat Turun untuk Android (APK)',

            /* --- Section D: Feature highlights --- */
            promo_badge_ecosystem: "Ekosistem CornGrid",
            promo_features_title: 'Dibina untuk <span class="highlight-gold">Trading Bersambung</span>',
            promo_features_lead: "Semua yang anda perlukan untuk kekal mengawal persekitaran trading CornGrid anda.",
            promo_feat1_title: "Trading Bersambung",
            promo_feat1_desc: "Sambungkan CornGrid EA anda ke portal terminal menggunakan kod sambungan.",
            promo_feat2_title: "Ringkasan Pasaran Langsung",
            promo_feat2_desc: "Terokapi informasi pasaran dan aktiviti langsung yang tersedia melalui platform.",
            promo_feat3_title: "Pemantauan Akaun",
            promo_feat3_desc: "Semak butiran akaun, posisi terbuka, dan sejarah trading yang tersedia.",
            promo_feat4_title: "Suapan Langsung &amp; Komuniti",
            promo_feat4_desc: "Kekal berhubung melalui perbincangan, komen, dan kemas kini suapan langsung.",
            promo_feat5_title: "Akses Merentas Platform",
            promo_feat5_desc: "Akses terminal melalui pelayar yang disokong dan aplikasi Android.",
            promo_feat6_title: "Akses Akaun Selamat",
            promo_feat6_desc: "Daftar dan log masuk ke akaun CornGrid anda untuk mengakses terminal dan aplikasi.",

            /* --- Section E: Screenshot showcase --- */
            promo_badge_gallery: "Galeri Produk",
            promo_showcase_title: "Lihat Ia Beraksi",
            promo_showcase_lead: "Tangkapan skrin sebenar daripada Portal Terminal Trading CornGrid dan Aplikasi Android, dipaparkan pada nisbah asalnya.",
            promo_group_desktop: "Portal Terminal Trading &mdash; Desktop",
            promo_group_mobile: "Aplikasi Android CornGrid &mdash; Mobile",
            promo_showcase_cap1: "Ringkasan pasaran dengan carta langsung",
            promo_showcase_cap2: "Posisi terbuka dengan untung/rugi langsung",
            promo_showcase_cap3: "Pemantauan EA &amp; kesihatan sistem",
            promo_showcase_cap4: "Akaun MT5 &amp; kod pasangan",
            promo_showcase_cap5: "Tetapan, profil &amp; keutamaan",
            promo_showcase_cap6: "Posisi terbuka",
            promo_showcase_cap7: "Sejarah trading",
            promo_showcase_cap8: "Sembang terminal",

            /* --- Section F: Getting started --- */
            promo_badge_start: "Mula Sekarang",
            promo_steps_title: 'Bersambung dalam <span class="highlight-gold">Empat Langkah</span>',
            promo_steps_lead: "Daripada akaun baharu kepada terminal langsung dalam beberapa minit. Portal web tidak memerlukan pemasangan &mdash; hanya aplikasi Android dimuat turun secara berasingan.",
            promo_step1_title: "Cipta akaun CornGrid anda",
            promo_step1_desc: "Daftar sekali untuk membolehkan Portal Terminal Trading, aplikasi Android dan suapan komuniti CornGrid. Akaun yang sama digunakan pada setiap peranti.",
            promo_step2_title: "Jana kod pasangan",
            promo_step2_desc: 'Buka <strong>MT5 Accounts</strong> dalam terminal dan jana kod pasangan sekali guna. Kod akan luput selepas 10 minit dan hanya boleh digunakan sekali.',
            promo_step3_title: "Sambungkan CornGrid EA anda",
            promo_step3_desc: 'Tampal kod ke dalam parameter <code>InpDashboardPairingCode</code> CornGrid EA dalam MetaTrader 5, kemudian benarkan WebRequest untuk <code>https://corngrid.com</code> di bawah <strong>Tools &rarr; Options &rarr; Expert Advisors</strong>.',
            promo_step4_title: "Trade dari mana-mana peranti",
            promo_step4_desc: "Akaun anda akan menjadi dalam talian di terminal selepas denyut jantung pertama. Pasang aplikasi Android untuk mengikuti papan pemuka, posisi dan suapan yang sama dalam tangan anda.",

            /* --- Section G: Registration & download CTA --- */
            promo_badge_cta: "Mula Sekarang",
            promo_cta_title: "Bersedia Untuk Bersambung dengan CornGrid?",
            promo_cta_lead: "Cipta akaun anda, sambungkan persekitaran trading anda, dan terokapi terminal CornGrid serta pengalaman Android yang baharu.",
            promo_btn_apk: '<i class="fab fa-android"></i> Muat Turun APK Android',

            /* --- Footer --- */
            promo_footer_about: "CornGrid menyediakan teknologi trading automatik untuk MetaTrader 5 dan Portal Terminal Trading CornGrid, menghubungkan trader dengan akaun, pasaran, dan komuniti mereka.",
            promo_footer_status: "Portal Terminal &amp; Aplikasi Android &mdash; Kini Langsung",
            promo_footer_beta_label: "Android beta:",
            promo_footer_beta: "Aplikasi Android CornGrid diedarkan sebagai APK dan belum lagi tersedia di Google Play Store. Muat turun dan pasang hanya jika anda mempercayai sumber ini.",
            promo_footer_platform: "Platform",
            promo_footer_main: "Main Website",
            promo_footer_terminal: "Terminal Portal",
            promo_footer_register: "Sign in",
            promo_footer_apk: "Download APK",
            promo_footer_support: "Support",
            promo_footer_tg_helpdesk: "@CornGridSupportbot",
            promo_footer_trader_net: "@CornGridGroup",
            promo_footer_whatsapp: "+60 17-566 0753",
            promo_footer_email: "support@corngrid.com",
            promo_footer_tiktok: "TikTok &mdash; @corngrid",
            promo_footer_legal: "Legal",
            promo_footer_risk: "Risk Policy",
            promo_footer_terms: "Terms of Deployment",
            promo_footer_copyright: "&copy; 2026 <strong>CornGrid Technologies</strong>. Semua Hak Terpelihara.",
            promo_footer_motto: "Trade Smart. Recover Smarter.",

            /* --- Floating support widget --- */
            promo_support_title: "Meja Sokongan CornGrid",
            promo_support_sub: "Sokongan Pelanggan Institusi",
            promo_support_tg_title: "Telegram Helpdesk",
            promo_support_tg_sub: "@CornGridSupportbot",
            promo_support_tn_title: "Komuniti Trader",
            promo_support_tn_sub: "Sertai Komuniti Rasmi",
            promo_support_wa_title: "Talian Pelanggan Langsung",
            promo_support_wa_sub: "Sembang melalui WhatsApp",
            promo_support_email_title: "Hubungan Korporat",
            promo_support_email_sub: "support@corngrid.com",
            promo_support_aria_open: "Buka Sokongan CornGrid",
            promo_support_aria_close: "Tutup Sokongan CornGrid",

            /* --- Image alt text --- */
            promo_alt_hero_terminal: "Portal Terminal Trading CornGrid &mdash; jadual sejarah trading dengan import untung bersih setiap dagangan",
            promo_alt_hero_mobile: "Aplikasi Android CornGrid &mdash; ringkasan akaun dengan baki, ekuiti dan untung terapung",
            promo_alt_terminal_01: "Portal Terminal Trading CornGrid &mdash; suapan langsung dengan pengumuman rasmi CornGrid dan kiriman komuniti",
            promo_alt_terminal_02: "Portal Terminal Trading CornGrid &mdash; Terminal Chat dengan sokongan CornGrid dan trader lain",
            promo_alt_terminal_03: "Portal Terminal Trading CornGrid &mdash; ringkasan trading dengan baki, ekuiti, untung bersih dan kadar kemenangan",
            promo_alt_mobile_01: "Aplikasi Android CornGrid &mdash; ringkasan akaun dengan baki, ekuiti, untung/rugi terapung dan kadar kemenangan",
            promo_alt_mobile_02: "Aplikasi Android CornGrid &mdash; suapan komuniti langsung dengan pengumuman rasmi",
            promo_alt_mobile_03: "Aplikasi Android CornGrid &mdash; akaun MT5 dengan kod pasangan dan pemasangan CornGrid EA bersambung",
            promo_alt_showcase_01: "Portal Terminal Trading CornGrid &mdash; ringkasan pasaran dengan carta candlestick langsung untuk emas dan mata wang utama",
            promo_alt_showcase_02: "Portal Terminal Trading CornGrid &mdash; posisi terbuka dengan untung dan rugi terapung langsung",
            promo_alt_showcase_03: "Portal Terminal Trading CornGrid &mdash; pemantauan EA yang memaparkan denyut jantung dan status penyegerakan",
            promo_alt_showcase_04: "Portal Terminal Trading CornGrid &mdash; akaun MT5, kod pasangan dan pemasangan CornGrid EA bersambung",
            promo_alt_showcase_05: "Portal Terminal Trading CornGrid &mdash; tetapan dan profil dengan keutamaan paparan dan pembantu pemasangan Android",
            promo_alt_showcase_mobile_01: "Aplikasi Android CornGrid &mdash; posisi terbuka pada telefon pintar",
            promo_alt_showcase_mobile_02: "Aplikasi Android CornGrid &mdash; sejarah trading dengan import untung bersih setiap dagangan pada telefon pintar",
            promo_alt_showcase_mobile_03: "Aplikasi Android CornGrid &mdash; Terminal Chat dengan sokongan CornGrid pada telefon pintar"
        }
    };
    /* =========================================
       APPLY TRANSLATIONS
       ========================================= */

    function getStoredLang() {
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            return SUPPORTED.indexOf(saved) !== -1 ? saved : DEFAULT_LANG;
        } catch (e) {
            return DEFAULT_LANG;
        }
    }

    function setStoredLang(lang) {
        try {
            localStorage.setItem(STORAGE_KEY, lang);
        } catch (e) {
            /* Storage may be unavailable (private mode); the page still works. */
        }
    }

    /* Read a translation value, supporting a per-element fallback key. */
    function lookup(dict, key) {
        if (!dict || !key) return null;
        if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
        /* "key:fallback" lets one element carry two translation keys. */
        var parts = key.split('|');
        for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            if (part && Object.prototype.hasOwnProperty.call(dict, part)) return dict[part];
        }
        return null;
    }

    function decodeEntities(value) {
        return String(value)
            .replace(/&mdash;/g, '—')
            .replace(/&ndash;/g, '–')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"');
    }

    function applyLanguage(lang) {
        if (SUPPORTED.indexOf(lang) === -1) lang = DEFAULT_LANG;
        var dict = promoTranslations[lang];
        if (!dict) return;

        document.documentElement.setAttribute('lang', lang);

        var nodes = document.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var value = lookup(dict, el.getAttribute('data-i18n'));
            if (value !== null) el.innerHTML = value;
        }

        /* Document title & meta description follow the selected language. */
        var titleEl = document.querySelector('[data-i18n-title]');
        if (titleEl) {
            var titleValue = lookup(dict, titleEl.getAttribute('data-i18n-title'));
            if (titleValue !== null) document.title = decodeEntities(titleValue);
        }

        var descEl = document.querySelector('[data-i18n-desc]');
        if (descEl) {
            var descValue = lookup(dict, descEl.getAttribute('data-i18n-desc'));
            if (descValue !== null) descEl.setAttribute('content', decodeEntities(descValue));
        }

        /* Image alt text follows the language too. */
        var altNodes = document.querySelectorAll('[data-i18n-alt]');
        for (var a = 0; a < altNodes.length; a++) {
            var altValue = lookup(dict, altNodes[a].getAttribute('data-i18n-alt'));
            if (altValue !== null) altNodes[a].setAttribute('alt', decodeEntities(altValue));
        }

        /* Language switcher button state. */
        var btnEn = document.getElementById('btnEn');
        var btnBm = document.getElementById('btnBm');
        if (btnEn && btnBm) {
            btnEn.classList.toggle('active', lang !== 'bm');
            btnBm.classList.toggle('active', lang === 'bm');
        }

        /* Support widget aria-label follows the language too. */
        var supportButton = document.getElementById('cgContactButton');
        if (supportButton) {
            var isOpen = document.querySelector('.cg-contact.open');
            var ariaKey = isOpen ? 'promo_support_aria_close' : 'promo_support_aria_open';
            var ariaValue = lookup(dict, ariaKey);
            if (ariaValue !== null) supportButton.setAttribute('aria-label', ariaValue);
        }

        var navToggle = document.getElementById('menuToggle');
        if (navToggle) {
            var isNavOpen = document.querySelector('#navMenu.active');
            var navAriaKey = isNavOpen ? 'promo_aria_close_nav' : 'promo_aria_open_nav';
            var navAriaValue = lookup(dict, navAriaKey);
            if (navAriaValue !== null) navToggle.setAttribute('aria-label', navAriaValue);
        }
    }

    function switchPromoLanguage(lang) {
        if (SUPPORTED.indexOf(lang) === -1) lang = DEFAULT_LANG;
        setStoredLang(lang);
        applyLanguage(lang);
    }

    global.PromoI18n = {
        translations: promoTranslations,
        applyLanguage: applyLanguage,
        switchLanguage: switchPromoLanguage,
        getStoredLang: getStoredLang
    };
})(window);
