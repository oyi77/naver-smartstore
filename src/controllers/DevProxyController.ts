import { FastifyRequest, FastifyReply } from 'fastify';
import { getProxyManager } from '../proxy/ProxyManager';
import { ProxyParser } from '../proxy/ProxyParser';
import { successResponse, errorResponse } from '../utils/response';

/**
 * Development endpoints for proxy management
 * All responses use consistent format: { status: 'success'/'error', data: {...} }
 */
export class DevProxyController {
    /**
     * GET /dev/proxy - List all proxies with optional filters
     */
    static async listProxies(
        request: FastifyRequest<{ Querystring: { working?: string; naverReady?: string; type?: string; protocol?: string } }>,
        reply: FastifyReply
    ) {
        const { working, naverReady, type, protocol } = request.query;
        const proxyManager = getProxyManager();
        let proxies = proxyManager.getAllProxies();

        // Apply filters
        if (working === 'true') {
            proxies = proxies.filter(p => proxyManager.isProxyWorking(p));
        }
        if (naverReady === 'true') {
            proxies = proxies.filter(p => p.canAccessNaver);
        }
        if (type) {
            proxies = proxies.filter(p => p.ipType === type);
        }
        if (protocol) {
            proxies = proxies.filter(p => p.protocol === protocol);
        }

        return reply.send(successResponse({
            total: proxies.length,
            proxies: proxies.map(p => ({
                host: p.host,
                port: p.port,
                protocol: p.protocol,
                latency: p.latency,
                ipType: p.ipType,
                canAccessNaver: p.canAccessNaver,
                isWorking: proxyManager.isProxyWorking(p),
                isRotating: p.isRotating,
                source: p.source,
                isp: p.isp,
                country: p.country,
                lastValidated: p.lastValidated
            }))
        }));
    }

