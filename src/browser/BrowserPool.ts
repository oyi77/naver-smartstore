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
}

export interface BrowserPoolConfig {
    browserCount: number;
    tabsPerBrowser: number;
    proxiedCount: number; // Number of browsers that should use a proxy
    headless: boolean;
}

const DEFAULT_CONFIG: BrowserPoolConfig = {
    browserCount: 3,
    tabsPerBrowser: 2,
    proxiedCount: 3,
    headless: false
};

export class BrowserPool {
    private browsers: BrowserInstance[] = [];
    private proxyManager: ProxyManager;
    private profileManager: ProfileManager;
    private config: BrowserPoolConfig;
    private isInitialized: boolean = false;

    constructor(config: Partial<BrowserPoolConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.proxyManager = new ProxyManager();
        this.profileManager = new ProfileManager();
    }

    async initialize(): Promise<void> {
        console.log(`🚀 Initializing Browser Pool (${this.config.browserCount} browsers × ${this.config.tabsPerBrowser} tabs)`);
        console.log(`   Config: ${this.config.proxiedCount} browsers will use proxies`);

        // ALWAYS initialize Proxy Manager (to keep it running/fetching/validating)
        await this.proxyManager.initialize();

        if (this.config.proxiedCount > 0) {
            if (this.proxyManager.getPoolSize() < this.config.proxiedCount) {
                console.warn(`⚠️ Not enough proxies (${this.proxyManager.getPoolSize()}), some browsers (target: ${this.config.proxiedCount}) will run without proxy`);
            }
        }

        // Create browsers in parallel
        const createPromises = [];
        for (let i = 0; i < this.config.browserCount; i++) {
            createPromises.push(this.createBrowserInstance(i));
        }

        await Promise.all(createPromises);
        this.isInitialized = true;

        console.log(`✅ Browser Pool initialized: ${this.browsers.filter(b => b.isActive).length} active browsers`);
    }

    private async createBrowserInstance(id: number): Promise<BrowserInstance | null> {
        const profile = this.profileManager.getRandomProfile();
        // Determine if this specific browser instance should use a proxy
        // Logic: if id (0-based) is less than proxiedCount, it uses a proxy.
        // E.g. proxiedCount=1 -> id 0 uses proxy, id 1+ do not.
        const shouldUseProxy = id < this.config.proxiedCount;
        const proxy = shouldUseProxy ? this.proxyManager.getProxy() : null;

        console.log(`[Browser ${id}] Creating with profile: ${profile.name}${proxy ? `, proxy: ${proxy.host}:${proxy.port}` : ', no proxy'}`);

        try {
            const args = [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
            ];

            const browser = await puppeteer.launch({
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
                isActive: true
            };

            // Create tabs (pages)
            for (let t = 0; t < this.config.tabsPerBrowser; t++) {
                const page = await this.createConfiguredPage(browser, profile, proxy);
                instance.pages.push(page);
            }

            this.browsers[id] = instance;
            return instance;

        } catch (error) {
            console.error(`❌ [Browser ${id}] Failed to create:`, error);

            if (proxy) {
                this.proxyManager.markProxyBad(proxy);
            }

            return null;
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

        // Warmup
        try {
            console.log(`[Browser] 🌤️ Warming up page: https://smartstore.naver.com/`);
            await page.goto('https://smartstore.naver.com/', {
                waitUntil: 'domcontentloaded',
                timeout: 5000
            });
        } catch (e: any) {
            console.warn(`⚠️ Warmup navigation failed: ${e.message}`);
        }

        return page;
    }

    async restartBrowser(browserId: number): Promise<void> {
        const instance = this.browsers[browserId];
        if (!instance) return;

        console.log(`🔄 [Browser ${browserId}] Restarting with new proxy...`);

        // Mark old proxy as bad if it exists
        if (instance.proxy) {
            this.proxyManager.markProxyBad(instance.proxy);
        }

        // Release profile
        this.profileManager.releaseProfile(instance.profile);

        // Close old browser
        try {
            for (const page of instance.pages) {
                try { await page.close(); } catch (e) { }
            }
            await instance.browser.close();
        } catch (e) { }

        instance.isActive = false;

        // Wait before restart
        const cooldown = 10000 + Math.random() * 10000;
        console.log(`[Browser ${browserId}] 💤 Cooling down for ${Math.round(cooldown / 1000)}s...`);
        await new Promise(r => setTimeout(r, cooldown));

        // Create new browser with new proxy
        await this.createBrowserInstance(browserId);
    }

    getBrowser(browserId: number): BrowserInstance | null {
        return this.browsers[browserId] || null;
    }

    getPage(browserId: number, tabId: number): Page | null {
        const browser = this.browsers[browserId];
        if (!browser || !browser.isActive) return null;
        return browser.pages[tabId] || null;
    }

    getAllActivePages(): { browserId: number; tabId: number; page: Page }[] {
        const pages: { browserId: number; tabId: number; page: Page }[] = [];

        for (const browser of this.browsers) {
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
        const browser = this.browsers[browserId];
        if (browser) {
            browser.consecutiveFailures++;
            return browser.consecutiveFailures;
        }
        return 0;
    }

    resetFailure(browserId: number): void {
        const browser = this.browsers[browserId];
        if (browser) {
            browser.consecutiveFailures = 0;
        }
    }

    async shutdown(): Promise<void> {
        console.log('🛑 Shutting down Browser Pool...');

        for (const browser of this.browsers) {
            if (browser && browser.browser) {
                try {
                    await browser.browser.close();
                } catch (e) { }
            }
        }

        await this.proxyManager.shutdown();
        this.browsers = [];
        this.isInitialized = false;

        console.log('✅ Browser Pool shutdown complete');
    }

    getStats(): { active: number; total: number; proxied: number } {
        const active = this.browsers.filter(b => b && b.isActive).length;
        const proxied = this.browsers.filter(b => b && b.isActive && b.proxy).length;

        return {
            active,
            total: this.config.browserCount,
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

// Factory function
export function createBrowserPool(config?: Partial<BrowserPoolConfig>): BrowserPool {
    return new BrowserPool(config);
}
