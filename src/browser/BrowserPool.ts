import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { ValidatedProxy, BrowserProfile } from '../proxy/types';
import { ProxyManager } from '../proxy/ProxyManager';
import { ProfileManager } from '../profiles/ProfileManager';
import { StealthInjector } from './StealthInjector';

puppeteer.use(StealthPlugin());

export interface BrowserInstance {
    id: number;
    browser: Browser;
    pages: Page[];
    proxy: ValidatedProxy | null;
    profile: BrowserProfile;
    consecutiveFailures: number;
    isActive: boolean;
    isRestarting: boolean;
}

export interface BrowserPoolConfig {
    minBrowsers: number;
    maxBrowsers: number;
    minTabs: number;
    tabsPerBrowser: number;
    proxiedCount: number; // Number of browsers that should use a proxy
    headless: boolean;
}

const DEFAULT_CONFIG: BrowserPoolConfig = {
    minBrowsers: 1,
    maxBrowsers: 3,
    minTabs: 1,
    tabsPerBrowser: 2,
    proxiedCount: 3,
    headless: false
};

export class BrowserPool {
    private browsers: Map<number, BrowserInstance> = new Map();
    private proxyManager: ProxyManager;
    private profileManager: ProfileManager;
    private config: BrowserPoolConfig;
    private isInitialized: boolean = false;
    private pendingLaunches: Set<number> = new Set();

    constructor(config: Partial<BrowserPoolConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.proxyManager = new ProxyManager();
        this.profileManager = new ProfileManager();
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        console.log('🚀 Initializing Browser Pool (Dynamic Scaling)');
        console.log(`   Min: ${this.config.minBrowsers} browsers × ${this.config.minTabs} tabs`);
        console.log(`   Max: ${this.config.maxBrowsers} browsers × ${this.config.tabsPerBrowser} tabs`);
        console.log(`   Config: ${this.config.proxiedCount} browsers will use proxies`);

        // Initialize ProxyManager first
        await this.proxyManager.initialize();

        // Start with minimum browsers
        const promises = [];
        for (let i = 0; i < this.config.minBrowsers; i++) {
            promises.push(this.createBrowserInstance(i));
        }
        await Promise.all(promises);

        console.log(`✅ Browser Pool initialized: ${this.browsers.size} active browsers`);
        this.isInitialized = true;
    }

    /**
     * Scale up browser pool if needed (called by queue when demand increases)
     */
    async scaleUp(queueLength: number): Promise<void> {
        // Calculate true utilization including pending launches
        let effectiveActive = 0;
        for (let i = 0; i < this.config.maxBrowsers; i++) {
            const b = this.browsers.get(i);
            const isPending = this.pendingLaunches.has(i);
            // Slot is occupied if it has an active/restarting browser OR if it is currently launching
            if ((b && (b.isActive || b.isRestarting)) || isPending) {
                effectiveActive++;
            }
        }

        const maxCount = this.config.maxBrowsers;

        if (effectiveActive >= maxCount) {
            return; // Already at max capacity
        }

        // Scale up if queue is building (more than 2x current capacity)
        const currentCapacity = effectiveActive * this.config.tabsPerBrowser;
        if (queueLength > currentCapacity * 2 || effectiveActive === 0) {
            // Find first available ID
            let newBrowserId = -1;
            for (let i = 0; i < maxCount; i++) {
                const browser = this.browsers.get(i);
                const isPending = this.pendingLaunches.has(i);

                // Check if slot is empty (no browser map entry or inactive) AND not pending
                // If isPending is true, we MUST skip
                // If browser exists: check if active or restarting.
                const isOccupied = (browser && (browser.isActive || browser.isRestarting)) || isPending;

                if (!isOccupied) {
                    newBrowserId = i;
                    break;
                }
            }

            if (newBrowserId !== -1) {
                console.log(`📈 Scaling up: Adding browser ${newBrowserId} (queue: ${queueLength})`);
                // Start creation in background to avoid blocking the queue processing loop
                // We rely on pendingLaunches to prevent duplicates
                this.createBrowserInstance(newBrowserId).catch(err => {
                    console.error(`[BrowserPool] Scaling error for B${newBrowserId}: ${err instanceof Error ? err.message : String(err)}`);
                });
            } else {
                // Strict logging - no scale allowed
            }
        }
    }

