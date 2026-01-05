import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { ProxyBlacklistManager } from './ProxyBlacklistManager';
import { FingerprintGenerator } from './FingerprintGenerator';
import { VisionService } from './VisionService';

puppeteer.use(StealthPlugin());

interface ProxyConfig {
    name: string;
    host?: string;
    port?: string;
    user?: string;
    pass?: string;
}

export class ScraperService {
    private readonly BLOCKED_RESOURCES = [
        'image', 'font', 'media', 'stylesheet', 'texttrack',
        'object', 'beacon', 'csp_report', 'imageset'
    ];
    private blacklistManager = ProxyBlacklistManager.getInstance();
    private fingerprintGenerator = FingerprintGenerator.getInstance();
    private visionService = VisionService.getInstance();
    private cookiesPath = path.resolve('./cookies.json');
    private lastCaptchaData: { question: string, image: string, sessionKey: string } | null = null;

    // Helper to load and sanitize cookies from cookies.json
    private async loadCookies(): Promise<any[]> {
        try {
            if (fs.existsSync(this.cookiesPath)) {
                const data = fs.readFileSync(this.cookiesPath, 'utf8');
                const cookies = JSON.parse(data);
                if (Array.isArray(cookies)) {
                    return cookies.map(c => {
                        const sanitized = { ...c };
                        // Sanitize sameSite for Puppeteer compatibility
                        if (sanitized.sameSite === 'no_restriction') sanitized.sameSite = 'None';
                        if (sanitized.sameSite && typeof sanitized.sameSite === 'string') {
                            const ss = sanitized.sameSite.toLowerCase();
                            if (ss === 'lax') sanitized.sameSite = 'Lax';
                            else if (ss === 'strict') sanitized.sameSite = 'Strict';
                            else if (ss === 'none') sanitized.sameSite = 'None';
                            else delete sanitized.sameSite;
                        } else {
                            delete sanitized.sameSite;
                        }
                        return sanitized;
                    });
                }
            }
        } catch (e: any) {
            console.warn(`[Config] Failed to load cookies: ${e.message}`);
        }
        return [];
    }

    // Helper to normalize various proxy formats to ProxyConfig
    detectType(url: string): 'PRODUCT' | 'STORE' | 'CATEGORY' {
        if (url.includes('/products/')) return 'PRODUCT';
        if (url.includes('/category/')) return 'CATEGORY';
        // Fallback: If it looks like a smartstore URL but no specific path keywords, assume Store root
        if (url.includes('smartstore.naver.com')) return 'STORE';

        // Default to STORE if unsure, or maybe throw? For now default to STORE as it's the most generic
        return 'STORE';
    }

    private normalizeProxy(item: any, label: string): ProxyConfig | null {
        try {
            // 1. Handle String "protocol://user:pass@host:port" or "host:port"
            if (typeof item === 'string') {
                try {
                    // Try to parse as URL
                    const urlStr = item.includes('://') ? item : `http://${item}`;
                    const url = new URL(urlStr);
                    return {
                        name: label,
                        host: url.hostname,
                        port: url.port,
                        user: url.username,
                        pass: url.password
                    };
                } catch {
                    // Fallback for simple "host:port" if URL parsing fails or is weird
                    const parts = item.split(':');
                    if (parts.length === 2) {
                        return { name: label, host: parts[0], port: parts[1] };
                    }
                    return null;
                }
            }

            // 2. Handle Object
            if (typeof item === 'object' && item !== null) {
                // 2a. "proxy": "protocol://ip:port" field (like the user request)
                if (item.proxy && typeof item.proxy === 'string') {
                    try {
                        const url = new URL(item.proxy);
                        return {
                            name: label,
                            host: url.hostname,
                            port: url.port,
                            user: url.username,
                            pass: url.password
                        };
                    } catch { /* ignore and try other fields */ }
                }

                // 2b. Explicit fields
                const host = item.host || item.ip || item.hostname;
                const port = item.port;
                const user = item.user || item.username || item.auth?.user;
                const pass = item.pass || item.password || item.auth?.pass;

                if (host && port) {
                    return {
                        name: label,
                        host,
                        port: String(port),
                        user,
                        pass
                    };
                }
            }
        } catch (e) {
            console.error(`[Config] Failed to normalize proxy item: ${JSON.stringify(item)}`);
        }
        return null;
    }

