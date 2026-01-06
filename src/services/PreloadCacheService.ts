import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface StoreMetadata {
    storeUrl: string;
    channelId: string;
    timestamp: number;
}

export interface PreloadEntry {
    storeUrl: string;
    productId: string;
    partialData: any;
    timestamp: number;
}

/**
 * PreloadCacheService manages:
 * 1. Store metadata (storeUrl -> channelId) with longer TTL (default 24 hours)
 * 2. Preload product data (storeUrl + productId -> partial) with shorter TTL (default 15 minutes)
 * 
 * Uses two-tier caching: L1 in-memory (fast) + L2 SQLite (persistent)
 */
export class PreloadCacheService {
    private static instance: PreloadCacheService | null = null;
    private db: Database.Database;
    
    // L1 In-memory caches
    private storeMetadataCache: Map<string, StoreMetadata> = new Map();
    private preloadCache: Map<string, PreloadEntry> = new Map();
    
    // TTLs in minutes
    private readonly storeMetadataTTL: number;
    private readonly preloadTTL: number;
    
    private readonly dbPath: string;

    private constructor() {
        const dbDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
        this.dbPath = path.join(dbDir, 'preload_cache.db');

        // Parse TTLs from env or use defaults
        this.storeMetadataTTL = parseInt(process.env.PRELOAD_STORE_TTL || '1440'); // 24 hours default
        this.preloadTTL = parseInt(process.env.PRELOAD_PRODUCT_TTL || '15'); // 15 minutes default

        console.log(`[PreloadCache] 📂 Using database: ${this.dbPath}`);
        console.log(`[PreloadCache] ⏱️ Store metadata TTL: ${this.storeMetadataTTL} min, Preload TTL: ${this.preloadTTL} min`);

        try {
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            this.db = new Database(this.dbPath);
            this.initialize();
            this.loadFromDatabase();
        } catch (error: any) {
            console.error(`[PreloadCache] ❌ Failed to initialize:`, error.message);
            throw error;
        }
    }

    static getInstance(): PreloadCacheService {
        if (!PreloadCacheService.instance) {
            PreloadCacheService.instance = new PreloadCacheService();
        }
        return PreloadCacheService.instance;
    }

