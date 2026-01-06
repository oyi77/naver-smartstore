// =
// This one is used to test PoC for paralelism and simulatanous browser scraping
// =
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createBrowserPool, BrowserPool } from '../src/browser/BrowserPool';
import { BROWSER_PROFILES } from '../src/profiles/ProfileManager';
import fs from 'fs';
import path from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const BROWSER_COUNT = 2;      // Start with 1 for testing
const TABS_PER_BROWSER = 3;   // Multiple tabs per browser
const USE_PROXIES = false;     // Always use proxies
const HEADLESS = false;       // Visible for debugging

const MAX_TAB_FETCHES = 10;   // Rotate tab every 10 fetches
const ROTATION_SLEEP_MIN = 3000;
const ROTATION_SLEEP_MAX = 8000;
const REST_TIME_MIN = 2000;
const REST_TIME_MAX = 5000;

const OUTPUT_FILE = path.join(__dirname, '../data/products_v3.json');
const STATE_FILE = path.join(__dirname, '../data/scraper_state_v3.json');
const STORE_URL = 'https://smartstore.naver.com/llovve17';

// ============================================================================
// TYPES & HELPERS
// ============================================================================

interface ScraperState {
    channelId: string | null;
    allProductIds: string[];
    processedIds: string[];
    failedIds: string[];
    uaStats?: Record<string, { success: number; fail: number }>;
}

class StateManager {
    static load(): ScraperState {
        if (fs.existsSync(STATE_FILE)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            return {
                channelId: null,
                allProductIds: [],
                processedIds: [],
                failedIds: [],
                uaStats: {},
                ...state
            };
        }
        return { channelId: null, allProductIds: [], processedIds: [], failedIds: [], uaStats: {} };
    }

    static save(state: ScraperState) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }

    static loadData(): any[] {
        if (fs.existsSync(OUTPUT_FILE)) {
            return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
        }
        return [];
    }

    static saveData(data: any[]) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
    }
}

class TaskDispatcher {
    private state: ScraperState;
    private queue: string[] = [];

    constructor(state: ScraperState) {
        this.state = state;
        if (!this.state.uaStats) this.state.uaStats = {};

        const processedSet = new Set(this.state.processedIds);
        this.queue = this.state.allProductIds.filter(id => !processedSet.has(id));

        if (this.state.failedIds.length > 0) {
            console.log(`[TaskDispatcher] ♻️ Re-queuing ${this.state.failedIds.length} previously failed products`);
            this.queue.push(...this.state.failedIds);
            this.state.failedIds = [];
            StateManager.save(this.state);
        }

        console.log(`[TaskDispatcher] 📦 Initialized with ${this.queue.length} products to process`);
    }

    getNextTask(): string | null {
        return this.queue.shift() || null;
    }

    markProcessed(id: string, ua?: string) {
        if (!this.state.processedIds.includes(id)) {
            this.state.processedIds.push(id);
            this.state.failedIds = this.state.failedIds.filter(fid => fid !== id);

            if (ua) {
                if (!this.state.uaStats) this.state.uaStats = {};
                if (!this.state.uaStats[ua]) this.state.uaStats[ua] = { success: 0, fail: 0 };
                this.state.uaStats[ua].success++;
            }

            StateManager.save(this.state);
        }
    }

    markFailed(id: string, ua?: string) {
        if (!this.state.failedIds.includes(id) && !this.state.processedIds.includes(id)) {
            this.state.failedIds.push(id);

            if (ua) {
                if (!this.state.uaStats) this.state.uaStats = {};
                if (!this.state.uaStats[ua]) this.state.uaStats[ua] = { success: 0, fail: 0 };
                this.state.uaStats[ua].fail++;
            }

            StateManager.save(this.state);
        }
    }

    getStats() {
        return {
            total: this.state.allProductIds.length,
            processed: this.state.processedIds.length,
            failed: this.state.failedIds.length,
            remaining: this.queue.length
        };
    }
}

// ============================================================================
// SCRAPER CORE
// ============================================================================

interface TabState {
    id: number;
    page: any;
    profile: any;
    fetchCount: number;
    restingUntil: number;
    currentTask: string | null;
}

