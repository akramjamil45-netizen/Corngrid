// =========================================
// 1. DYNAMIC HEADER ON SCROLL
// =========================================
const mainHeader = document.querySelector("#mainHeader");

if (mainHeader) {
    window.addEventListener("scroll", () => {
        if (window.scrollY > 50) {
            mainHeader.classList.add("header-scrolled");
        } else {
            mainHeader.classList.remove("header-scrolled");
        }
    });
}

// =========================================
// 2. FAQ ACCORDION (SUPPORTING WHITE & DARK THEME)
// =========================================
const faqItems = document.querySelectorAll(".faq-item-white, .faq-item");

faqItems.forEach((item, index) => {
    const button = item.querySelector(".faq-question-white, .faq-question");
    const panel = item.querySelector(".faq-answer-white, .faq-answer");

    if (!button) return;

    // Expose the accordion pattern (WCAG 4.1.2): link each button to its panel
    // and report expanded state. Native <button> already handles Enter/Space.
    if (panel && !panel.id) panel.id = `faq-panel-${index + 1}`;
    if (panel && panel.id) button.setAttribute("aria-controls", panel.id);
    button.setAttribute("aria-expanded", String(item.classList.contains("active")));

    button.addEventListener("click", () => {
        faqItems.forEach((faq) => {
            if (faq !== item) {
                faq.classList.remove("active");
            }
        });
        item.classList.toggle("active");

        // The toggle is exclusive, so every button's expanded state can change.
        faqItems.forEach((faq) => {
            const faqButton = faq.querySelector(".faq-question-white, .faq-question");
            if (faqButton) {
                faqButton.setAttribute("aria-expanded", String(faq.classList.contains("active")));
            }
        });
    });
});

// =========================================
// 3. Support button
// =========================================

    const cgContact = document.querySelector(".cg-contact");
    const cgContactButton = document.querySelector("#cgContactButton");

    if (cgContact && cgContactButton) {
    cgContactButton.addEventListener("click", (e) => {
        e.preventDefault();
        cgContact.classList.toggle("open");
    });

    // Petua Tambahan: Tutup widget jika pengguna menekan di luar butang/contact box
    document.addEventListener("click", (e) => {
        if (!cgContact.contains(e.target) && !cgContactButton.contains(e.target)) {
            cgContact.classList.remove("open");
        }
    });
    }

// =========================================
// 4. MOBILE NAVIGATION MENU TOGGLE
// =========================================
const menuToggle = document.querySelector("#menuToggle");
const navMenu = document.querySelector("#navMenu");
const navLinks = document.querySelectorAll(".nav-link");

