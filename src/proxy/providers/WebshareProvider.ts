import https from 'https';
import http from 'http';
import { BaseRotatingProxyProvider } from './BaseProvider';
import { RawProxy, WebshareConfig, ProviderStats } from '../types';

interface WebshareProxyResponse {
    count: number;
    next: string | null;
    previous: string | null;
    results: Array<{
        id: string;
        username: string;
        password: string;
        proxy_address: string;
        port: number;
        valid: boolean;
        last_verification: string;
        country_code: string;
        city_name?: string;
        created_at: string;
    }>;
}

/**
 * Webshare rotating proxy provider
 * Docs: https://proxy.webshare.io/api/v2/docs/
 */
export class WebshareProvider extends BaseRotatingProxyProvider {
    protected declare config: WebshareConfig;
    private proxyCache: RawProxy[] = [];
    private currentIndex: number = 0;
    private refreshTimer?: NodeJS.Timeout;
    private stats = {
        totalFetched: 0,
        activeFetched: 0,
        requestCount: 0,
        successCount: 0,
        failCount: 0
    };

    constructor(name: string = 'webshare') {
        super(name);
    }

    async initialize(config: WebshareConfig): Promise<void> {
        if (!config.apiKey) {
            throw new Error('Webshare API key is required');
        }

        this.config = {
            apiUrl: config.apiUrl || 'https://proxy.webshare.io/api/v2/',
            mode: config.mode || 'list',
            protocol: config.protocol || 'http',
            autoRefresh: config.autoRefresh !== false,
            refreshInterval: config.refreshInterval || 3600, // 1 hour default
            ...config
        };

        console.log(`[${this.name}] Initializing Webshare provider (mode: ${this.config.mode})...`);

        // Fetch initial proxy list
        await this.fetchProxyList();

        // Setup auto-refresh if enabled
        if (this.config.autoRefresh && this.config.mode === 'list') {
            const intervalMs = this.config.refreshInterval! * 1000;
            this.refreshTimer = setInterval(() => {
                this.fetchProxyList().catch(e =>
                    this.setError(`Auto-refresh failed: ${e.message}`)
                );
            }, intervalMs);
            console.log(`[${this.name}] Auto-refresh enabled (every ${this.config.refreshInterval}s)`);
        }

        this.isInitialized = true;
        this.clearError();
        console.log(`[${this.name}] Initialized with ${this.proxyCache.length} proxies`);
    }

    async getProxy(): Promise<RawProxy | null> {
        if (!this.isInitialized) {
            throw new Error('Provider not initialized');
        }

        this.stats.requestCount++;

        // Mode: rotating - use rotating endpoint (single endpoint that rotates)
        if (this.config.mode === 'rotating') {
            return this.getRotatingProxy();
        }

        // Mode: list - rotate through cached list
        if (this.proxyCache.length === 0) {
            this.setError('No proxies available in cache');
            return null;
        }

        const proxy = this.proxyCache[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.proxyCache.length;

        this.stats.successCount++;
        return { ...proxy }; // Return a copy
    }

    async releaseProxy(proxy: RawProxy): Promise<void> {
        // No-op for Webshare
    }

    async markProxyBad(proxy: RawProxy): Promise<void> {
        this.stats.failCount++;
        // Could implement filtering here if needed
    }

    async refresh(): Promise<void> {
        await this.fetchProxyList();
    }

    async healthCheck(): Promise<boolean> {
        try {
            // Simple health check - try to fetch proxy list
            const url = `${this.config.apiUrl}proxy/list/?mode=direct&page=1&page_size=1`;
            const data = await this.fetchWebshareAPI(url);
            return data && typeof data === 'object';
        } catch (e: any) {
            this.setError(`Health check failed: ${e.message}`);
            return false;
        }
    }

    async getStats(): Promise<ProviderStats> {
        const successRate = this.stats.requestCount > 0
            ? this.stats.successCount / this.stats.requestCount
            : 0;

        return {
            name: this.name,
            type: 'webshare',
            status: this.isInitialized && !this.errorMessage ? 'active' :
                this.errorMessage ? 'error' : 'inactive',
            totalProxies: this.stats.totalFetched,
            activeProxies: this.proxyCache.length,
            avgLatency: 0, // Not tracked by provider
            successRate,
            lastRefresh: this.lastRefresh,
            error: this.errorMessage
        };
    }

    async shutdown(): Promise<void> {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
        this.proxyCache = [];
        await super.shutdown();
        console.log(`[${this.name}] Shutdown complete`);
    }

    /**
     * Fetch proxy list from Webshare API
     */
    private async fetchProxyList(): Promise<void> {
        try {
            console.log(`[${this.name}] Fetching proxy list...`);

            const proxies: RawProxy[] = [];
            let page = 1;
            let hasMore = true;

            // Fetch all pages
            while (hasMore) {
                let url = `${this.config.apiUrl}proxy/list/?mode=direct&page=${page}&page_size=100`;

                if (this.config.country) {
                    url += `&country_code=${this.config.country.toUpperCase()}`;
                }

                const data: WebshareProxyResponse = await this.fetchWebshareAPI(url);

                // Convert to RawProxy format
                for (const item of data.results) {
                    if (!item.valid) continue; // Skip invalid proxies

                    proxies.push({
                        host: item.proxy_address,
                        port: item.port,
                        protocol: this.config.protocol || 'http',
                        source: this.name,
                        username: item.username,
                        password: item.password,
                        country: item.country_code,
                        isRotating: true,
                        rotatingConfig: {
                            providerId: this.name,
                            providerType: 'webshare'
                        }
                    });
                }

                hasMore = data.next !== null;
                page++;

                // Safety limit
                if (page > 100) {
                    console.warn(`[${this.name}] Reached page limit (100), stopping fetch`);
                    break;
                }
            }

            this.proxyCache = proxies;
            this.stats.totalFetched = proxies.length;
            this.stats.activeFetched = proxies.length;
            this.lastRefresh = new Date();
            this.clearError();

            console.log(`[${this.name}] Fetched ${proxies.length} proxies`);
        } catch (e: any) {
            this.setError(`Failed to fetch proxy list: ${e.message}`);
            throw e;
        }
    }

    /**
     * Get rotating proxy (single endpoint mode)
     */
    private getRotatingProxy(): RawProxy {
        // For rotating mode, Webshare provides a single endpoint that automatically rotates
        // We return the same proxy config, and Webshare handles rotation server-side
        const proxy: RawProxy = {
            host: 'proxy.webshare.io',
            port: this.config.protocol === 'socks5' ? 1080 : 80,
            protocol: this.config.protocol || 'http',
            source: this.name,
            username: this.config.apiKey, // In rotating mode, API key is username
            password: '', // No password needed
            isRotating: true,
            rotatingConfig: {
                providerId: this.name,
                providerType: 'webshare'
            }
        };

        this.stats.successCount++;
        return proxy;
    }

    /**
     * Fetch data from Webshare API
     */
    private fetchWebshareAPI(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                headers: {
                    'Authorization': `Token ${this.config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            };

            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`API returned ${res.statusCode}: ${data}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e: any) {
                        reject(new Error(`Failed to parse response: ${e.message}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }
}
