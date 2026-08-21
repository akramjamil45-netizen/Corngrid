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

faqItems.forEach((item) => {
    const button = item.querySelector(".faq-question-white, .faq-question");

    if (button) {
        button.addEventListener("click", () => {
            faqItems.forEach((faq) => {
                if (faq !== item) {
                    faq.classList.remove("active");
                }
            });
            item.classList.toggle("active");
        });
    }
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
    menuToggle.addEventListener("click", () => {
        menuToggle.classList.toggle("active");
        navMenu.classList.toggle("active");
    });

    navLinks.forEach((link) => {
        link.addEventListener("click", () => {
            menuToggle.classList.remove("active");
            navMenu.classList.remove("active");
        });
    });

    document.addEventListener("click", (e) => {
        if (!navMenu.contains(e.target) && !menuToggle.contains(e.target)) {
            menuToggle.classList.remove("active");
            navMenu.classList.remove("active");
        }
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
        nav_support: "Support",
        nav_full_version: "Get Full Version",

        // --- Hero Section ---
        hero_badge: "INSTITUTIONAL QUANT ALGORITHM v1.90",
        hero_title: 'Maximize Recovery & <span class="highlight-gold">Trade Smarter</span> with CornGrid EA MT5',
        hero_desc: "Fully Automated Trading System powered by Smart Reverse Entry & Dynamic Basket Profit Technology. Engineered for institutional and retail traders who demand intelligent grid recovery, drawdown control, and sub-millisecond MT5 execution.",
        hero_btn_demo: '<i class="fas fa-download"></i> Download Free Demo',
        hero_btn_full: '<i class="fas fa-shopping-cart"></i> Get Full Version',
        trust_hedging: "Native MT5 Hedging",
        trust_drawdown: "Hard-Stop Drawdown Breaker",
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
        myfx_dd_sub: "Strict Risk Control Guard",
        myfx_winrate: "Profit Factor",
        myfx_winrate_sub: "Quantitative Profitability Ratio",

        // --- Dashboard Showcase ---
        dash_badge: "TERMINAL INTERFACE",
        dash_title: "CornGrid EA Analytics Dashboard",
        dash_subtitle: "Gain complete visual control with real-time exposure monitoring, margin metrics, and institutional risk parameters rendered directly on your MetaTrader 5 chart.",
        dash_tag: "RISK MANAGEMENT ENGINE",
        dash_h3: "Enterprise Analytics Suite",
        dash_intro: "Directly integrated into MT5 graphics engine to deliver low-latency quantitative metrics without performance lag.",
        dash_f1_title: "Equity & Balance Synchronization",
        dash_f1_desc: "Real-time tracking of floating P/L, total equity yield, and balance fluctuation.",
        dash_f2_title: "Basket Exposure Consolidation",
        dash_f2_desc: "Aggregates long & short positions into unified exposure metrics for quick execution.",
        dash_f3_title: "Margin & Free Capital Buffer",
        dash_f3_desc: "Monitors free margin levels and prevents over-leveraging during extreme market speed.",
        dash_f4_title: "Hard-Stop Circuit Breaker",
        dash_f4_desc: "Automated safety threshold that freezes new grid cycles upon reaching max drawdown rules.",
        dash_btn: '<i class="fas fa-download"></i> Deploy Demo Terminal',
        dash_demo_sub: "Includes Free Practice License",

        hiw_badge: "EXECUTION MODEL",
        hiw_title: "System Architecture & Order Flow",
        hiw_subtitle: "Designed like hedge fund execution models, balancing order entry speed with dynamic draw-down stabilization.",
        hiw_c1_title: "Momentum Signal Protocol",
        hiw_c1_desc: "Analyzes multi-candle price action momentum to pinpoint high-probability reversal channels prior to trade trigger.",
        hiw_c2_title: "Adaptive Grid Recovery",
        hiw_c2_desc: "Dynamically recalculates order spacing during high volatility, mitigating over-leveraging and protecting margin.",
        hiw_c3_title: "Basket Exposure Clearance",
        hiw_c3_desc: "Tracks net floating equity across all open positions, instantly liquidating the basket when net profit targets are hit.",

        comp_badge: "BENCHMARK COMPARISON",
        comp_title: "Why Institutional Traders Upgrade to CornGrid",
        comp_subtitle: "Discover the structural advantages over traditional retail trading practices.",
        comp_th_metric: "Performance Metric",
        comp_th_manual: "Manual Execution",
        comp_th_retail: "Standard Retail EA",
        comp_th_corngrid: "<strong>CornGrid EA Quant Model</strong>",
        comp_r1_metric: "Execution Precision",
        comp_r1_manual: "Human Delay & Bias",
        comp_r1_retail: "Static Rules",
        comp_r1_corngrid: "✔ Sub-millisecond Reaction Time",
        comp_r2_metric: "Volatility Handling",
        comp_r2_manual: "High Fatigue Factor",
        comp_r2_retail: "Static Spacing (Account Blowout Risk)",
        comp_r2_corngrid: "✔ Dynamic Volatility Grid Adaptation",
        comp_r3_metric: "Capital Liquidation",
        comp_r3_manual: "Manual Close Lag",
        comp_r3_retail: "Basic Single Stop Loss",
        comp_r3_corngrid: "✔ Net Basket Equity Target Clearance",
        comp_r4_metric: "Risk Management",
        comp_r4_manual: "Inconsistent Discipline",
        comp_r4_retail: "No Equity Protection",
        comp_r4_corngrid: "✔ Institutional Hard-Stop Protection",

        // --- Core Features ---
        feat_badge: "ALGORITHMIC CORE",
        feat_title: "Core Quantitative Capabilities",
        feat_subtitle: "Algorithmic components engineered for high liquidity markets and extreme gold volatility.",
        feat_m1_tag: "MODULE 01",
        feat_m1_title: "Reverse Entry Logic",
        feat_m1_desc: "Filters false breakouts by measuring multi-timeframe candle exhaustion patterns before initiating counter-trend orders.",
        feat_m1_foot: "False Breakout Filter",
        feat_m2_tag: "CORE MATRIX",
        feat_m2_title: "Dynamic Grid Matrix",
        feat_m2_desc: "Algorithmic grid adjustment adapts lot sizing, recovery distances, and basket targets dynamically based on current ATR velocity.",
        feat_m2_foot: "Adaptive Volatility Spacing",
        feat_m3_tag: "MODULE 03",
        feat_m3_title: "Capital Protection Module",
        feat_m3_desc: "Enforces hard-stop equity thresholds, free margin buffers, and automatic circuit breakers to eliminate tail risk and drawdown spikes.",
        feat_m3_foot: "Equity Circuit Breaker",

        // --- Specifications & Setup ---
        algo_badge: "CORE ALGORITHM",
        algo_title: "Algorithmic Specifications",
        algo_subtitle: "Engineered with high-speed execution protocols and mathematical exposure control.",
        algo_c1_title: "Dynamic Basket Profit Engine",
        algo_c1_desc: "Evaluates aggregate floating P/L continuously and automatically liquidates full exposure upon target completion.",
        algo_c2_title: "Margin Integrity Safeguard",
        algo_c2_desc: "Monitors real-time free margin levels, slippage parameters, and full MT5 Hedging structure compliance.",
        algo_c3_title: "Smart Lot Multiplier Algorithm",
        algo_c3_desc: "Calculates dynamic lot progression mathematically aligned with overall account balance and risk limits.",
        algo_c4_title: "Broker Conditions Validator",
        algo_c4_desc: "Checks current spreads, order execution delays, and market liquidity before submitting orders.",

        setup_badge: "SYSTEM REQUIREMENTS",
        setup_title: "Institutional Environment Setup",
        setup_subtitle: "Recommended account architecture and infrastructure for low-latency execution.",
        setup_l1: "Trading Architecture",
        setup_l1_tag: "Hedging Mandated",
        setup_l2: "Supported Assets",
        setup_l3: "Operating Timeframes",
        setup_l4: "Cent / Micro Tier",
        setup_l4_tag: "Base Testing Capital",
        setup_l5: "Standard Institutional Tier",
        setup_l5_tag: "Full Exposure Capacity",
        setup_l6: "Leverage & Infrastructure",

        guide_badge: "DEPLOYMENT PROTOCOL",
        guide_title: "Simple 4-Step Setup Guide",
        guide_subtitle: "Quickly deploy CornGrid EA on MetaTrader 5 in just a few minutes.",
        guide_s1_title: "Download EA",
        guide_s1_desc: "Get the official release package (.ex5) from our directory.",
        guide_s2_title: "Paste in MT5",
        guide_s2_desc: "Paste file into <strong>File → Open Data Folder → MQL5 → Experts</strong>.",
        guide_s3_title: "Enable Algo",
        guide_s3_desc: "Turn on <strong>Allow Algorithmic Trading</strong> and WebRequest in MT5 settings.",
        guide_s4_title: "Load Preset",
        guide_s4_desc: "Attach EA to XAUUSD M5 chart, load .SET file, and activate.",
        pdf_banner_h4: "Need Visual Walkthrough?",
        pdf_banner_p: "Download the complete step-by-step PDF manual & setup guide.",
        pdf_banner_btn: '<i class="fas fa-download"></i> Download PDF Guide',

        // --- Deployment Guide ---
        guide_badge: "DEPLOYMENT PROTOCOL",
        guide_title: "Simple 4-Step Setup Guide",
        guide_subtitle: "Quickly deploy CornGrid EA on MetaTrader 5 in just a few minutes.",
        guide_s1_title: "Download EA",
        guide_s1_desc: "Get the official release package (.ex5) from our directory.",
        guide_s2_title: "Paste in MT5",
        guide_s2_desc: "Paste file into File → Open Data Folder → MQL5 → Experts.",
        guide_s3_title: "Enable Algo",
        guide_s3_desc: "Turn on Allow Algorithmic Trading and WebRequest in MT5 settings.",
        guide_s4_title: "Load Preset",
        guide_s4_desc: "Attach EA to XAUUSD M5 chart, load .SET file, and activate.",
        pdf_banner_h4: "Need Visual Walkthrough?",
        pdf_banner_p: "Download the complete step-by-step PDF manual & setup guide.",
        pdf_banner_btn: '<i class="fas fa-download"></i> Download PDF Guide',

        // --- Quant SET Vault ---
        vault_badge: "QUANTITATIVE PRESETS",
        vault_title: "Official SET File Vault",
        vault_subtitle: "Precision-engineered parameters optimized by CornGrid Quantitative Analysts. Stress-tested under real tick data to match specific instrument volatility profiles.",
        meta_build: "ALGORITHM BUILD",
        meta_opt: "LAST OPTIMIZATION",
        meta_status: "DEPLOYMENT STATUS",
        vault_download: '<i class="fas fa-download"></i> Download .SET',

        // --- Recommended Brokers ---
        broker_badge: "PRIME BROKERAGE DIRECTORY",
        broker_title: "High-Execution MetaTrader 5 Brokers",
        broker_subtitle: "Select from our verified brokerage partners offering competitive spreads, fast execution routes, and full MT5 Cent / Micro account infrastructure.",
        broker_btn: 'Open Brokerage Account <i class="fas fa-arrow-right"></i>',

        // --- Testimonials & FAQ ---
        testi_badge: "TRADER PROOF",
        testi_title: "Validated Trader Experiences",
        testi_subtitle: "Trusted by independent traders and fund managers utilizing automated quantitative algorithms.",
        verified_user: "Verified User",
        risk_title: "High Risk Investment Warning",
        risk_desc: "Algorithmic trading using Grid models involves significant financial exposure. Capital protection parameters should be strictly configured. Past results do not guarantee future performance. Always test parameters on Demo Accounts prior to live deployment.",

        faq_badge: "FREQUENTLY ASKED QUESTIONS",
        faq_title: "Frequently Asked Questions",
        faq_subtitle: "Comprehensive answers regarding deployment, infrastructure, and risk models.",


        faq_q1: "Is CornGrid EA compliant with Prop Firm rules?",
        faq_a1: "Yes. CornGrid EA can be deployed on Prop Firm platforms that permit Expert Advisors and Hedging. Ensure max drawdown equity safeguards are aligned with your Prop Firm's specific daily loss limits.",
        faq_q2: "Why is MetaTrader 5 Hedging required?",
        faq_a2: "CornGrid EA utilizes independent order management protocols. MT5 Hedging structure allows concurrent long and short positions, maximizing the efficiency of the Dynamic Basket Recovery algorithm.",
        faq_q3: "What latency and leverage conditions are optimal?",
        faq_a3: "We recommend a leverage environment of <strong>1:1000</strong> paired with an Equinix-hosted VPS (&lt; 5ms latency) for optimal basket liquidation timing.",
        faq_q4: "How are algorithm updates delivered?",
        faq_a4: "CornGrid EA receives ongoing version optimizations, bug fixes, performance enhancements, and new preset releases delivered automatically to license holders.",
        faq_q5: "Can lot progression and grid parameters be customized?",
        faq_a5: "Full customization is supported. Users can configure Lot Multipliers, Grid Distances, Basket Target Levels, Max Recovery Trades, and Hard Stop Loss Limits.",

        // --- Support & Footer ---
        supp_badge: "CLIENT DESK",
        supp_title: "Support & Institutional Relations",
        supp_subtitle: "Get direct access to our technical specialists, quantitative assistance, and official community channels.",
        supp_hours: "Desk Hours: Mon - Fri | 24/5 Active Market Coverage",
        priv_title: "Full Version Privilege Suite",
        priv_sub: "Subscribing to the Full Version unlocks institutional-grade support and core quantitative assets:",

        footer_about: "Next-generation quantitative trading algorithms engineered for MetaTrader 5. Specializing in intelligent XAUUSD grid recovery, dynamic risk management, and capital protection.",
        footer_nav: "Navigation",
        footer_res: "Resources & Tools",
        footer_contact: "Direct Client Support",
        footer_motto: "Trade Smart. Recover Smarter."
    },

    bm: {
        // --- Navigation ---
        nav_features: "Ciri Utama",
        nav_setup: "Panduan",
        nav_presets: "Fail Preset",
        nav_support: "Sokongan",
        nav_full_version: "Dapatkan Versi Penuh",

        // --- Hero Section ---
        hero_badge: "ALGORITMA KUANTITATIF INSTITUSI v1.90",
        hero_title: 'Maksimumkan Keuntungan & <span class="highlight-gold">Berdagang Lebih Bijak</span> Bersama CornGrid EA MT5',
        hero_desc: "Sistem Dagangan Berautomatik Penuh dikuasai Teknologi Smart Reverse Entry & Dynamic Basket Profit. Direka khas untuk pedagang institusi dan runcit yang memerlukan kawalan pemulihan grid pintar, perlindungan drawdown, serta eksekusi pantas MT5.",
        hero_btn_demo: '<i class="fas fa-download"></i> Muat Turun Demo Percuma',
        hero_btn_full: '<i class="fas fa-shopping-cart"></i> Dapatkan Versi Penuh',
        trust_hedging: "Mod Hedging Asli MT5",
        trust_drawdown: "Pemberhenti Drawdown Hard-Stop",
        trust_xauusd: "Dioptimumkan Untuk XAUUSD",
        float_exec_title: "Eksekusi Bawah 5ms",
        float_exec_sub: "Latensi VPS Equinix",
        float_shield_title: "Perlindungan Ekuiti",
        float_shield_sub: "Perisai Risiko Berautomatik",

        // --- Metrics Bar ---
        metric_1_title: "Platform MT5",
        metric_1_sub: "Seni Bina Dioptimumkan",
        metric_2_title: "Fokus XAUUSD",
        metric_2_sub: "Presisi Kuantitatif",
        metric_3_title: "Sub-Milisaat",
        metric_3_sub: "Eksekusi Latensi Rendah",
        metric_4_title: "Kawalan Hard Stop",
        metric_4_sub: "Perlindungan Modal",

        myfx_verified_badge: "REKOD DISAHKAN",
        myfx_title: "Analisis Akaun Real CornGrid",
        myfx_btn: "Sahkan di Myfxbook",
        myfx_total_gain: "Jumlah Keuntungan",
        myfx_gain_sub: "Hasil Kumulatif Automatikal",
        myfx_monthly_gain: "Purata Harian",
        myfx_monthly_sub: "Pulangan Konsisten Harian ",
        myfx_max_dd: "Drawdown Maksimum",
        myfx_dd_sub: "Perlindungan Risiko Ketat",
        myfx_winrate: "Faktor Keuntungan",
        myfx_winrate_sub: "Nisbah Keuntungan Kuantitatif",

        // --- Dashboard Showcase ---
        dash_badge: "ANTARAMUKA TERMINAL",
        dash_title: "Dashboard Analitik CornGrid EA",
        dash_subtitle: "Dapatkan kawalan visual lengkap dengan pemantauan pendedahan masa nyata, metrik margin, dan parameter risiko institusi terus pada carta MetaTrader 5 anda.",
        dash_tag: "ENJIN PENGURUSAN RISIKO",
        dash_h3: "Suite Analitik Perusahaan",
        dash_intro: "Diintegrasikan secara langsung ke dalam enjin grafik MT5 untuk menyampaikan metrik kuantitatif latensi rendah tanpa gangguan prestasi.",
        dash_f1_title: "Penyelarasan Ekuiti & Baki",
        dash_f1_desc: "Pemantauan masa nyata untuk P/L terapung, hasil ekuiti keseluruhan, dan turun naik baki akaun.",
        dash_f2_title: "Konsolidasi Pendedahan Bakul",
        dash_f2_desc: "Menggabungkan posisi Beli & Jual ke dalam metrik pendedahan tersusun untuk eksekusi pantas.",
        dash_f3_title: "Penimbal Margin & Capital Bebas",
        dash_f3_desc: "Memantau tahap margin bebas dan mengelakkan penggunaan leveraj berlebihan semasa pergerakan pasaran ekstrim.",
        dash_f4_title: "Pemberhenti Litar Hard-Stop",
        dash_f4_desc: "Nilai ambang keselamatan automatik yang menghentikan kitaran grid baharu apabila mencapai had maksimum drawdown.",
        dash_btn: '<i class="fas fa-download"></i> Lancarkan Terminal Demo',
        dash_demo_sub: "Termasuk Lesen Latihan Percuma",

        hiw_badge: "MODEL EKSEKUSI",
        hiw_title: "Seni Bina Sistem & Aliran Pesanan",
        hiw_subtitle: "Direka seperti model eksekusi dana lindung nilai, mengimbangi kelajuan kemasukan pesanan dengan penstabilan drawdown dinamik.",
        hiw_c1_title: "Protokol Sinyal Momentum",
        hiw_c1_desc: "Menganalisis momentum tindakan harga pelbagai lilin untuk mengenal pasti saluran pembalikan kebarangkalian tinggi sebelum pesanan dicetuskan.",
        hiw_c2_title: "Pemulihan Grid Adaptif",
        hiw_c2_desc: "Menghitung semula jarak pesanan secara dinamik semasa volatiliti tinggi, mengurangkan penggunaan leveraj berlebihan dan melindungi margin.",
        hiw_c3_title: "Pembersihan Pendedahan Bakul",
        hiw_c3_desc: "Memantau ekuiti terapung bersih di seluruh posisi terbuka, mencairkan bakul secara serta-merta apabila sasaran keuntungan bersih dicapai.",


        comp_badge: "PERBANDINGAN PENANDA ARAS",
        comp_title: "Mengapa Pedagang Institusi Memilih CornGrid",
        comp_subtitle: "Ketahui kelebihan struktur berbanding amalan dagangan runcit tradisional.",
        comp_th_metric: "Metrik Prestasi",
        comp_th_manual: "Eksekusi Manual",
        comp_th_retail: "EA Runcit Biasa",
        comp_th_corngrid: "<strong>Model Kuantitatif CornGrid EA</strong>",
        comp_r1_metric: "Ketepatan Eksekusi",
        comp_r1_manual: "Kelewatan & Bias Manusia",
        comp_r1_retail: "Peraturan Statik",
        comp_r1_corngrid: "✔ Masa Tindak Balas Sub-milisaat",
        comp_r2_metric: "Pengendalian Volatiliti",
        comp_r2_manual: "Faktor Keletihan Tinggi",
        comp_r2_retail: "Jarak Statik (Risiko Akaun MC)",
        comp_r2_corngrid: "✔ Adaptasi Grid Volatiliti Dinamik",
        comp_r3_metric: "Pencairan Modal",
        comp_r3_manual: "Kelewatan Penutupan Manual",
        comp_r3_retail: "Stop Loss Tunggal Asas",
        comp_r3_corngrid: "✔ Pembersihan Sasaran Ekuiti Bakul Bersih",
        comp_r4_metric: "Pengurusan Risiko",
        comp_r4_manual: "Disiplin Tidak Konsisten",
        comp_r4_retail: "Tiada Perlindungan Ekuiti",
        comp_r4_corngrid: "✔ Perlindungan Hard-Stop Institusi",

        // --- Core Features ---
        feat_badge: "TERAS ALGORITMA",
        feat_title: "Keupayaan Kuantitatif Teras",
        feat_subtitle: "Komponen algoritma yang direka untuk pasaran kecairan tinggi dan kemeruat harga emas ekstrim.",
        feat_m1_tag: "MODUL 01",
        feat_m1_title: "Logik Reverse Entry",
        feat_m1_desc: "Menapis pemecahan harga palsu (false breakout) dengan mengukur corak keletihan lilin sebelum membuka pesanan berlawanan arah.",
        feat_m1_foot: "Penapis False Breakout",
        feat_m2_tag: "MATRIKS TERAS",
        feat_m2_title: "Matriks Grid Dinamik",
        feat_m2_desc: "Pelarasan grid beralgoritma yang menyesuaikan saiz lot, jarak pemulihan, dan sasaran bakul secara dinamik berdasarkan kelajuan ATR semasa.",
        feat_m2_foot: "Jarak Volatiliti Adaptif",
        feat_m3_tag: "MODUL 03",
        feat_m3_title: "Modul Perlindungan Modal",
        feat_m3_desc: "Menguatkuasakan nilai ambang ekuiti hard-stop, penimbal margin bebas, dan pemutus litar automatik untuk menghapuskan risiko tail risk.",
        feat_m3_foot: "Pemutus Litar Ekuiti",

        // --- Specifications & Setup ---
        algo_badge: "ALGORITMA TERAS",
        algo_title: "Spesifikasi Algoritma",
        algo_subtitle: "Direka dengan protokol eksekusi pantas dan kawalan pendedahan matematik.",
        algo_c1_title: "Enjin Keuntungan Bakul Dinamik",
        algo_c1_desc: "Menilai P/L terapung terkumpul secara berterusan dan mencairkan keseluruhan posisi secara automatik sebaik sasaran dicapai.",
        algo_c2_title: "Perisai Integriti Margin",
        algo_c2_desc: "Memantau tahap margin bebas masa nyata, parameter slippage, dan pematuhan penuh struktur MT5 Hedging.",
        algo_c3_title: "Algoritma Pengganda Lot Pintar",
        algo_c3_desc: "Menghitung janjang lot dinamik yang diselaraskan secara matematik dengan baki akaun dan had risiko.",
        algo_c4_title: "Pengesah Kondisi Broker",
        algo_c4_desc: "Memeriksa kelebatan spread, kelewatan eksekusi pesanan, dan kecairan pasaran semasa sebelum menghantar pesanan.",

        setup_badge: "KEPERLUAN SISTEM",
        setup_title: "Persediaan Persekitaran Institusi",
        setup_subtitle: "Seni bina akaun dan infrastruktur yang disyorkan untuk eksekusi latensi rendah.",
        setup_l1: "Seni Bina Dagangan",
        setup_l1_tag: "Mandatori Hedging",
        setup_l2: "Aset Disokong",
        setup_l3: "Kerangka Masa (Timeframe)",
        setup_l4: "Tingkat Cent / Micro",
        setup_l4_tag: "Modal Ujian Teras",
        setup_l5: "Tingkat Institusi Standard",
        setup_l5_tag: "Kapasiti Pendedahan Penuh",
        setup_l6: "Leveraj & Infrastruktur",

        guide_badge: "PROTOKOL PELANCARAN",
        guide_title: "Panduan Pemasangan 4-Langkah",
        guide_subtitle: "Lakukan pemasangan CornGrid EA pada MetaTrader 5 dengan pantas dalam beberapa minit sahaja.",
        guide_s1_title: "Muat Turun EA",
        guide_s1_desc: "Dapatkan pakej keluaran rasmi (.ex5) daripada direktori kami.",
        guide_s2_title: "Tampal Dalam MT5",
        guide_s2_desc: "Tampal fail ke dalam <strong>Fail → Buka Folder Data → MQL5 → Experts</strong>.",
        guide_s3_title: "Aktifkan Algo",
        guide_s3_desc: "Benarkan <strong>Dagangan Beralgoritma</strong> dan WebRequest dalam tetapan MT5.",
        guide_s4_title: "Muat Preset",
        guide_s4_desc: "Masukkan EA pada carta XAUUSD M5, muat naik fail .SET, dan aktifkan.",
        pdf_banner_h4: "Memerlukan Panduan Visual?",
        pdf_banner_p: "Muat turun manual panduan PDF langkah demi langkah yang lengkap.",
        pdf_banner_btn: '<i class="fas fa-download"></i> Muat Turun Panduan PDF',

        // --- Deployment Guide ---
        guide_badge: "PROTOKOL PELANCARAN",
        guide_title: "Panduan Pemasangan 4-Langkah",
        guide_subtitle: "Lakukan pemasangan CornGrid EA pada MetaTrader 5 dengan pantas dalam beberapa minit sahaja.",
        guide_s1_title: "Muat Turun EA",
        guide_s1_desc: "Dapatkan pakej keluaran rasmi (.ex5) daripada direktori kami.",
        guide_s2_title: "Tampal Dalam MT5",
        guide_s2_desc: "Tampal fail ke dalam Fail → Buka Folder Data → MQL5 → Experts.",
        guide_s3_title: "Aktifkan Algo",
        guide_s3_desc: "Benarkan Dagangan Beralgoritma dan WebRequest dalam tetapan MT5.",
        guide_s4_title: "Muat Preset",
        guide_s4_desc: "Masukkan EA pada carta XAUUSD M5, muat naik fail .SET, dan aktifkan.",
        pdf_banner_h4: "Memerlukan Panduan Visual?",
        pdf_banner_p: "Muat turun manual panduan PDF langkah demi langkah yang lengkap.",
        pdf_banner_btn: '<i class="fas fa-download"></i> Muat Turun Panduan PDF',

        // --- Quant SET Vault ---
        vault_badge: "PRESET KUANTITATIF",
        vault_title: "Vault Fail SET Rasmi",
        vault_subtitle: "Parameter jitu yang dioptimumkan oleh Penganalisis Kuantitatif CornGrid. Diuji di bawah data tick sebenar mengikut profil volatiliti instrumen khusus.",
        meta_build: "VERSI ALGORITMA",
        meta_opt: "OPTIMASI TERAKHIR",
        meta_status: "STATUS PELANCARAN",
        vault_download: '<i class="fas fa-download"></i> Muat Turun .SET',

        // --- Recommended Brokers ---
        broker_badge: "DIREKTORI BROKER UTAMA",
        broker_title: "Broker MetaTrader 5 Eksekusi Tinggi",
        broker_subtitle: "Pilih daripada rakan broker terbukti yang menawarkan spread kompetitif, laluan eksekusi pantas, dan infrastruktur akaun MT5 Cent / Micro penuh.",
        broker_btn: 'Buka Akaun Broker <i class="fas fa-arrow-right"></i>',

        // --- Testimonials & FAQ ---
        testi_badge: "BUKTI PEDAGANG",
        testi_title: "Pengalaman Pedagang Terbukti",
        testi_subtitle: "Dipercayai oleh pedagang bebas dan pengurus dana yang menggunakan algoritma kuantitatif automatik.",
        verified_user: "Pengguna Terbukti",
        risk_title: "Amaran Pelaburan Risiko Tinggi",
        risk_desc: "Dagangan beralgoritma menggunakan model Grid melibatkan pendedahan kewangan yang signifikan. Parameter perlindungan modal hendaklah dikonfigurasi secara ketat. Keputusan lepas tidak menjamin prestasi masa hadapan. Sentiasa uji parameter pada Akaun Demo sebelum pelancaran akaun live.",

        faq_badge: "SOALAN LAZIM",
        faq_title: "Soalan Yang Sering Ditanya",
        faq_subtitle: "Jawapan lengkap mengenai pelancaran, infrastruktur, dan model risiko.",
        faq_q1: "Adakah CornGrid EA mematuhi peraturan Prop Firm?",
        faq_a1: "Ya. CornGrid EA boleh digunakan pada platform Prop Firm yang membenarkan Expert Advisor dan Hedging. Pastikan tetapan perlindungan ekuiti drawdown sejajar dengan had kerugian harian khusus Prop Firm anda.",
        faq_q2: "Mengapa akaun MetaTrader 5 Hedging diperlukan?",
        faq_a2: "CornGrid EA menggunakan protokol pengurusan pesanan bebas. Struktur MT5 Hedging membenarkan posisi Beli dan Jual serentak, memaksimumkan kecekapan algoritma Pemulihan Bakul Dinamik.",
        faq_q3: "Apakah kondisi latensi dan leveraj yang paling optimum?",
        faq_a3: "Kami mengesyorkan persekitaran leveraj <strong>1:1000</strong> dipadankan dengan VPS berprestasi tinggi (&lt; 5ms latensi) untuk masa penutupan bakul yang optimum.",
        faq_q4: "Bagaimanakah kemas kini algoritma dihantar?",
        faq_a4: "CornGrid EA menerima optimasi versi secara berterusan, pembaikan pepijat, peningkatan prestasi, dan keluaran preset baharu yang dihantar secara automatik kepada pemegang lesen.",
        faq_q5: "Bolehkah janjang lot dan parameter grid diubah suai?",
        faq_a5: "Kustomisasi penuh disokong. Pengguna boleh mengkonfigurasi Pengganda Lot, Jarak Grid, Aras Sasaran Bakul, Maksimum Dagangan Pemulihan, dan Had Stop Loss Hard Stop.",

        // --- Support & Footer ---
        supp_badge: "MEJA SOKONGAN",
        supp_title: "Sokongan & Hubungan Institusi",
        supp_subtitle: "Dapatkan akses terus kepada pakar teknikal kami, bantuan kuantitatif, dan saluran komuniti rasmi.",
        supp_hours: "Waktu Operasi: Isnin - Jumaat | Liputan Pasaran 24/5",
        priv_title: "Suite Keistimewaan Versi Penuh",
        priv_sub: "Langganan Versi Penuh membuka akses sokongan gred institusi dan aset kuantitatif teras:",

        footer_about: "Algoritma dagangan kuantitatif generasi seterusnya yang direka untuk MetaTrader 5. Mengkhusus dalam pemulihan grid XAUUSD pintar, pengurusan risiko dinamik, dan perlindungan modal.",
        footer_nav: "Navigasi",
        footer_res: "Sumber & Peralatan",
        footer_contact: "Sokongan Pelanggan Terus",
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