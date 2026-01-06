import http from 'http';
import https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import {
    RawProxy, ValidatedProxy, ProxyTestResult, ProxyMetrics,
    RotationStrategy, ProxyPoolConfig, ProviderStats, ProxyFormat
} from './types';
import { ProxyParser } from './ProxyParser';
import { BaseRotatingProxyProvider, ProviderFactory } from './providers';

// Default configuration
const DEFAULT_CONFIG: ProxyPoolConfig = {
    maxSize: parseInt(process.env.PROXY_POOL_MAX_SIZE || '10000'),
    minSize: parseInt(process.env.PROXY_MIN_POOL_SIZE || '5'),
    validationInterval: parseInt(process.env.PROXY_VALIDATION_INTERVAL || '1800') * 1000, // 30 min default
    revalidationThreshold: 60 * 60 * 1000, // 1 hour
    batchSize: 200,
    rotationStrategy: (process.env.PROXY_ROTATION_STRATEGY as RotationStrategy) || RotationStrategy.LATENCY_BASED
};

// Test configuration
const PROXY_TEST_URL = 'http://ip-api.com/json?fields=status,message,country,isp,org,hosting,proxy,query';
const NAVER_TEST_URL = 'https://smartstore.naver.com/';
const PROXY_TEST_TIMEOUT = 5000;
const MAX_LATENCY = 2500;

// Persistence
const DATA_DIR = path.join(process.cwd(), 'data');
const PROXY_FILE = path.join(DATA_DIR, 'proxy.json');
const PROXY_WHITELIST_FILE = path.join(DATA_DIR, 'proxy_whitelist.json');
const PROXY_SOURCES_FILE = path.join(DATA_DIR, 'proxy_sources.json');
const DEFAULT_SOURCES_FILE = path.join(DATA_DIR, 'default_proxy_sources.json');
const PROVIDERS_CONFIG_FILE = path.join(DATA_DIR, 'proxy_providers.json');

export class ProxyManager {
    private config: ProxyPoolConfig;
    private proxyPool: ValidatedProxy[] = [];
    private allValidatedProxies: ValidatedProxy[] = [];
    private badProxies: Set<string> = new Set();
    private workingProxies: Set<string> = new Set();
    private proxySources: Record<string, string> = {};
    private rotatingProviders: Map<string, BaseRotatingProxyProvider> = new Map();
    private isRunning: boolean = false;
    private agentPool: Map<string, http.Agent> = new Map();
    private sessionProxies: Map<string, ValidatedProxy> = new Map(); // For sticky sessions
    private currentRotationIndex: number = 0;
    private lastValidationTime?: Date;
    private validationDuration?: number;

    // Metrics
    private metrics = {
        totalValidated: 0,
        totalFailed: 0,
        avgLatency: 0,
        lastCycleTime: 0
    };