    // Proxy List defined in order of preference
    private async getProxies(): Promise<ProxyConfig[]> {
        const proxies: ProxyConfig[] = [];
        const configStr = process.env.PROXY_LIST || ''; // e.g. "http://url.json, ./local.json, socks5://..."

        console.log(`[Config] PROXY_LIST from env: ${configStr}`);

        if (!configStr) {
            console.log(`[Config] No PROXY_LIST configured, using Direct connection only`);
            return [{ name: 'Direct' }];
        }

        try {
            // Split by comma first to allow mixing modes
            const items = configStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
            console.log(`[Config] Found ${items.length} proxy config items`);

            for (let i = 0; i < items.length; i++) {
                const itemStr = items[i];
                let extracted: any[] = [];

                try {
                    // 1. Remote JSON URL
                    if (itemStr.startsWith('http') && itemStr.endsWith('.json')) {
                        console.log(`[Config] Fetching proxy list from URL: ${itemStr}`);
                        const response = await fetch(itemStr);
                        if (response.ok) {
                            const json = await response.json();
                            if (Array.isArray(json)) extracted = json;
                        }
                    }
                    // 2. Local JSON File
                    else if (itemStr.endsWith('.json') && !itemStr.startsWith('http')) {
                        const filePath = path.resolve(itemStr);
                        if (fs.existsSync(filePath)) {
                            console.log(`[Config] Loading proxy list from file: ${filePath}`);
                            const content = fs.readFileSync(filePath, 'utf-8');
                            const json = JSON.parse(content);
                            if (Array.isArray(json)) extracted = json;
                        }
                    }
                    // 3. Direct String (or just a single proxy object later standardized)
                    else {
                        console.log(`[Config] Processing direct proxy string: ${itemStr.substring(0, 50)}...`);
                        extracted = [itemStr];
                    }

                    // Normalize and add
                    extracted.forEach((raw, j) => {
                        const label = `Proxy-G${i + 1}-${j + 1}`; // Group i, Item j
                        const proxy = this.normalizeProxy(raw, label);
                        if (proxy) {
                            console.log(`[Config] Added proxy: ${proxy.name} -> ${proxy.host}:${proxy.port} (auth: ${proxy.user ? 'yes' : 'no'})`);
                            proxies.push(proxy);
                        } else {
                            console.warn(`[Config] Failed to normalize proxy item: ${JSON.stringify(raw).substring(0, 100)}`);
                        }
                    });

                } catch (e: any) {
                    console.error(`[Config] Failed to process config item '${itemStr}': ${e.message}`);
                }
            }

        } catch (e: any) {
            console.error(`[Config] Critical error loading proxies: ${e.message}`);
        }

        // Always add Direct fallback at the end
        proxies.push({ name: 'Direct' });

        // Filter out blacklisted proxies
        const filteredProxies = proxies.filter(proxy => {
            const isBlacklisted = this.blacklistManager.isBlacklisted(proxy);
            if (isBlacklisted) {
                console.log(`[Config] Skipping blacklisted proxy: ${proxy.name} (${proxy.host}:${proxy.port})`);
            }
            return !isBlacklisted;
        });

        const blacklistedCount = proxies.length - filteredProxies.length;
        console.log(`[Config] Total proxies loaded: ${filteredProxies.length} (${blacklistedCount} blacklisted, including Direct fallback)`);

        if (blacklistedCount > 0) {
            console.log(`[Blacklist] Currently blacklisted proxies: ${this.blacklistManager.getBlacklistedCount()}`);
        }

        return filteredProxies;
    }

    /**
     * Scrapes a product URL with automatic proxy fallback.
     */
    async scrapeProduct(url: string, userAgent: string) {
        return this.scrapeGenericWithRetry(url, userAgent, 'PRODUCT');
    }

    async scrapeProductWithRetry(url: string, userAgent: string) {
        return this.scrapeGenericWithRetry(url, userAgent, 'PRODUCT');
    }

