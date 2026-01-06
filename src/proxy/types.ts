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
    isRotating?: boolean;
    rotatingConfig?: RotatingProxyConfig;
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
    lastUsed?: Date;
    penaltyUntil?: Date;
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

// ============================================================================
// Rotating Proxy Types
// ============================================================================

export interface RotatingProxyConfig {
    providerId: string;
    providerType: 'webshare' | 'thordata' | 'custom';
    refreshInterval?: number; // ms between proxy refreshes
}

export interface ProviderStats {
    name: string;
    type: string;
    status: 'active' | 'inactive' | 'error';
    totalProxies: number;
    activeProxies: number;
    avgLatency: number;
    successRate: number;
    lastRefresh?: Date;
    error?: string;
}

// ============================================================================
// Provider Configuration Types
// ============================================================================

export interface WebshareConfig {
    apiKey: string;
    apiUrl?: string; // default: https://proxy.webshare.io/api/v2/
    mode?: 'rotating' | 'list'; // rotating = use rotating endpoint, list = fetch list
    country?: string;
    protocol?: 'http' | 'socks5';
    autoRefresh?: boolean;
    refreshInterval?: number; // seconds
}

export interface ThordataConfig {
    username: string;
    password: string;
    endpoint: string; // e.g., gate.smartproxy.com:7000
    country?: string;
    sessionPrefix?: string; // For session-based rotation
    protocol?: 'http' | 'socks5';
}

export interface CustomProviderConfig {
    name: string;
    endpoint: string;
    authHeader?: string;
    format?: ProxyFormat;
    refreshInterval?: number;
}

// ============================================================================
// Parser Types
// ============================================================================

export enum ProxyFormat {
    JSON = 'json',
    TXT = 'txt',
    CSV = 'csv',
    INLINE = 'inline',
    UNKNOWN = 'unknown'
}

export interface ProxyParseResult {
    proxies: RawProxy[];
    format: ProxyFormat;
    errors: string[];
    total: number;
    valid: number;
}

// ============================================================================
// Rotation Strategy Types
// ============================================================================

export enum RotationStrategy {
    ROUND_ROBIN = 'ROUND_ROBIN',
    LATENCY_BASED = 'LATENCY_BASED',
    WEIGHTED = 'WEIGHTED',
    STICKY_SESSION = 'STICKY_SESSION',
    RANDOM = 'RANDOM'
}

// ============================================================================
// Metrics Types
// ============================================================================

export interface ProxyMetrics {
    totalProxies: number;
    naverReady: number;
    byProtocol: Record<string, number>;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    rotatingProviders: number;
    avgLatency: number;
    successRate: number;
    lastValidation?: Date;
    validationDuration?: number;
}

export interface ProxyPoolConfig {
    maxSize: number;
    minSize: number;
    validationInterval: number; // ms
    revalidationThreshold: number; // ms
    batchSize: number;
    rotationStrategy: RotationStrategy;
}
