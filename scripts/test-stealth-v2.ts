// ============================================================================
// THIS V2 is using POC for saving product scrape state, in case we want to scrap a large amount of products thru store
// ============================================================================

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// CONFIGURATION
// ============================================================================

const TARGET_URL = 'https://smartstore.naver.com/llovve17/';
const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'scraper_state.json');
const OUTPUT_FILE = path.join(DATA_DIR, 'products_full_v2.json');

interface ProxyConfig {
    host: string;
    port: string;
    user?: string;
    pass?: string;
}

const PROXY_CONFIG: ProxyConfig | null = null;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const FINGERPRINT = {
    viewport: { width: 1920, height: 1080 },
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    languages: ['ko-KR', 'ko', 'en-US', 'en'],
    hardwareConcurrency: 8,
    deviceMemory: 8
};

const HEADLESS = false;
const MAX_CONSECUTIVE_FAILURES = 3;

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

interface ScraperState {
    channelId: string | null;
    allProductIds: string[];
    processedIds: string[];
    lastIndex: number;
}

function loadState(): ScraperState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        } catch (e) {
            console.error('⚠️ Failed to load state file, starting fresh.');
        }
    }
    return {
        channelId: null,
        allProductIds: [],
        processedIds: [],
        lastIndex: 0
    };
}

function saveState(state: ScraperState) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadData(): any[] {
    if (fs.existsSync(OUTPUT_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
        } catch (e) {
            console.error('⚠️ Failed to load data file.');
        }
    }
    return [];
}

function saveData(data: any[]) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2));
}

// ============================================================================
// UTILS & STEALTH
// ============================================================================

async function checkIpQuality(proxy: ProxyConfig | null): Promise<void> {
    console.log('🌐 Checking Network Quality...');
    const getIpInfo = (useProxy: boolean): Promise<any> => {
        return new Promise((resolve) => {
            const options: any = {
                hostname: 'ip-api.com',
                path: '/json?fields=status,message,country,countryCode,regionName,city,isp,org,as,query,proxy,hosting',
                method: 'GET',
                timeout: 5000
            };
            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
        });
    };

    const localInfo = await getIpInfo(false);
    if (localInfo && localInfo.status === 'success') {
        console.log(`   IP: ${localInfo.query} | ${localInfo.city}, ${localInfo.country} | ${localInfo.hosting ? '🚩 DC' : '🟢 RES'}`);
    }
}

puppeteer.use(StealthPlugin());

async function setupBrowser(): Promise<{ browser: Browser, page: Page }> {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=http://${PROXY_CONFIG.host}:${PROXY_CONFIG.port}`);
    }

    const browser = await puppeteer.launch({
        headless: HEADLESS,
        args,
        ignoreDefaultArgs: ['--disable-extensions'],
    });

    const pages = await browser.pages();
    const page = pages[0];

    page.on('console', msg => {
        const text = msg.text();
        if (text.startsWith('State Keys:') || text.includes('Fallback')) {
            console.log(`📡 [BROWSER] ${text}`);
        }
    });

    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
        'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
    });
    await page.setViewport(FINGERPRINT.viewport);

    // EXACT V1 STEALTH CONFIGURATION
    await page.evaluateOnNewDocument((fp) => {
        // @ts-ignore
        const ua = navigator.userAgent;

        Object.defineProperty(navigator, 'platform', { get: () => fp.platform });
        Object.defineProperty(navigator, 'vendor', { get: () => fp.vendor });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.deviceMemory });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.hardwareConcurrency });
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => fp.languages });
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
    }, FINGERPRINT);

    if (PROXY_CONFIG && PROXY_CONFIG.user && PROXY_CONFIG.pass) {
        await page.authenticate({ username: PROXY_CONFIG.user, password: PROXY_CONFIG.pass });
    }

    return { browser, page };
}

async function simulateHumanBehavior(page: Page) {
    console.log('      🖱️ Simulating human behavior...');
    for (let i = 0; i < 3; i++) {
        const scrollAmt = Math.floor(Math.random() * 300) + 100;
        await page.evaluate((y) => window.scrollBy(0, y), scrollAmt);
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
    }
    const mx = Math.floor(Math.random() * FINGERPRINT.viewport.width);
    const my = Math.floor(Math.random() * FINGERPRINT.viewport.height);
    await page.mouse.move(mx, my, { steps: 15 });
}

// ============================================================================
// EXTRACTION LOGIC (Copied from V2 robust version)
// ============================================================================

async function extractInitialData(page: Page) {
    console.log('� Navigating to store and extracting initial data...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    return await page.evaluate(() => {
        // @ts-ignore
        let state = window.__PRELOADED_STATE__;
        if (!state) {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const s of scripts) {
                if (s.textContent?.includes('__PRELOADED_STATE__')) {
                    try {
                        const jsonStr = s.textContent.split('__PRELOADED_STATE__=')[1].split(';')[0];
                        state = JSON.parse(jsonStr);
                        break;
                    } catch (e) { }
                }
            }
        }

        if (!state) return { error: 'PRELOADED_STATE not found' };

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

        return { channelId, allProductIds };
    });
}