    /**
     * Scrapes a store URL with automatic proxy fallback.
     */
    async scrapeStoreWithRetry(url: string, userAgent: string) {
        return this.scrapeGenericWithRetry(url, userAgent, 'STORE');
    }

    /**
     * Scrapes a category URL with automatic proxy fallback.
     */
    async scrapeCategoryWithRetry(url: string, userAgent: string) {
        return this.scrapeGenericWithRetry(url, userAgent, 'CATEGORY');
    }

    private async scrapeGenericWithRetry(url: string, userAgent: string, type: 'PRODUCT' | 'STORE' | 'CATEGORY') {
        let lastError: any = null;
        const proxies = await this.getProxies();

        for (const proxy of proxies) {
            console.log(`[Scraper] Attempting ${type} with strategy: ${proxy.name}`);
            try {
                const data = await this.scrapeWithProxy(url, proxy, userAgent, type);

                // Validation based on type
                let success = false;
                if (type === 'PRODUCT' && (data.product || data.benefits)) success = true;
                if (type === 'STORE' && (data.channel || data.products)) success = true;
                if (type === 'CATEGORY' && (data.category || data.products)) success = true;

                if (!success) {
                    console.warn(`[Scraper] ${proxy.name} returned incomplete data for ${type}. Treating as failure.`);
                    throw new Error("Empty or incomplete data received");
                }

                console.log(`[Scraper] Success with ${proxy.name}`);

                // Flatten Logic to match User Requirements
                let finalData: any = { ...data, usedProxy: proxy.name };

                if (type === 'PRODUCT' && data.product) {
                    finalData = { ...data.product, benefits: data.benefits, usedProxy: proxy.name };
                } else if (type === 'STORE' && data.channel) {
                    finalData = { ...data.channel, products: data.products, usedProxy: proxy.name };
                } else if (type === 'CATEGORY' && data.category) {
                    finalData = { ...data.category, products: data.products, usedProxy: proxy.name };
                }

                if (finalData) {
                    console.log(`[Scraper] Successfully retrieved ${type} data using strategy: ${proxy.name}`);
                    return finalData;
                }

            } catch (error: any) {
                console.error(`[Scraper] Failed with ${proxy.name}: ${error.message}`);
                lastError = error;
            }
        }
        throw new Error(`All proxy attempts failed. Last error: ${lastError?.message}`);
    }

    private getRandomUserAgent(): string {
        // @ts-ignore
        const UserAgent = require('user-agents');
        return new UserAgent({ deviceCategory: 'desktop' }).toString();
    }

