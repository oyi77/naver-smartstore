import { BaseRotatingProxyProvider } from './BaseProvider';
import { RawProxy, ThordataConfig, ProviderStats } from '../types';

/**
 * Thordata (SmartProxy) rotating proxy provider
 * Supports session-based sticky IPs via username manipulation
 * 
 * Example: username-session-{sessionId} creates a sticky session
 * Different sessionIds = different IPs
 */
export class ThordataProvider extends BaseRotatingProxyProvider {
    protected declare config: ThordataConfig;
    private sessionCounter: number = 0;
    private stats = {
        requestCount: 0,
        successCount: 0,
        failCount: 0
    };

    constructor(name: string = 'thordata') {
        super(name);
    }

    async initialize(config: ThordataConfig): Promise<void> {
        if (!config.username || !config.password || !config.endpoint) {
            throw new Error('Thordata username, password, and endpoint are required');
        }

        this.config = {
            sessionPrefix: config.sessionPrefix || 'session',
            protocol: config.protocol || 'http',
            ...config
        };

        // Parse endpoint to extract host and port
        const [host, portStr] = this.config.endpoint.split(':');
        if (!host || !portStr) {
            throw new Error('Invalid endpoint format. Expected: host:port (e.g., gate.smartproxy.com:7000)');
        }

        console.log(`[${this.name}] Initializing Thordata provider...`);
        console.log(`[${this.name}] Endpoint: ${this.config.endpoint}`);
        console.log(`[${this.name}] Protocol: ${this.config.protocol}`);

        this.isInitialized = true;
        this.clearError();
        console.log(`[${this.name}] Initialized successfully`);
    }

    async getProxy(): Promise<RawProxy | null> {
        if (!this.isInitialized) {
            throw new Error('Provider not initialized');
        }

        this.stats.requestCount++;

        const [host, portStr] = this.config.endpoint.split(':');
        const port = parseInt(portStr);

        // Generate session-based username for sticky IP
        // Format: username-session-{counter}
        const sessionId = this.sessionCounter++;
        const sessionUsername = `${this.config.username}-${this.config.sessionPrefix}-${sessionId}`;

        // Apply country if specified
        let username = sessionUsername;
        if (this.config.country) {
            username = `${sessionUsername}-country-${this.config.country.toLowerCase()}`;
        }

        const proxy: RawProxy = {
            host,
            port,
            protocol: this.config.protocol || 'http',
            source: this.name,
            username,
            password: this.config.password,
            country: this.config.country,
            isRotating: true,
            rotatingConfig: {
                providerId: this.name,
                providerType: 'thordata'
            }
        };

        this.stats.successCount++;
        return proxy;
    }

    /**
     * Get proxy with specific session ID (for sticky sessions)
     */
    async getProxyForSession(sessionId: string): Promise<RawProxy | null> {
        if (!this.isInitialized) {
            throw new Error('Provider not initialized');
        }

        const [host, portStr] = this.config.endpoint.split(':');
        const port = parseInt(portStr);

        let username = `${this.config.username}-${this.config.sessionPrefix}-${sessionId}`;
        if (this.config.country) {
            username = `${username}-country-${this.config.country.toLowerCase()}`;
        }

        return {
            host,
            port,
            protocol: this.config.protocol || 'http',
            source: this.name,
            username,
            password: this.config.password,
            country: this.config.country,
            isRotating: true,
            rotatingConfig: {
                providerId: this.name,
                providerType: 'thordata'
            }
        };
    }

    async releaseProxy(proxy: RawProxy): Promise<void> {
        // No-op for Thordata
    }

    async markProxyBad(proxy: RawProxy): Promise<void> {
        this.stats.failCount++;
    }

    async healthCheck(): Promise<boolean> {
        try {
            // For Thordata, we can't really verify without making a request
            // Just verify config is valid
            const [host, portStr] = this.config.endpoint.split(':');
            const port = parseInt(portStr);

            return !!(host && port && port > 0 && port < 65536);
        } catch (e: any) {
            this.setError(`Health check failed: ${e.message}`);
            return false;
        }
    }

    async getStats(): Promise<ProviderStats> {
        const successRate = this.stats.requestCount > 0
            ? this.stats.successCount / this.stats.requestCount
            : 0;

        return {
            name: this.name,
            type: 'thordata',
            status: this.isInitialized && !this.errorMessage ? 'active' :
                this.errorMessage ? 'error' : 'inactive',
            totalProxies: 1, // Rotating proxy = infinite proxies
            activeProxies: this.isInitialized ? 1 : 0,
            avgLatency: 0, // Not tracked
            successRate,
            lastRefresh: this.lastRefresh,
            error: this.errorMessage
        };
    }

    /**
     * Reset session counter
     */
    resetSessionCounter(): void {
        this.sessionCounter = 0;
    }

    /**
     * Get current session counter value
     */
    getSessionCounter(): number {
        return this.sessionCounter;
    }
}
