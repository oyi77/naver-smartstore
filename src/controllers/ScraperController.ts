
import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { QueueService } from '../services/QueueService';
import { CacheService } from '../services/CacheService';
import { PreloadCacheService } from '../services/PreloadCacheService';
import { successResponse, errorResponse } from '../utils/response';
// @ts-ignore
import UserAgent from 'user-agents';

const cache = CacheService.getInstance();
const preloadCache = PreloadCacheService.getInstance();

const querySchema = z.object({
    url: z.string().url().optional(),
    productUrl: z.string().url().optional(),
    storeUrl: z.string().url().optional(),
    categoryUrl: z.string().url().optional(),
    proxy: z.string().optional(),
    refresh: z.union([z.string(), z.boolean()]).optional().transform(val => val === 'true' || val === true),
    wait: z.union([z.string(), z.boolean()]).optional().transform(val => val === 'true' || val === true)
});

export class ScraperController {
    static async handleScrape(req: FastifyRequest, reply: FastifyReply) {
        try {
            // 1. Parse & Validate
            const queryRaw = req.query as any;
            const parsed = querySchema.parse(queryRaw);
            const refresh = parsed.refresh;
            const wait = parsed.wait;

            // 2. Determine Target URL & Type
            let targetUrl = '';
            let type: any = 'STORE'; // default

            if (parsed.productUrl) {
                targetUrl = parsed.productUrl;
                type = 'PRODUCT';
            } else if (parsed.storeUrl) {
                targetUrl = parsed.storeUrl;
                type = 'STORE';
            } else if (parsed.categoryUrl) {
                targetUrl = parsed.categoryUrl;
                type = 'CATEGORY';
            } else if (parsed.url) {
                targetUrl = parsed.url;
                // Simple detection
                if (targetUrl.includes('/products/')) type = 'PRODUCT';
                else if (targetUrl.includes('/category/')) type = 'CATEGORY';
                else type = 'STORE';
            }

            // 3. Readiness Check
            const queue = QueueService.getInstance();
            if (!queue.getIsInitialized()) {
                req.log.warn({ url: targetUrl, msg: 'QueueService not initialized' });
                return reply.status(503).send(errorResponse('Service is initializing, please try again in a moment', 503));
            }

            // 4. Cache Check (Full Product Cache)
            if (!refresh) {
                const cached = cache.get(targetUrl);
                if (cached) {
                    req.log.info({ url: targetUrl, type, msg: 'Cache Hit' });
                    return reply.send(successResponse(cached));
                }
            }

            // 5. Preload Cache Check (for PRODUCT type only)
            if (type === 'PRODUCT' && !refresh) {
                // Extract storeUrl and productId from productUrl
                const productUrlMatch = targetUrl.match(/^(https?:\/\/[^\/]+(?:\/[^\/]+)*)\/products\/(\d+)/);
                if (productUrlMatch) {
                    const [, storeUrl, productId] = productUrlMatch;
                    const preload = preloadCache.getPreload(storeUrl, productId);
                    
                    if (preload) {
                        req.log.info({ url: targetUrl, msg: 'Preload Cache Hit', productId });
                        
                        // Ensure a job is queued to fetch full data
                        let job = queue.getJobByUrl(targetUrl);
                        if (!job || job.status === 'FAILED') {
                            job = queue.addJob(targetUrl, type, { customProxy: parsed.proxy });
                        }
                        
                        // Return partial data immediately with jobId
                        return reply.send(successResponse({
                            ...preload,
                            jobId: job.id,
                            _isPartial: true
                        }));
                    }
                }
            }

            req.log.info({ url: targetUrl, type, msg: 'Cache Miss - Queueing' });

            // 6. Queue / Job Check
            let job = queue.getJobByUrl(targetUrl);

            // If refresh requested or no job exists, start new one
            if (refresh || !job || job.status === 'FAILED') {
                if (!job || job.status !== 'PENDING' && job.status !== 'PROCESSING') {
                    job = queue.addJob(targetUrl, type, { customProxy: parsed.proxy });
                }
            }

            // 7. Wait Logic (Optional, capped at 5.5s)
            if (wait && (job.status === 'PENDING' || job.status === 'PROCESSING')) {
                const startTime = Date.now();
                const TIMEOUT_MS = 5500; // Capped at 5.5s to meet <6s SLO

                while (Date.now() - startTime < TIMEOUT_MS) {
                    // Refresh job status
                    job = queue.getJob(job.id) || job;
                    
                    // Check if completed or failed
                    if (job.status === 'COMPLETED' || job.status === 'FAILED') break;
                    
                    // Check if partial result is available (for progressive enrichment)
                    if (job.status === 'PROCESSING' && job.result && (job.result as any)._isPartial) {
                        // Return partial immediately if available during wait
                        return reply.send(successResponse({
                            ...job.result,
                            jobId: job.id,
                            _isPartial: true
                        }));
                    }
                    
                    // Sleep 200ms (faster polling for better responsiveness)
                    await new Promise(r => setTimeout(r, 200));
                }
            }

            // 8. Response based on Status
            if (job.status === 'COMPLETED') {
                // If it was just completed (e.g. ephemeral) or retrieved from memory
                if (job.result) {
                    if (!refresh) cache.set(targetUrl, job.result); // Ensure cache is set if fresh
                    return reply.send(successResponse(job.result));
                } else {
                    return reply.status(500).send(errorResponse('Job completed but no result found', 500));
                }
            } else if (job.status === 'FAILED') {
                return reply.status(500).send(errorResponse(job.error || 'Scraping Failed', 500));
            } else {
                // PENDING or PROCESSING - check for partial result
                // IMPORTANT: Refresh job from queue to get latest result
                const refreshedJob = queue.getJob(job.id) || job;
                
                if (refreshedJob.status === 'PROCESSING' && refreshedJob.result && (refreshedJob.result as any)._isPartial) {
                    req.log.info({ url: targetUrl, jobId: refreshedJob.id, msg: 'Returning partial result' });
                    return reply.send(successResponse({
                        ...refreshedJob.result,
                        jobId: refreshedJob.id,
                        _isPartial: true
                    }));
                }
                
                // Otherwise return 202
                return reply.status(202).send({
                    status: 'processing',
                    message: 'The data isnt available right now, we will get it for u, please try again later.',
                    jobId: refreshedJob.id,
                    progress: refreshedJob.status
                });
            }

        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send(errorResponse('Validation Failed', 400, (error as any).issues));
            }
            req.log.error(error);
            return reply.status(500).send(errorResponse(error.message || 'Internal Server Error', 500));
        }
    }
}
