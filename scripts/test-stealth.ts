// =
// This v1 is for testing PoC of evasion logic
// =
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser } from 'puppeteer';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// MANUAL ADJUSTMENTS START HERE
// ============================================================================

// const TARGET_URL = 'https://smartstore.naver.com/llovve17/products/12647771530';
const TARGET_URL = 'https://smartstore.naver.com/llovve17/';


interface ProxyConfig {
    host: string;
    port: string;
    user?: string;
    pass?: string;
}

// Proxy configuration: Set to null to use direct connection
// Format: { host: '...', port: '...', user: '...', pass: '...' }
// const PROXY_CONFIG: ProxyConfig | null = {
//     host: '9p4wpf2y.as.thordata.net',
//     port: '9999',
//     user: 'td-customer-TUncHjimaa0t-country-kr',
//     pass: 'd4w2kldd81'
// };
const PROXY_CONFIG: ProxyConfig | null = null;

// User Agent: The browser's identity
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

// Fingerprint settings
const FINGERPRINT = {
    viewport: { width: 1920, height: 1080 },
    platform: 'MacIntel',
    vendor: 'Google Inc.',
    languages: ['ko-KR', 'ko', 'en-US', 'en'],
    hardwareConcurrency: 8,
    deviceMemory: 8
};

const HEADLESS = false; // Set to true to run in the background

// ============================================================================
// MANUAL ADJUSTMENTS END HERE
// ============================================================================

/**
 * Checks IP quality and basic info before launching the browser
 */
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
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
            req.end();
        });
    };

    console.log('🏠 Local (Machine) IP Check:');
    const localInfo = await getIpInfo(false);
    if (localInfo && localInfo.status === 'success') {
        console.log(`   IP: ${localInfo.query}`);
        console.log(`   Location: ${localInfo.city}, ${localInfo.country} (${localInfo.countryCode})`);
        console.log(`   ISP: ${localInfo.isp}`);
        console.log(`   Type: ${localInfo.hosting ? '🚩 DC' : '🟢 RES'} | ${localInfo.proxy ? '🚩 VPN/PROXY' : '🟢 CLEAN'}`);
    } else {
        console.log('   ⚠️ Could not retrieve local IP info');
    }

    if (proxy) {
        console.log(`\n📡 Proxy Configured: ${proxy.host}:${proxy.port}`);
        console.log('   (Proxy quality will be verified inside the browser session)');
    } else {
        console.log('\n� No proxy configured: Using DIRECT connection.');
    }
}

puppeteer.use(StealthPlugin());

