import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export interface CacheEntry {
    url: string;
    data: any;
    timestamp: number;
}

export class CacheService {
    private db: Database.Database;
    private readonly TTL_MS = 10 * 60 * 1000; // 10 minutes

    constructor() {
        const dbPath = path.join(__dirname, '../../data/cache.db');
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        this.db = new Database(dbPath);
        this.initialize();
    }

    private initialize() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS cache (
                url TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            )
        `);
        // Periodic cleanup
        setInterval(() => this.cleanup(), 60 * 1000); // Check every minute
    }

    get(url: string): any | null {
        try {
            const row = this.db.prepare('SELECT data, timestamp FROM cache WHERE url = ?').get(url) as any;

            if (!row) return null;

            if (Date.now() - row.timestamp > this.TTL_MS) {
                this.delete(url);
                return null;
            }

            return JSON.parse(row.data);
        } catch (e) {
            console.error('Cache get error:', e);
            return null;
        }
    }

    set(url: string, data: any) {
        try {
            const stmt = this.db.prepare('INSERT OR REPLACE INTO cache (url, data, timestamp) VALUES (?, ?, ?)');
            stmt.run(url, JSON.stringify(data), Date.now());
        } catch (e) {
            console.error('Cache set error:', e);
        }
    }

    delete(url: string) {
        try {
            this.db.prepare('DELETE FROM cache WHERE url = ?').run(url);
        } catch (e) {
            console.error('Cache delete error:', e);
        }
    }

    private cleanup() {
        try {
            const cutoff = Date.now() - this.TTL_MS;
            this.db.prepare('DELETE FROM cache WHERE timestamp < ?').run(cutoff);
        } catch (e) {
            console.error('Cache cleanup error:', e);
        }
    }
}
