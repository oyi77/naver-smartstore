interface ProxyConfig {
    name: string;
    host?: string;
    port?: string;
    user?: string;
    pass?: string;
}

interface BlacklistEntry {
    timestamp: number;
    reason: string;
}

export class ProxyBlacklistManager {
    private static instance: ProxyBlacklistManager;
    private blacklistMap: Map<string, BlacklistEntry>;
    private readonly TTL_MS = 3600 * 1000; // 1 hour

    private constructor() {
        this.blacklistMap = new Map();
    }

    public static getInstance(): ProxyBlacklistManager {
        if (!ProxyBlacklistManager.instance) {
            ProxyBlacklistManager.instance = new ProxyBlacklistManager();
        }
        return ProxyBlacklistManager.instance;
    }

    /**
     * Generate a unique identifier for a proxy based on host:port
     */
    private getProxyIdentifier(proxy: ProxyConfig): string {
        if (proxy.host && proxy.port) {
            return `${proxy.host}:${proxy.port}`;
        }
        return proxy.name || 'Direct';
    }

    /**
     * Add a proxy to the blacklist
     */
    public blacklist(proxy: ProxyConfig, reason: string = 'HTTP 429'): void {
        const identifier = this.getProxyIdentifier(proxy);

        // Don't blacklist "Direct" connection
        if (identifier === 'Direct' || !proxy.host) {
            return;
        }

        this.blacklistMap.set(identifier, {
            timestamp: Date.now(),
            reason
        });

        console.log(`[Blacklist] Blacklisted proxy: ${identifier} (reason: ${reason})`);
    }

    /**
     * Check if a proxy is currently blacklisted
     * Automatically cleans up expired entries
     */
    public isBlacklisted(proxy: ProxyConfig): boolean {
        const identifier = this.getProxyIdentifier(proxy);

        // Direct connection is never blacklisted
        if (identifier === 'Direct' || !proxy.host) {
            return false;
        }

        const entry = this.blacklistMap.get(identifier);

        if (!entry) {
            return false;
        }

        // Check if entry has expired
        const now = Date.now();
        if (now - entry.timestamp > this.TTL_MS) {
            this.blacklistMap.delete(identifier);
            console.log(`[Blacklist] Removed expired entry: ${identifier}`);
            return false;
        }

        return true;
    }

    /**
     * Get the count of currently blacklisted proxies (excluding expired)
     */
    public getBlacklistedCount(): number {
        this.clearExpired();
        return this.blacklistMap.size;
    }

    /**
     * Clear all expired entries from the blacklist
     */
    public clearExpired(): void {
        const now = Date.now();
        const toDelete: string[] = [];

        for (const [identifier, entry] of this.blacklistMap.entries()) {
            if (now - entry.timestamp > this.TTL_MS) {
                toDelete.push(identifier);
            }
        }

        toDelete.forEach(identifier => {
            this.blacklistMap.delete(identifier);
            console.log(`[Blacklist] Removed expired entry: ${identifier}`);
        });
    }

    /**
     * Get all currently blacklisted proxies (for debugging)
     */
    public getBlacklist(): Array<{ identifier: string; reason: string; age: number }> {
        this.clearExpired();
        const now = Date.now();
        const result: Array<{ identifier: string; reason: string; age: number }> = [];

        for (const [identifier, entry] of this.blacklistMap.entries()) {
            result.push({
                identifier,
                reason: entry.reason,
                age: Math.floor((now - entry.timestamp) / 1000) // age in seconds
            });
        }

        return result;
    }

    /**
     * Manually clear the entire blacklist (for testing/debugging)
     */
    public clear(): void {
        this.blacklistMap.clear();
        console.log(`[Blacklist] Cleared all entries`);
    }
}