    private async createBrowserInstance(id: number): Promise<BrowserInstance | null> {
        // Prevent double launch for same ID
        if (this.pendingLaunches.has(id)) {
            console.warn(`[BrowserPool] ⚠️ Browser ${id} is already launching. Skipping duplicate request.`);
            return null;
        }

        this.pendingLaunches.add(id);

        let proxy: ValidatedProxy | null = null;
        let browser: Browser | null = null; // LIFTED SCOPE

        try {
            const profile = this.profileManager.getRandomProfile();
            // Determine if this specific browser instance should use a proxy
            // Logic: Prioritize direct connections for lower browser IDs.
            // If proxiedCount < maxBrowsers, the first browsers (starting from ID 0) will be direct.
            const directCount = this.config.maxBrowsers - this.config.proxiedCount;
            const shouldUseProxy = id >= directCount;

            if (shouldUseProxy) {
                proxy = await this.proxyManager.getProxy();
            }

            console.log(`[Browser ${id}] Creating with profile: ${profile.name}${proxy ? `, proxy: ${proxy.host}:${proxy.port}` : ', no proxy'}`);

            const args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
            ];

            browser = await puppeteer.launch({
                headless: this.config.headless,
                args: proxy ? [
                    ...args,
                    `--proxy-server=http://${proxy.host}:${proxy.port}`,
                ] : args,
                ignoreDefaultArgs: ['--disable-extensions'],
            });

            const instance: BrowserInstance = {
                id,
                browser,
                pages: [],
                proxy,
                profile,
                consecutiveFailures: 0,
                isActive: true,
                isRestarting: false
            };

            // Create tabs (pages)
            for (let t = 0; t < this.config.tabsPerBrowser; t++) {
                const page = await this.createConfiguredPage(browser, profile, proxy);
                instance.pages.push(page);
            }

            this.browsers.set(id, instance);
            return instance;

        } catch (error: any) {
            console.error(`❌ [Browser ${id}] Failed to create:`, error.message);

            // CRITICAL FIX: Clean up the process if it was launched (zombie prevention)
            if (browser) {
                console.log(`[BrowserPool] 🧹 Cleaning up failed browser instance for B${id}...`);
                try { await browser.close(); } catch (e) { }
            }

            if (proxy) {
                this.proxyManager.markProxyBad(proxy);
            }

            return null;
        } finally {
            this.pendingLaunches.delete(id);
        }
    }

    private async createConfiguredPage(browser: Browser, profile: BrowserProfile, proxy: ValidatedProxy | null): Promise<Page> {
        const page = await browser.newPage();

        // Apply Proxy Auth if needed
        if (proxy && proxy.username && proxy.password) {
            console.log(`[Browser] 🔐 Authenticating page for proxy ${proxy.host}`);
            await page.authenticate({ username: proxy.username, password: proxy.password });
        }

        // Apply high-fidelity fingerprinting via StealthInjector
        await StealthInjector.inject(page, profile);

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url().toLowerCase();
            const resourceType = req.resourceType() as string;

            // ALWAYS allow main document
            if (resourceType === 'document') {
                req.continue().catch(() => { });
                return;
            }

            // Block known trackers/ads/analytics
            if (url.includes('google-analytics') ||
                url.includes('facebook') ||
                url.includes('doubleclick') ||
                url.includes('t.co') ||
                url.includes('analytics') ||
                url.includes('beacon')) {
                // console.log(`[Browser] 🚫 Blocking tracker: ${url}`);
                req.abort().catch(() => { });
                return;
            }

            // Blocking stylesheet can cause issues with Naver's visibility-based rendering
            // Relieving the block on images/fonts to see if it fixes "BLOCKED_BY_CLIENT" on main page
            if (['image', 'media', 'font', 'texttrack', 'object', 'csp_report', 'imageset'].includes(resourceType)) {
                // For now, allow them but maybe log? 
                // Actually, let's just allow them to ensure stability. 
                // Optimizing bandwidth is secondary to it actually working.
                req.abort().catch(() => { });
            } else {
                req.continue().catch(() => { });
            }
        });

        // Warmup
        try {
            console.log(`[Browser] 🌤️ Warming up page: https://smartstore.naver.com/`);
            await page.goto('https://smartstore.naver.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 15000 // Increased from 5s to 15s for proxies
            });
        } catch (e: any) {
            console.warn(`⚠️ Warmup navigation failed: ${e.message}`);
        }

        return page;
    }

    async restartBrowser(browserId: number): Promise<void> {
        const instance = this.browsers.get(browserId);
        if (!instance) return;

        console.log(`🔄 [Browser ${browserId}] Restarting with fresh instance...`);

        // Mark old proxy as bad if it exists
        if (instance.proxy) {
            this.proxyManager.markProxyBad(instance.proxy);
        }

        // Release profile
        this.profileManager.releaseProfile(instance.profile);

        // Close old browser aggressively
        instance.isActive = false;
        instance.isRestarting = true;
        try {
            // Set a timeout for closing
            const closePromise = Promise.all([
                ...instance.pages.map(p => p.close().catch(() => { })),
                instance.browser.close().catch(() => { })
            ]);

            // Wait max 5s for cleanup
            await Promise.race([
                closePromise,
                new Promise(r => setTimeout(r, 5000))
            ]);
        } catch (e) { }

        // Wait before restart
        const cooldown = 5000 + Math.random() * 5000;
        console.log(`[Browser ${browserId}] 💤 Cooling down for ${Math.round(cooldown / 1000)}s...`);
        await new Promise(r => setTimeout(r, cooldown));

        // Create new browser instance (this will update this.browsers.set(browserId, ...))
        await this.createBrowserInstance(browserId);
    }

    /**
     * Rotate the profile (User Agent, fingerprint) on a specific page
     * Used when UNSUPPORTED_BROWSER error occurs - change UA without restarting browser
     */
    async rotatePageProfile(browserId: number, tabId: number): Promise<string | null> {
        const instance = this.browsers.get(browserId);
        if (!instance || !instance.isActive) {
            console.warn(`[BrowserPool] Cannot rotate profile - Browser ${browserId} not active`);
            return null;
        }

        const page = instance.pages[tabId];
        if (!page) {
            console.warn(`[BrowserPool] Cannot rotate profile - Tab ${tabId} not found`);
            return null;
        }

        const oldProfileName = instance.profile.name;

        // Release old profile
        this.profileManager.releaseProfile(instance.profile);

        // Get new profile - may fail if all UAs are blacklisted
        let newProfile: BrowserProfile;
        try {
            newProfile = this.profileManager.getRandomProfile();
        } catch (e: any) {
            console.error(`[BrowserPool] ❌ Failed to get new profile: ${e.message}`);
            return null; // All UAs blacklisted
        }

        console.log(`[Browser ${browserId}.T${tabId}] 🔄 Rotating profile from "${oldProfileName}" to "${newProfile.name}"`);

        // Re-inject new profile on existing page
        await StealthInjector.inject(page, newProfile);

        // Update instance reference
        instance.profile = newProfile;

        return newProfile.name;
    }

    /**
     * Get the current profile for a browser
     */
    getProfileForBrowser(browserId: number): BrowserProfile | null {
        const instance = this.browsers.get(browserId);
        return instance?.profile ?? null;
    }

    getBrowser(browserId: number): BrowserInstance | null {
        return this.browsers.get(browserId) || null;
    }

    getPage(browserId: number, tabId: number): Page | null {
        const browser = this.browsers.get(browserId);
        if (!browser || !browser.isActive) return null;
        return browser.pages[tabId] || null;
    }

    getAllActivePages(): { browserId: number; tabId: number; page: Page }[] {
        const pages: { browserId: number; tabId: number; page: Page }[] = [];

        for (const browser of this.browsers.values()) {
            if (browser && browser.isActive) {
                for (let t = 0; t < browser.pages.length; t++) {
                    pages.push({
                        browserId: browser.id,
                        tabId: t,
                        page: browser.pages[t]
                    });
                }
            }
        }

        return pages;
    }

    incrementFailure(browserId: number): number {
        const browser = this.browsers.get(browserId);
        if (browser) {
            browser.consecutiveFailures++;
            return browser.consecutiveFailures;
        }
        return 0;
    }

    resetFailure(browserId: number): void {
        const browser = this.browsers.get(browserId);
        if (browser) {
            browser.consecutiveFailures = 0;
        }
    }

    async shutdown(): Promise<void> {
        console.log('🛑 Shutting down Browser Pool...');

        for (const browser of this.browsers.values()) {
            if (browser && browser.browser) {
                try {
                    await browser.browser.close();
                } catch (e) { }
            }
        }

        await this.proxyManager.shutdown();
        this.browsers.clear();
        this.isInitialized = false;

        console.log('✅ Browser Pool shutdown complete');
    }

    getStats(): { active: number; total: number; proxied: number } {
        const browsers = Array.from(this.browsers.values());
        const active = browsers.filter(b => b && b.isActive).length;
        const proxied = browsers.filter(b => b && b.isActive && b.proxy).length;

        return {
            active,
            total: this.config.maxBrowsers,
            proxied
        };
    }

    /**
     * Creates a single-use browser instance with a custom proxy.
     * This is NOT added to the managed pool and must be closed manually.
     */
    async createEphemeralBrowser(proxyUrl: string): Promise<{ browser: Browser; page: Page } | null> {
        console.log(`[BrowserPool] 🌩️ Creating Ephemeral Browser with proxy: ${proxyUrl}`);

        try {
            // Parse proxyUrl (format: protocol://user:pass@host:port or host:port)
            // Simplified parsing for standard http/https proxies

            // NOTE: Puppeteer expects --proxy-server=host:port and page.authenticate for auth
            // We need to extract auth credentials if present

            let host: string, port: string, username, password;

            // Remove protocol if present
            let cleanUrl = proxyUrl.replace(/https?:\/\//, '');

            if (cleanUrl.includes('@')) {
                const parts = cleanUrl.split('@');
                const auth = parts[0].split(':');
                username = auth[0];
                password = auth[1];
                const addr = parts[1].split(':');
                host = addr[0];
                port = addr[1];
            } else {
                const addr = cleanUrl.split(':');
                host = addr[0];
                port = addr[1];
            }

            const args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                `--proxy-server=http://${host}:${port}`
            ];

            const browser = await puppeteer.launch({
                headless: this.config.headless,
                args: args,
                ignoreDefaultArgs: ['--disable-extensions'],
            });

            const page = await browser.newPage();

            if (username && password) {
                await page.authenticate({ username, password });
            }

            // Apply stealth
            const profile = this.profileManager.getRandomProfile(); // Just borrow a random profile profile
            await StealthInjector.inject(page, profile);

            return { browser, page };

        } catch (error) {
            console.error('[BrowserPool] ❌ Failed to create ephemeral browser:', error);
            return null;
        }
    }
}

export function createBrowserPool(config?: Partial<BrowserPoolConfig>): BrowserPool {
    return new BrowserPool(config);
}
