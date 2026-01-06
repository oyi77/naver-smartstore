import { BrowserPool } from '../browser/BrowserPool';
import { Page } from 'puppeteer';
import { ScraperWorker } from './ScraperWorker';
import { CacheService } from './CacheService';
import Redis from 'ioredis';
import * as path from 'path';
import * as fs from 'fs';

export type JobType = 'PRODUCT' | 'STORE' | 'CATEGORY';

export interface Job {
    id: string;
    url: string;
    type: JobType;
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
    result?: any;
    error?: string;
    timestamp: number;
    customProxy?: string;
}

export class QueueService {
    private static instance: QueueService;
    private browserPool: BrowserPool;
    private jobs: Map<string, Job> = new Map();
    private queue: string[] = [];
    private processing: Set<string> = new Set();
    private isProcessing: boolean = false;
    private isInitialized: boolean = false;
    private redis: Redis;
    private redisPrefix: string;
    private backupFile = path.resolve(process.cwd(), 'data', 'queue_backup.json');
    private readonly JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours for completed/failed jobs

    private constructor() {
        const useProxyRaw = process.env.USE_PROXY ? process.env.USE_PROXY.trim().toLowerCase() : 'true';
        const minBrowsers = process.env.MIN_BROWSERS ? parseInt(process.env.MIN_BROWSERS) : 1;
        const maxBrowsers = process.env.MAX_BROWSERS ? parseInt(process.env.MAX_BROWSERS) : 3;
        const minTabs = process.env.MIN_TABS ? parseInt(process.env.MIN_TABS) : 1;
        const tabsPerBrowser = process.env.TABS_PER_BROWSER ? parseInt(process.env.TABS_PER_BROWSER) : 2;
        const headless = process.env.HEADLESS === 'true';

        let proxiedCount = maxBrowsers; // Default: all using proxy

        // Logic for USE_PROXY
        if (useProxyRaw === 'true') {
            proxiedCount = maxBrowsers;
        } else if (useProxyRaw === 'false') {
            proxiedCount = 0;
        } else {
            const val = parseInt(useProxyRaw);
            if (!isNaN(val)) {
                if (val >= 0) {
                    // Positive: EXACTLY N browsers use proxy (e.g. 1)
                    proxiedCount = Math.min(val, maxBrowsers);
                } else {
                    // Negative: ALL EXCEPT N use proxy (e.g. -1 => max - 1)
                    proxiedCount = Math.max(0, maxBrowsers + val);
                }
            } else {
                console.warn(`[QueueService] ⚠️ Invalid USE_PROXY value '${useProxyRaw}', defaulting to logical TRUE (all proxies)`);
                proxiedCount = maxBrowsers;
            }
        }

        console.log(`[QueueService] 🔧 Config: MAX_BROWSERS=${maxBrowsers}, TABS=${tabsPerBrowser}, HEADLESS=${headless}`);
        console.log(`[QueueService] 🔧 Proxy Strategy: USE_PROXY='${useProxyRaw}' -> ${proxiedCount}/${maxBrowsers} browsers will be proxied.`);

        this.browserPool = new BrowserPool({
            minBrowsers,
            maxBrowsers,
            minTabs,
            tabsPerBrowser: tabsPerBrowser,
            proxiedCount: proxiedCount,
            headless: headless
        });

        // Initialize Redis
        this.redis = new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD || undefined,
            retryStrategy: (times) => Math.min(times * 50, 2000)
        });
        this.redisPrefix = process.env.REDIS_PREFIX || 'naver_scraper:';

        this.redis.on('error', (err) => {
            console.error(`[Redis] ❌ Connection error: ${err.message}`);
        });
    }

    static getInstance(): QueueService {
        if (!QueueService.instance) {
            QueueService.instance = new QueueService();
        }
        return QueueService.instance;
    }

    async initialize() {
        await this.loadState();
        await this.browserPool.initialize();
        this.isInitialized = true;
        this.processQueue(); // Start processing loop
        
        // Start periodic job cleanup
        setInterval(() => this.cleanupOldJobs(), 60 * 60 * 1000); // Every hour
    }

    /**
     * Cleanup old completed/failed jobs to prevent memory growth
     */
    private cleanupOldJobs() {
        try {
            const cutoff = Date.now() - this.JOB_TTL_MS;
            let cleaned = 0;
            
            for (const [id, job] of Array.from(this.jobs.entries())) {
                // Only cleanup completed or failed jobs that are old
                if ((job.status === 'COMPLETED' || job.status === 'FAILED') && job.timestamp < cutoff) {
                    this.jobs.delete(id);
                    cleaned++;
                }
            }
            
            if (cleaned > 0) {
                console.log(`[Queue] 🧹 Cleaned up ${cleaned} old jobs`);
                this.saveState(); // Persist cleanup
            }
        } catch (e: any) {
            console.error(`[Queue] Cleanup error: ${e.message}`);
        }
    }

    getIsInitialized(): boolean {
        return this.isInitialized;
    }

    /**
     * Normalize URL for consistent caching/lookup
     * - Remove trailing slashes
     * - Remove irrelevant query params (keep only meaningful ones if needed)
     * - Convert to lowercase for hostname
     */
    private normalizeUrl(url: string): string {
        try {
            const urlObj = new URL(url);
            // Normalize pathname (remove trailing slash)
            urlObj.pathname = urlObj.pathname.replace(/\/$/, '');
            // Remove common tracking/irrelevant query params
            const paramsToKeep = ['productId', 'categoryId']; // Add more if needed
            const newParams = new URLSearchParams();
            for (const [key, value] of urlObj.searchParams.entries()) {
                if (paramsToKeep.includes(key)) {
                    newParams.set(key, value);
                }
            }
            urlObj.search = newParams.toString();
            return urlObj.toString();
        } catch (e) {
            // If URL parsing fails, just normalize trailing slash
            return url.replace(/\/$/, '');
        }
    }

    addJob(url: string, type: JobType, options: { customProxy?: string } = {}): Job {
        const normalizedUrl = this.normalizeUrl(url);
        
        // Check if job exists and is valid (not failed/completed long ago)
        const existingJobId = Array.from(this.jobs.keys()).find(id => {
            const job = this.jobs.get(id);
            return job && this.normalizeUrl(job.url) === normalizedUrl;
        });
        if (existingJobId) {
            const job = this.jobs.get(existingJobId)!;
            // If pending or processing, return it
            if (job.status === 'PENDING' || job.status === 'PROCESSING') {
                return job;
            }
            // If completed recently (handled by cache usually, but double check here if needed)
            // For now, if completed/failed, we create a new one to refresh
        }

        const id = Math.random().toString(36).substring(7);
        const job: Job = {
            id,
            url: normalizedUrl, // Store normalized URL
            type,
            status: 'PENDING',
            timestamp: Date.now(),
            customProxy: options.customProxy
        };

        this.jobs.set(id, job);

        if (options.customProxy) {
            console.log(`[Queue] ⚡ Added EPHEMERAL job ${id} for ${url} with proxy ${options.customProxy}`);
            this.runEphemeralJob(job);
        } else {
            this.queue.push(id);
            console.log(`[Queue] ➕ Added job ${id} for ${url} (${type})`);
        }

        // Trigger processing
        if (!options.customProxy) {
            this.saveState();
            this.processQueue();
        }

        return job;
    }

    getJob(id: string): Job | undefined {
        const job = this.jobs.get(id);
        // Always try to refresh from Redis if job is PROCESSING to get latest partial results
        // This ensures we get partial data that was saved via onProgress callback
        if (job && job.status === 'PROCESSING') {
            this.refreshJobFromRedis(id).catch(() => {
                // Silently fail - in-memory is fine
            });
        }
        return job;
    }
    
    private async refreshJobFromRedis(id: string): Promise<void> {
        try {
            const jobJson = await this.redis.hget(`${this.redisPrefix}jobs`, id);
            if (jobJson) {
                const redisJob = JSON.parse(jobJson) as Job;
                const memJob = this.jobs.get(id);
                // Update in-memory job with Redis data if Redis has a result
                // This is critical for partial results sent via onProgress
                if (memJob && redisJob.result) {
                    // Always update if Redis has result (could be partial or full)
                    // Check if Redis result is newer or if in-memory doesn't have result
                    if (!memJob.result || 
                        (redisJob.result as any)._isPartial || 
                        (redisJob.timestamp && memJob.timestamp && redisJob.timestamp > memJob.timestamp)) {
                        memJob.result = redisJob.result;
                        console.log(`[Queue] 🔄 Refreshed job ${id} result from Redis (hasPartial: ${!!(redisJob.result as any)?._isPartial})`);
                    }
                }
            }
        } catch (e: any) {
            // Redis failed, try JSON fallback
            console.warn(`[Queue] ⚠️ Redis error during refresh: ${e.message}. Trying JSON fallback...`);
            try {
                if (fs.existsSync(this.backupFile)) {
                    const data = JSON.parse(fs.readFileSync(this.backupFile, 'utf-8'));
                    if (Array.isArray(data.jobs)) {
                        const jobEntry = data.jobs.find(([jobId]: [string, Job]) => jobId === id);
                        if (jobEntry) {
                            const [, backupJob] = jobEntry as [string, Job];
                            const memJob = this.jobs.get(id);
                            // Update in-memory job with backup data if backup has a result
                            if (memJob && backupJob.result) {
                                if (!memJob.result || 
                                    (backupJob.result as any)._isPartial || 
                                    (backupJob.timestamp && memJob.timestamp && backupJob.timestamp > memJob.timestamp)) {
                                    memJob.result = backupJob.result;
                                    console.log(`[Queue] 🔄 Refreshed job ${id} result from JSON backup (hasPartial: ${!!(backupJob.result as any)?._isPartial})`);
                                }
                            }
                        }
                    }
                }
            } catch (fsError: any) {
                // Ignore JSON fallback errors
                console.warn(`[Queue] ⚠️ JSON fallback also failed: ${fsError.message}`);
            }
        }
    }

    getJobByUrl(url: string): Job | undefined {
        const normalizedUrl = this.normalizeUrl(url);
        // Return most recent job for this URL (using normalized comparison)
        const matchingJobs = Array.from(this.jobs.values())
            .filter(j => this.normalizeUrl(j.url) === normalizedUrl)
            .sort((a, b) => b.timestamp - a.timestamp);

        return matchingJobs[0];
    }

    private busyWorkers: Set<string> = new Set();

    private async saveState() {
        try {
            // Redis Sync: Save all jobs and the queue
            const pipeline = this.redis.pipeline();

            // Save each job in a hash map
            for (const [id, job] of Array.from(this.jobs.entries())) {
                pipeline.hset(`${this.redisPrefix}jobs`, id, JSON.stringify(job));
            }

            // Overwrite the queue list in Redis
            pipeline.del(`${this.redisPrefix}queue`);
            if (this.queue.length > 0) {
                pipeline.rpush(`${this.redisPrefix}queue`, ...this.queue);
            }

            await pipeline.exec();
        } catch (e: any) {
            console.error(`[Queue] ❌ Failed to save state to Redis: ${e.message}`);

            // Fallback to JSON
            try {
                console.log(`[Queue] 💾 Saving state to backup JSON file: ${this.backupFile}`);
                const data = {
                    jobs: Array.from(this.jobs.entries()),
                    queue: this.queue
                };

                // Ensure directory exists
                const dir = path.dirname(this.backupFile);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.writeFileSync(this.backupFile, JSON.stringify(data, null, 2));
            } catch (fsError: any) {
                console.error(`[Queue] ❌ Failed to save backup JSON: ${fsError.message}`);
            }
        }
    }

    private async loadState() {
        try {
            console.log(`[Queue] 📡 Connecting to Redis at ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}...`);

            // Load all jobs
            const jobsData = await this.redis.hgetall(`${this.redisPrefix}jobs`);
            const recoveredJobs = new Map<string, Job>();

            for (const [id, json] of Object.entries(jobsData)) {
                try {
                    const job = JSON.parse(json) as Job;
                    recoveredJobs.set(id, job);
                } catch (e) { }
            }

            this.jobs = recoveredJobs;

            // Load queue
            this.queue = await this.redis.lrange(`${this.redisPrefix}queue`, 0, -1);

            // CRASH RECOVERY: Convert all non-completed/non-failed jobs to PENDING
            let recovered = 0;
            for (const [id, job] of Array.from(this.jobs.entries())) {
                if (job.status === 'PROCESSING') {
                    job.status = 'PENDING';
                    if (!this.queue.includes(id)) {
                        this.queue.unshift(id);
                    }
                    recovered++;
                }
            }

            if (this.queue.length > 0 || recovered > 0) {
                console.log(`[Queue] 📂 Restored state from Redis: ${this.queue.length} jobs in queue (${recovered} recovered from crash)`);
                this.saveState(); // Sync status updates back to Redis
            }
        } catch (e: any) {
            console.warn(`[Queue] ⚠️ Redis error during load: ${e.message}. Trying backup JSON...`);

            // Fallback to JSON
            try {
                if (fs.existsSync(this.backupFile)) {
                    console.log(`[Queue] 📂 Loading state from backup JSON: ${this.backupFile}`);
                    const data = JSON.parse(fs.readFileSync(this.backupFile, 'utf-8'));

                    // Restore jobs
                    if (Array.isArray(data.jobs)) {
                        this.jobs = new Map(data.jobs);
                    }

                    // Restore queue
                    if (Array.isArray(data.queue)) {
                        this.queue = data.queue;
                    }

                    // CRASH RECOVERY for JSON
                    let recovered = 0;
                    for (const [id, job] of Array.from(this.jobs.entries())) {
                        if (job.status === 'PROCESSING') {
                            job.status = 'PENDING';
                            if (!this.queue.includes(id)) {
                                this.queue.unshift(id);
                            }
                            recovered++;
                        }
                    }

                    console.log(`[Queue] 📂 Restored state from JSON: ${this.queue.length} jobs in queue (${recovered} recovered from crash)`);
                } else {
                    console.log(`[Queue] ℹ️ No backup JSON found.`);
                }
            } catch (fsError: any) {
                console.error(`[Queue] ❌ Failed to load backup JSON: ${fsError.message}`);
            }
        }
    }

    private async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        // Auto-scale browser pool if queue is building up
        if (this.queue.length > 0) {
            await this.browserPool.scaleUp(this.queue.length);
        }

        while (this.queue.length > 0) {
            const jobId = this.queue.shift();
            if (!jobId) break;

            const job = this.jobs.get(jobId);
            if (!job) continue;

            if (this.processing.has(jobId)) continue;

            // Mark as processing
            job.status = 'PROCESSING';
            this.processing.add(jobId);

            // Check if this is a custom proxy job
            if (job.customProxy) {
                this.runEphemeralJob(job);
                continue;
            }

            // DIRECT-FIRST STRATEGY: Prefer non-proxy workers for speed
            const allPages = this.browserPool.getAllActivePages();
            const availableWorkers = allPages.filter(p => !this.busyWorkers.has(`${p.browserId}:${p.tabId}`));

            if (availableWorkers.length === 0) {
                // No workers available, requeue
                this.queue.unshift(jobId);
                this.processing.delete(jobId);
                break;
            }

            // Sort workers: non-proxy first (direct connection is fastest)
            availableWorkers.sort((a, b) => {
                const browserA = this.browserPool.getBrowser(a.browserId);
                const browserB = this.browserPool.getBrowser(b.browserId);
                const aIsProxy = browserA?.proxy ? 1 : 0;
                const bIsProxy = browserB?.proxy ? 1 : 0;
                return aIsProxy - bIsProxy; // Non-proxy (0) comes before proxy (1)
            });

            // Use first available worker (direct if available, proxy otherwise)
            const worker = availableWorkers[0];
            const workerKey = `${worker.browserId}:${worker.tabId}`;
            const browserInfo = this.browserPool.getBrowser(worker.browserId);
            const connectionType = browserInfo?.proxy ? 'proxy' : 'direct';

            console.log(`[Queue] 🎯 Using ${connectionType} connection for job ${job.id}`);

            this.busyWorkers.add(workerKey);

            // Execute job with Hedged (Race) logic
            this.executeHedgedJob(job, worker).finally(() => {
                this.busyWorkers.delete(workerKey);
                this.processing.delete(jobId);
                this.processQueue();
            });
        }

        this.isProcessing = false;
    }

    /**
     * Hedged Execution (Race Strategy)
     * Starts one attempt, then starts a second one if the first is slow.
     */
    private async executeHedgedJob(job: Job, firstWorker: { browserId: number; tabId: number; page: Page }) {
        const HEDGE_TIMEOUT = 2000; // 2 seconds (reduced from 7s for faster parallel attempts)
        let completed = false;
        const abortController = new AbortController();

        // Tracker for workers used in this job
        const activeWorkers: string[] = [`${firstWorker.browserId}:${firstWorker.tabId}`];

        const runAttempt = async (worker: { browserId: number; tabId: number; page: Page }, isHedge: boolean = false) => {
            if (isHedge) {
                console.log(`[Queue] 🏎️ HEDGE START: Launching second worker for job ${job.id} (Race Mode)`);
            }

            try {
                await this.executeJob(job, worker, abortController.signal);
                if (!completed) {
                    completed = true;
                    abortController.abort(); // Cancel other attempt
                }
            } catch (e: any) {
                if (e.name === 'AbortError') return;
                // Only log if it's the last standing attempt
                if (!completed) {
                    console.warn(`[Queue] Attempt on B${worker.browserId} failed: ${e.message}`);
                }
            }
        };

        // Start first attempt
        const firstAttempt = runAttempt(firstWorker);

        // Wait for timeout or completion
        const hedgeTimer = setTimeout(async () => {
            if (!completed && job.status === 'PROCESSING') {
                // Find another worker for the hedge
                const allPages = this.browserPool.getAllActivePages();
                const available = allPages.filter(p => !this.busyWorkers.has(`${p.browserId}:${p.tabId}`));

                if (available.length > 0) {
                    // Prefer a DIFFERENT browser for diversity
                    const otherBrowser = available.find(p => p.browserId !== firstWorker.browserId) || available[0];
                    const otherKey = `${otherBrowser.browserId}:${otherBrowser.tabId}`;

                    this.busyWorkers.add(otherKey);
                    activeWorkers.push(otherKey);

                    runAttempt(otherBrowser, true).finally(() => {
                        this.busyWorkers.delete(otherKey);
                    });
                }
            }
        }, HEDGE_TIMEOUT);

        await firstAttempt;
        clearTimeout(hedgeTimer);
    }

    /**
     * Runs a job immediately using a custom ephemeral browser.
     * Bypasses the main queue loop.
     */
    private async runEphemeralJob(job: Job) {
        if (!job.customProxy) return;

        job.status = 'PROCESSING';
        console.log(`[Queue] ⚡ Starting Ephemeral Job ${job.id}...`);

        const ephemeral = await this.browserPool.createEphemeralBrowser(job.customProxy);

        if (!ephemeral) {
            job.status = 'FAILED';
            job.error = 'Failed to launch custom proxy browser';
            return;
        }

        try {
            const { browser, page } = ephemeral;
            console.log(`[Queue] ⚡ Ephemeral Job ${job.id} launched. Scraping...`);

            let result;
            if (job.type === 'STORE') {
                result = await ScraperWorker.scrapeStore(page, job.url);
            } else if (job.type === 'PRODUCT') {
                result = await ScraperWorker.scrapeProduct(page, job.url);
            }

            if (result && result.error) {
                throw new Error(result.error);
            }

            // Unwrap API response if needed
            if (result && (result as any).success === true && (result as any).data) { // Cast to any to fix TS errors
                result = (result as any).data;
            }

            job.result = result;
            job.status = 'COMPLETED';

            // Cache
            const cache = CacheService.getInstance();
            cache.set(job.url, result);

            console.log(`[Queue] ⚡ Ephemeral Job ${job.id} COMPLETED.`);

        } catch (e: any) {
            console.error(`[Queue] ⚡ Ephemeral Job ${job.id} FAILED: ${e.message}`);
            job.status = 'FAILED';
            job.error = e.message;
        } finally {
            console.log(`[Queue] ⚡ Closing Ephemeral Browser for job ${job.id}`);
            try {
                if (ephemeral && ephemeral.browser) {
                    await ephemeral.browser.close();
                }
            } catch (e) { }
        }
    }

    private async executeJob(job: Job, worker: { browserId: number; tabId: number; page: Page }, signal?: AbortSignal) {
        if (signal?.aborted) return;

        console.log(`[Queue] Processing job ${job.id} - ${job.url} on B${worker.browserId}.T${worker.tabId}`);
        const MAX_RETRIES = 3;
        let attempt = 0;

        while (attempt < MAX_RETRIES) {
            attempt++;
            if (signal?.aborted) return;

            try {
                let result;
                if (job.type === 'STORE') {
                    result = await ScraperWorker.scrapeStore(worker.page, job.url);
                    if (result && result.error) throw new Error(result.error);
                } else if (job.type === 'PRODUCT') {
                    // Use the new flow: Store -> Scroll -> Product -> Extract
                    // Pass onProgress callback to support partial updates (progressive enrichment)
                    const onProgress = async (partialData: any) => {
                        console.log(`[Queue] 📡 Received partial data for job ${job.id}. Updating Redis...`);
                        console.log(`[Queue] 📦 Partial data keys: ${Object.keys(partialData).slice(0, 10).join(', ')}...`);

                        // We do NOT mark as COMPLETED yet, but we update the result
                        // Ensure _isPartial flag is set so controller can detect it
                        job.result = {
                            ...partialData,
                            _isPartial: true
                        };
                        // Update timestamp to ensure Redis has latest
                        job.timestamp = Date.now();
                        
                        // Save to Redis immediately so controller can retrieve it
                        await this.saveState();
                        console.log(`[Queue] ✅ Saved partial data to Redis for job ${job.id}`);
                    };

                    result = await ScraperWorker.scrapeProduct(worker.page, job.url, onProgress);

                    if (result && result.error) {
                        if (result.error.includes('429') ||
                            result.error.includes('403') ||
                            result.error.includes('NETWORK') ||
                            result.error.includes('TIMEOUT') ||
                            result.error.includes('CHANNEL_ID_NOT_FOUND')) {

                            throw new Error(`PROXY_ISSUE: ${result.error}`);
                        }
                        if (result.error) throw new Error(result.error);
                    }
                }

                if (signal?.aborted) return;

                // Unwrap API response if needed
                if (result && (result as any).success === true && (result as any).data) {
                    result = (result as any).data;
                }

                job.result = result;
                job.status = 'COMPLETED';
                this.saveState();

                // Mark this UA as working (add to whitelist)
                const successProfile = this.browserPool.getProfileForBrowser(worker.browserId);
                if (successProfile) {
                    const { getProfileManager } = await import('../profiles/ProfileManager');
                    getProfileManager().markUAAsWorking(successProfile.userAgent);
                }

                // Mark proxy as working if used
                const browserInstance = this.browserPool.getBrowser(worker.browserId);
                if (browserInstance?.proxy) {
                    const { getProxyManager } = await import('../proxy/ProxyManager');
                    getProxyManager().markProxyAsWorking(browserInstance.proxy);
                }

                // Cache the result
                const cache = CacheService.getInstance();
                cache.set(job.url, result);

                // BACKGROUND PREFETCH: If this was a store scrape, queue all products found
                if (job.type === 'STORE' && result && result.allProductIds && Array.isArray(result.allProductIds)) {
                    const productIds = result.allProductIds as string[];
                    console.log(`[Queue] 🛍️ Store scrape completed. Found ${productIds.length} products. Queueing background fetch...`);

                    // Construct base URL for products. 
                    // Typically storeUrl is like https://smartstore.naver.com/storename or https://brand.naver.com/storename
                    // Products are usually at {storeUrl}/products/{productId}
                    // We can try to be smart or just assume standard structure.
                    // Remove trailing slash if present
                    const baseUrl = job.url.replace(/\/$/, '');

                    productIds.forEach((pid) => {
                        // Construct URL
                        // Check if it already has /products logic or just append
                        const productUrl = `${baseUrl}/products/${pid}`;

                        // Add to queue. Using standard method. 
                        // Note: addJob checks if job exists. We rely on that to avoid duplicates.
                        // We are NOT using ephemereal (customProxy) for these, just standard queue.
                        this.addJob(productUrl, 'PRODUCT');
                    });
                }

                return; // Success, exit

            } catch (e: any) {
                const isProxyIssue = e.message.includes('PROXY_ISSUE') ||
                    e.message.includes('Timeout') ||
                    e.message.includes('ERR_');

                const isCriticalBrowserError = e.message.includes('detached Frame') ||
                    e.message.includes('Target closed') ||
                    e.message.includes('Session closed') ||
                    e.message.includes('Execution context was destroyed');

                const isNoContent = e.message.includes('204_NO_CONTENT');

                const isUnsupportedBrowser = e.message.includes('UNSUPPORTED_BROWSER');

                console.warn(`[Queue] Job ${job.id} failed attempt ${attempt}/${MAX_RETRIES}: ${e.message}`);

                // 1. Critical Browser Error: The page/browser is dead. Re-queue and abort this worker.
                if (isCriticalBrowserError) {
                    console.log(`[Queue] ⚠️ Browser/Page crashed (${e.message}). Re-queuing job ${job.id} for fresh worker...`);

                    try {
                        await this.browserPool.restartBrowser(worker.browserId);
                    } catch (restartErr: any) {
                        console.error(`[Queue] ❌ Failed to restart browser B${worker.browserId}: ${restartErr.message}`);
                    }

                    this.queue.unshift(job.id);
                    job.status = 'PENDING';
                    return; // Abort - this worker is dead
                }

                // 2. Proxy/Network Issue: Mark proxy bad, then rotate browser and re-queue.
                if (isProxyIssue) {
                    const browserInstance = this.browserPool.getBrowser(worker.browserId);

                    // IMPORTANT: Mark proxy as bad BEFORE restarting
                    if (browserInstance?.proxy) {
                        const { getProxyManager } = await import('../proxy/ProxyManager');
                        console.log(`[Queue] 🚫 Marking proxy ${browserInstance.proxy.host}:${browserInstance.proxy.port} as bad`);
                        getProxyManager().markProxyBad(browserInstance.proxy);
                    }

                    console.log(`[Queue] 🚨 Proxy/Network issue detected on B${worker.browserId}. Triggering rotation...`);
                    this.browserPool.incrementFailure(worker.browserId);

                    try {
                        await this.browserPool.restartBrowser(worker.browserId);
                    } catch (restartErr: any) {
                        console.error(`[Queue] ❌ Failed to rotate browser B${worker.browserId}: ${restartErr.message}`);
                    }

                    console.log(`[Queue] ♻️ Re-queuing job ${job.id} for a fresh worker...`);
                    this.queue.unshift(job.id);
                    job.status = 'PENDING';
                    return; // Abort
                }

                // 3. No Content: Fail fast.
                if (isNoContent) {
                    console.log(`[Queue] ⚠️ Job ${job.id} returned 204 NO CONTENT. Failing fast.`);
                    job.error = '204_NO_CONTENT';
                    job.status = 'FAILED';
                    return; // Stop retrying
                }

                // 4. Unsupported Browser: Retry indefinitely with different UAs
                if (isUnsupportedBrowser) {
                    console.log(`[Queue] ⚠️ Unsupported Browser detected. Trying different UA...`);

                    // Try to rotate to a new profile
                    let newProfileName: string | null = null;
                    try {
                        newProfileName = await this.browserPool.rotatePageProfile(worker.browserId, worker.tabId);
                    } catch (rotateErr: any) {
                        console.error(`[Queue] ❌ Failed to rotate profile: ${rotateErr.message}`);
                    }

                    if (!newProfileName) {
                        // Couldn't get new profile - wait a bit and retry
                        console.log(`[Queue] ⏳ Waiting 5s before retry...`);
                        await new Promise(r => setTimeout(r, 5000));
                    }

                    // Clean page and retry (don't count against MAX_RETRIES)
                    console.log(`[Queue] 🔄 Retrying with ${newProfileName || 'same'} UA...`);
                    try {
                        if (worker.page && !worker.page.isClosed()) {
                            await worker.page.goto('about:blank').catch(() => { });
                        }
                        await new Promise(r => setTimeout(r, 3000));
                    } catch (navErr) { }

                    attempt--; // Don't count UNSUPPORTED_BROWSER against retry limit
                    continue; // Retry with new profile
                }

                // 5. Standard Retry Logic
                if (attempt < MAX_RETRIES) {
                    console.log(`[Queue] ♻️ Retrying job ${job.id} in 3s (Cleaning page context)...`);
                    try {
                        if (worker.page && !worker.page.isClosed()) {
                            await worker.page.goto('about:blank').catch(() => { });
                        }
                        await new Promise(r => setTimeout(r, 3000));
                    } catch (navErr) { }
                } else {
                    console.error(`[Queue] Job ${job.id} permanently failed after ${MAX_RETRIES} attempts.`);
                    job.error = e.message;
                    job.status = 'FAILED';
                    this.saveState();
                }
            }
        }
    }

    // Helper to shutdown
    async shutdown() {
        await this.browserPool.shutdown();
    }
}
