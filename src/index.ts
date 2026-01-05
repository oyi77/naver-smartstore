
import Fastify from 'fastify';
import dotenv from 'dotenv';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import { ScraperController } from './controllers/ScraperController';
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
                        refresh: { type: 'boolean' }
                    }
                }
            }
        }, ScraperController.handleScrape);

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