class BrowserCoordinator {
    private browserId: number;
    private pool: BrowserPool;
    private dispatcher: TaskDispatcher;
    private results: any[];
    private state: ScraperState;
    private tabs: TabState[] = [];
    private isRunning: boolean = true;
    private failureCount: number = 0;
    private MAX_BROWSER_FAILURES = 5;
    private tabRotationCount: number = 0;

    constructor(id: number, pool: BrowserPool, dispatcher: TaskDispatcher, results: any[], state: ScraperState) {
        this.browserId = id;
        this.pool = pool;
        this.dispatcher = dispatcher;
        this.results = results;
        this.state = state;
    }

    async initialize() {
        console.log(`[B${this.browserId}] 🚀 Initializing coordinator (Parallel Warm-up)...`);
        const instance = this.pool.getBrowser(this.browserId);
        if (!instance) throw new Error(`Browser ${this.browserId} not found`);
        const browserPages = instance.pages;

        for (let i = 0; i < browserPages.length; i++) {
            const page = browserPages[i];
            const profile = BROWSER_PROFILES[i % BROWSER_PROFILES.length];

            this.tabs.push({
                id: i,
                page,
                profile,
                fetchCount: 0,
                restingUntil: 0,
                currentTask: null
            });

            page.on('console', (msg: any) => {
                const text = msg.text();
                if (text.includes('FETCH_ERROR') || text.includes('FETCH_SUCCESS')) {
                    console.log(`[B${this.browserId}.T${i}] 📱 ${text}`);
                }
            });

            // Request interception is already handled by BrowserPool
            // Do not add another listener that calls request.continue() blindly
        }

        // Parallel warm-up for all tabs
        const results = await Promise.all(this.tabs.map(tab => this.warmUpTab(tab)));
        const successCount = results.filter(r => r).length;

        if (successCount === 0) {
            throw new Error(`[B${this.browserId}] ❌ All tabs failed to warm up! Check proxy or internet connection.`);
        }

        console.log(`[B${this.browserId}] ✨ ${successCount}/${this.tabs.length} tabs warmed up and ready`);
    }

