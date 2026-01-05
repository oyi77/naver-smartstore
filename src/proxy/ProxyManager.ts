import http from 'http';
import https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { RawProxy, ValidatedProxy, ProxyTestResult } from './types';

const PROXY_SOURCES = {
    proxifly: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/all/data.txt',
    monosans: 'https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/all.txt'
};

// Use ip-api.com with full fields to detect datacenter/hosting
const PROXY_TEST_URL = 'http://ip-api.com/json?fields=status,message,country,isp,org,hosting,proxy,query';
const NAVER_TEST_URL = 'https://smartstore.naver.com/';
const PROXY_TEST_TIMEOUT = 5000; // 5 seconds (Aggressive timeout)
const MAX_LATENCY = 2500; // 2.5 seconds max acceptable latency
const MIN_POOL_SIZE = 5; // Need fewer but higher quality proxies
const REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

// Persistence
const DATA_DIR = path.join(process.cwd(), 'data');
const PROXY_FILE = path.join(DATA_DIR, 'proxy.json');

export class ProxyManager {
    private proxyPool: ValidatedProxy[] = [];
    private allValidatedProxies: ValidatedProxy[] = []; // All validated, including non-Naver
    private badProxies: Set<string> = new Set();
    private isRunning: boolean = false;

    async initialize(): Promise<void> {
        console.log('🔄 Initializing Proxy Manager...');

        // 1. Load cached proxies from file to start immediately
        const cached = this.loadProxiesFromFile();
        if (cached.length > 0) {
            this.allValidatedProxies = cached;
            this.rebuildPoolFromAll();
            console.log(`📂 Loaded ${cached.length} cached proxies (${this.proxyPool.length} Naver-ready)`);
        }

        // 2. Start the continuous loop
        this.isRunning = true;
        this.startLoop().catch(console.error);

        const residentialCount = this.proxyPool.filter(p => p.ipType === 'residential').length;
        const naverAccessCount = this.proxyPool.filter(p => p.canAccessNaver).length;
        console.log(`✅ Proxy Manager initialized (Continuous background optimization started)`);
        console.log(`   Total: ${this.proxyPool.length} | Residential: ${residentialCount} | Naver-ready: ${naverAccessCount}`);
    }

    private async startLoop() {
        while (this.isRunning) {
            try {
                await this.runValidationCycle();
            } catch (error) {
                console.error('❌ Error in Proxy Manager loop:', error);
            }
            // Wait a bit before next cycle to prevent CPU thrashing, but keep it active
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    private async runValidationCycle(): Promise<void> {
        console.log('🔄 Starting Proxy Validation Cycle...');

        // 1. Fetch New Proxies
        const rawProxies = await this.fetchAllProxies();

        // 2. Aggregate: Mix with existing known proxies (to re-validate them)
        // Convert existing ValidatedProxy back to RawProxy structure for re-validation candidacy
        const existingAsRaw: RawProxy[] = this.allValidatedProxies.map(p => ({
            host: p.host,
            port: p.port,
            protocol: p.protocol,
            source: p.source,
            username: p.username,
            password: p.password
        }));

        const combinedMap = new Map<string, RawProxy>();

        // Add existing first
        for (const p of existingAsRaw) {
            combinedMap.set(this.getProxyKey(p), p);
        }
        // Add/Overwrite with new (though keys are same, new might have fresher source info if changed? unlikely for basic fields)
        for (const p of rawProxies) {
            if (!this.badProxies.has(this.getProxyKey(p))) {
                combinedMap.set(this.getProxyKey(p), p);
            }
        }

        const candidates = Array.from(combinedMap.values());
        console.log(`🔍 Validating ${candidates.length} unique proxies (New + Existing)...`);

        // 3. Validate & Test
        const validated: ValidatedProxy[] = [];
        const batchSize = 200; // Increased to 200 for faster processing

        for (let i = 0; i < candidates.length; i += batchSize) {
            if (!this.isRunning) break;

            const batch = candidates.slice(i, i + batchSize);
            const results = await Promise.allSettled(batch.map(p => this.validateProxy(p)));

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    validated.push(result.value);
                }
            }

            // Incremental save/update could go here if list is huge, 
            // but for <1000 proxies, doing it at end of cycle is cleaner for sorting.
        }

        // 4. Sort & Update
        this.allValidatedProxies = validated;
        this.saveProxiesToFile();
        this.rebuildPoolFromAll(); // This sorts by latency

        console.log(`✅ Cycle Complete. Pool Size: ${this.proxyPool.length} Naver-ready proxies.`);
    }