    /**
     * POST /dev/proxy - Add proxy manually
     */
    static async addProxy(
        request: FastifyRequest<{ Body: { host: string; port: number; protocol?: string; username?: string; password?: string } }>,
        reply: FastifyReply
    ) {
        const { host, port, protocol, username, password } = request.body;

        if (!host || !port) {
            return reply.code(400).send(errorResponse('Missing required fields: host, port', 400));
        }

        try {
            const proxyManager = getProxyManager();
            proxyManager.addProxyManually({
                host,
                port,
                protocol: (protocol || 'http') as any,
                source: 'manual',
                username,
                password
            });

            return reply.send(successResponse({
                message: 'Proxy added manually (will be validated in next cycle)',
                proxy: { host, port, protocol: protocol || 'http' }
            }));
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * POST /dev/proxy/upload - Upload proxy file (JSON/TXT/CSV)
     */
    static async uploadProxyFile(
        request: FastifyRequest,
        reply: FastifyReply
    ) {
        try {
            const data: any = await request.file();

            if (!data) {
                return reply.code(400).send(errorResponse('No file uploaded', 400));
            }

            const buffer = await data.toBuffer();
            const content = buffer.toString('utf-8');
            const filename = data.filename;

            // Parse the file
            const result = await ProxyParser.parseString(content, ProxyParser.detectFormat(content, filename));

            if (result.proxies.length === 0) {
                return reply.code(400).send(errorResponse('No valid proxies found in file', 400, { errors: result.errors }));
            }

            // Add all proxies to manager
            const proxyManager = getProxyManager();
            for (const proxy of result.proxies) {
                proxy.source = `upload:${filename}`;
                proxyManager.addProxyManually(proxy);
            }

            return reply.send(successResponse({
                message: `Imported ${result.proxies.length} proxies from ${filename}`,
                imported: result.proxies.length,
                format: result.format,
                errors: result.errors.length > 0 ? result.errors.slice(0, 10) : undefined
            }));

        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * GET /dev/proxy/stats - Get pool statistics
     */
    static async getStats(
        request: FastifyRequest,
        reply: FastifyReply
    ) {
        try {
            const proxyManager = getProxyManager();
            const metrics = await proxyManager.getMetrics();
            const providerStats = await proxyManager.getProviderStats();

            const providers = Array.from(providerStats.values());

            return reply.send(successResponse({
                ...metrics,
                providers: providers.map(p => ({
                    name: p.name,
                    type: p.type,
                    status: p.status,
                    totalProxies: p.totalProxies,
                    activeProxies: p.activeProxies,
                    successRate: p.successRate,
                    error: p.error
                }))
            }));
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * GET /dev/proxy/sources - List proxy sources
     */
    static async listSources(
        request: FastifyRequest,
        reply: FastifyReply
    ) {
        const proxyManager = getProxyManager();
        const sources = proxyManager.getProxySources();

        // Load default sources to compare
        let defaultSources: Record<string, string> = {};
        try {
            const defaultPath = require('path').join(process.cwd(), 'data', 'default_proxy_sources.json');
            if (require('fs').existsSync(defaultPath)) {
                const data = JSON.parse(require('fs').readFileSync(defaultPath, 'utf-8'));
                defaultSources = data.defaultSources || {};
            }
        } catch (e) {
            // Ignore errors
        }

        // Enrich sources with type information
        const enrichedSources = Object.entries(sources).map(([name, url]) => ({
            name,
            url,
            type: defaultSources[name] === url ? 'default' : 'user',
            format: url.endsWith('.json') ? 'json' :
                url.endsWith('.csv') ? 'csv' :
                    url.endsWith('.txt') ? 'txt' : 'unknown'
        }));

        return reply.send(successResponse({
            total: enrichedSources.length,
            sources: enrichedSources,
            defaultCount: enrichedSources.filter(s => s.type === 'default').length,
            userCount: enrichedSources.filter(s => s.type === 'user').length
        }));
    }

    /**
     * POST /dev/proxy/sources - Add proxy source
     */
    static async addSource(
        request: FastifyRequest<{ Body: { name: string; url: string } }>,
        reply: FastifyReply
    ) {
        const { name, url } = request.body;

        if (!name || !url) {
            return reply.code(400).send(errorResponse('Missing required fields: name, url', 400));
        }

        try {
            const proxyManager = getProxyManager();
            proxyManager.addProxySource(name, url);

            return reply.send(successResponse({
                message: `Proxy source '${name}' added (supports JSON/TXT/CSV formats)`,
                source: { name, url }
            }));
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * DELETE /dev/proxy/sources/:name - Delete proxy source
     */
    static async deleteSource(
        request: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply
    ) {
        const { name } = request.params;

        if (!name) {
            return reply.code(400).send(errorResponse('Missing source name', 400));
        }

        try {
            const proxyManager = getProxyManager();
            const deleted = proxyManager.deleteProxySource(name);

            if (deleted) {
                return reply.send(successResponse({
                    message: `Proxy source '${name}' deleted`
                }));
            } else {
                return reply.code(404).send(errorResponse(`Proxy source '${name}' not found`, 404));
            }
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * GET /dev/proxy/providers - List rotating proxy providers
     */
    static async listProviders(
        request: FastifyRequest,
        reply: FastifyReply
    ) {
        try {
            const proxyManager = getProxyManager();
            const providerStats = await proxyManager.getProviderStats();

            const providers = Array.from(providerStats.entries()).map(([name, stats]) => ({
                name,
                type: stats.type,
                status: stats.status,
                totalProxies: stats.totalProxies,
                activeProxies: stats.activeProxies,
                avgLatency: stats.avgLatency,
                successRate: stats.successRate,
                lastRefresh: stats.lastRefresh,
                error: stats.error
            }));

            return reply.send(successResponse({
                total: providers.length,
                providers
            }));
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * POST /dev/proxy/providers - Add rotating proxy provider
     */
    static async addProvider(
        request: FastifyRequest<{ Body: { name: string; type: string; config: any } }>,
        reply: FastifyReply
    ) {
        const { name, type, config } = request.body;

        if (!name || !type || !config) {
            return reply.code(400).send(errorResponse('Missing required fields: name, type, config', 400));
        }

        try {
            const proxyManager = getProxyManager();
            await proxyManager.addRotatingProvider(name, type, config);

            return reply.send(successResponse({
                message: `Rotating provider '${name}' added successfully`,
                provider: { name, type, status: 'active' }
            }));
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }

    /**
     * DELETE /dev/proxy/providers/:name - Remove rotating proxy provider
     */
    static async deleteProvider(
        request: FastifyRequest<{ Params: { name: string } }>,
        reply: FastifyReply
    ) {
        const { name } = request.params;

        if (!name) {
            return reply.code(400).send(errorResponse('Missing provider name', 400));
        }

        try {
            const proxyManager = getProxyManager();
            const deleted = await proxyManager.removeRotatingProvider(name);

            if (deleted) {
                return reply.send(successResponse({
                    message: `Rotating provider '${name}' removed`
                }));
            } else {
                return reply.code(404).send(errorResponse(`Provider '${name}' not found`, 404));
            }
        } catch (e: any) {
            return reply.code(500).send(errorResponse(e.message, 500));
        }
    }
}