// ============================================================================
// MAIN RUNNER
// ============================================================================

async function run() {
    console.log('🚀 Starting Stealth Scraper V2 (Robust Mode)');
    await checkIpQuality(PROXY_CONFIG);

    let state = loadState();
    let results = loadData();

    while (true) {
        let browser: Browser | null = null;
        try {
            const setup = await setupBrowser();
            browser = setup.browser;
            const page = setup.page;

            // 1. Initial Data Extraction
            if (state.allProductIds.length === 0 || !state.channelId) {
                const initial = await extractInitialData(page);
                if (initial.error || !initial.channelId) {
                    throw new Error(`Failed to extract initial data: ${initial.error}`);
                }
                state.channelId = initial.channelId;
                state.allProductIds = initial.allProductIds || [];
                saveState(state);
                console.log(`📦 Found ${state.allProductIds.length} unique products. Store ID: ${state.channelId}`);
            }

            // 2. Warm-up
            console.log('📡 Visiting Store Page for session establishment...');
            await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            await simulateHumanBehavior(page);

            const randomProductId = state.allProductIds[Math.floor(Math.random() * state.allProductIds.length)];
            console.log(`📡 Warming up session with product ${randomProductId}...`);
            await page.goto(`${TARGET_URL}products/${randomProductId}`, { waitUntil: 'networkidle2', timeout: 60000 });
            await simulateHumanBehavior(page);

            console.log(`🧪 Resuming from index ${state.lastIndex || 0}...`);
            let consecutiveFailures = 0;

            // 3. Main Loop
            for (let i = state.lastIndex || 0; i < state.allProductIds.length; i++) {
                const productId = state.allProductIds[i];

                if (state.processedIds.includes(productId)) {
                    console.log(`⏭️ Skipping already processed product ${productId} [${i + 1}/${state.allProductIds.length}]`);
                    continue;
                }

                console.log(`   [${i + 1}/${state.allProductIds.length}] Processing ${productId}...`);

                const apiResponse = await page.evaluate(async (pid, cid) => {
                    const endpoint = `https://smartstore.naver.com/i/v2/channels/${cid}/products/${pid}?withWindow=false`;
                    try {
                        const res = await fetch(endpoint, {
                            headers: {
                                'accept': 'application/json, text/plain, */*',
                                'x-client-version': '1.144.1',
                                'sec-fetch-dest': 'empty',
                                'sec-fetch-mode': 'cors',
                                'sec-fetch-site': 'same-origin',
                                'referer': `https://smartstore.naver.com/i/v2/channels/${cid}/products/${pid}?withWindow=false`
                            }
                        });
                        if (res.ok) return { success: true, data: await res.json() };
                        return { success: false, status: res.status, statusText: res.statusText };
                    } catch (e: any) {
                        return { success: false, error: e.message };
                    }
                }, productId, state.channelId);

                if (apiResponse.success) {
                    results.push(apiResponse.data);
                    state.processedIds.push(productId);
                    state.lastIndex = i + 1;
                    consecutiveFailures = 0;

                    saveData(results);
                    saveState(state);
                    console.log(`      ✅ Fetch success.`);
                } else {
                    console.error(`   🔴 [FAILED] ${productId} - Status: ${apiResponse.status}`);

                    if (apiResponse.status === 429) {
                        console.warn(`🚨 Rate limit hit (429)! Triggering immediate cooldown and restart...`);
                        throw new Error('429_RESTART');
                    }

                    consecutiveFailures++;
                    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                        console.warn(`⚠️  ${consecutiveFailures} consecutive failures. Restarting browser...`);
                        throw new Error('RESTART_REQUESTED');
                    }

                    await new Promise(r => setTimeout(r, 5000));
                }

                const waitTime = Math.floor(Math.random() * 5000) + 5000;
                console.log(`      � Resting for ${waitTime / 1000}s...`);
                await new Promise(r => setTimeout(r, waitTime));
            }

            console.log('✅ All products processed successfully!');
            break;

        } catch (error: any) {
            if (error.message === '429_RESTART') {
                const cooldown = 60000 + Math.random() * 60000;
                console.log(`🔄 Cooling down for ${Math.round(cooldown / 1000)}s before restart...`);
                await new Promise(r => setTimeout(r, cooldown));
            } else if (error.message === 'RESTART_REQUESTED') {
                console.log('🔄 Performing planned browser restart...');
            } else {
                console.error(`❌ Unexpected error: ${error.message}`);
                console.log('🔄 Restarting in 10 seconds...');
                await new Promise(r => setTimeout(r, 10000));
            }
        } finally {
            if (browser) await browser.close();
        }

        if (state.lastIndex >= state.allProductIds.length && state.allProductIds.length > 0) break;
    }
}

run().catch(console.error);