    private initialize() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS store_metadata (
                store_url TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            
            CREATE TABLE IF NOT EXISTS preload_data (
                key TEXT PRIMARY KEY,
                store_url TEXT NOT NULL,
                product_id TEXT NOT NULL,
                partial_data TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            
            CREATE INDEX IF NOT EXISTS idx_preload_store_product ON preload_data(store_url, product_id);
        `);

        // Periodic cleanup
        setInterval(() => this.cleanup(), 5 * 60 * 1000); // Every 5 minutes
    }

    private loadFromDatabase() {
        try {
            // Load store metadata
            const storeRows = this.db.prepare('SELECT store_url, channel_id, timestamp FROM store_metadata').all() as any[];
            for (const row of storeRows) {
                if (this.isStoreMetadataValid(row.timestamp)) {
                    this.storeMetadataCache.set(row.store_url, {
                        storeUrl: row.store_url,
                        channelId: row.channel_id,
                        timestamp: row.timestamp
                    });
                }
            }

            // Load preload data
            const preloadRows = this.db.prepare('SELECT key, store_url, product_id, partial_data, timestamp FROM preload_data').all() as any[];
            for (const row of preloadRows) {
                if (this.isPreloadValid(row.timestamp)) {
                    try {
                        this.preloadCache.set(row.key, {
                            storeUrl: row.store_url,
                            productId: row.product_id,
                            partialData: JSON.parse(row.partial_data),
                            timestamp: row.timestamp
                        });
                    } catch (e) {
                        // Skip invalid JSON
                    }
                }
            }

            console.log(`[PreloadCache] 📂 Loaded ${this.storeMetadataCache.size} store metadata, ${this.preloadCache.size} preload entries`);
        } catch (e: any) {
            console.warn(`[PreloadCache] ⚠️ Failed to load from database: ${e.message}`);
        }
    }

    // Store Metadata Methods
    getChannelId(storeUrl: string): string | null {
        const normalized = this.normalizeStoreUrl(storeUrl);
        const cached = this.storeMetadataCache.get(normalized);
        
        if (!cached) return null;
        if (!this.isStoreMetadataValid(cached.timestamp)) {
            this.storeMetadataCache.delete(normalized);
            return null;
        }
        
        return cached.channelId;
    }

    setChannelId(storeUrl: string, channelId: string): void {
        const normalized = this.normalizeStoreUrl(storeUrl);
        const metadata: StoreMetadata = {
            storeUrl: normalized,
            channelId,
            timestamp: Date.now()
        };

        // L1 cache
        this.storeMetadataCache.set(normalized, metadata);

        // L2 database
        try {
            const stmt = this.db.prepare('INSERT OR REPLACE INTO store_metadata (store_url, channel_id, timestamp) VALUES (?, ?, ?)');
            stmt.run(normalized, channelId, metadata.timestamp);
        } catch (e: any) {
            console.error(`[PreloadCache] Failed to save store metadata: ${e.message}`);
        }
    }

    // Preload Data Methods
    getPreload(storeUrl: string, productId: string): any | null {
        const key = this.getPreloadKey(storeUrl, productId);
        const cached = this.preloadCache.get(key);
        
        if (!cached) return null;
        if (!this.isPreloadValid(cached.timestamp)) {
            this.preloadCache.delete(key);
            return null;
        }
        
        return cached.partialData;
    }

    setPreload(storeUrl: string, productId: string, partialData: any): void {
        const normalized = this.normalizeStoreUrl(storeUrl);
        const key = this.getPreloadKey(normalized, productId);
        const entry: PreloadEntry = {
            storeUrl: normalized,
            productId,
            partialData,
            timestamp: Date.now()
        };

        // L1 cache
        this.preloadCache.set(key, entry);

        // L2 database
        try {
            const stmt = this.db.prepare('INSERT OR REPLACE INTO preload_data (key, store_url, product_id, partial_data, timestamp) VALUES (?, ?, ?, ?, ?)');
            stmt.run(key, normalized, productId, JSON.stringify(partialData), entry.timestamp);
        } catch (e: any) {
            console.error(`[PreloadCache] Failed to save preload: ${e.message}`);
        }
    }

    /**
     * Batch set preloads from a productsMap (from store page __PRELOADED_STATE__)
     */
    setPreloadsFromMap(storeUrl: string, productsMap: Record<string, any>): void {
        const normalized = this.normalizeStoreUrl(storeUrl);
        const timestamp = Date.now();
        const entries: PreloadEntry[] = [];

        for (const [productId, productData] of Object.entries(productsMap)) {
            const key = this.getPreloadKey(normalized, productId);
            const entry: PreloadEntry = {
                storeUrl: normalized,
                productId,
                partialData: { id: productId, ...productData, _isPartial: true },
                timestamp
            };
            this.preloadCache.set(key, entry);
            entries.push(entry);
        }

        // Batch insert to database
        if (entries.length > 0) {
            try {
                const stmt = this.db.prepare('INSERT OR REPLACE INTO preload_data (key, store_url, product_id, partial_data, timestamp) VALUES (?, ?, ?, ?, ?)');
                const transaction = this.db.transaction((entries: PreloadEntry[]) => {
                    for (const entry of entries) {
                        const key = this.getPreloadKey(entry.storeUrl, entry.productId);
                        stmt.run(key, entry.storeUrl, entry.productId, JSON.stringify(entry.partialData), entry.timestamp);
                    }
                });
                transaction(entries);
                console.log(`[PreloadCache] 💾 Saved ${entries.length} preload entries for store ${normalized}`);
            } catch (e: any) {
                console.error(`[PreloadCache] Failed to batch save preloads: ${e.message}`);
            }
        }
    }

    // Helper methods
    private getPreloadKey(storeUrl: string, productId: string): string {
        return `${this.normalizeStoreUrl(storeUrl)}::${productId}`;
    }

    private normalizeStoreUrl(url: string): string {
        // Remove trailing slash, normalize protocol
        return url.replace(/\/$/, '').toLowerCase();
    }

    private isStoreMetadataValid(timestamp: number): boolean {
        const age = Date.now() - timestamp;
        return age < (this.storeMetadataTTL * 60 * 1000);
    }

    private isPreloadValid(timestamp: number): boolean {
        const age = Date.now() - timestamp;
        return age < (this.preloadTTL * 60 * 1000);
    }

    private cleanup() {
        try {
            const now = Date.now();
            
            // Cleanup store metadata
            const storeCutoff = now - (this.storeMetadataTTL * 60 * 1000);
            for (const [url, metadata] of this.storeMetadataCache.entries()) {
                if (metadata.timestamp < storeCutoff) {
                    this.storeMetadataCache.delete(url);
                }
            }
            this.db.prepare('DELETE FROM store_metadata WHERE timestamp < ?').run(storeCutoff);

            // Cleanup preload data
            const preloadCutoff = now - (this.preloadTTL * 60 * 1000);
            for (const [key, entry] of this.preloadCache.entries()) {
                if (entry.timestamp < preloadCutoff) {
                    this.preloadCache.delete(key);
                }
            }
            this.db.prepare('DELETE FROM preload_data WHERE timestamp < ?').run(preloadCutoff);
        } catch (e: any) {
            console.error(`[PreloadCache] Cleanup error: ${e.message}`);
        }
    }

    getStats(): { storeMetadata: number; preloads: number } {
        return {
            storeMetadata: this.storeMetadataCache.size,
            preloads: this.preloadCache.size
        };
    }
}

