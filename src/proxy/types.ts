// Proxy types for the multi-browser architecture

export interface RawProxy {
    host: string;
    port: number;
    protocol: 'http' | 'https' | 'socks4' | 'socks5';
    country?: string;
    anonymity?: string;
    source: string;
    username?: string;
    password?: string;
}

export interface ValidatedProxy extends RawProxy {
    latency: number;
    lastValidated: Date;
    successCount: number;
    failCount: number;
    isActive: boolean;
    // Enhanced validation fields
    ipType: 'residential' | 'datacenter' | 'unknown';
    canAccessNaver: boolean;
    isp?: string;
    org?: string;
}

export interface ProxyTestResult {
    success: boolean;
    latency: number;
    error?: string;
    ipType?: 'residential' | 'datacenter' | 'unknown';
    canAccessNaver?: boolean;
    isp?: string;
    org?: string;
}

export interface BrowserProfile {
    name: string;
    userAgent: string;
    viewport: { width: number; height: number };
    platform: string;
    vendor: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number;
    secChUa: string;
    secChUaPlatform: string;
}
