import { BaseRotatingProxyProvider } from './BaseProvider';
import { WebshareProvider } from './WebshareProvider';
import { ThordataProvider } from './ThordataProvider';

/**
 * Factory for creating rotating proxy providers
 */
export class ProviderFactory {
    private static providers = new Map<string, new (name: string) => BaseRotatingProxyProvider>([
        ['webshare', WebshareProvider as new (name: string) => BaseRotatingProxyProvider],
        ['thordata', ThordataProvider as new (name: string) => BaseRotatingProxyProvider],
        ['smartproxy', ThordataProvider as new (name: string) => BaseRotatingProxyProvider],
    ]);

    /**
     * Create a provider instance
     */
    static createProvider(type: string, name?: string): BaseRotatingProxyProvider {
        const normalizedType = type.toLowerCase();
        const ProviderClass = this.providers.get(normalizedType);

        if (!ProviderClass) {
            throw new Error(`Unknown provider type: ${type}. Supported: ${this.getSupportedProviders().join(', ')}`);
        }

        return new ProviderClass(name || normalizedType);
    }

    /**
     * Register a custom provider
     */
    static registerProvider(type: string, providerClass: new (name: string) => BaseRotatingProxyProvider): void {
        this.providers.set(type.toLowerCase(), providerClass);
    }

    /**
     * Get list of supported provider types
     */
    static getSupportedProviders(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Check if a provider type is supported
     */
    static isSupported(type: string): boolean {
        return this.providers.has(type.toLowerCase());
    }
}
