import * as fs from 'fs';
import * as path from 'path';
import { RawProxy, ProxyFormat, ProxyParseResult } from './types';

/**
 * ProxyParser - Unified parser for multiple proxy formats
 * Supports: JSON, TXT, CSV, and inline proxy strings
 */
export class ProxyParser {
    /**
     * Parse proxy file (auto-detects format)
     */
    static async parseFile(filePath: string): Promise<ProxyParseResult> {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const format = this.detectFormat(content, filePath);
        return this.parseString(content, format);
    }

    /**
     * Parse proxy string with optional format hint
     */
    static parseString(content: string, format?: ProxyFormat): Promise<ProxyParseResult> {
        const detectedFormat = format || this.detectFormat(content);
        const errors: string[] = [];
        let proxies: RawProxy[] = [];

        try {
            switch (detectedFormat) {
                case ProxyFormat.JSON:
                    proxies = this.parseJSON(content, errors);
                    break;
                case ProxyFormat.CSV:
                    proxies = this.parseCSV(content, errors);
                    break;
                case ProxyFormat.TXT:
                case ProxyFormat.INLINE:
                    proxies = this.parseTXT(content, errors);
                    break;
                default:
                    // Try TXT as fallback
                    proxies = this.parseTXT(content, errors);
            }
        } catch (e: any) {
            errors.push(`Parse error: ${e.message}`);
        }

        return Promise.resolve({
            proxies,
            format: detectedFormat,
            errors,
            total: proxies.length + errors.length,
            valid: proxies.length
        });
    }

    /**
     * Parse single inline proxy string
     * Supports: protocol://user:pass@host:port, user:pass@host:port, host:port
     */
    static parseInline(proxyString: string): RawProxy | null {
        const trimmed = proxyString.trim();
        if (!trimmed) return null;

        try {
            // Try URL format with protocol: protocol://user:pass@host:port
            if (trimmed.includes('://')) {
                const url = new URL(trimmed);
                const protocol = url.protocol.replace(':', '') as any;

                // Validate protocol
                if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
                    return null;
                }

                return {
                    host: url.hostname,
                    port: parseInt(url.port) || this.getDefaultPort(protocol),
                    protocol: protocol,
                    source: 'inline',
                    username: url.username || undefined,
                    password: url.password || undefined
                };
            }

            // Try username:password@host:port format
            const authMatch = trimmed.match(/^([^:]+):([^@]+)@([^:]+):(\d+)$/);
            if (authMatch) {
                return {
                    host: authMatch[3],
                    port: parseInt(authMatch[4]),
                    protocol: 'http', // default
                    source: 'inline',
                    username: authMatch[1],
                    password: authMatch[2]
                };
            }

            // Try host:port format
            const basicMatch = trimmed.match(/^([^:]+):(\d+)$/);
            if (basicMatch) {
                return {
                    host: basicMatch[1],
                    port: parseInt(basicMatch[2]),
                    protocol: 'http', // default
                    source: 'inline'
                };
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Detect proxy format from content
     */
    static detectFormat(content: string, filename?: string): ProxyFormat {
        const trimmed = content.trim();

        // Check file extension first
        if (filename) {
            const ext = path.extname(filename).toLowerCase();
            if (ext === '.json') return ProxyFormat.JSON;
            if (ext === '.csv') return ProxyFormat.CSV;
            if (ext === '.txt') return ProxyFormat.TXT;
        }

        // Check content structure
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                JSON.parse(trimmed);
                return ProxyFormat.JSON;
            } catch {
                // Not valid JSON
            }
        }

        // Check for CSV (look for commas in first few lines)
        const firstLines = trimmed.split('\n').slice(0, 5);
        const hasCommas = firstLines.some(line => line.split(',').length >= 2);
        if (hasCommas) {
            return ProxyFormat.CSV;
        }

        // Default to TXT
        return ProxyFormat.TXT;
    }

    /**
     * Parse JSON format
     * Supports: array of objects, object with proxies array, array of strings
     */
    private static parseJSON(content: string, errors: string[]): RawProxy[] {
        const proxies: RawProxy[] = [];

        try {
            const data = JSON.parse(content);

            // Handle array
            if (Array.isArray(data)) {
                for (let i = 0; i < data.length; i++) {
                    const item = data[i];

                    // Object format
                    if (typeof item === 'object') {
                        const proxy = this.parseJSONObject(item, errors, `[${i}]`);
                        if (proxy) proxies.push(proxy);
                    }
                    // String format
                    else if (typeof item === 'string') {
                        const proxy = this.parseInline(item);
                        if (proxy) {
                            proxy.source = 'json';
                            proxies.push(proxy);
                        } else {
                            errors.push(`Invalid proxy string at [${i}]: ${item}`);
                        }
                    }
                }
            }
            // Handle object with 'proxies' array
            else if (data.proxies && Array.isArray(data.proxies)) {
                for (let i = 0; i < data.proxies.length; i++) {
                    const proxy = this.parseJSONObject(data.proxies[i], errors, `proxies[${i}]`);
                    if (proxy) proxies.push(proxy);
                }
            }
            // Handle single object
            else if (typeof data === 'object') {
                const proxy = this.parseJSONObject(data, errors, 'root');
                if (proxy) proxies.push(proxy);
            }
        } catch (e: any) {
            errors.push(`JSON parse error: ${e.message}`);
        }

        return proxies;
    }

