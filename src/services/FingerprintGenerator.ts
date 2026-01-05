import UserAgent from 'user-agents';

export interface BrowserFingerprint {
    userAgent: string;
    viewport: {
        width: number;
        height: number;
    };
    platform: string;
}

export class FingerprintGenerator {
    private static instance: FingerprintGenerator;

    // Common desktop resolutions with their relative popularity
    private readonly COMMON_RESOLUTIONS = [
        { width: 1920, height: 1080, weight: 40 },  // Full HD (most common)
        { width: 1366, height: 768, weight: 20 },   // HD (laptops)
        { width: 1536, height: 864, weight: 15 },   // HD+ (laptops)
        { width: 1440, height: 900, weight: 10 },   // MacBook
        { width: 2560, height: 1440, weight: 10 },  // 2K
        { width: 1600, height: 900, weight: 5 },    // HD+
    ];

    private constructor() { }

    public static getInstance(): FingerprintGenerator {
        if (!FingerprintGenerator.instance) {
            FingerprintGenerator.instance = new FingerprintGenerator();
        }
        return FingerprintGenerator.instance;
    }

    /**
     * Generate a random user agent for desktop browsers
     * Focuses on Chrome/Edge on Windows/Mac for realism
     */
    public generateUserAgent(): string {
        let userAgent;
        let uaStr = '';

        // Loop until we get a non-Linux Chrome/Edge desktop UA
        let attempts = 0;
        while (attempts < 20) {
            userAgent = new UserAgent({ deviceCategory: 'desktop' });
            uaStr = userAgent.toString();
            if (!uaStr.includes('Linux') && (uaStr.includes('Chrome') || uaStr.includes('Edg'))) break;
            attempts++;
        }

        // Cap Chrome version with realistic 4-part version
        uaStr = uaStr.replace(/Chrome\/[\d.]+/g, (match) => {
            const versionMatch = match.match(/\d+/);
            if (versionMatch && parseInt(versionMatch[0]) > 131) {
                return `Chrome/131.0.6778.${Math.floor(Math.random() * 100) + 100}`;
            }
            return match;
        });

        // Cap Edge version with realistic 4-part version
        uaStr = uaStr.replace(/Edg\/[\d.]+/g, (match) => {
            const versionMatch = match.match(/\d+/);
            if (versionMatch && parseInt(versionMatch[0]) > 131) {
                return `Edg/131.0.2903.${Math.floor(Math.random() * 50) + 50}`;
            }
            return match;
        });

        return uaStr;
    }

    /**
     * Generate a random viewport size based on common desktop resolutions
     * Adds small random variations to avoid exact matches
     */
    public generateViewport(): { width: number; height: number } {
        // Weighted random selection
        const totalWeight = this.COMMON_RESOLUTIONS.reduce((sum, res) => sum + res.weight, 0);
        let random = Math.random() * totalWeight;

        let selectedResolution = this.COMMON_RESOLUTIONS[0];
        for (const resolution of this.COMMON_RESOLUTIONS) {
            random -= resolution.weight;
            if (random <= 0) {
                selectedResolution = resolution;
                break;
            }
        }

        // Add small random variation (±10 pixels) to avoid exact matches
        const widthVariation = Math.floor(Math.random() * 21) - 10; // -10 to +10
        const heightVariation = Math.floor(Math.random() * 21) - 10;

        return {
            width: Math.max(1024, selectedResolution.width + widthVariation),
            height: Math.max(768, selectedResolution.height + heightVariation)
        };
    }

    /**
     * Extract platform from user agent string
     */
    private extractPlatform(userAgent: string): string {
        if (userAgent.includes('Windows')) return 'Win32';
        if (userAgent.includes('Macintosh') || userAgent.includes('Mac OS')) return 'MacIntel';
        if (userAgent.includes('Linux')) return 'Linux x86_64';
        return 'Win32'; // Default fallback
    }

    /**
     * Generate a complete browser fingerprint
     */
    public generateFingerprint(): BrowserFingerprint {
        const userAgent = this.generateUserAgent();
        const viewport = this.generateViewport();
        const platform = this.extractPlatform(userAgent);

        return {
            userAgent,
            viewport,
            platform
        };
    }

    /**
     * Get a list of common resolutions (for debugging/testing)
     */
    public getCommonResolutions(): Array<{ width: number; height: number }> {
        return this.COMMON_RESOLUTIONS.map(({ width, height }) => ({ width, height }));
    }
}
