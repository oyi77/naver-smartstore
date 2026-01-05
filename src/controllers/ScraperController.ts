
import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { QueueService } from '../services/QueueService';
import { CacheService } from '../services/CacheService';
import { successResponse, errorResponse } from '../utils/response';
// @ts-ignore
import UserAgent from 'user-agents';

const cache = new CacheService();

const querySchema = z.object({
    url: z.string().url().optional(),
    productUrl: z.string().url().optional(),
    storeUrl: z.string().url().optional(),
    categoryUrl: z.string().url().optional(),
    proxy: z.string().optional(),
    refresh: z.union([z.string(), z.boolean()]).optional().transform(val => val === 'true' || val === true)
});

export class ScraperController {
    static async handleScrape(req: FastifyRequest, reply: FastifyReply) {
        try {
            // 1. Parse & Validate
            const queryRaw = req.query as any;
            const parsed = querySchema.parse(queryRaw);
            const refresh = parsed.refresh;

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

            // 3. Cache Check
            if (!refresh) {
                const cached = cache.get(targetUrl);
                if (cached) {
                    req.log.info({ url: targetUrl, type, msg: 'Cache Hit' });
                    return reply.send(successResponse(cached));
                }
            }

            req.log.info({ url: targetUrl, type, msg: 'Cache Miss - Queueing' });

            // 4. Queue / Job Check
            const queue = QueueService.getInstance();
            let job = queue.getJobByUrl(targetUrl);

            // If refresh requested or no job exists, start new one
            if (refresh || !job || job.status === 'FAILED') {
                if (!job || job.status !== 'PENDING' && job.status !== 'PROCESSING') {
                    job = queue.addJob(targetUrl, type, { customProxy: parsed.proxy });
                }
            }

            // 5. Response based on Status
            if (job.status === 'COMPLETED') {
                // If it was just completed (e.g. ephemeral) or retrieved from memory
                if (job.result) {
                    cache.set(targetUrl, job.result);
                    return reply.send(successResponse(job.result));
                } else {
                    return reply.status(500).send(errorResponse('Job completed but no result found', 500));
                }
            } else if (job.status === 'FAILED') {
                return reply.status(500).send(errorResponse(job.error || 'Scraping Failed', 500));
            } else {
                // PENDING or PROCESSING
                return reply.status(202).send({
                    status: 'processing',
                    message: 'The data isnt available right now, we will get it for u, please try again later.',
                    jobId: job.id,
                    progress: job.status
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
