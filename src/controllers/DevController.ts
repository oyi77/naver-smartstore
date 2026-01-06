import { FastifyRequest, FastifyReply } from 'fastify';
import { getProfileManager } from '../profiles/ProfileManager';

/**
 * Development endpoints for manual testing and configuration
 */
export class DevController {
    /**
     * POST /dev/ua - Manually add a working UA to the whitelist
     */
    static async addWorkingUA(
        request: FastifyRequest<{ Body: { userAgent: string } }>,
        reply: FastifyReply
    ) {
        const { userAgent } = request.body;

        if (!userAgent || typeof userAgent !== 'string') {
            return reply.code(400).send({
                success: false,
                error: 'Missing or invalid userAgent in request body'
            });
        }

        try {
            const profileManager = getProfileManager();
            profileManager.markUAAsWorking(userAgent);

            return reply.send({
                success: true,
                message: 'User Agent added to whitelist',
                userAgent,
                totalWorkingUAs: profileManager.getWorkingUACount()
            });
        } catch (e: any) {
            return reply.code(500).send({
                success: false,
                error: e.message
            });
        }
    }

    /**
     * GET /dev/ua - Get list of working UAs
     */
    static async listWorkingUAs(
        request: FastifyRequest,
        reply: FastifyReply
    ) {
        const profileManager = getProfileManager();
        // @ts-ignore - accessing private field for dev purposes
        const workingUAs = Array.from(profileManager.workingUAs || []);

        return reply.send({
            success: true,
            count: workingUAs.length,
            workingUAs
        });
    }

    /**
     * POST /dev/proxy - Manually add a proxy
     * Note: Proxy management is done through ProxyManager - this is a placeholder
     */
    static async addProxy(
        request: FastifyRequest<{ Body: { proxyUrl: string; type?: string } }>,
        reply: FastifyReply
    ) {
        const { proxyUrl, type } = request.body;

        if (!proxyUrl || typeof proxyUrl !== 'string') {
            return reply.code(400).send({
                success: false,
                error: 'Missing or invalid proxyUrl in request body'
            });
        }

        // For now, just return a message
        // Proxies are managed through data/proxy.json and environment variables
        return reply.send({
            success: false,
            message: 'Proxy addition via API not yet implemented. Please add proxies manually to data/proxy.json or use PROXY_LIST env variable.',
            proxyUrl,
            type: type || 'datacenter'
        });
    }
}