    constructor(config?: Partial<ProxyPoolConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    async initialize(): Promise<void> {
        console.log('🔄 Initializing Enhanced Proxy Manager...');

        // 1. Load sources and whitelist
        this.proxySources = this.loadProxySources();
        this.loadProxyWhitelist();

        // 2. Load rotating providers
        await this.loadRotatingProviders();

        // 3. Load cached proxies from file
        const cached = this.loadProxiesFromFile();
        if (cached.length > 0) {
            this.allValidatedProxies = cached;
            this.rebuildPoolFromAll();
            console.log(`📂 Loaded ${cached.length} cached proxies (${this.proxyPool.length} Naver-ready)`);
        }

        // 4. Start continuous validation loop
        this.isRunning = true;
        this.startLoop().catch(console.error);

        const stats = await this.getMetrics();
        console.log(`✅ Proxy Manager initialized`);
        console.log(`   Naver-ready: ${stats.naverReady} | Rotating Providers: ${stats.rotatingProviders}`);
        console.log(`   Strategy: ${this.config.rotationStrategy}`);
    }

    // ============================================================================
    // Main Validation Loop
    // ============================================================================

    private async startLoop() {
        while (this.isRunning) {
            try {
                await this.runValidationCycle();
            } catch (error) {
                console.error('❌ Error in Proxy Manager loop:', error);
            }
            await new Promise(resolve => setTimeout(resolve, this.config.validationInterval));
        }
    }

    private async runValidationCycle(): Promise<void> {
        const startTime = Date.now();
        console.log('🔄 Starting Proxy Validation Cycle...');

        // 1. Fetch new proxies from all sources
        const rawProxies = await this.fetchAllProxies();

        // 2. Get existing proxies that need revalidation
        const needRevalidation = this.allValidatedProxies.filter(p => {
            if (p.isRotating) return false; // Don't revalidate rotating proxies
            const age = Date.now() - p.lastValidated.getTime();
            return age > this.config.revalidationThreshold;
        });

        console.log(`   Fetched: ${rawProxies.length} new | Revalidating: ${needRevalidation.length} existing`);

        // 3. Combine and deduplicate
        const combinedMap = new Map<string, RawProxy>();

        for (const p of needRevalidation) {
            const raw: RawProxy = {
                host: p.host,
                port: p.port,
                protocol: p.protocol,
                source: p.source,
                username: p.username,
                password: p.password,
                isRotating: p.isRotating,
                rotatingConfig: p.rotatingConfig
            };
            combinedMap.set(this.getProxyKey(p), raw);
        }

        for (const p of rawProxies) {
            if (!this.badProxies.has(this.getProxyKey(p))) {
                combinedMap.set(this.getProxyKey(p), p);
            }
        }

        const candidates = Array.from(combinedMap.values());

        // 4. Validate in batches (with adaptive batch size)
        const validated = await this.validateProxyBatch(candidates);

        // 5. Merge with current proxies (keep rotating proxies and recently validated)
        const stillValid = this.allValidatedProxies.filter(p => {
            if (p.isRotating) return true; // Keep rotating proxies
            const age = Date.now() - p.lastValidated.getTime();
            return age <= this.config.revalidationThreshold;
        });

        this.allValidatedProxies = [...stillValid, ...validated];

        // Apply size limit
        if (this.allValidatedProxies.length > this.config.maxSize) {
            this.allValidatedProxies.sort((a, b) => {
                const scoreA = a.successCount / Math.max(a.failCount + 1, 1);
                const scoreB = b.successCount / Math.max(b.failCount + 1, 1);
                return scoreB - scoreA;
            });
            this.allValidatedProxies = this.allValidatedProxies.slice(0, this.config.maxSize);
        }

        // 6. Save and rebuild pool
        this.saveProxiesToFile();
        this.rebuildPoolFromAll();

        this.lastValidationTime = new Date();
        this.validationDuration = Date.now() - startTime;

        console.log(`✅ Cycle Complete in ${this.validationDuration}ms`);
        console.log(`   Pool Size: ${this.proxyPool.length} Naver-ready proxies`);
    }

    // ============================================================================
    // Proxy Fetching (Multi-Format Support)
    // ============================================================================

    private async fetchAllProxies(): Promise<RawProxy[]> {
        const allProxies: RawProxy[] = [];

        // 1. Check PROXY_LIST environment variable
        const envProxyList = process.env.PROXY_LIST;
        if (envProxyList) {
            console.log(`📥 Processing PROXY_LIST from environment...`);
            const proxies = await this.loadProxiesFromSource(envProxyList, 'env');
            allProxies.push(...proxies);
            console.log(`   ✓ Loaded ${proxies.length} proxies from PROXY_LIST`);
        }

        // 2. Fetch from configured sources (supports URLs with JSON/TXT/CSV)
        for (const [sourceName, sourceUrl] of Object.entries(this.proxySources)) {
            try {
                console.log(`📥 Fetching from ${sourceName}: ${sourceUrl}`);
                const proxies = await this.loadProxiesFromSource(sourceUrl, sourceName);
                allProxies.push(...proxies);
                console.log(`   ✓ ${sourceName}: ${proxies.length} proxies`);
            } catch (e: any) {
                console.warn(`   ⚠️ Failed to fetch from ${sourceName}: ${e.message}`);
            }
        }

        // 3. Get proxies from rotating providers
        // Rotating providers don't need validation cycles - they're on-demand
        for (const [name, provider] of this.rotatingProviders) {
            if (provider.isReady()) {
                console.log(`   ✓ Rotating provider '${name}' active`);
            }
        }

        return allProxies;
    }

    /**
     * Load proxies from a source (URL or local file path or inline string)
     * Supports: JSON, TXT, CSV formats (local or remote)
     */
    private async loadProxiesFromSource(source: string, sourceName: string): Promise<RawProxy[]> {
        try {
            // Check if it's a URL
            if (source.startsWith('http://') || source.startsWith('https://')) {
                const content = await this.fetchUrl(source);
                const result = await ProxyParser.parseString(content, ProxyParser.detectFormat(content, source));

                // Set source name for all proxies
                result.proxies.forEach(p => p.source = sourceName);

                if (result.errors.length > 0) {
                    console.warn(`   ⚠️ ${result.errors.length} parse errors from ${sourceName}`);
                }

                return result.proxies;
            }

            // Check if it's a local file path
            if (source.includes('/') || source.includes('\\') || source.endsWith('.json') ||
                source.endsWith('.txt') || source.endsWith('.csv')) {
                const filePath = path.isAbsolute(source) ? source : path.join(DATA_DIR, source);

                if (fs.existsSync(filePath)) {
                    const result = await ProxyParser.parseFile(filePath);
                    result.proxies.forEach(p => p.source = sourceName);
                    return result.proxies;
                }
            }

            // Try parsing as inline proxy string(s)
            const result = await ProxyParser.parseString(source);
            result.proxies.forEach(p => p.source = sourceName);
            return result.proxies;

        } catch (e: any) {
            console.error(`Failed to load proxies from ${sourceName}: ${e.message}`);
            return [];
        }
    }

    private fetchUrl(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, { timeout: 15000 }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    // ============================================================================
    // Proxy Validation (Optimized)
    // ============================================================================

    private async validateProxyBatch(proxies: RawProxy[]): Promise<ValidatedProxy[]> {
        const validated: ValidatedProxy[] = [];
        const batchSize = this.config.batchSize;

        for (let i = 0; i < proxies.length; i += batchSize) {
            if (!this.isRunning) break;

            const batch = proxies.slice(i, i + batchSize);
            const results = await Promise.allSettled(batch.map(p => this.validateProxy(p)));

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    validated.push(result.value);
                    this.metrics.totalValidated++;
                } else {
                    this.metrics.totalFailed++;
                }
            }

            // Progress indicator for large batches
            if (proxies.length > 500 && (i + batchSize) % 500 === 0) {
                console.log(`   Progress: ${Math.min(i + batchSize, proxies.length)}/${proxies.length} validated`);
            }
        }

        return validated;
    }