if (menuToggle && navMenu) {
    const closeMenu = () => {
        menuToggle.classList.remove("active");
        navMenu.classList.remove("active");
        menuToggle.setAttribute("aria-expanded", "false");
        menuToggle.setAttribute("aria-label", "Open navigation");
    };

    menuToggle.addEventListener("click", () => {
        const isOpen = menuToggle.classList.toggle("active");
        navMenu.classList.toggle("active", isOpen);
        menuToggle.setAttribute("aria-expanded", String(isOpen));
        menuToggle.setAttribute("aria-label", isOpen ? "Close navigation" : "Open navigation");
    });

    navLinks.forEach((link) => {
        link.addEventListener("click", closeMenu);
    });

    document.addEventListener("click", (e) => {
        if (!navMenu.contains(e.target) && !menuToggle.contains(e.target)) {
            closeMenu();
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMenu();
    });

    // Leaving the drawer breakpoint must not strand an open drawer.
    window.addEventListener("resize", () => {
        if (window.innerWidth > 1100) closeMenu();
    });
}

// =========================================
// 5. TESTIMONIAL SLIDER ANIMATION (DARK QUANT THEME)
// =========================================
const sliderTrack = document.querySelector("#sliderTrack");
const testSlides = document.querySelectorAll(".testimonial-card-dark");
const testPrevBtn = document.querySelector("#prevBtn");
const testNextBtn = document.querySelector("#nextBtn");
const testDots = document.querySelectorAll(".dot-item");
const sliderContainer = document.querySelector("#testimonialSlider");

if (sliderTrack && testSlides.length > 0) {
    let currentIndex = 0;
    let autoSlideInterval;
    const slideCount = testSlides.length;

    function updateSlider(index) {
        if (index < 0) {
            currentIndex = slideCount - 1;
        } else if (index >= slideCount) {
            currentIndex = 0;
        } else {
            currentIndex = index;
        }

        sliderTrack.style.transform = `translateX(-${currentIndex * 100}%)`;

        testDots.forEach((dot, idx) => {
            if (idx === currentIndex) {
                dot.classList.add("active");
            } else {
                dot.classList.remove("active");
            }
        });
    }

    if (testNextBtn) {
        testNextBtn.addEventListener("click", () => {
            updateSlider(currentIndex + 1);
            resetAutoSlide();
        });
    }

    if (testPrevBtn) {
        testPrevBtn.addEventListener("click", () => {
            updateSlider(currentIndex - 1);
            resetAutoSlide();
        });
    }

    testDots.forEach((dot) => {
        dot.addEventListener("click", (e) => {
            const targetIndex = parseInt(e.target.getAttribute("data-index"));
            updateSlider(targetIndex);
            resetAutoSlide();
        });
    });

    function startAutoSlide() {
        autoSlideInterval = setInterval(() => {
            updateSlider(currentIndex + 1);
        }, 5000);
    }

    function resetAutoSlide() {
        clearInterval(autoSlideInterval);
        startAutoSlide();
    }

    startAutoSlide();

    if (sliderContainer) {
        sliderContainer.addEventListener("mouseenter", () => clearInterval(autoSlideInterval));
        sliderContainer.addEventListener("mouseleave", startAutoSlide);
    }
}


// =========================================
// MULTI-LANGUAGE SWITCHER (ENGLISH & BAHASA MELAYU)
// =========================================

function switchLanguage(lang) {
    // Simpan pilihan bahasa pengguna di localStorage
    localStorage.setItem("selectedLang", lang);

    // Kemas kini gaya aktif pada butang
    const btnEn = document.querySelector("#btnEn");
    const btnBm = document.querySelector("#btnBm");

    if (btnEn && btnBm) {
        if (lang === "bm") {
            btnBm.classList.add("active");
            btnEn.classList.remove("active");
        } else {
            btnEn.classList.add("active");
            btnBm.classList.remove("active");
        }
    }

    // Tukar semua teks mengikut data-i18n
    const elements = document.querySelectorAll("[data-i18n]");
    elements.forEach((el) => {
        const key = el.getAttribute("data-i18n");
        if (translations[lang] && translations[lang][key]) {
            el.innerHTML = translations[lang][key];
        }
    });
}

// Semak bahasa pilihan apabila laman web dibuka
document.addEventListener("DOMContentLoaded", () => {
    const savedLang = localStorage.getItem("selectedLang") || "en";
    switchLanguage(savedLang);
});


// =========================================
// CORNGRID EA - FULL TRANSLATION DICTIONARY
// =========================================
const translations = {
    en: {
        // --- Navigation ---
        nav_features: "Features",
        nav_setup: "Setup",
        nav_presets: "Preset Files",
        nav_terminal_app: "Terminal App",
        nav_support: "Support",
        nav_portfolios: "Portfolios",
        nav_login: "Sign in",

        // --- Hero Section ---
        hero_badge: "PREMIUM QUANT ALGORITHM v1.90",
        hero_title: 'Maximize Recovery & <span class="highlight-gold">Trade Smarter</span> with CornGrid EA MT5',
        hero_desc: "Fully Automated Trading System powered by Smart Reverse Entry & Dynamic Basket Profit Technology. Built for traders who want intelligent grid recovery, safe drawdown limits, and lightning-fast MT5 execution.",
        hero_btn_demo: '<i class="fas fa-download"></i> Download Free Demo',
        hero_btn_full: '<i class="fas fa-shopping-cart"></i> Get Full Version',
        trust_hedging: "Native MT5 Hedging",
        trust_drawdown: "Hard-Stop Capital Protection",
        trust_xauusd: "XAUUSD Optimized",
        float_exec_title: "Sub-5ms Execution",
        float_exec_sub: "Equinix VPS Latency",
        float_shield_title: "Equity Safeguard",
        float_shield_sub: "Automated Risk Shield",

        // --- Metrics Bar ---
        metric_1_title: "MT5 Platform",
        metric_1_sub: "Optimized Architecture",
        metric_2_title: "XAUUSD Focus",
        metric_2_sub: "Quantitative Precision",
        metric_3_title: "Sub-Millisecond",
        metric_3_sub: "Latency Execution",
        metric_4_title: "Hard Stop Safeguard",
        metric_4_sub: "Capital Protection",

        myfx_verified_badge: "VERIFIED",
        myfx_title: "CornGrid Real Account Analytics",
        myfx_btn: "Verify on Myfxbook",
        myfx_total_gain: "Total Gain",
        myfx_gain_sub: "Automated Cumulative Yield",
        myfx_monthly_gain: "Daily Average",
        myfx_monthly_sub: "Consistent Daily Return",
        myfx_max_dd: "Max Drawdown",
        myfx_dd_sub: "Strict Risk Control",
        myfx_winrate: "Profit Factor",
        myfx_winrate_sub: "Consistent Profitability",

        // --- Dashboard Showcase ---
        dash_badge: "EA DASHBOARD",
        dash_title: "Monitor Everything Easily",
        dash_subtitle: "Get complete visual control. Monitor your real-time exposure, margin limits, and risk parameters directly on your MetaTrader 5 chart.",
        dash_tag: "RISK MANAGEMENT",
        dash_h3: "On-Chart Analytics",
        dash_intro: "Directly integrated into the MT5 graphics engine to deliver real-time metrics without slowing down your terminal.",
        dash_f1_title: "Equity & Balance Tracking",
        dash_f1_desc: "Monitor your floating P/L, total equity, and balance fluctuations in real-time.",
        dash_f2_title: "Unified Basket Exposure",
        dash_f2_desc: "Easily see your combined Buy & Sell positions for quicker decision making.",
        dash_f3_title: "Margin Protection",
        dash_f3_desc: "Keeps an eye on your free margin to prevent over-leveraging during extreme market moves.",
        dash_f4_title: "Hard-Stop Circuit Breaker",
        dash_f4_desc: "An automated safety net that pauses new grid cycles if you hit your maximum drawdown limit.",
        dash_btn: '<i class="fas fa-download"></i> Try Demo Version',
        dash_demo_sub: "Includes Free Practice License",

        hiw_badge: "HOW IT WORKS",
        hiw_title: "System Architecture & Order Flow",
        hiw_subtitle: "Designed for speed and safety, balancing fast order entries with smart drawdown stabilization.",
        hiw_c1_title: "Momentum Signal Protocol",
        hiw_c1_desc: "Analyzes candle momentum to find high-probability reversal zones before taking a trade.",
        hiw_c2_title: "Adaptive Grid Recovery",
        hiw_c2_desc: "Automatically adjusts the distance between trades during high volatility to protect your margin.",
        hiw_c3_title: "Smart Basket Closure",
        hiw_c3_desc: "Tracks your total floating profit and closes all open positions instantly when the target is reached.",

        comp_badge: "WHY CHOOSE US?",
        comp_title: "Why Traders Upgrade to CornGrid",
        comp_subtitle: "Discover the advantages over manual trading and standard retail EAs.",
        comp_th_metric: "Performance Metric",
        comp_th_manual: "Manual Trading",
        comp_th_retail: "Standard EAs",
        comp_th_corngrid: "<strong>CornGrid EA</strong>",
        comp_r1_metric: "Execution Speed",
        comp_r1_manual: "Human Delay & Emotion",
        comp_r1_retail: "Static Rules",
        comp_r1_corngrid: "✔ Sub-millisecond Reaction",
        comp_r2_metric: "Handling Volatility",
        comp_r2_manual: "High Stress & Fatigue",
        comp_r2_retail: "Static Grid (High Risk)",
        comp_r2_corngrid: "✔ Dynamic Grid Adaptation",
        comp_r3_metric: "Closing Profits",
        comp_r3_manual: "Manual Close Lag",
        comp_r3_retail: "Basic Stop Loss",
        comp_r3_corngrid: "✔ Auto Basket Closure",
        comp_r4_metric: "Risk Management",
        comp_r4_manual: "Inconsistent Discipline",
        comp_r4_retail: "No Equity Protection",
        comp_r4_corngrid: "✔ Built-in Hard-Stop",

        // --- Core Features ---
        feat_badge: "CORE FEATURES",
        feat_title: "What Makes CornGrid Different?",
        feat_subtitle: "Built specifically for high-liquidity markets and extreme gold (XAUUSD) volatility.",
        feat_m1_tag: "MODULE 01",
        feat_m1_title: "Smart Reverse Entry",
        feat_m1_desc: "Avoid false breakouts. The system analyzes candle exhaustion patterns before opening a counter-trend trade.",
        feat_m1_foot: "False Breakout Filter",
        feat_m2_tag: "CORE MATRIX",
        feat_m2_title: "Dynamic Grid Matrix",
        feat_m2_desc: "Automatically adapts lot sizes, recovery distances, and profit targets based on real-time market speed (ATR).",
        feat_m2_foot: "Adaptive Volatility Spacing",
        feat_m3_tag: "MODULE 03",
        feat_m3_title: "Capital Protection",
        feat_m3_desc: "Features hard-stop limits, free margin buffers, and an auto-pause function to prevent account blowouts.",
        feat_m3_foot: "Equity Circuit Breaker",

        // --- Specifications & Setup ---
        algo_badge: "SYSTEM SPECS",
        algo_title: "Under the Hood",
        algo_subtitle: "Engineered with high-speed execution protocols and smart exposure control.",
        algo_c1_title: "Dynamic Basket Engine",
        algo_c1_desc: "Continuously evaluates floating P/L and liquidates all positions seamlessly once the profit target is hit.",
        algo_c2_title: "Margin Integrity Safeguard",
        algo_c2_desc: "Monitors real-time free margin and ensures full compliance with MT5 Hedging structures.",
        algo_c3_title: "Smart Lot Multiplier",
        algo_c3_desc: "Calculates lot progression automatically based on your account balance and risk limits.",
        algo_c4_title: "Broker Validator",
        algo_c4_desc: "Checks current spreads and market liquidity before placing any orders.",

        setup_badge: "SYSTEM REQUIREMENTS",
        setup_title: "Recommended Setup",
        setup_subtitle: "The ideal account architecture for the best trading performance.",
        setup_l1: "Trading Architecture",
        setup_l1_tag: "Hedging Required",
        setup_l2: "Supported Assets",
        setup_l3: "Operating Timeframes",
        setup_l4: "Cent / Micro Tier",
        setup_l4_tag: "Good for Testing",
        setup_l5: "Standard Tier",
        setup_l5_tag: "Full Potential",
        setup_l6: "Leverage & VPS",

        // --- Deployment Guide ---
        guide_badge: "EASY DEPLOYMENT",
        guide_title: "Simple 4-Step Setup",
        guide_subtitle: "Get CornGrid EA running on your MT5 in just a few minutes.",
        guide_s1_title: "Download EA",
        guide_s1_desc: "Get the official release package (.ex5) from our portal.",
        guide_s2_title: "Paste in MT5",
        guide_s2_desc: "Paste the file into <strong>File → Open Data Folder → MQL5 → Experts</strong>.",
        guide_s3_title: "Enable Algo",
        guide_s3_desc: "Turn on <strong>Allow Algorithmic Trading</strong> and WebRequest in your MT5 settings.",
        guide_s4_title: "Load Preset",
        guide_s4_desc: "Attach the EA to a XAUUSD M5 chart, load the .SET file, and you're good to go.",
        pdf_banner_h4: "Need a Visual Walkthrough?",
        pdf_banner_p: "Download our complete step-by-step PDF manual & setup guide.",
        pdf_banner_btn: '<i class="fas fa-download"></i> Download PDF Guide',

        // --- Quant SET Vault ---
        vault_badge: "PRESET FILES",
        vault_title: "Official SET File Vault",
        vault_subtitle: "Ready-to-use presets optimized and stress-tested by the CornGrid team for maximum stability.",
        meta_build: "EA VERSION",
        meta_opt: "LAST OPTIMIZED",
        meta_status: "STATUS",
        vault_download: '<i class="fas fa-download"></i> Download .SET',

        // --- Recommended Brokers ---
        broker_badge: "TRUSTED BROKERS",
        broker_title: "Recommended MT5 Brokers",
        broker_subtitle: "Trade with our verified partners offering tight spreads, fast execution, and full Cent/Micro account support.",
        broker_btn: 'Open Broker Account <i class="fas fa-arrow-right"></i>',

        // --- Testimonials & FAQ ---
        testi_badge: "TRADER FEEDBACK",
        testi_title: "What Our Users Say",
        testi_subtitle: "Trusted by independent traders who rely on automated trading.",
        verified_user: "Verified User",
        risk_title: "High Risk Investment Warning",
        risk_desc: "Algorithmic trading with Grid models involves risk. Please configure your Hard Stop limits properly. Past results do not guarantee future performance. Always test on a Demo Account first.",

        faq_badge: "FAQ",
        faq_title: "Frequently Asked Questions",
        faq_subtitle: "Everything you need to know about setting up and using CornGrid.",

        faq_q1: "Can I use CornGrid EA for Prop Firms?",
        faq_a1: "Yes. CornGrid EA works on Prop Firm platforms that allow EAs and Hedging. Just make sure to set the Max Drawdown limit according to your firm's daily loss rules.",
        faq_q2: "Why do I need an MT5 Hedging account?",
        faq_a2: "Our algorithm manages Buy and Sell orders independently. A Hedging account allows these positions to be open at the same time for faster basket recovery.",
        faq_q3: "What leverage and VPS do you recommend?",
        faq_a3: "We recommend a leverage of <strong>1:500 or 1:1000</strong>, paired with a fast VPS (< 5ms latency) so trades close instantly.",
        faq_q4: "Are updates free?",
        faq_a4: "Yes. All license holders automatically receive version optimizations, bug fixes, and new preset files.",
        faq_q5: "Can I change the lot sizes and grid settings?",
        faq_a5: "Absolutely. You have full control over the Lot Multipliers, Grid Distances, Profit Targets, and Hard Stop limits.",

        // --- Support & Footer ---
        supp_badge: "HELP DESK",
        supp_title: "We're Here to Help",
        supp_subtitle: "Get direct access to our support team and join our official community channel.",
        supp_hours: "Support Hours: Mon - Fri | 24/5 Coverage",
        priv_title: "Full Version Perks",
        priv_sub: "Getting the Full Version unlocks premium support and core assets:",

        footer_about: "Next-generation trading algorithms for MetaTrader 5. We specialize in smart XAUUSD grid recovery, dynamic risk management, and keeping your capital safe.",
        footer_nav: "Navigation",
        footer_res: "Resources & Tools",
        footer_contact: "Contact Us",
        footer_motto: "Trade Smart. Recover Smarter."
    },

    bm: {
        // --- Navigation ---
        nav_features: "Ciri-Ciri",
        nav_setup: "Cara Setup",
        nav_presets: "Fail Preset",
        nav_terminal_app: "Aplikasi Terminal",
        nav_support: "Bantuan",
        nav_portfolios: "Portfolio",
        nav_login: "Daftar masuk",

        // --- Hero Section ---
        hero_badge: "ALGORITMA TRADING PREMIUM v1.90",
        hero_title: 'Kembangkan Akaun & <span class="highlight-gold">Trade Lebih Bijak</span> Bersama CornGrid EA MT5',
        hero_desc: "Sistem Trading Automatik Sepenuhnya dengan Teknologi Smart Reverse Entry & Dynamic Basket Profit. Direka khas untuk trader yang inginkan pemulihan grid pintar, kawalan drawdown yang selamat, dan eksekusi pantas di MT5.",
        hero_btn_demo: '<i class="fas fa-download"></i> Cuba Demo Percuma',
        hero_btn_full: '<i class="fas fa-shopping-cart"></i> Dapatkan Versi Penuh',
        trust_hedging: "Sokongan Hedging MT5",
        trust_drawdown: "Perlindungan Modal (Hard-Stop)",
        trust_xauusd: "Khas untuk XAUUSD (Gold)",
        float_exec_title: "Eksekusi Pantas < 5ms",
        float_exec_sub: "Sesuai dengan VPS",
        float_shield_title: "Perlindungan Akaun",
        float_shield_sub: "Sistem Auto-Cutloss",

        // --- Metrics Bar ---
        metric_1_title: "Platform MT5",
        metric_1_sub: "Seni Bina Moden",
        metric_2_title: "Fokus XAUUSD",
        metric_2_sub: "Tepat & Konsisten",
        metric_3_title: "Pantas & Lancar",
        metric_3_sub: "Eksekusi Tanpa Delay",
        metric_4_title: "Kawalan Hard Stop",
        metric_4_sub: "Lindungi Modal Anda",

        myfx_verified_badge: "REKOD DISAHKAN",
        myfx_title: "Prestasi Akaun Real CornGrid",
        myfx_btn: "Lihat di Myfxbook",
        myfx_total_gain: "Jumlah Keuntungan",
        myfx_gain_sub: "Keuntungan Terkumpul Automatik",
        myfx_monthly_gain: "Purata Harian",
        myfx_monthly_sub: "Pulangan Yang Konsisten",
        myfx_max_dd: "Max Drawdown",
        myfx_dd_sub: "Kawalan Risiko Yang Ketat",
        myfx_winrate: "Profit Factor",
        myfx_winrate_sub: "Prestasi Jangka Panjang",

        // --- Dashboard Showcase ---
        dash_badge: "PAPAN PEMUKA EA",
        dash_title: "Pantau Semua Dengan Mudah",
        dash_subtitle: "Kawal akaun anda dengan paparan visual yang jelas. Pantau info penting, margin, dan tahap risiko terus dari carta MetaTrader 5 anda.",
        dash_tag: "PENGURUSAN RISIKO",
        dash_h3: "Analitik Lengkap Di Carta",
        dash_intro: "Sistem dipasang terus pada enjin grafik MT5 supaya anda dapat baca data penting secara real-time tanpa buatkan MT5 anda 'lagging'.",
        dash_f1_title: "Pantau Ekuiti & Baki",
        dash_f1_desc: "Lihat jumlah floating untung/rugi, ekuiti semasa, dan baki akaun anda dengan mudah.",
        dash_f2_title: "Pendedahan (Exposure) Bersepadu",
        dash_f2_desc: "Gabungkan posisi Buy & Sell untuk mudahkan anda buat keputusan trading yang pantas.",
        dash_f3_title: "Penjagaan Margin Bebas",
        dash_f3_desc: "Sentiasa pantau tahap free margin anda supaya akaun tak over-trade bila market bergerak laju.",
        dash_f4_title: "Sistem Brek Automatik (Hard-Stop)",
        dash_f4_desc: "Sistem keselamatan yang akan tolong hentikan entry grid baru kalau dah capai limit drawdown yang anda tetapkan.",
        dash_btn: '<i class="fas fa-download"></i> Cuba Terminal Demo',
        dash_demo_sub: "Termasuk Lesen Latihan Percuma",

        hiw_badge: "CARA SISTEM BERFUNGSI",
        hiw_title: "Senibina & Logik Trading",
        hiw_subtitle: "Direka untuk kelajuan dan keselamatan, mengimbangi kemasukan pasaran yang pantas dengan kawalan risiko yang bijak.",
        hiw_c1_title: "Protokol Signal Momentum",
        hiw_c1_desc: "EA akan kaji momentum pergerakan candle untuk cari zon 'reversal' terbaik sebelum mula buka entry.",
        hiw_c2_title: "Grid Adaptif & Pintar",
        hiw_c2_desc: "Bila market tengah laju, EA akan jarakkan automatik entry grid seterusnya untuk jimatkan margin anda.",
        hiw_c3_title: "Sistem Take Profit (Basket)",
        hiw_c3_desc: "EA akan pantau jumlah keseluruhan floating profit dan terus 'clear' semua entry bila target keuntungan dicapai.",

        comp_badge: "KENAPA PILIH CORNGRID?",
        comp_title: "Kelebihan CornGrid Berbanding Cara Biasa",
        comp_subtitle: "Lihat sendiri kelebihan sistem kami berbanding trade secara manual atau pakai EA biasa.",
        comp_th_metric: "Ciri-Ciri Utama",
        comp_th_manual: "Trade Manual",
        comp_th_retail: "EA Runcit Biasa",
        comp_th_corngrid: "<strong>CornGrid EA</strong>",
        comp_r1_metric: "Kelajuan Eksekusi",
        comp_r1_manual: "Lambat & Ada Emosi",
        comp_r1_retail: "Statik",
        comp_r1_corngrid: "✔ Sepantas Kilat (Milisec)",
        comp_r2_metric: "Bila Market Laju",
        comp_r2_manual: "Mudah Panik & Penat",
        comp_r2_retail: "Grid Statik (Risiko MC)",
        comp_r2_corngrid: "✔ Grid Berubah Ikut Volatiliti",
        comp_r3_metric: "Sistem Take Profit",
        comp_r3_manual: "Manual Close (Lambat)",
        comp_r3_retail: "Stop Loss Biasa",
        comp_r3_corngrid: "✔ Close Automatik Secara Pukal (Basket)",
        comp_r4_metric: "Pengurusan Risiko",
        comp_r4_manual: "Disiplin Tak Konsisten",
        comp_r4_retail: "Tiada Perlindungan Auto",
        comp_r4_corngrid: "✔ Ada Auto Hard-Stop",

        // --- Core Features ---
        feat_badge: "CIRI-CIRI HEBAT",
        feat_title: "Apa Yang CornGrid Boleh Buat?",
        feat_subtitle: "Ciri-ciri khas yang direka untuk pasaran pantas dan agresif macam Gold (XAUUSD).",
        feat_m1_tag: "MODUL 01",
        feat_m1_title: "Smart Reverse Entry",
        feat_m1_desc: "Elak dari terperangkap dengan false breakout. Sistem akan kaji pergerakan candle dulu sebelum buka trade melawan arah (counter-trend).",
        feat_m1_foot: "Penapis False Breakout",
        feat_m2_tag: "MODUL TERAS",
        feat_m2_title: "Matriks Grid Dinamik",
        feat_m2_desc: "EA akan adjust saiz lot, jarak grid, dan target TP secara automatik berdasarkan kelajuan (ATR) market masa tu.",
        feat_m2_foot: "Jarak Grid Adaptif",
        feat_m3_tag: "MODUL 03",
        feat_m3_title: "Sistem Perlindungan Modal",
        feat_m3_desc: "Sistem ini menjaga modal anda dengan Auto Hard-Stop dan limit margin bebas untuk elak dari terkena margin call (MC).",
        feat_m3_foot: "Brek Keselamatan Ekuiti",

        // --- Specifications & Setup ---
        algo_badge: "SPESIFIKASI SISTEM",
        algo_title: "Prestasi Enjin CornGrid",
        algo_subtitle: "Dikuasakan dengan kelajuan eksekusi mantap dan kawalan risiko automatik.",
        algo_c1_title: "Enjin Take Profit (Basket)",
        algo_c1_desc: "Sentiasa memantau jumlah floating dan akan close semua posisi serentak secara automatik bila capai target.",
        algo_c2_title: "Perisai Margin",
        algo_c2_desc: "Memastikan tahap free margin anda sentiasa sihat dan patuh sepenuhnya pada struktur akaun Hedging MT5.",
        algo_c3_title: "Lot Multiplier Pintar",
        algo_c3_desc: "Sistem akan kira kenaikan saiz lot secara logik, bersesuaian dengan baki akaun dan had risiko anda.",
        algo_c4_title: "Semakan Broker",
        algo_c4_desc: "EA akan cek saiz spread dan keadaan pasaran semasa sebelum ia meletakkan sebarang entry.",

        setup_badge: "KEPERLUAN SISTEM",
        setup_title: "Cara Setup Yang Disyorkan",
        setup_subtitle: "Gunakan setting ini untuk dapatkan prestasi trading yang paling optimum.",
        setup_l1: "Jenis Akaun",
        setup_l1_tag: "Wajib Hedging",
        setup_l2: "Pair Disokong",
        setup_l3: "Timeframe (TF)",
        setup_l4: "Akaun Cent / Micro",
        setup_l4_tag: "Sesuai Untuk Test",
        setup_l5: "Akaun Standard",
        setup_l5_tag: "Potensi Sebenar",
        setup_l6: "Leverage & VPS",

        // --- Deployment Guide ---
        guide_badge: "CARA PEMASANGAN",
        guide_title: "Setup Mudah Dalam 4 Langkah",
        guide_subtitle: "Pasang CornGrid EA di MetaTrader 5 anda dengan pantas dalam masa beberapa minit saja.",
        guide_s1_title: "Muat Turun EA",
        guide_s1_desc: "Download file rasmi EA (.ex5) dari portal kami.",
        guide_s2_title: "Paste Dalam MT5",
        guide_s2_desc: "Paste file tu ke dalam <strong>File → Open Data Folder → MQL5 → Experts</strong>.",
        guide_s3_title: "Aktifkan Algo",
        guide_s3_desc: "Tick <strong>Allow Algorithmic Trading</strong> dan benarkan WebRequest dalam setting MT5.",
        guide_s4_title: "Load Preset",
        guide_s4_desc: "Masukkan EA pada chart XAUUSD M5, load fail .SET, dan anda sedia untuk bermula.",
        pdf_banner_h4: "Perlukan Panduan Bergambar?",
        pdf_banner_p: "Download manual PDF kami yang tunjuk cara setup *step-by-step*.",
        pdf_banner_btn: '<i class="fas fa-download"></i> Download Panduan PDF',

        // --- Quant SET Vault ---
        vault_badge: "FAIL PRESET",
        vault_title: "Koleksi Fail SET Rasmi",
        vault_subtitle: "Tetapan (preset) sedia guna yang dah diuji dan dioptimumkan oleh pasukan CornGrid untuk prestasi paling stabil.",
        meta_build: "VERSI EA",
        meta_opt: "UPDATE TERAKHIR",
        meta_status: "STATUS",
        vault_download: '<i class="fas fa-download"></i> Download .SET',

        // --- Recommended Brokers ---
        broker_badge: "BROKER PILIHAN",
        broker_title: "Broker MT5 Yang Disyorkan",
        broker_subtitle: "Pilih broker yang terbukti berikan spread rendah, eksekusi pantas, dan sokong akaun Cent/Micro di MT5.",
        broker_btn: 'Buka Akaun Broker <i class="fas fa-arrow-right"></i>',

        // --- Testimonials & FAQ ---
        testi_badge: "KATA-KATA TRADER",
        testi_title: "Apa Kata Pengguna Kami",
        testi_subtitle: "Dipercayai oleh para trader yang perlukan sistem trading yang automatik & konsisten.",
        verified_user: "Pengguna Sah",
        risk_title: "Peringatan Risiko",
        risk_desc: "Trading menggunakan sistem Grid ada risikonya tersendiri. Pastikan anda setkan had perlindungan modal (Hard Stop) dengan betul. Result yang lepas tak menjamin keuntungan masa depan. Sentiasa cuba di Akaun Demo dulu sebelum guna duit sebenar.",

        faq_badge: "SOALAN LAZIM (FAQ)",
        faq_title: "Soalan Yang Kerap Ditanya",
        faq_subtitle: "Semua jawapan yang anda perlu tahu sebelum mula gunakan CornGrid EA.",

        faq_q1: "Boleh ke guna CornGrid EA ni untuk akaun Prop Firm?",
        faq_a1: "Boleh. CornGrid EA boleh guna di Prop Firm yang benarkan Expert Advisor (EA) dan Hedging. Cuma pastikan anda setkan limit Max Drawdown selari dengan rules Daily Loss Prop Firm tu.",
        faq_q2: "Kenapa wajib guna akaun jenis MT5 Hedging?",
        faq_a2: "Sistem kami uruskan entry Buy dan Sell secara berasingan. Akaun jenis Hedging benarkan posisi Buy dan Sell dibuka serentak supaya proses 'recovery' jadi lebih cepat dan cekap.",
        faq_q3: "Berapa Leverage dan VPS yang sesuai?",
        faq_a3: "Kami sarankan guna leverage <strong>1:500 ke atas</strong>, dipadankan dengan VPS yang laju (ping bawah 5ms) supaya EA boleh close profit dengan pantas.",
        faq_q4: "Kena bayar tak kalau ada update EA baru?",
        faq_a4: "Tak perlu. Pengguna berdaftar akan dapat update secara percuma termasuk versi terbaru, perbaiki bugs, dan fail preset baru.",
        faq_q5: "Boleh ke saya ubah saiz lot dan setting grid tu sendiri?",
        faq_a5: "Boleh sangat. Anda ada kawalan penuh untuk setting Lot Multiplier, Jarak Grid, Target TP, dan juga limit Stop Loss / Hard Stop.",

        // --- Support & Footer ---
        supp_badge: "BANTUAN & SUPPORT",
        supp_title: "Kami Sedia Membantu",
        supp_subtitle: "Dapatkan akses terus kepada team teknikal kami dan join channel komuniti rasmi CornGrid.",
        supp_hours: "Waktu Operasi: Isnin - Jumaat | Support 24/5",
        priv_title: "Kelebihan Versi Penuh",
        priv_sub: "Bila anda langgan Versi Penuh, anda akan dapat akses istimewa ini:",

        footer_about: "Algoritma trading generasi baru untuk MetaTrader 5. Pakar dalam sistem recovery grid XAUUSD pintar, pengurusan risiko dinamik, dan perlindungan modal automatik.",
        footer_nav: "Navigasi",
        footer_res: "Sumber & Tool",
        footer_contact: "Hubungi Kami",
        footer_motto: "Trade Smart. Recover Smarter."
    }
};

document.addEventListener("DOMContentLoaded", function () {
    const openModalBtn = document.getElementById("openTermsModal");
    const closeModalBtn = document.getElementById("closeTermsModal");
    const cancelModalBtn = document.getElementById("cancelTermsBtn");
    const termsModal = document.getElementById("termsModal");
    const termsScrollBox = document.getElementById("termsScrollBox");
    const termsTextContent = document.getElementById("termsTextContent");
    const termsCheckbox = document.getElementById("termsCheckbox");
    const confirmDownloadBtn = document.getElementById("confirmDownloadBtn");

    let isTxtLoaded = false;
    let hasScrolledToBottom = false;

    // Fungsi membaca fail .txt
    function loadTermsTxt() {
        if (isTxtLoaded) return;

        // Tukar 'files/terms.txt' mengikut laluan/nama fail .txt anda
        fetch('files/terms.txt')
            .then(response => {
                if (!response.ok) {
                    throw new Error('Fail terms.txt tidak dijumpai.');
                }
                return response.text();
            })
            .then(data => {
                // Tukar pemutus baris \n kepada <br> supaya teks tersusun kemas
                termsTextContent.innerHTML = data.replace(/\n/g, '<br>');
                isTxtLoaded = true;
                checkScrollRequirement();
            })
            .catch(error => {
                console.error('Ralat membaca fail:', error);
                termsTextContent.innerHTML = '<p style="color:#ef4444;">Gagal memuat turun terma. Sila pastikan fail terms.txt wujud.</p>';
            });
    }

    // Buka Modal & Muat Fail TXT
    if (openModalBtn) {
        openModalBtn.addEventListener("click", function (e) {
            e.preventDefault();
            termsModal.classList.add("active");
            document.body.style.overflow = "hidden";
            loadTermsTxt();
        });
    }

    // Tutup Modal
    function closeModal() {
        termsModal.classList.remove("active");
        document.body.style.overflow = "auto";
    }

    if (closeModalBtn) closeModalBtn.addEventListener("click", closeModal);
    if (cancelModalBtn) cancelModalBtn.addEventListener("click", closeModal);

    // Semakan keperluan scroll
    function checkScrollRequirement() {
        // Jika kandungan teks pendek dan tiada scrollbar, buka kuncian checkbox terus
        if (termsScrollBox.scrollHeight <= termsScrollBox.clientHeight + 20) {
            hasScrolledToBottom = true;
            termsCheckbox.disabled = false;
        }
    }

    // Pengesanan Scroll hingga bawah
    if (termsScrollBox) {
        termsScrollBox.addEventListener("scroll", function () {
            const scrollPosition = termsScrollBox.scrollTop + termsScrollBox.clientHeight;
            const scrollTotal = termsScrollBox.scrollHeight;

            if (scrollTotal - scrollPosition <= 20) {
                if (!hasScrolledToBottom) {
                    hasScrolledToBottom = true;
                    termsCheckbox.disabled = false;
                }
            }
        });
    }

    // Kawalan Checkbox
    if (termsCheckbox) {
        termsCheckbox.addEventListener("change", function () {
            if (this.checked && hasScrolledToBottom) {
                confirmDownloadBtn.classList.remove("disabled");
            } else {
                confirmDownloadBtn.classList.add("disabled");
            }
        });
    }

    // Tutup modal selepas muat turun bermula
    if (confirmDownloadBtn) {
        confirmDownloadBtn.addEventListener("click", function () {
            setTimeout(closeModal, 500);
        });
    }
});

// Gantikan logik pembukaan modal sedia ada di script.js dengan kod ini:
const openModalBtns = document.querySelectorAll("#openTermsModal, .open-terms-modal-btn");

openModalBtns.forEach(btn => {
    btn.addEventListener("click", function (e) {
        e.preventDefault();
        termsModal.classList.add("active");
        document.body.style.overflow = "hidden";
        loadTermsTxt();
    });
});