    /**
     * Verify IP and device info to ensure proxy and user agent are correctly applied
     */
    private async verifyProxyAndUserAgent(browser: Browser, expectedUserAgent: string, proxy: ProxyConfig): Promise<void> {
        const page = await browser.newPage();

        try {
            // Apply authentication if proxy has credentials
            if (proxy.user && proxy.pass) {
                await page.authenticate({ username: proxy.user, password: proxy.pass });
            }

            await page.setUserAgent(expectedUserAgent);

            console.log(`[Verification] Checking IP and device info for proxy: ${proxy.name}`);
            console.log(`[Verification] Expected User Agent: ${expectedUserAgent}`);
            if (proxy.host && proxy.port) {
                console.log(`[Verification] Expected Proxy: ${proxy.host}:${proxy.port} (auth: ${proxy.user ? 'yes' : 'no'})`);
            }

            // Use multiple services if one fails
            const ipCheckUrls = [
                proxy.host?.includes('thordata') ? 'http://ipinfo.thordata.com' : 'https://api.ipify.org?format=json',
                'https://api.ipify.org?format=json',
                'https://ifconfig.me/all.json'
            ];

            let ipContent = '';
            for (const url of ipCheckUrls) {
                try {
                    console.log(`[Verification] Checking IP via: ${url}`);
                    await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
                    ipContent = await page.content();
                    if (ipContent.includes(proxy.host || '') || ipContent.includes('{')) break;
                } catch (e) {
                    console.warn(`[Verification] Service ${url} failed, trying next...`);
                }
            }
            console.log(`[Verification] IP Check Response:`, ipContent.substring(0, 500));

            // Also check headers
            await page.goto('https://httpbin.org/headers', { waitUntil: 'networkidle2', timeout: 15000 });
            const content = await page.content();
            const jsonMatch = content.match(/<pre[^>]*>(.*?)<\/pre>/s);

            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[1]);
                console.log(`[Verification] Detected User Agent: ${data.headers['User-Agent']}`);
                console.log(`[Verification] Accept-Language: ${data.headers['Accept-Language']}`);
            }

        } catch (error: any) {
            console.warn(`[Verification] Failed to verify proxy/user agent: ${error.message}`);
        } finally {
            await page.close();
        }
    }

    private async scrapeWithProxy(url: string, proxy: ProxyConfig, userAgent: string, type: 'PRODUCT' | 'STORE' | 'CATEGORY') {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            // `--user-data-dir=${userDataDir}`, // DISABLED to match successful Step 290
        ];

        if (proxy.host && proxy.port) {
            const proxyUrl = `http://${proxy.host}:${proxy.port}`;
            args.push(`--proxy-server=${proxyUrl}`);
            console.log(`[Scraper] Using proxy: ${proxyUrl}`);
        }

        let browser: Browser | null = null;
        let lastError: any = null;
        const headless = false; // Toggle here for testing

        try {
            console.log(`[Scraper] Launching browser (Headless: ${headless.toString().toUpperCase()})`);
            browser = await puppeteer.launch({
                headless,
                args,
                ignoreDefaultArgs: ['--disable-extensions'],
            });

            const fingerprint = this.fingerprintGenerator.generateFingerprint();
            console.log(`[Fingerprint] User Agent: ${fingerprint.userAgent.substring(0, 80)}...`);
            console.log(`[Fingerprint] Viewport: ${fingerprint.viewport.width}x${fingerprint.viewport.height}`);

            // await this.verifyProxyAndUserAgent(browser, fingerprint.userAgent, proxy); // Removed early signal

            const scrapedData: any = {
                products: null,
                product: null,
                benefits: null,
                channel: null,
                category: null
            };

            const page = await browser.newPage();
            await page.setUserAgent(fingerprint.userAgent);
            await page.setViewport(fingerprint.viewport);

            // Deep fingerprint synchronization (Matches Step 290 strategy)
            await page.evaluateOnNewDocument((fp: any) => {
                // @ts-ignore
                const isWin = fp.userAgent.includes('Windows');
                const platform = isWin ? 'Win32' : 'MacIntel';
                // @ts-ignore
                Object.defineProperty(navigator, 'platform', { get: () => platform });
                // @ts-ignore
                Object.defineProperty(navigator, 'vendor', { get: () => isWin ? 'Google Inc.' : 'Apple Computer, Inc.' });
                // @ts-ignore
                Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                // @ts-ignore
                Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                // @ts-ignore
                Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
                // @ts-ignore
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                // @ts-ignore
                Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
            }, fingerprint);

            // Re-enabling cookies to leverage provided session/CAPTCHA tokens
            const cookies = await this.loadCookies();
            if (cookies.length > 0) {
                console.log(`[Cookies] Injecting ${cookies.length} cookies...`);
                await page.setCookie(...cookies);
            }

            console.log(`[Scraper] Stealth overrides and Cookie injection ENABLED.`);

            const dataPromise = new Promise<any>((resolve) => {
                let resolved = false;
                const timeoutId = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        resolve(null);
                    }
                }, 40000); // 40s wait for all XHRs to settle

                page.on('response', async (res) => {
                    const resUrl = res.url();
                    const status = res.status();
                    const contentType = res.headers()['content-type'] || '';

                    if (status === 403 || status === 429) {
                        console.warn(`[Scraper] Detected HTTP ${status} from ${resUrl}`);
                        if (status === 429) {
                            this.blacklistManager.blacklist(proxy, `HTTP 429 from ${resUrl}`);
                        }
                    }

                    if (contentType.includes('application/json')) {
                        try {
                            const json = await res.json();
                            console.log(`[Network] JSON: ${resUrl.substring(0, 120)}`);

                            // Store everything in a flat cache to analyze later if needed
                            if (resUrl.includes('/channels/')) {
                                if (resUrl.includes('/products/')) scrapedData.product = json;
                                else if (resUrl.includes('/products?')) scrapedData.products = json;
                                else scrapedData.channel = json;
                            }
                            if (resUrl.includes('/benefits/')) scrapedData.benefits = json;
                            if (resUrl.includes('/categories/')) scrapedData.category = json;

                            // Naver often uses /i/v2/ or /i/v1/ URLs
                            if (resUrl.includes('/i/v')) {
                                if (json.channelUid || json.channelName) scrapedData.channel = json;
                            }

                            // Intercept CAPTCHA data
                            if (resUrl.includes('/challenge/receipt/question')) {
                                if (json.receiptData) {
                                    const urlParams = new URLSearchParams(resUrl.split('?')[1]);
                                    const key = urlParams.get('key') || "";

                                    this.lastCaptchaData = {
                                        question: json.receiptData.question,
                                        image: json.receiptData.image,
                                        sessionKey: key
                                    };
                                    console.log(`[CAPTCHA] Intercepted network data (Key: ${key}): ${json.receiptData.question.substring(0, 50)}...`);
                                }
                            }
                        } catch (e) { }
                    }
                });
            });

            if (proxy.user && proxy.pass) {
                await page.authenticate({ username: proxy.user, password: proxy.pass });
            }

            // More interactive multi-stage warm-up
            const warmUpUrls = ['https://www.naver.com', 'https://shopping.naver.com'];
            for (const warmUpUrl of warmUpUrls) {
                console.log(`[Puppeteer] Warming up at ${warmUpUrl}...`);
                try {
                    await page.goto(warmUpUrl, { waitUntil: 'networkidle2', timeout: 30000 });

                    // Check for CAPTCHA at each stage
                    const content = await page.content();
                    const hasCaptchaText = (text: string) =>
                        text.includes('security verification') ||
                        text.includes('complete the security') ||
                        text.includes('봇이 아니') ||
                        text.includes('보안절차');

                    if (hasCaptchaText(content) || !!this.lastCaptchaData) {
                        console.log(`🔐 [CAPTCHA] Detected during warm-up at ${warmUpUrl}. Attempting solve...`);
                        await this.handleCaptcha(page);
                    }

                    // Simulate human interaction
                    await page.evaluate(async () => {
                        const randomScroll = () => window.scrollBy(0, Math.floor(Math.random() * 500) + 200);
                        randomScroll();
                        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
                        randomScroll();
                    });

                    // Random mouse moves
                    for (let i = 0; i < 5; i++) {
                        await page.mouse.move(Math.random() * 1024, Math.random() * 768, { steps: 50 });
                        await new Promise(r => setTimeout(r, 800 + Math.random() * 500));
                    }

                    await new Promise(resolve => setTimeout(resolve, Math.random() * 5000 + 4000));
                } catch (e: any) {
                    console.warn(`[Puppeteer] Warm-up at ${warmUpUrl} failed: ${e.message}. Proceeding...`);
                }
            }

            const preNavDelay = Math.floor(Math.random() * 5000) + 7000;
            console.log(`[Puppeteer] Waiting ${preNavDelay}ms before navigating to target...`);
            await new Promise(resolve => setTimeout(resolve, preNavDelay));

            console.log(`[Puppeteer] Navigating to target: ${url}...`);
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

            // Check if blocked
            const currentTitle = await page.title();
            if (currentTitle.includes('429') || currentTitle.includes('시스템오류')) {
                console.warn(`[Scraper] Immediate block detected on ${url}`);
                const status = await page.evaluate(() => {
                    // @ts-ignore
                    return document.body.innerText.substring(0, 100);
                });
                console.warn(`[Scraper] Page text: ${status}`);
            } else {
                console.log(`[Scraper] Page loaded! Title: ${currentTitle}. Waiting 15s for XHRs to finish...`);
                await new Promise(resolve => setTimeout(resolve, 15000));
            }

            console.log(`[Puppeteer] Simulating human behavior...`);
            await page.evaluate(async () => {
                const scrollSteps = 5;
                for (let i = 0; i < scrollSteps; i++) {
                    window.scrollBy(0, Math.floor(Math.random() * 300) + 100);
                    await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500) + 500));
                }
            });

            const title = await page.title();
            const pageContent = await page.content();

            const hasCaptchaOnTarget = (text: string) =>
                text.includes('security verification') ||
                text.includes('complete the security') ||
                text.includes('봇이 아니') ||
                text.includes('보안절차');

            let captchaOnTarget = hasCaptchaOnTarget(pageContent) || !!this.lastCaptchaData;

            if (!captchaOnTarget) {
                for (const frame of page.frames()) {
                    try {
                        const frameContent = await frame.content();
                        if (hasCaptchaOnTarget(frameContent)) {
                            captchaOnTarget = true;
                            break;
                        }
                    } catch (e) { }
                }
            }

            if (captchaOnTarget) {
                console.log(`🔐 [CAPTCHA DETECTED] Attempting automated solution...`);
                const solved = await this.handleCaptcha(page);
                if (!solved) {
                    console.log(`[CAPTCHA] Automated solution failed. Waiting 60s for manual solution...`);
                    await new Promise(resolve => setTimeout(resolve, 60000));
                } else {
                    console.log(`[CAPTCHA] Automated solution potentially successful.`);
                }
            }

            if (title.includes('시스템오류') || title.includes('에러페이지') || title.includes('상품이 존재하지 않습니다')) {
                throw new Error(`Naver Blocked Request (Title: ${title})`);
            }

            const result = await dataPromise;

            // Allow inspection for observation
            if (!headless) {
                console.log(`[Scraper] Observation period: 10 seconds...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }

            if (browser) await browser.close();

            // Return whatever we captured during the timeout
            const finalResult = result || scrapedData;

            // Check if we captured enough
            let hasData = false;
            if (type === 'PRODUCT' && (finalResult.product || finalResult.benefits)) hasData = true;
            if (type === 'STORE' && (finalResult.channel || finalResult.products)) hasData = true;
            if (type === 'CATEGORY' && (finalResult.category || finalResult.products)) hasData = true;

            if (!hasData) {
                throw new Error('Empty or incomplete data received');
            }

            return { ...finalResult, usedProxy: proxy.name };

        } catch (error: any) {
            console.warn(`[Scraper] Failed with ${proxy.name}: ${error.message}`);
            if (browser) await browser.close();
            throw error;
        }
    }

    private async handleCaptcha(page: Page): Promise<boolean> {
        try {
            console.log(`🔐 [CAPTCHA] Attempting to solve AI CAPTCHA...`);

            // 1. Identify CAPTCHA elements (Search in all frames)
            const imgSelector = 'img[src*="challenge"]';
            const inputSelector = 'input[type="text"]';
            const confirmBtnSelector = 'button.btn_confirm, button[type="submit"], .btn_area button';

            let captchaFrame: any = page;
            let found = false;

            // Wait a bit for UI to render
            await new Promise(r => setTimeout(r, 2000));

            // Check main page
            if (await page.$(imgSelector)) {
                found = true;
                console.log(`[CAPTCHA] Found element in main frame.`);
            } else {
                // Check iframes
                const frames = page.frames();
                for (const frame of frames) {
                    if (await frame.$(imgSelector)) {
                        captchaFrame = frame;
                        found = true;
                        console.log(`[CAPTCHA] Found element in iframe: ${frame.url()}`);
                        break;
                    }
                }
            }

            if (!found && !this.lastCaptchaData) {
                console.warn(`[CAPTCHA] Could not find CAPTCHA elements and no intercepted data.`);
                return false;
            }

            // 2. Extract question and image (Use intercepted data first, then fallback to DOM)
            let question_text = "";
            let base64Image = "";

            if (this.lastCaptchaData) {
                question_text = this.lastCaptchaData.question;
                const rawImage = this.lastCaptchaData.image;
                base64Image = rawImage.includes('base64,') ? rawImage.split('base64,')[1] : rawImage;
                console.log(`[CAPTCHA] Using intercepted data for solving.`);
            } else {
                console.log(`[CAPTCHA] No intercepted data found, falling back to DOM scraping...`);
                question_text = await captchaFrame.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll('div, p, span'));
                    const mainText = elements.find(el =>
                        el.textContent?.includes('location') ||
                        el.textContent?.includes('number') ||
                        el.textContent?.includes('Fill') ||
                        el.textContent?.includes('전화번호') ||
                        el.textContent?.includes('번호')
                    )?.textContent || '';
                    return mainText.trim();
                });

                const captchaElement = await captchaFrame.$(imgSelector);
                if (!captchaElement) throw new Error('CAPTCHA image not found in DOM');
                base64Image = await captchaElement.screenshot({ encoding: 'base64' }) as string;
            }

            console.log(`[CAPTCHA] Question: "${question_text}"`);

            const sessionKey = this.lastCaptchaData?.sessionKey || "";

            // Clear state after use
            this.lastCaptchaData = null;

            if (!question_text || !base64Image) {
                console.warn(`[CAPTCHA] Missing question or image for solving.`);
                return false;
            }

            // [DEBUG] Save the image for manual verification if it's failing
            try {
                const debugPath = path.resolve('./captcha_debug.png');
                fs.writeFileSync(debugPath, Buffer.from(base64Image, 'base64'));
                console.log(`[CAPTCHA] Saved image to ${debugPath} for verification.`);
            } catch (e: any) {
                console.warn(`[CAPTCHA] Failed to save debug image: ${e.message}`);
            }

            // 4. Solve using Vision Service
            const answer = await this.visionService.solveReceiptCaptcha(base64Image, question_text);

            if (!answer) {
                console.warn(`[CAPTCHA] AI failed to provide an answer.`);
                return false;
            }

            // 5. Input and Confirm
            console.log(`[CAPTCHA] Entering answer: ${answer}`);

            // Try DOM-based submission first
            let domSubmissionSuccess = false;
            try {
                // Wait for input to be available in the correct frame
                await captchaFrame.waitForSelector(inputSelector, { timeout: 3000 });
                await captchaFrame.focus(inputSelector);
                await captchaFrame.keyboard.type(answer, { delay: 100 });
                await new Promise(r => setTimeout(r, 1000));
                await captchaFrame.click(confirmBtnSelector);
                domSubmissionSuccess = true;
                console.log(`[CAPTCHA] Answer submitted via DOM.`);
            } catch (domErr: any) {
                console.warn(`[CAPTCHA] DOM submission failed: ${domErr.message}. Trying API-based submission...`);
            }

            // Fallback: API-based submission if DOM failed or as extra insurance
            if (!domSubmissionSuccess) {
                try {
                    let apiSessionKey = sessionKey;

                    if (!apiSessionKey) {
                        // Try to extract from URL as last resort
                        const currentUrl = page.url();
                        if (currentUrl.includes('key=')) {
                            const urlParams = new URLSearchParams(currentUrl.split('?')[1]);
                            apiSessionKey = urlParams.get('key') || "";
                        }
                    }

                    if (apiSessionKey) {
                        console.log(`[CAPTCHA] Attempting API verify with key: ${apiSessionKey}`);
                        const verifyUrl = `https://ncpt.naver.com/v1/wcpt/m/challenge/receipt/verify?key=${apiSessionKey}&answer=${encodeURIComponent(answer)}`;
                        await page.goto(verifyUrl, { waitUntil: 'networkidle2', timeout: 10000 });
                        console.log(`[CAPTCHA] API verify request sent.`);
                    } else {
                        console.warn(`[CAPTCHA] Could not find session key for API verification.`);
                    }
                } catch (apiErr: any) {
                    console.error(`[CAPTCHA] API submission failed: ${apiErr.message}`);
                }
            }

            console.log(`[CAPTCHA] Submitted. Waiting for verification...`);
            await new Promise(r => setTimeout(r, 5000));
            return true;
        } catch (e: any) {
            console.error(`[CAPTCHA] Error during solving: ${e.message}`);
            return false;
        }
    }
}