    private rebuildPoolFromAll() {
        // Rebuild existing pool map
        const existingMap = new Map(this.allValidatedProxies.map(p => [this.getProxyKey(p), p]));

        // Sort: Naver-accessible residential first, then by latency
        this.proxyPool = Array.from(existingMap.values())
            .filter(p => p.isActive && p.canAccessNaver)
            .sort((a, b) => {
                if (a.ipType === 'residential' && b.ipType !== 'residential') return -1;
                if (b.ipType === 'residential' && a.ipType !== 'residential') return 1;
                return a.latency - b.latency;
            });
    }

    async shutdown(): Promise<void> {
        this.isRunning = false;
    }

    private async fetchAllProxies(): Promise<RawProxy[]> {
        const allProxies: RawProxy[] = [];

        // 1. Check process.env.PROXY_LIST first
        const envProxyList = process.env.PROXY_LIST;
        if (envProxyList) {
            console.log(`[ProxyManager] 🚀 PROXY_LIST detected in environment. Using provided proxies...`);
            const items = envProxyList.split(',').map(s => s.trim()).filter(s => s.length > 0);

            for (const item of items) {
                // Handle "protocol://user:pass@host:port" or "host:port"
                try {
                    let proxy: RawProxy | null = null;

                    // Simple parsing logic
                    if (item.includes('://')) {
                        const url = new URL(item);
                        proxy = {
                            host: url.hostname,
                            port: parseInt(url.port),
                            protocol: (url.protocol.replace(':', '') as any),
                            source: 'env',
                            username: url.username,
                            password: url.password
                        };
                    } else {
                        const parts = item.split(':');
                        if (parts.length >= 2) {
                            proxy = {
                                host: parts[0],
                                port: parseInt(parts[1]),
                                protocol: 'http',
                                source: 'env'
                            };
                        }
                    }

                    if (proxy) {
                        allProxies.push(proxy);
                        console.log(`   + Added Env Proxy: ${proxy.host}:${proxy.port}`);
                    }
                } catch (e) {
                    console.warn(`   ⚠️ Failed to parse env proxy: ${item}`);
                }
            }

        }

        for (const [source, url] of Object.entries(PROXY_SOURCES)) {
            try {
                console.log(`🌐 Fetching proxies from ${source}...`);
                const data = await this.fetchUrl(url);
                var lines: string[] | any[] = [];
                if (url.endsWith('.txt')) {
                    lines = data.split('\n').filter(l => l.trim());
                } else if (url.endsWith('.json')) {
                    lines = JSON.parse(data);
                }

                for (const line of lines) {
                    if (typeof line === 'string') {
                        const cleanLine = line.trim();
                        if (!cleanLine) continue;

                        // Support both protocol://host:port and bare host:port
                        const protocolMatch = cleanLine.match(/^(https?|socks[45]?):\/\/([^:]+):(\d+)/i);
                        const bareMatch = cleanLine.match(/^([^:]+):(\d+)$/);

                        if (protocolMatch) {
                            allProxies.push({
                                host: protocolMatch[2],
                                port: parseInt(protocolMatch[3]),
                                protocol: protocolMatch[1].toLowerCase() as any,
                                source: source
                            });
                        } else if (bareMatch) {
                            allProxies.push({
                                host: bareMatch[1],
                                port: parseInt(bareMatch[2]),
                                protocol: 'http', // Default to http for bare host:port
                                source: source
                            });
                        }
                    }
                    else if (typeof line === 'object') {
                        allProxies.push({
                            host: line.ip,
                            port: line.port,
                            protocol: line.protocol,
                            source: source
                        });
                    }
                }
                console.log(`   ${source}: ${lines.length} proxies`);
            } catch (e) {
                console.warn(`⚠️ Failed to fetch from ${source}:`, e);
            }
        }

        return allProxies;
    }