    async warmUpTab(tab: TabState): Promise<boolean> {
        console.log(`[B${this.browserId}.T${tab.id}] 🔥 Warming up...`);
        try {
            // 1. Visit Store Page - Use domcontentloaded for better stability
            await tab.page.goto(STORE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.simulateHumanBehavior(tab.page);

            // 2. Visit Random Product Page (if available)
            if (this.state.allProductIds.length > 0) {
                const randomId = this.state.allProductIds[Math.floor(Math.random() * this.state.allProductIds.length)];
                console.log(`[B${this.browserId}.T${tab.id}] 📡 Warming up with product ${randomId}...`);
                await tab.page.goto(`${STORE_URL}/products/${randomId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await this.simulateHumanBehavior(tab.page);
            }

            await new Promise(r => setTimeout(r, 2000));
            return true;
        } catch (e: any) {
            console.log(`[B${this.browserId}.T${tab.id}] ⚠️ Warmup failed: ${e.message}`);
            return false;
        }
    }

    async simulateHumanBehavior(page: any) {
        console.log(`[B${this.browserId}] 🖱️ Simulating human behavior (Full Scroll)...`);
        try {
            const viewport = await page.viewport();
            const width = viewport?.width || 1920;
            const height = viewport?.height || 1080;

            // 1. Initial "Look around" mouse move
            const mx = Math.floor(Math.random() * width);
            const my = Math.floor(Math.random() * height);
            await page.mouse.move(mx, my, { steps: 15 });

            // 2. Scroll from top to bottom in chunks
            let currentHeight = 0;
            let totalHeight = await page.evaluate(() => document.body.scrollHeight);

            while (currentHeight < totalHeight) {
                const scrollAmt = Math.floor(Math.random() * 400) + 200; // Larger chunks
                await page.evaluate((y: number) => window.scrollBy(0, y), scrollAmt);
                currentHeight += scrollAmt;

                // Update total height in case of infinite scroll / lazy loading
                totalHeight = await page.evaluate(() => document.body.scrollHeight);

                // Random delay between scrolls (Human reading/scanning)
                const delay = 500 + Math.random() * 1000;
                await new Promise(r => setTimeout(r, delay));

                // Occasional mouse jiggle
                if (Math.random() > 0.7) {
                    await page.mouse.move(
                        Math.floor(Math.random() * width),
                        Math.floor(Math.random() * height),
                        { steps: 5 }
                    );
                }
            }

            // 3. One final pause at the bottom
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));

        } catch (e) {
            // Ignore simulation errors
        }
    }

    async rotateTab(tab: TabState, forceNewProfile: boolean = false) {
        this.tabRotationCount++;
        console.log(`[B${this.browserId}.T${tab.id}] ♻️ Rotating tab${forceNewProfile ? ' WITH NEW PROFILE' : ''} (Total: ${this.tabRotationCount})...`);

        try {
            // If forceNewProfile, change the UA/fingerprint before warmup
            if (forceNewProfile) {
                const oldProfileName = tab.profile.name;
                const ProfileManager = await import('../src/profiles/ProfileManager');
                const manager = new ProfileManager.ProfileManager();
                const newProfile = manager.getRandomProfile();

                console.log(`[B${this.browserId}.T${tab.id}] 🔄 Rotating profile from "${oldProfileName}" to "${newProfile.name}"`);

                // Re-inject new profile
                const StealthInjector = await import('../src/browser/StealthInjector');
                await StealthInjector.StealthInjector.inject(tab.page, newProfile);

                // Update tab reference
                tab.profile = newProfile;
            }

            await tab.page.goto('about:blank');
            await new Promise(r => setTimeout(r, 1000));
            await this.warmUpTab(tab);
            tab.fetchCount = 0;

            const sleep = ROTATION_SLEEP_MIN + Math.random() * (ROTATION_SLEEP_MAX - ROTATION_SLEEP_MIN);
            await new Promise(r => setTimeout(r, sleep));
        } catch (e: any) {
            console.error(`[B${this.browserId}.T${tab.id}] ❌ Rotation error: ${e.message}`);
        }
    }

    async run() {
        const workers = this.tabs.map(tab => this.runWorker(tab));
        await Promise.all(workers);
    }

    async runWorker(tab: TabState) {
        const workerId = `B${this.browserId}.T${tab.id}`;

        while (this.isRunning && this.failureCount < this.MAX_BROWSER_FAILURES) {
            if (tab.fetchCount >= MAX_TAB_FETCHES) {
                await this.rotateTab(tab);
            }

            if (tab.restingUntil > Date.now()) {
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            const productId = this.dispatcher.getNextTask();
            if (!productId) {
                console.log(`[${workerId}] ✅ No more tasks`);
                break;
            }

            tab.currentTask = productId;
            tab.fetchCount++;

            console.log(`[${workerId}] 🔄 Fetching product ${productId} (${tab.fetchCount}/${MAX_TAB_FETCHES})`);

            try {
                const result = await this.processProduct(tab.page, productId);

                if (result.success && result.data) {
                    this.results.push(result.data);
                    this.dispatcher.markProcessed(productId, tab.profile.userAgent);
                    StateManager.saveData(this.results);
                    const stats = this.dispatcher.getStats();
                    console.log(`[${workerId}] ✅ Saved product ${productId} (${stats.processed}/${stats.total})`);
                    this.failureCount = 0;
                } else if (result.error === 'RATELIMIT') {
                    console.log(`[${workerId}] 🛑 Rate limited (429). Rotating and resting...`);
                    this.dispatcher.markFailed(productId, tab.profile.userAgent);
                    await this.rotateTab(tab);
                    tab.restingUntil = Date.now() + 60000;
                } else if (result.error === 'NOT_FOUND' || result.error === '204_NO_CONTENT') {
                    console.log(`[${workerId}] ⚠️ ${result.error}. Product ${productId} re-queued.`);
                    this.dispatcher.markFailed(productId, tab.profile.userAgent);
                    await this.rotateTab(tab);
                    tab.restingUntil = Date.now() + 5000;
                } else if (result.error === 'UNSUPPORTED_BROWSER') {
                    console.log(`[${workerId}] 🚨 UNSUPPORTED BROWSER DETECTED! Rotating with NEW UA/Fingerprint...`);
                    this.dispatcher.markFailed(productId, tab.profile.userAgent);
                    await this.rotateTab(tab, true); // Force new profile!
                    tab.restingUntil = Date.now() + 5000;
                } else {
                    console.log(`[${workerId}] ❌ Failed: ${result.error}`);
                    this.dispatcher.markFailed(productId, tab.profile.userAgent);
                    this.failureCount++;
                }
            } catch (e: any) {
                this.dispatcher.markFailed(productId, tab.profile.userAgent);
                this.failureCount++;
                console.log(`[${workerId}] ❌ Error: ${e.message}`);
            }

            const restTime = REST_TIME_MIN + Math.random() * (REST_TIME_MAX - REST_TIME_MIN);
            tab.restingUntil = Date.now() + restTime;
            tab.currentTask = null;
        }

        if (this.failureCount >= this.MAX_BROWSER_FAILURES) {
            console.log(`[${workerId}] ⚠️ Too many failures, stopping this browser`);
        }
    }


    async humanRecoveryDance(page: any) {
        console.log(`[B${this.browserId}] 💃 Performing Human Recovery Dance...`);
        try {
            // 1. Go Back / Refresh
            await page.goBack();
            await new Promise(r => setTimeout(r, 1500));

            // 2. Scroll a bit on the previous page (likely store page)
            await page.evaluate(() => window.scrollBy(0, 300));
            await new Promise(r => setTimeout(r, 1000));

            // 3. Click random product (if possible) or just navigate to a random one
            if (this.state.allProductIds.length > 0) {
                const randomId = this.state.allProductIds[Math.floor(Math.random() * this.state.allProductIds.length)];
                console.log(`[B${this.browserId}] 🎲 Random walk to ${randomId}...`);
                await page.goto(`${STORE_URL}/products/${randomId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await this.simulateHumanBehavior(page);
            }
        } catch (e) {
            console.log(`[B${this.browserId}] Recovery dance stumbled: ${(e as any).message}`);
        }
    }

    async processProduct(page: any, productId: string) {
        const productUrl = `${STORE_URL}/products/${productId}`;
        const channelId = this.state.channelId;
        const self = this;

        if (!channelId) return { success: false, error: 'NO_CHANNEL_ID' };

        // Helper to perform the fetch
        const performFetch = async () => {
            console.log(`[B${self.browserId}] 📡 Executing API fetch for ${productId}...`);
            return await page.evaluate(async (pid: string, cid: string, pUrl: string) => {
                const endpoint = `https://smartstore.naver.com/i/v2/channels/${cid}/products/${pid}?withWindow=false`;
                try {
                    const response = await fetch(endpoint, {
                        method: 'GET',
                        mode: 'cors',
                        credentials: 'include',
                        headers: {
                            'accept': 'application/json, text/plain, */*',
                            'accept-language': 'en-US,en;q=0.5',
                            'content-type': 'application/json',
                            'x-client-version': '20251223161333',
                            'sec-fetch-dest': 'empty',
                            'sec-fetch-mode': 'cors',
                            'sec-fetch-site': 'same-origin',
                            'pragma': 'no-cache',
                            'cache-control': 'no-cache',
                            'referer': pUrl
                        }
                    });

                    if (response.status === 204) return { success: false, error: '204_NO_CONTENT' };
                    if (response.status === 429) return { success: false, error: 'RATELIMIT' };
                    if (!response.ok) return { success: false, error: `HTTP_${response.status}` };

                    const data = await response.json();
                    return { success: true, data };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }, productId, channelId, productUrl);
        };

        try {
            await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await this.simulateHumanBehavior(page);
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
        } catch (e: any) {
            return { success: false, error: `NAV_FAILED: ${e.message}` };
        }

        // First Try
        let result = await performFetch();

        // Retry Logic
        if (!result.success && (
            result.error === '204_NO_CONTENT' ||
            result.error === 'RATELIMIT' ||
            (typeof result.error === 'string' && result.error.includes('HTTP_490'))
        )) {
            console.log(`[B${this.browserId}] ⚠️ Encountered ${result.error}. Retrying with Dance...`);
            await this.humanRecoveryDance(page);

            // Navigate back to target product
            try {
                await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) {
                return { success: false, error: 'RETRY_NAV_FAILED' };
            }

            // Second Try
            result = await performFetch();
        }

        return result;
    }
}

async function extractInitialData(page: any): Promise<any> {
    const url = STORE_URL;
    console.log(`[Initial] 📄 Navigating to ${url}...`);
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e: any) {
        console.error(`[Initial] ❌ Navigation failed: ${e.message}`);
        try {
            await page.goto(url + '/products/5144680074', { waitUntil: 'networkidle2', timeout: 60000 });
        } catch (e2: any) { }
    }

    return await page.evaluate(() => {
        let state: any = null;

        // 1. Check window directly
        if ((window as any).__PRELOADED_STATE__) {
            state = (window as any).__PRELOADED_STATE__;
        }

        // 2. Search scripts with VERY robust matching and logging for failures
        if (!state) {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const s of scripts) {
                const text = s.textContent || '';
                if (text.includes('__PRELOADED_STATE__')) {
                    try {
                        const match = text.match(/__PRELOADED_STATE__\s*=\s*({.*?});/s) ||
                            text.match(/__PRELOADED_STATE__\s*=\s*({.*})/s);
                        if (match) {
                            state = JSON.parse(match[1]);
                            break;
                        }
                    } catch (e) {
                        console.error("Parse error on suspected state script:", (e as any).message);
                    }
                }
            }
        }

        if (!state) return { error: 'PRELOADED_STATE not found' };

        // DEBUG: Inspect state structure
        console.log('DEBUG: State found. Keys:', JSON.stringify(Object.keys(state)));
        if (state.smartStoreV2) {
            console.log('DEBUG: state.smartStoreV2 keys:', JSON.stringify(Object.keys(state.smartStoreV2)));
            if (state.smartStoreV2.channel) {
                console.log('DEBUG: state.smartStoreV2.channel:', JSON.stringify(state.smartStoreV2.channel));
            } else {
                console.log('DEBUG: state.smartStoreV2.channel is MISSING');
            }
        }
        if (state.smartStore) console.log('DEBUG: state.smartStore keys:', JSON.stringify(Object.keys(state.smartStore)));
        if (state.product) console.log('DEBUG: state.product keys:', JSON.stringify(Object.keys(state.product)));

        const harvestAllSecretProducts = (obj: any, depth = 0): string[] => {
            if (depth > 15 || !obj || typeof obj !== 'object') return [];
            let found: string[] = [];
            try {
                for (const key in obj) {
                    const val = obj[key];
                    if (key.toLowerCase().includes('productno') && val && (typeof val === 'string' || typeof val === 'number')) {
                        const strVal = String(val);
                        if (strVal.length >= 10 && /^\d+$/.test(strVal)) found.push(strVal);
                    }
                    if (typeof val === 'object' && val !== null) {
                        found = found.concat(harvestAllSecretProducts(val, depth + 1));
                    }
                }
            } catch (e) { }
            return found;
        };

        const allProductIds = Array.from(new Set(harvestAllSecretProducts(state)));
        const channelId = state.smartStoreV2?.channel?.channelUid ||
            state.smartStoreV2?.channel?.channelId ||
            state.smartStore?.channel?.channelId ||
            state.product?.channelId || null;

        console.log('DEBUG: Extraction result:', { channelId, productCount: allProductIds.length });

        return { channelId, allProductIds };
    });
}

// ============================================================================
// MAIN
// ============================================================================

async function run() {
    console.log('\n🚀 Starting Multi-Browser Stealth Scraper v3');
    const state = StateManager.load();
    const results = StateManager.loadData();

    const browserPool = new BrowserPool({
        maxBrowsers: 2,
        tabsPerBrowser: 1,
        proxiedCount: 2, // All proxied
        headless: false
    });

    try {
        if (state.allProductIds.length === 0 || !state.channelId) {
            console.log('📄 Initial data extraction (direct)...');
            const puppeteer = await import('puppeteer-extra');
            const StealthPlugin = await import('puppeteer-extra-plugin-stealth');
            puppeteer.default.use(StealthPlugin.default());

            const directBrowser = await puppeteer.default.launch({
                headless: HEADLESS,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                ],
                ignoreDefaultArgs: ['--disable-extensions'],
            });

            try {
                const pages = await directBrowser.pages();
                const extractPage = pages[0];

                // Use Mac Profile (Index 3) for proven success - STRICTLY MATCHING V2
                // Do not change this index without verifying V2 still works with other profiles.
                const profile = BROWSER_PROFILES[3] || BROWSER_PROFILES[2] || BROWSER_PROFILES[0];

                extractPage.on('console', msg => console.log(`[ExtractPage] 🖥️ ${msg.text()}`));

                const FINGERPRINT = {
                    viewport: profile.viewport,
                    platform: profile.platform,
                    vendor: profile.vendor,
                    languages: profile.languages,
                    hardwareConcurrency: profile.hardwareConcurrency,
                    deviceMemory: profile.deviceMemory
                };

                await extractPage.setUserAgent(profile.userAgent);

                await extractPage.setExtraHTTPHeaders({
                    'sec-ch-ua': profile.secChUa || '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': profile.secChUaPlatform || '"macOS"',
                });

                await extractPage.setViewport(profile.viewport);

                // Deep Fingerprint Synchronization (Matched to V1/V2)
                await extractPage.evaluateOnNewDocument((fp, ua) => {
                    // @ts-ignore
                    Object.defineProperty(navigator, 'platform', { get: () => fp.platform });
                    Object.defineProperty(navigator, 'vendor', { get: () => fp.vendor });
                    Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.deviceMemory });
                    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency });
                    Object.defineProperty(navigator, 'webdriver', { get: () => false });
                    Object.defineProperty(navigator, 'languages', { get: () => fp.languages });
                    // @ts-ignore
                    Object.defineProperty(navigator, 'appVersion', { get: () => ua.split('Mozilla/')[1] });

                    // Add extra stealth for plugins
                    // @ts-ignore
                    Object.defineProperty(navigator, 'plugins', {
                        get: () => [
                            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
                        ]
                    });

                    // Mock chrome object
                    // @ts-ignore
                    window.chrome = {
                        runtime: {},
                        loadTimes: () => { },
                        csi: () => { },
                        app: {}
                    };
                }, FINGERPRINT, profile.userAgent);

