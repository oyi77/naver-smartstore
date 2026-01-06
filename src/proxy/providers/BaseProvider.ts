import { RawProxy, ProviderStats } from '../types';

/**
 * Base abstract class for rotating proxy providers
 */
export abstract class BaseRotatingProxyProvider {
    protected name: string;
    protected config: any;
    protected isInitialized: boolean = false;
    protected lastRefresh?: Date;
    protected errorMessage?: string;

    constructor(name: string) {
        this.name = name;
    }

    /**
     * Get provider name
     */
    getName(): string {
        return this.name;
    }

    /**
     * Initialize the provider with configuration
     */
    abstract initialize(config: any): Promise<void>;

    /**
     * Get a proxy from the provider
     * Returns null if no proxies available
     */
    abstract getProxy(): Promise<RawProxy | null>;

    /**
     * Release/return a proxy (for providers that track usage)
     */
    async releaseProxy(proxy: RawProxy): Promise<void> {
        // Default: no-op, override if needed
    }

    /**
     * Mark a proxy as bad/failed
     */
    async markProxyBad(proxy: RawProxy): Promise<void> {
        // Default: no-op, override if needed
    }

    /**
     * Refresh proxy list (for providers that cache)
     */
    async refresh(): Promise<void> {
        // Default: no-op, override if needed
    }

    /**
     * Health check - verify provider is operational
     */
    abstract healthCheck(): Promise<boolean>;

    /**
     * Get provider statistics
     */
    abstract getStats(): Promise<ProviderStats>;

    /**
     * Shutdown/cleanup provider
     */
    async shutdown(): Promise<void> {
        this.isInitialized = false;
    }

    /**
     * Check if provider is initialized
     */
    isReady(): boolean {
        return this.isInitialized;
    }

    /**
     * Set error message
     */
    protected setError(message: string): void {
        this.errorMessage = message;
        console.error(`[${this.name}] Error: ${message}`);
    }

    /**
     * Clear error message
     */
    protected clearError(): void {
        this.errorMessage = undefined;
    }
}