    private async validateProxy(proxy: RawProxy): Promise<ValidatedProxy | null> {
        // Skip validation for rotating proxies from providers
        if (proxy.isRotating) {
            return {
                ...proxy,
                latency: 0,
                lastValidated: new Date(),
                successCount: 0,
                failCount: 0,
                isActive: true,
                ipType: 'unknown',
                canAccessNaver: true // Assume rotating proxies work
            };
        }

        // Test IP info and Naver access in parallel
        const [ipResult, naverResult] = await Promise.all([
            this.testProxyIP(proxy),
            this.testNaverAccess(proxy)
        ]);

        if (!ipResult.success || ipResult.latency > MAX_LATENCY) {
            return null;
        }

        return {
            ...proxy,
            latency: ipResult.latency,
            lastValidated: new Date(),
            successCount: 1,
            failCount: 0,
            isActive: true,
            ipType: ipResult.ipType || 'unknown',
            canAccessNaver: naverResult.success,
            isp: ipResult.isp,
            org: ipResult.org
        };
    }

    private testProxyIP(proxy: RawProxy): Promise<ProxyTestResult> {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const headers: any = {
                'Host': 'ip-api.com',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
            };

            if (proxy.username && proxy.password) {
                const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
                headers['Proxy-Authorization'] = `Basic ${auth}`;
            }

            const options = {
                hostname: proxy.host,
                port: proxy.port,
                path: PROXY_TEST_URL,
                method: 'GET',
                timeout: PROXY_TEST_TIMEOUT,
                headers,
                agent: this.getAgent(proxy)
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const latency = Date.now() - startTime;
                    try {
                        const json = JSON.parse(data);
                        if (json.status === 'success') {
                            const isDatacenter = json.hosting === true || json.proxy === true;
                            const ipType: 'residential' | 'datacenter' | 'unknown' =
                                isDatacenter ? 'datacenter' : 'residential';

                            resolve({
                                success: true,
                                latency,
                                ipType,
                                isp: json.isp,
                                org: json.org
                            });
                        } else {
                            resolve({ success: false, latency, error: json.message || 'API error' });
                        }
                    } catch {
                        resolve({ success: res.statusCode === 200, latency, ipType: 'unknown' });
                    }
                });
            });

            req.on('error', (e) => {
                resolve({ success: false, latency: Date.now() - startTime, error: e.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, latency: PROXY_TEST_TIMEOUT, error: 'Timeout' });
            });

            req.end();
        });
    }

    private testNaverAccess(proxy: RawProxy): Promise<{ success: boolean; error?: string }> {
        return new Promise((resolve) => {
            const headers: any = {
                'Host': 'smartstore.naver.com:443',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            };

            if (proxy.username && proxy.password) {
                const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
                headers['Proxy-Authorization'] = `Basic ${auth}`;
            }

            const connectReq = http.request({
                hostname: proxy.host,
                port: proxy.port,
                method: 'CONNECT',
                path: 'smartstore.naver.com:443',
                timeout: PROXY_TEST_TIMEOUT,
                headers
            });

            connectReq.on('connect', (res, socket) => {
                if (res.statusCode === 200) {
                    const tls = require('tls');
                    const tlsSocket = tls.connect({
                        socket: socket,
                        servername: 'smartstore.naver.com',
                        rejectUnauthorized: false
                    }, () => {
                        const httpReq = `GET / HTTP/1.1\r\nHost: smartstore.naver.com\r\nConnection: close\r\n\r\n`;
                        tlsSocket.write(httpReq);
                    });

                    let responseData = '';
                    tlsSocket.on('data', (chunk: Buffer) => {
                        responseData += chunk.toString();
                    });

                    tlsSocket.on('end', () => {
                        const isSuccess = responseData.includes('200 OK') ||
                            responseData.includes('<!DOCTYPE') ||
                            responseData.includes('smartstore');
                        resolve({ success: isSuccess });
                        tlsSocket.destroy();
                    });

                    tlsSocket.on('error', (e: Error) => {
                        resolve({ success: false, error: e.message });
                        tlsSocket.destroy();
                    });

                    tlsSocket.setTimeout(PROXY_TEST_TIMEOUT, () => {
                        resolve({ success: false, error: 'TLS Timeout' });
                        tlsSocket.destroy();
                    });
                } else {
                    resolve({ success: false, error: `CONNECT failed: ${res.statusCode}` });
                    socket.destroy();
                }
            });

            connectReq.on('error', (e) => {
                resolve({ success: false, error: e.message });
            });

            connectReq.on('timeout', () => {
                connectReq.destroy();
                resolve({ success: false, error: 'Timeout' });
            });

            connectReq.end();
        });
    }

    // ============================================================================
    // Connection Pooling
    // ============================================================================

    private getAgent(proxy: RawProxy): http.Agent {
        const key = `${proxy.host}:${proxy.port}`;
        if (!this.agentPool.has(key)) {
            this.agentPool.set(key, new http.Agent({
                keepAlive: true,
                maxSockets: 10,
                timeout: PROXY_TEST_TIMEOUT
            }));
        }
        return this.agentPool.get(key)!;
    }

    // ============================================================================
    // Proxy Retrieval (With Rotation Strategies)
    // ============================================================================

    async getProxy(strategy?: RotationStrategy, protocol?: string, sessionId?: string): Promise<ValidatedProxy | null> {
        // 1. Check sticky session first
        if (sessionId && this.sessionProxies.has(sessionId)) {
            const proxy = this.sessionProxies.get(sessionId)!;
            if (proxy.isActive) return proxy;
        }

        // 2. Try getting from rotating providers first (highest priority)
        if (this.rotatingProviders.size > 0) {
            for (const provider of this.rotatingProviders.values()) {
                try {
                    const rawProxy = await provider.getProxy();
                    if (rawProxy) {
                        const validated: ValidatedProxy = {
                            ...rawProxy,
                            latency: 0,
                            lastValidated: new Date(),
                            successCount: 0,
                            failCount: 0,
                            isActive: true,
                            ipType: 'unknown',
                            canAccessNaver: true
                        };

                        if (sessionId) {
                            this.sessionProxies.set(sessionId, validated);
                        }

                        return validated;
                    }
                } catch (e: any) {
                    console.warn(`Failed to get proxy from provider: ${e.message}`);
                }
            }
        }

        // 3. Fall back to validated proxy pool
        const pool = this.getFilteredPool(protocol);
        if (pool.length === 0) return null;

        const effectiveStrategy = strategy || this.config.rotationStrategy;
        let proxy: ValidatedProxy | null = null;

        switch (effectiveStrategy) {
            case RotationStrategy.ROUND_ROBIN:
                // Sort by lastUsed to pick the least recently used
                pool.sort((a, b) => (a.lastUsed?.getTime() || 0) - (b.lastUsed?.getTime() || 0));
                proxy = pool[0];
                break;

            case RotationStrategy.LATENCY_BASED:
                // Already sorted by priority in rebuildPool, but we add jitter to Top 3 to avoid stickiness
                const candidates = pool.slice(0, 5);
                // Within top 5, pick the one least recently used
                candidates.sort((a, b) => (a.lastUsed?.getTime() || 0) - (b.lastUsed?.getTime() || 0));
                proxy = candidates[0];
                break;

            case RotationStrategy.WEIGHTED:
                proxy = this.getWeightedProxy(pool);
                break;

            case RotationStrategy.RANDOM:
                proxy = pool[Math.floor(Math.random() * pool.length)];
                break;

            case RotationStrategy.STICKY_SESSION:
                if (!sessionId) {
                    proxy = pool[0];
                } else {
                    proxy = pool[0];
                    this.sessionProxies.set(sessionId, proxy);
                }
                break;

            default:
                proxy = pool[0];
        }

        if (proxy) {
            proxy.lastUsed = new Date();
        }

        return proxy ? { ...proxy } : null;
    }

    private getFilteredPool(protocol?: string): ValidatedProxy[] {
        const now = Date.now();
        let pool = this.proxyPool.filter(p => {
            // Must be active and Naver-ready
            if (!p.isActive || !p.canAccessNaver) return false;

            // Filter out penalized proxies (temporary cool-off)
            if (p.penaltyUntil && p.penaltyUntil.getTime() > now) return false;

            return true;
        });

        if (protocol) {
            pool = pool.filter(p => p.protocol === protocol);
        }

        return pool;
    }

    private getWeightedProxy(pool: ValidatedProxy[]): ValidatedProxy {
        const weights = pool.map(p => {
            const successRate = p.successCount / Math.max(p.successCount + p.failCount, 1);
            const latencyScore = 1 - (p.latency / MAX_LATENCY);
            return successRate * 0.7 + latencyScore * 0.3;
        });

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        let random = Math.random() * totalWeight;

        for (let i = 0; i < pool.length; i++) {
            random -= weights[i];
            if (random <= 0) return pool[i];
        }

        return pool[0];
    }

    getProxyForSession(sessionId: string): ValidatedProxy | null {
        return this.sessionProxies.get(sessionId) || null;
    }

    releaseProxy(proxy: ValidatedProxy): void {
        proxy.successCount++;
        proxy.isActive = true;
    }

    markProxyBad(proxy: ValidatedProxy): void {
        proxy.failCount++;

        // 5-minute PENALTY for ANY failure
        const penaltyMinutes = proxy.failCount >= 3 ? 60 : 5; // 1 hour if confirmed bad, 5 mins if just a blip
        proxy.penaltyUntil = new Date(Date.now() + (penaltyMinutes * 60 * 1000));

        if (proxy.failCount >= 3) {
            proxy.isActive = false;
            const key = this.getProxyKey(proxy);
            this.badProxies.add(key);

            // Remove from whitelist if it was there
            if (this.workingProxies.has(key)) {
                this.workingProxies.delete(key);
                this.saveProxyWhitelist();
                console.log(`🚫 Proxy marked as bad & removed from whitelist: ${proxy.host}:${proxy.port}`);
            } else {
                console.log(`🚫 Proxy marked as bad: ${proxy.host}:${proxy.port}`);
            }
        } else {
            console.log(`⚠️ Proxy penalized for ${penaltyMinutes} mins after failure: ${proxy.host}:${proxy.port} (Fail count: ${proxy.failCount})`);
        }
    }

    markProxyAsWorking(proxy: ValidatedProxy): void {
        const key = this.getProxyKey(proxy);
        if (!this.workingProxies.has(key)) {
            this.workingProxies.add(key);
            this.saveProxyWhitelist();
            console.log(`✅ Marked proxy as working: ${key}`);
        }
    }

    isProxyWorking(proxy: ValidatedProxy): boolean {
        return this.workingProxies.has(this.getProxyKey(proxy));
    }

    // ============================================================================
    // Rotating Provider Management
    // ============================================================================

    async addRotatingProvider(name: string, type: string, config: any): Promise<void> {
        try {
            const provider = ProviderFactory.createProvider(type, name);
            await provider.initialize(config);
            this.rotatingProviders.set(name, provider);
            this.saveProvidersConfig();
            console.log(`✅ Added rotating provider: ${name} (${type})`);
        } catch (e: any) {
            console.error(`Failed to add provider ${name}: ${e.message}`);
            throw e;
        }
    }

    async removeRotatingProvider(name: string): Promise<boolean> {
        const provider = this.rotatingProviders.get(name);
        if (provider) {
            await provider.shutdown();
            this.rotatingProviders.delete(name);
            this.saveProvidersConfig();
            console.log(`🗑️ Removed rotating provider: ${name}`);
            return true;
        }
        return false;
    }

    getRotatingProviders(): Map<string, BaseRotatingProxyProvider> {
        return this.rotatingProviders;
    }

    async getProviderStats(): Promise<Map<string, ProviderStats>> {
        const stats = new Map<string, ProviderStats>();

        for (const [name, provider] of this.rotatingProviders) {
            try {
                const providerStats = await provider.getStats();
                stats.set(name, providerStats);
            } catch (e: any) {
                console.error(`Failed to get stats for${name}: ${e.message}`);
            }
        }

        return stats;
    }

    // ============================================================================
    // Pool Management
    // ============================================================================

    private rebuildPoolFromAll() {
        const existingMap = new Map(this.allValidatedProxies.map(p => [this.getProxyKey(p), p]));

        this.proxyPool = Array.from(existingMap.values())
            .filter(p => p.isActive && p.canAccessNaver)
            .sort((a, b) => {
                // Priority: rotating > env > whitelisted > residential > low latency
                if (a.isRotating && !b.isRotating) return -1;
                if (!a.isRotating && b.isRotating) return 1;

                if (a.source === 'env' && b.source !== 'env') return -1;
                if (b.source === 'env' && a.source !== 'env') return 1;

                const aWorking = this.isProxyWorking(a);
                const bWorking = this.isProxyWorking(b);
                if (aWorking && !bWorking) return -1;
                if (!aWorking && bWorking) return 1;

                if (a.ipType === 'residential' && b.ipType !== 'residential') return -1;
                if (b.ipType === 'residential' && a.ipType !== 'residential') return 1;

                return a.latency - b.latency;
            });
    }

    getPoolSize(): number {
        return this.proxyPool.filter(p => p.isActive && p.canAccessNaver).length;
    }

    getAllProxies(): ValidatedProxy[] {
        return this.allValidatedProxies;
    }

    async getMetrics(): Promise<ProxyMetrics> {
        const naverReady = this.proxyPool.filter(p => p.canAccessNaver).length;

        const byProtocol: Record<string, number> = {};
        const byType: Record<string, number> = {};
        const bySource: Record<string, number> = {};

        for (const proxy of this.allValidatedProxies) {
            byProtocol[proxy.protocol] = (byProtocol[proxy.protocol] || 0) + 1;
            byType[proxy.ipType] = (byType[proxy.ipType] || 0) + 1;
            bySource[proxy.source] = (bySource[proxy.source] || 0) + 1;
        }

        const totalLatency = this.proxyPool.reduce((sum, p) => sum + p.latency, 0);
        const avgLatency = this.proxyPool.length > 0 ? totalLatency / this.proxyPool.length : 0;

        const successRate = this.metrics.totalValidated + this.metrics.totalFailed > 0
            ? this.metrics.totalValidated / (this.metrics.totalValidated + this.metrics.totalFailed)
            : 0;

        return {
            totalProxies: this.allValidatedProxies.length,
            naverReady,
            byProtocol,
            byType,
            bySource,
            rotatingProviders: this.rotatingProviders.size,
            avgLatency,
            successRate,
            lastValidation: this.lastValidationTime,
            validationDuration: this.validationDuration
        };
    }

    // ============================================================================
    // Proxy Sources Management
    // ============================================================================

    getProxySources(): Record<string, string> {
        return { ...this.proxySources };
    }

    addProxySource(name: string, url: string): void {
        this.proxySources[name] = url;
        this.saveProxySources();
        console.log(`➕ Added proxy source: ${name}`);
    }

    deleteProxySource(name: string): boolean {
        if (this.proxySources[name]) {
            delete this.proxySources[name];
            this.saveProxySources();
            console.log(`🗑️ Deleted proxy source: ${name}`);
            return true;
        }
        return false;
    }

    addProxyManually(proxy: RawProxy): void {
        this.allValidatedProxies.push({
            ...proxy,
            latency: 0,
            lastValidated: new Date(),
            successCount: 0,
            failCount: 0,
            isActive: true,
            ipType: 'unknown',
            canAccessNaver: false
        });
        console.log(`➕ Added manual proxy: ${proxy.host}:${proxy.port}`);
    }

    // ============================================================================
    // Persistence
    // ============================================================================

    private getProxyKey(proxy: RawProxy): string {
        return `${proxy.host}:${proxy.port}`;
    }

    private saveProxiesToFile(): void {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            const filteredProxies = this.allValidatedProxies
                .filter(p => p.canAccessNaver)
                .map(p => ({
                    host: p.host,
                    port: p.port,
                    protocol: p.protocol,
                    latency: p.latency,
                    ipType: p.ipType,
                    canAccessNaver: p.canAccessNaver,
                    isp: p.isp,
                    org: p.org,
                    country: p.country,
                    source: p.source,
                    lastValidated: p.lastValidated,
                    isRotating: p.isRotating
                }));

            const data = {
                lastUpdated: new Date().toISOString(),
                totalCount: filteredProxies.length,
                naverReadyCount: filteredProxies.length,
                residentialCount: filteredProxies.filter(p => p.ipType === 'residential').length,
                proxies: filteredProxies
            };

            fs.writeFileSync(PROXY_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            console.warn('⚠️ Failed to save proxies to file:', e);
        }
    }

    loadProxiesFromFile(): ValidatedProxy[] {
        try {
            if (fs.existsSync(PROXY_FILE)) {
                const data = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf-8'));
                return (data.proxies || []).map((p: any) => ({
                    ...p,
                    lastValidated: new Date(p.lastValidated),
                    isActive: true,
                    failCount: 0,
                    successCount: 0
                }));
            }
        } catch (e) {
            console.warn('⚠️ Failed to load proxies from file:', e);
        }
        return [];
    }

    private loadProxyWhitelist(): void {
        try {
            if (fs.existsSync(PROXY_WHITELIST_FILE)) {
                const data = JSON.parse(fs.readFileSync(PROXY_WHITELIST_FILE, 'utf-8'));
                this.workingProxies = new Set(data.workingProxies || []);
                console.log(`✅ Loaded ${this.workingProxies.size} known-good proxies`);
            }
        } catch (e: any) {
            console.warn(`⚠️ Failed to load proxy whitelist: ${e.message}`);
        }
    }

    private saveProxyWhitelist(): void {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            const data = {
                workingProxies: Array.from(this.workingProxies),
                lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(PROXY_WHITELIST_FILE, JSON.stringify(data, null, 2));
        } catch (e: any) {
            console.error(`❌ Failed to save proxy whitelist: ${e.message}`);
        }
    }

    private loadProxySources(): Record<string, string> {
        try {
            // First, try to load user-configured sources
            if (fs.existsSync(PROXY_SOURCES_FILE)) {
                const data = JSON.parse(fs.readFileSync(PROXY_SOURCES_FILE, 'utf-8'));
                console.log(`📂 Loaded ${Object.keys(data.sources || {}).length} user proxy sources`);
                return data.sources || {};
            }

            // If no user sources, load defaults from config file
            if (fs.existsSync(DEFAULT_SOURCES_FILE)) {
                const data = JSON.parse(fs.readFileSync(DEFAULT_SOURCES_FILE, 'utf-8'));
                const defaultSources = data.defaultSources || {};
                console.log(`📂 Loaded ${Object.keys(defaultSources).length} default proxy sources`);
                return defaultSources;
            }

            console.log(`⚠️ No proxy sources configured`);
            return {};
        } catch (e: any) {
            console.warn(`⚠️ Failed to load proxy sources: ${e.message}`);
            return {};
        }
    }

    private saveProxySources(): void {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            const data = {
                sources: this.proxySources,
                lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(PROXY_SOURCES_FILE, JSON.stringify(data, null, 2));
        } catch (e: any) {
            console.error(`❌ Failed to save proxy sources: ${e.message}`);
        }
    }

    private async loadRotatingProviders(): Promise<void> {
        try {
            // Load from config file
            if (fs.existsSync(PROVIDERS_CONFIG_FILE)) {
                const data = JSON.parse(fs.readFileSync(PROVIDERS_CONFIG_FILE, 'utf-8'));
                for (const [name, config] of Object.entries(data.providers || {})) {
                    const providerConfig = config as any;
                    await this.addRotatingProvider(name, providerConfig.type, providerConfig.config);
                }
            }

            // Load from environment variables
            if (process.env.WEBSHARE_CONFIG) {
                try {
                    const config = JSON.parse(process.env.WEBSHARE_CONFIG);
                    await this.addRotatingProvider('webshare', 'webshare', config);
                } catch (e: any) {
                    console.warn(`Failed to load WEBSHARE_CONFIG: ${e.message}`);
                }
            }

            if (process.env.THORDATA_CONFIG) {
                try {
                    const config = JSON.parse(process.env.THORDATA_CONFIG);
                    await this.addRotatingProvider('thordata', 'thordata', config);
                } catch (e: any) {
                    console.warn(`Failed to load THORDATA_CONFIG: ${e.message}`);
                }
            }
        } catch (e: any) {
            console.warn(`⚠️ Failed to load rotating providers: ${e.message}`);
        }
    }

    private saveProvidersConfig(): void {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            const providers: Record<string, any> = {};
            // Note: We can't serialize provider instances, so this just saves metadata
            // Actual providers are re-initialized on startup from env vars

            const data = {
                providers,
                lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(PROVIDERS_CONFIG_FILE, JSON.stringify(data, null, 2));
        } catch (e: any) {
            console.error(`❌ Failed to save providers config: ${e.message}`);
        }
    }

    async shutdown(): Promise<void> {
        this.isRunning = false;

        // Shutdown all providers
        for (const provider of this.rotatingProviders.values()) {
            await provider.shutdown();
        }

        // Clear agent pool
        for (const agent of this.agentPool.values()) {
            agent.destroy();
        }
        this.agentPool.clear();

        console.log('🛑 Proxy Manager shutdown complete');
    }
}

// Singleton instance
let instance: ProxyManager | null = null;

export function getProxyManager(): ProxyManager {
    if (!instance) {
        instance = new ProxyManager();
    }
    return instance;
}