                const initial = await extractInitialData(extractPage);
                if (initial.error || !initial.channelId) {
                    throw new Error(initial.error || 'Unknown error during extraction');
                }

                state.channelId = initial.channelId;
                state.allProductIds = (initial.allProductIds || []) as string[];
                state.failedIds = state.failedIds || [];
                StateManager.save(state);
                console.log(`📦 Found ${state.allProductIds.length} products. Store ID: ${state.channelId}`);
            } finally {
                await directBrowser.close();
            }
        }

        await browserPool.initialize();
        const dispatcher = new TaskDispatcher(state);
        const coordinators: BrowserCoordinator[] = [];
        for (let b = 0; b < BROWSER_COUNT; b++) {
            coordinators.push(new BrowserCoordinator(b, browserPool, dispatcher, results, state));
        }

        console.log('🔥 Warming up browsers...');
        await Promise.all(coordinators.map(c => c.initialize()));

        console.log('\n🚀 Starting processing...\n');
        await Promise.all(coordinators.map(c => c.run()));

        const finalStats = dispatcher.getStats();
        console.log(`\n📊 Final: ${finalStats.processed}/${finalStats.total} processed, ${finalStats.failed} failed`);
    } catch (error: any) {
        console.error('❌ Fatal error:', error.message);
    } finally {
        await browserPool.shutdown();
    }
}

run().catch(console.error);
