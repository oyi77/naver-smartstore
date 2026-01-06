
import Fastify from 'fastify';
import dotenv from 'dotenv';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { ScraperController } from './controllers/ScraperController';
import { DevController } from './controllers/DevController';
import { DevProxyController } from './controllers/DevProxyController';
import { QueueService } from './services/QueueService';

dotenv.config();

const start = async () => {
    const server = Fastify({
        logger: {
            level: process.env.LOG_LEVEL || 'info'
        }
    });

    // Global Error Handler
    server.setErrorHandler((error: any, request, reply) => {
        server.log.error(error);
        reply.status(500).send({
            status: 'error',
            error: {
                code: 500,
                message: error.message || 'Internal Server Error',
            }
        });
    });

    try {
        await server.register(cors); // Register CORS first
        await server.register(multipart); // Register multipart for file uploads

        const swaggerServers = [
            {
                url: `http://localhost:${process.env.PORT || 3000}`,
                description: 'Development API Server'
            }
        ];

        if (process.env.PUBLIC_API_URL) {
            swaggerServers.push({
                url: process.env.PUBLIC_API_URL,
                description: 'Production API Server'
            });
        }

        // Register Swagger (Awaiting ensures it's ready)
        await server.register(swagger, {
            openapi: {
                info: {
                    title: 'Naver SmartStore Scraper',
                    description: 'Unified API for scraping Naver SmartStore details (Product, Store, Category)',
                    version: '1.2.0'
                },
                servers: swaggerServers
            }
        });

        await server.register(swaggerUi, {
            routePrefix: '/docs',
        });

        // Root Healthcheck
        server.get('/', async () => {
            return { status: 'ok', message: 'Naver SmartStore Scraper API is running', docs: '/docs' };
        });

        // Unified Route
        server.get('/naver', {
            schema: {
                description: 'Unified Scraper Endpoint. Auto-detects type from `url` param, or accepts explicit `productUrl`, `storeUrl`, `categoryUrl`.',
                tags: ['scraper'],
                querystring: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'Auto-detect type' },
                        productUrl: { type: 'string', description: 'Force scrape as Product' },
                        storeUrl: { type: 'string', description: 'Force scrape as Store' },
                        categoryUrl: { type: 'string', description: 'Force scrape as Category' },
                        proxy: { type: 'string', description: 'Custom proxy URL (http://user:pass@host:port)' },
                        refresh: { type: 'boolean' },
                        wait: { type: 'boolean', description: 'Wait up to 5s for data' }
                    }
                }
            }
        }, ScraperController.handleScrape);

        // Development Endpoints
        server.post('/dev/ua', {
            schema: {
                description: 'Manually add a working User Agent to whitelist',
                tags: ['development'],
                body: {
                    type: 'object',
                    required: ['userAgent'],
                    properties: {
                        userAgent: { type: 'string', description: 'User Agent string to whitelist' }
                    }
                }
            }
        }, DevController.addWorkingUA);

        server.get('/dev/ua', {
            schema: {
                description: 'List all working User Agents',
                tags: ['development']
            }
        }, DevController.listWorkingUAs);

        server.post('/dev/proxy', {
            schema: {
                description: 'Manually add a proxy',
                tags: ['development'],
                body: {
                    type: 'object',
                    required: ['host', 'port'],
                    properties: {
                        host: { type: 'string' },
                        port: { type: 'number' },
                        protocol: { type: 'string', enum: ['http', 'https', 'socks4', 'socks5'] },
                        username: { type: 'string' },
                        password: { type: 'string' }
                    }
                }
            }
        }, DevProxyController.addProxy);

        server.get('/dev/proxy', {
            schema: {
                description: 'List all proxies with optional filters',
                tags: ['development'],
                querystring: {
                    type: 'object',
                    properties: {
                        working: { type: 'string', enum: ['true', 'false'] },
                        naverReady: { type: 'string', enum: ['true', 'false'] },
                        type: { type: 'string', enum: ['residential', 'datacenter', 'unknown'] }
                    }
                }
            }
        }, DevProxyController.listProxies);

        server.get('/dev/proxy/sources', {
            schema: {
                description: 'List all proxy sources',
                tags: ['development']
            }
        }, DevProxyController.listSources);

        server.post('/dev/proxy/sources', {
            schema: {
                description: 'Add a new proxy source',
                tags: ['development'],
                body: {
                    type: 'object',
                    required: ['name', 'url'],
                    properties: {
                        name: { type: 'string', description: 'Source name' },
                        url: { type: 'string', description: 'Source URL (txt or json)' }
                    }
                }
            }
        }, DevProxyController.addSource);

        server.delete('/dev/proxy/sources/:name', {
            schema: {
                description: 'Delete a proxy source',
                tags: ['development'],
                params: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Source name to delete' }
                    }
                }
            }
        }, DevProxyController.deleteSource);

        // New Proxy Management Endpoints
        server.post('/dev/proxy/upload', {
            schema: {
                description: 'Upload proxy file (JSON/TXT/CSV format)',
                tags: ['development'],
                consumes: ['multipart/form-data']
            }
        }, DevProxyController.uploadProxyFile);

        server.get('/dev/proxy/stats', {
            schema: {
                description: 'Get comprehensive proxy pool statistics',
                tags: ['development']
            }
        }, DevProxyController.getStats);

        server.get('/dev/proxy/providers', {
            schema: {
                description: 'List all rotating proxy providers',
                tags: ['development']
            }
        }, DevProxyController.listProviders);

        server.post('/dev/proxy/providers', {
            schema: {
                description: 'Add a rotating proxy provider (Webshare, Thordata, etc.)',
                tags: ['development'],
                body: {
                    type: 'object',
                    required: ['name', 'type', 'config'],
                    properties: {
                        name: { type: 'string', description: 'Provider instance name' },
                        type: { type: 'string', enum: ['webshare', 'thordata', 'smartproxy'], description: 'Provider type' },
                        config: { type: 'object', description: 'Provider-specific configuration' }
                    }
                }
            }
        }, DevProxyController.addProvider);

        server.delete('/dev/proxy/providers/:name', {
            schema: {
                description: 'Remove a rotating proxy provider',
                tags: ['development'],
                params: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Provider name to remove' }
                    }
                }
            }
        }, DevProxyController.deleteProvider);

        server.get('/health', async () => {
            return { status: 'ok' };
        });

        // Start Server
        const PORT = process.env.PORT || 3000;
        await server.listen({ port: Number(PORT), host: '0.0.0.0' });
        console.log(`Server listening on port ${PORT}`);
        console.log(`Swagger available at http://localhost:${PORT}/docs`);

        // Initialize Queue/Browsers/Proxies in BACKGROUND
        console.log('🚀 Starting Queue Service initialization in background...');
        QueueService.getInstance().initialize()
            .then(() => console.log('✅ Queue Service Initialized'))
            .catch(err => console.error('❌ Queue Service Initialization Failed:', err));

    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