    /**
     * Parse a single JSON object into RawProxy
     */
    private static parseJSONObject(obj: any, errors: string[], path: string): RawProxy | null {
        // Support both 'host' and 'ip' fields
        const host = obj.host || obj.ip || obj.hostname;
        const port = obj.port;

        if (!host || !port) {
            errors.push(`Missing host/port at ${path}`);
            return null;
        }

        const protocol = (obj.protocol || 'http').toLowerCase();
        if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
            errors.push(`Invalid protocol at ${path}: ${protocol}`);
            return null;
        }

        return {
            host: String(host),
            port: parseInt(port),
            protocol: protocol as any,
            source: obj.source || 'json',
            username: obj.username || obj.user,
            password: obj.password || obj.pass,
            country: obj.country,
            anonymity: obj.anonymity
        };
    }

    /**
     * Parse TXT format (one proxy per line)
     * Supports all inline formats
     */
    private static parseTXT(content: string, errors: string[]): RawProxy[] {
        const proxies: RawProxy[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Skip empty lines and comments
            if (!line || line.startsWith('#') || line.startsWith('//')) {
                continue;
            }

            const proxy = this.parseInline(line);
            if (proxy) {
                proxy.source = 'txt';
                proxies.push(proxy);
            } else {
                errors.push(`Invalid proxy at line ${i + 1}: ${line}`);
            }
        }

        return proxies;
    }

    /**
     * Parse CSV format
     * Auto-detects headers or uses positional parsing
     * Expected columns: host,port,protocol,username,password (any order if headers present)
     */
    private static parseCSV(content: string, errors: string[]): RawProxy[] {
        const proxies: RawProxy[] = [];
        const lines = content.split('\n').map(l => l.trim()).filter(l => l);

        if (lines.length === 0) return proxies;

        // Check if first line is header
        const firstLine = lines[0].toLowerCase();
        const hasHeader = firstLine.includes('host') || firstLine.includes('ip') ||
            firstLine.includes('port') || firstLine.includes('protocol');

        let headers: string[] = [];
        let startIndex = 0;

        if (hasHeader) {
            headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            startIndex = 1;
        } else {
            // Default column order: host, port, protocol, username, password
            headers = ['host', 'port', 'protocol', 'username', 'password'];
        }

        // Find column indices
        const hostIdx = headers.findIndex(h => h === 'host' || h === 'ip' || h === 'hostname');
        const portIdx = headers.findIndex(h => h === 'port');
        const protocolIdx = headers.findIndex(h => h === 'protocol' || h === 'type');
        const userIdx = headers.findIndex(h => h === 'username' || h === 'user');
        const passIdx = headers.findIndex(h => h === 'password' || h === 'pass');

        if (hostIdx === -1 || portIdx === -1) {
            errors.push('CSV must have host and port columns');
            return proxies;
        }

        // Parse data rows
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            if (!line || line.startsWith('#')) continue;

            const cols = line.split(',').map(c => c.trim());

            const host = cols[hostIdx];
            const port = parseInt(cols[portIdx]);
            const protocol = protocolIdx >= 0 ? cols[protocolIdx]?.toLowerCase() : 'http';
            const username = userIdx >= 0 ? cols[userIdx] : undefined;
            const password = passIdx >= 0 ? cols[passIdx] : undefined;

            if (!host || !port || isNaN(port)) {
                errors.push(`Invalid data at line ${i + 1}: ${line}`);
                continue;
            }

            if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
                errors.push(`Invalid protocol at line ${i + 1}: ${protocol}`);
                continue;
            }

            proxies.push({
                host,
                port,
                protocol: protocol as any,
                source: 'csv',
                username,
                password
            });
        }

        return proxies;
    }

    /**
     * Get default port for protocol
     */
    private static getDefaultPort(protocol: string): number {
        switch (protocol) {
            case 'http': return 80;
            case 'https': return 443;
            case 'socks4':
            case 'socks5': return 1080;
            default: return 8080;
        }
    }

    /**
     * Validate proxy object
     */
    static isValidProxy(proxy: any): proxy is RawProxy {
        return proxy &&
            typeof proxy.host === 'string' &&
            typeof proxy.port === 'number' &&
            proxy.port > 0 &&
            proxy.port < 65536 &&
            ['http', 'https', 'socks4', 'socks5'].includes(proxy.protocol);
    }
}
