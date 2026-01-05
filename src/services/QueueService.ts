import { BrowserPool } from '../browser/BrowserPool';
import { Page } from 'puppeteer';
import { ScraperWorker } from './ScraperWorker';
import { CacheService } from './CacheService';

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

    private constructor() {
        const useProxyRaw = process.env.USE_PROXY ? process.env.USE_PROXY.trim().toLowerCase() : 'true';
        const maxBrowsers = process.env.MAX_BROWSERS ? parseInt(process.env.MAX_BROWSERS) : 2;
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
            browserCount: maxBrowsers,
            tabsPerBrowser: tabsPerBrowser,
            proxiedCount: proxiedCount,
            headless: headless
        });
    }

    static getInstance(): QueueService {
        if (!QueueService.instance) {
            QueueService.instance = new QueueService();
        }
        return QueueService.instance;
    }

    async initialize() {
        await this.browserPool.initialize();
        this.processQueue(); // Start processing loop
    }

    addJob(url: string, type: JobType, options: { customProxy?: string } = {}): Job {
        // Check if job exists and is valid (not failed/completed long ago)
        const existingJobId = Array.from(this.jobs.keys()).find(id => this.jobs.get(id)?.url === url);
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
            url,
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
            this.processQueue();
        }

        return job;
    }

    getJob(id: string): Job | undefined {
        return this.jobs.get(id);
    }

    getJobByUrl(url: string): Job | undefined {
        // Return most recent job for this URL
        const matchingJobs = Array.from(this.jobs.values())
            .filter(j => j.url === url)
            .sort((a, b) => b.timestamp - a.timestamp);

        return matchingJobs[0];
    }

    private async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            // Get available workers
            const pages = this.browserPool.getAllActivePages();

            if (pages.length === 0) {
                // No active browsers? Wait a bit
                await new Promise(r => setTimeout(r, 2000));
                // Try to initialize/restart if pool is empty might be needed, 
                // but let's assume they might come back if restarting
                // actually if getAllActivePages is 0, we might be deadlocked if we don't have logic to ensure min pool size.
                // But BrowserPool manages restarts.

                // If we have browsers but they are all inactive (restarting), we wait.
                if (this.browserPool.getStats().total > 0) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                } else {
                    console.error('[QueueService] ❌ No browsers available in pool!');
                    break;
                }
            }

            const jobId = this.queue.shift();
            if (!jobId) break;

            const job = this.jobs.get(jobId);
            if (!job) continue;

            // Simple Round Robin for now
            // In future, track busy status more accurately
            if (this.processing.size >= pages.length * 2) {
                // Allow some concurrency per tab (e.g. 2 tasks queueing up) 
                // but better to just throttle to 1 per tab if possible for strict stealth.
                // Let's settle on: if processing >= pages, wait.
                if (this.processing.size >= pages.length) {
                    this.queue.unshift(jobId);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }
            }

            this.processing.add(jobId);
            job.status = 'PROCESSING';

            // Select worker
            const worker = pages[this.processing.size % pages.length];

            // Execute async
            this.executeJob(job, worker).finally(() => {
                this.processing.delete(jobId);
                this.processQueue();
            });
        }

        this.isProcessing = false;
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

            job.result = result;
            job.status = 'COMPLETED';

            // Cache
            const cache = new CacheService();
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

    private async executeJob(job: Job, worker: { browserId: number; tabId: number; page: Page }) {
        console.log(`[Queue] Processing job ${job.id} - ${job.url} on B${worker.browserId}.T${worker.tabId}`);
        const MAX_RETRIES = 3;
        let attempt = 0;

        while (attempt < MAX_RETRIES) {
            attempt++;
            try {
                let result;
                if (job.type === 'STORE') {
                    result = await ScraperWorker.scrapeStore(worker.page, job.url);
                    if (result && result.error) throw new Error(result.error);
                } else if (job.type === 'PRODUCT') {
                    // Use the new flow: Store -> Scroll -> Product -> Extract
                    result = await ScraperWorker.scrapeProduct(worker.page, job.url);

                    if (result && result.error) {
                        // Check for specific retryable errors
                        // 429: Too Many Requests -> Proxy likely bad or rate limited
                        // 403: Forbidden -> WAF blocked -> Proxy bad
                        // NETWORK / TIMEOUT -> Proxy bad
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

                job.result = result;
                job.status = 'COMPLETED';

                // Cache the result
                const cache = new CacheService();
                cache.set(job.url, result);
                return; // Success, exit

            } catch (e: any) {
                const isProxyIssue = e.message.includes('PROXY_ISSUE') ||
                    e.message.includes('Timeout') ||
                    e.message.includes('ERR_');

                console.warn(`[Queue] Job ${job.id} failed attempt ${attempt}/${MAX_RETRIES}: ${e.message}`);

                if (isProxyIssue) {
                    console.log(`[Queue] 🚨 Proxy/Network issue detected on B${worker.browserId}. Triggering rotation...`);
                    // Restart the browser to get a fresh proxy
                    this.browserPool.incrementFailure(worker.browserId); // Track stats
                    // Firing restart async - we don't await the full restart here necessarily, 
                    // but since we are in a retry loop using 'worker.page', we MUST get a new page or abort.
                    // Because 'restartBrowser' closes the page, we can't use 'worker.page' anymore in next attempt!

                    // Trigger restart
                    await this.browserPool.restartBrowser(worker.browserId);

                    // Since the browser restarted, 'worker.page' is now closed/invalid.
                    // We must ABORT this worker's local retry loop and put the job back in the main queue 
                    // or (simpler) just return and let the queue pick it up again as 'FAILED' -> 'PENDING'?
                    // But we want to preserve retry count? 
                    // Let's just PUT BACK in queue and exit this function. 
                    // The job status is still 'PROCESSING' so we reset to 'PENDING'.

                    console.log(`[Queue] ♻️ Re-queuing job ${job.id} for a fresh worker...`);
                    this.queue.unshift(job.id); // Re-queue at front
                    job.status = 'PENDING';
                    return; // Exit execution, let processQueue match it to a new (or same restarted) worker
                }

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
                }
            }
        }
    }

    // Helper to shutdown
    async shutdown() {
        await this.browserPool.shutdown();
    }
}