async function runTest() {
    console.log('🚀 Starting Stealth Test Flow');
    console.log(`📍 Target: ${TARGET_URL}`);
    console.log(`👤 UA: ${USER_AGENT}`);

    // Perform pre-flight IP check
    await checkIpQuality(PROXY_CONFIG);

    console.log(`🌐 Browser Proxy: ${PROXY_CONFIG ? `${PROXY_CONFIG.host}:${PROXY_CONFIG.port}` : 'DIRECT'}`);

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

    let browser: Browser | null = null;

    try {
        browser = await puppeteer.launch({
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

        // 1. Set User Agent and Client Hints
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({
            'sec-ch-ua': '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
        });

        // 2. Set Viewport
        await page.setViewport(FINGERPRINT.viewport);

        // 3. Deep Fingerprint Synchronization
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

            // Mock chrome object if it's missing (often checked)
            // @ts-ignore
            window.chrome = {
                runtime: {},
                loadTimes: () => { },
                csi: () => { },
                app: {}
            };
        }, FINGERPRINT);

        // 4. Handle Proxy Auth if needed
        if (PROXY_CONFIG && PROXY_CONFIG.user && PROXY_CONFIG.pass) {
            await page.authenticate({
                username: PROXY_CONFIG.user,
                password: PROXY_CONFIG.pass
            });
        }

        // 5. Check IP and Headers (Optional debug)
        console.log('🔍 Verifying identity...');
        try {
            await page.goto('https://httpbin.org/headers', { waitUntil: 'networkidle2', timeout: 15000 });
            const headers = await page.evaluate(() => document.body.innerText);
            console.log('📡 Network Headers:', headers);
        } catch (e) {
            console.warn('⚠️ Identity verification failed (not critical)');
        }

        // 6. Navigate to Target
        console.log(`🚢 Navigating to ${TARGET_URL}...`);
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        // Wait for some product content to appear
        try {
            await page.waitForSelector('h3', { timeout: 10000 });
        } catch (e) { }

        console.log(`✅ Page loaded. Title: ${await page.title()}`);

        // 7. Extract Dynamic Data from PRELOADED_STATE
        console.log('🔍 Extracting products from __PRELOADED_STATE__...');
        const extractedData = await page.evaluate(() => {
            // Helper to find data in script tags
            const findInScripts = (pattern: string) => {
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                    if (s.textContent?.includes(pattern)) {
                        return s.textContent;
                    }
                }
                return null;
            };

            // @ts-ignore
            let state = window.__PRELOADED_STATE__;

            if (!state) {
                console.log('window.__PRELOADED_STATE__ not found. Searching scripts...');
                const content = findInScripts('__PRELOADED_STATE__');
                if (content) {
                    try {
                        // Naver usually does window.__PRELOADED_STATE__={...}
                        const jsonStr = content.split('__PRELOADED_STATE__=')[1].split(';')[0];
                        state = JSON.parse(jsonStr);
                        console.log('Successfully parsed state from script tag.');
                    } catch (e) {
                        console.log('Failed to parse state from script tag.');
                    }
                }
            }

            if (!state) {
                // Log all window keys that look like state
                const stateKeys = Object.keys(window).filter(k => k.includes('STATE') || k.includes('PRELOAD'));
                console.log('Available State-like keys:', stateKeys.join(', '));
                return { error: 'PRELOADED_STATE not found' };
            }

            // Improved deep search helper
            const findPathsByValue = (obj: any, target: string, path = '', depth = 0): string[] => {
                if (depth > 12 || !obj || typeof obj !== 'object') return [];
                let paths: string[] = [];
                try {
                    for (const key in obj) {
                        const val = obj[key];
                        const currentPath = path ? `${path}.${key}` : key;
                        if (String(val) === target) {
                            paths.push(currentPath);
                        } else if (typeof val === 'object' && val !== null) {
                            paths = paths.concat(findPathsByValue(val, target, currentPath, depth + 1));
                        }
                    }
                } catch (e) { }
                return paths;
            };

            // Exhaustive search for all product numbers
            const harvestAllSecretProducts = (obj: any, depth = 0): string[] => {
                if (depth > 15 || !obj || typeof obj !== 'object') return [];
                let found: string[] = [];
                try {
                    for (const key in obj) {
                        const val = obj[key];
                        // 1. Exact key match
                        if (key.toLowerCase().includes('productno') && val && (typeof val === 'string' || typeof val === 'number')) {
                            const strVal = String(val);
                            if (strVal.length >= 10 && /^\d+$/.test(strVal)) {
                                found.push(strVal);
                            }
                        }
                        // 2. CSV strings that look like product lists
                        if (typeof val === 'string' && val.includes(',') && val.length > 20) {
                            val.split(',').forEach(part => {
                                const trimmed = part.trim();
                                if (trimmed.length >= 10 && /^\d+$/.test(trimmed)) found.push(trimmed);
                            });
                        }
                        // 3. Recurse
                        if (typeof val === 'object' && val !== null) {
                            found = found.concat(harvestAllSecretProducts(val, depth + 1));
                        }
                    }
                } catch (e) { }
                return found;
            };

            const allHarvested = harvestAllSecretProducts(state);
            const uniqueSecrets = Array.from(new Set(allHarvested));

            let products = uniqueSecrets.map(id => ({ productNo: id }));

            // Extract Channel ID / UID
            // We search for both channelId and channelUid
            const channelId = state.smartStoreV2?.channel?.channelUid ||
                state.smartStoreV2?.channel?.channelId ||
                state.smartStore?.channel?.channelId ||
                state.product?.channelId ||
                null;

            // Debugging: show where ID was found
            const allIdPaths = channelId ? findPathsByValue(state, channelId) : [];

            return {
                channelId,
                channelUid: state.smartStoreV2?.channel?.channelUid,
                foundChannelPaths: allIdPaths,
                totalMatches: allHarvested.length,
                productCount: products.length,
                firstProductId: products[0]?.productNo || null,
                allProducts: products.slice(0, 5),
                allProductsList: products
            };
        });

        if (extractedData.error) {
            console.error(`❌ ${extractedData.error}`);
        } else {
            console.log('🔍 Global Harvest Analysis:');
            const paths = extractedData.foundChannelPaths;
            if (paths && paths.length > 0) {
                console.log(`   Internal paths for detected ID: ${paths.slice(0, 3).join(', ')}`);
            }
            console.log(`   Detected field 'channelUid': ${extractedData.channelUid}`);
            console.log(`   Total 'productNo' matches found: ${extractedData.totalMatches}`);
            console.log(`📦 Found ${extractedData.productCount} UNIQUE products after harvesting.`);
            console.log(`🆔 Dynamic Channel ID: ${extractedData.channelId}`);
            if (extractedData.allProducts) {
                console.log(`✨ Selected Dynamic Product: ${extractedData.firstProductId}`);
                extractedData.allProducts.forEach((p: any) => console.log(`   - productNo: ${p.productNo}`));
            }
        }

        // 7. Human Interaction simulation
        console.log('🖱️ Simulating human behavior...');

        // Random scroll
        for (let i = 0; i < 5; i++) {
            const scrollAmt = Math.floor(Math.random() * 300) + 100;
            console.log(`      Scrolling ${scrollAmt}px...`);
            await page.evaluate((y) => window.scrollBy(0, y), scrollAmt);
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
        }

        // Random mouse movement
        for (let i = 0; i < 3; i++) {
            const mx = Math.floor(Math.random() * FINGERPRINT.viewport.width);
            const my = Math.floor(Math.random() * FINGERPRINT.viewport.height);
            console.log(`      Moving mouse to ${mx}, ${my}...`);
            await page.mouse.move(mx, my, { steps: 25 });
            await new Promise(r => setTimeout(r, 500));
        }

        // Inspect outgoing headers for the first few requests
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (req.url().includes('i/v2/channels')) {
                console.log('📡 Reference Outgoing Headers:', req.headers());
            }
            req.continue();
        });

        await page.goto(TARGET_URL + 'products/12647771530', { waitUntil: 'networkidle2', timeout: 60000 });
        console.log(`✅ Product Page title: ${await page.title()}`);

        // 8. Bulk JSON API fetch
        const allProducts = extractedData.allProductsList || [];
        const cid = extractedData.channelId;

        if (allProducts.length === 0 || !cid) {
            console.error('❌ Cannot proceed with bulk fetch: Missing Product list or Channel ID.');
            await browser.close();
            process.exit(1);
        }

        const results: any[] = [];
        const BATCH_LIMIT = 100; // Expanded limit
        const productsToFetch = allProducts.slice(0, BATCH_LIMIT);

        const dataDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
        const outputPath = path.join(dataDir, 'products_full.json');

        console.log(`🧪 Starting bulk fetch for ${productsToFetch.length} products (Limit: ${BATCH_LIMIT})...`);

        let consecutiveFailures = 0;
        for (let i = 0; i < productsToFetch.length; i++) {
            const p = productsToFetch[i];
            const tid = p.productNo;

            console.log(`   [${i + 1}/${productsToFetch.length}] Fetching ${tid}...`);

            const apiResponse = await page.evaluate(async (tid, cid) => {
                const endpoint = `https://smartstore.naver.com/i/v2/channels/${cid}/products/${tid}?withWindow=false`;
                try {
                    const res = await fetch(endpoint, {
                        headers: {
                            'accept': 'application/json, text/plain, */*',
                            'x-client-version': '1.144.1',
                            'sec-fetch-dest': 'empty',
                            'sec-fetch-mode': 'cors',
                            'sec-fetch-site': 'same-origin',
                            'referer': `https://smartstore.naver.com/i/v2/channels/${cid}/products/${tid}?withWindow=false`
                        }
                    });
                    const text = await res.text();
                    if (res.ok) {
                        try {
                            return { success: true, data: JSON.parse(text) };
                        } catch (e) {
                            return { success: false, status: res.status, error: 'JSON_PARSE_ERROR', raw: text.substring(0, 100) };
                        }
                    }
                    return { success: false, status: res.status, statusText: res.statusText, raw: text.substring(0, 100) };
                } catch (e: any) {
                    return { success: false, error: e.message };
                }
            }, tid, cid);

            if (apiResponse.success) {
                results.push(apiResponse.data);
                consecutiveFailures = 0;

                // Incremental Save
                fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
            } else {
                consecutiveFailures++;
                console.error(`   🔴 [FETCH FAILED] ${tid} - Status: ${apiResponse.status} Error: ${apiResponse.error || apiResponse.statusText}`);
                console.error(`      Snippet: ${apiResponse.raw || 'N/A'}`);

                if (consecutiveFailures >= 3) {
                    console.warn(`⚠️  Detected ${consecutiveFailures} consecutive failures. Attempting page reload...`);
                    await page.reload({ waitUntil: 'networkidle2' });
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Cool down
                    consecutiveFailures = 0; // Reset after reload attempt
                }
            }

            // Random delay between 2s and 5s for stealth
            if (i < productsToFetch.length - 1) {
                const waitTime = Math.floor(Math.random() * 3000) + 2000;
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        console.log(`\n✅ Bulk fetch completed! Final count: ${results.length} products in ${outputPath}`);

        console.log('🎉 Test flow completed.');

        if (!HEADLESS) {
            console.log('� Browser open for manual inspection (Wait 30s)...');
            await new Promise(r => setTimeout(r, 30000));
        }

    } catch (error: any) {
        console.error(`❌ Test failed: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
            console.log('🛑 Browser closed.');
        }
    }
}

runTest();