    private fetchUrl(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.get(url, { timeout: 15000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
    }

    private async validateProxy(proxy: RawProxy): Promise<ValidatedProxy | null> {
        // Step 1: Basic connectivity + IP info
        const ipResult = await this.testProxyIP(proxy);
        if (!ipResult.success || ipResult.latency > MAX_LATENCY) {
            return null;
        }

        // Step 2: Test Naver access
        const naverResult = await this.testNaverAccess(proxy);

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
                headers: headers
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const latency = Date.now() - startTime;
                    try {
                        const json = JSON.parse(data);
                        if (json.status === 'success') {
                            // Determine IP type based on hosting/proxy flags
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
                'User-Agent': 'Mozilla/5.0'
            };

            if (proxy.username && proxy.password) {
                const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
                headers['Proxy-Authorization'] = `Basic ${auth}`;
            }

            // Use CONNECT method for HTTPS through HTTP proxy
            const connectReq = http.request({
                hostname: proxy.host,
                port: proxy.port,
                method: 'CONNECT',
                path: 'smartstore.naver.com:443',
                timeout: PROXY_TEST_TIMEOUT,
                headers: headers
            });

            connectReq.on('connect', (res, socket) => {
                if (res.statusCode === 200) {
                    // Tunnel established, test HTTPS
                    const tlsOptions = {
                        socket: socket,
                        servername: 'smartstore.naver.com',
                        rejectUnauthorized: false
                    };

                    const tls = require('tls');
                    const tlsSocket = tls.connect(tlsOptions, () => {
                        const httpReq = `GET / HTTP/1.1\r\nHost: smartstore.naver.com\r\nConnection: close\r\n\r\n`;
                        tlsSocket.write(httpReq);
                    });

                    let responseData = '';
                    tlsSocket.on('data', (chunk: Buffer) => {
                        responseData += chunk.toString();
                    });

                    tlsSocket.on('end', () => {
                        // Check if we got a valid response (not blocked)
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

    getProxy(): ValidatedProxy | null {
        // Return the best available proxy (Naver-accessible, preferring residential)
        const available = this.proxyPool.filter(p => p.isActive && p.canAccessNaver);
        if (available.length === 0) return null;

        // Rotate: move the first proxy to the end
        const proxy = available[0];
        const index = this.proxyPool.indexOf(proxy);
        if (index > -1) {
            this.proxyPool.splice(index, 1);
            this.proxyPool.push(proxy);
        }

        return proxy;
    }

    releaseProxy(proxy: ValidatedProxy): void {
        proxy.successCount++;
        proxy.isActive = true;
    }

    markProxyBad(proxy: ValidatedProxy): void {
        proxy.failCount++;

        if (proxy.failCount >= 3) {
            proxy.isActive = false;
            this.badProxies.add(this.getProxyKey(proxy));
            console.log(`🚫 Proxy marked as bad: ${proxy.host}:${proxy.port}`);
        }
    }

    getPoolSize(): number {
        return this.proxyPool.filter(p => p.isActive && p.canAccessNaver).length;
    }

    private getProxyKey(proxy: RawProxy): string {
        return `${proxy.host}:${proxy.port}`;
    }

    private saveProxiesToFile(): void {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }

            const data = {
                lastUpdated: new Date().toISOString(),
                totalCount: this.allValidatedProxies.length,
                naverReadyCount: this.allValidatedProxies.filter(p => p.canAccessNaver).length,
                residentialCount: this.allValidatedProxies.filter(p => p.ipType === 'residential').length,
                proxies: this.allValidatedProxies.map(p => ({
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
                    lastValidated: p.lastValidated
                }))
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
                console.log(`📂 Loaded ${data.proxies?.length || 0} proxies from ${PROXY_FILE}`);
                return (data.proxies || []).map((p: any) => ({
                    ...p,
                    isActive: true, // Reset status on reload
                    failCount: 0,
                    successCount: 0
                }));
            }
        } catch (e) {
            console.warn('⚠️ Failed to load proxies from file:', e);
        }
        return [];
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
