import { BrowserProfile } from '../proxy/types';
import UserAgent from 'user-agents';
import * as fs from 'fs';
import * as path from 'path';

// Pool of realistic browser profiles for fingerprint diversity
export const BROWSER_PROFILES: BrowserProfile[] = [
    // Windows profiles only to match host OS and avoid fingerprint leaks (fonts, scrollbars, etc)
    {
        name: 'Windows Chrome 143',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        platform: 'Win32',
        vendor: 'Google Inc.',
        languages: ['ko-KR', 'ko', 'en-US', 'en'],
        hardwareConcurrency: 12,
        deviceMemory: 16,
        secChUa: '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        secChUaPlatform: '"Windows"'
    },
    {
        name: 'Windows Chrome 142',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 768 },
        platform: 'Win32',
        vendor: 'Google Inc.',
        languages: ['ko-KR', 'ko', 'en-US', 'en'],
        hardwareConcurrency: 8,
        deviceMemory: 8,
        secChUa: '"Google Chrome";v="142", "Chromium";v="142", "Not A(Brand";v="24"',
        secChUaPlatform: '"Windows"'
    },
    {
        name: 'Windows Edge 143',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        viewport: { width: 1920, height: 1080 },
        platform: 'Win32',
        vendor: 'Google Inc.',
        languages: ['ko-KR', 'ko', 'en-US', 'en'],
        hardwareConcurrency: 16,
        deviceMemory: 32,
        secChUa: '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        secChUaPlatform: '"Windows"'
    },
    {
        name: 'Mac Chrome 143',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        platform: 'MacIntel',
        vendor: 'Google Inc.',
        languages: ['ko-KR', 'ko', 'en-US', 'en'],
        hardwareConcurrency: 8,
        deviceMemory: 8,
        secChUa: '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
        secChUaPlatform: '"macOS"'
    }
];

export class ProfileManager {
    private usedProfiles: Set<number> = new Set();
    private workingUAs: Set<string> = new Set();
    private whitelistFile = path.join(__dirname, '../../data/ua_whitelist.json');

    constructor() {
        this.loadWhitelist();
    }

    getRandomProfile(): BrowserProfile {
        // Prefer known-good UAs (80% of the time if we have any)
        if (this.workingUAs.size > 0 && Math.random() < 0.8) {
            // Try to get a whitelisted UA
            const workingProfile = this.getFromWhitelist();
            if (workingProfile) {
                return workingProfile;
            }
        }

        // Otherwise, try dynamic profile for discovery (50% chance)
        if (Math.random() > 0.5) {
            try {
                return this.generateDynamicProfile();
            } catch (e) {
                console.warn('Failed to generate dynamic profile, falling back to static');
            }
        }

        // Fallback to static profiles
        const availableIndices = BROWSER_PROFILES
            .map((_, i) => i)
            .filter(i => !this.usedProfiles.has(i));

        // If all profiles used, reset
        if (availableIndices.length === 0) {
            this.usedProfiles.clear();
            return this.getRandomProfile();
        }

        const randomIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
        this.usedProfiles.add(randomIndex);

        return BROWSER_PROFILES[randomIndex];
    }

    /**
     * Get a profile from the whitelist (known-good UAs)
     */
    private getFromWhitelist(): BrowserProfile | null {
        // Find a static profile that's in the whitelist
        for (const profile of BROWSER_PROFILES) {
            if (this.workingUAs.has(profile.userAgent)) {
                return profile;
            }
        }
        return null;
    }

    /**
     * Generates a fresh, valid profile using user-agents library
     * WITH correct Client Hints which the library normally misses
     */
    generateDynamicProfile(): BrowserProfile {
        // Generate a desktop profile, preferring Windows/Mac for better passing rates
        const ua = new UserAgent({
            deviceCategory: 'desktop',
            platform: (p: string) => p === 'Win32' || p === 'MacIntel'
        } as any);

        const data = ua.data;
        const userAgent = ua.toString();

        // Extract version for Client Hints
        let browserName = 'Google Chrome';
        let version = '120'; // Fallback

        const chromeMatch = userAgent.match(/Chrome\/(\d+)/);
        if (chromeMatch) {
            version = chromeMatch[1];
        }

        let secChUa = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not A(Brand";v="24"`;

        if (userAgent.includes('Edg/')) {
            browserName = 'Microsoft Edge';
            const edgeMatch = userAgent.match(/Edg\/(\d+)/);
            if (edgeMatch) {
                version = edgeMatch[1];
                secChUa = `"Microsoft Edge";v="${version}", "Chromium";v="${version}", "Not A(Brand";v="24"`;
            }
        }

        const platform = data.platform === 'Win32' ? 'Win32' : 'MacIntel';
        const secChUaPlatform = platform === 'Win32' ? '"Windows"' : '"macOS"';

        return {
            name: `Dynamic ${browserName} ${version} (${platform})`,
            userAgent: userAgent,
            viewport: {
                width: data.screenWidth || 1920,
                height: data.screenHeight || 1080
            },
            platform: platform,
            vendor: data.vendor || 'Google Inc.',
            languages: ['ko-KR', 'ko', 'en-US', 'en'],
            hardwareConcurrency: 8, // Standard default
            deviceMemory: 8,
            secChUa: secChUa,
            secChUaPlatform: secChUaPlatform
        };
    }

    releaseProfile(profile: BrowserProfile): void {
        const index = BROWSER_PROFILES.findIndex(p => p.name === profile.name);
        if (index > -1) {
            this.usedProfiles.delete(index);
        }
    }

    getTotalProfiles(): number {
        return BROWSER_PROFILES.length + 1000; // limitless dynamic
    }

    /**
     * Load whitelist from disk
     */
    private loadWhitelist(): void {
        try {
            if (fs.existsSync(this.whitelistFile)) {
                const data = JSON.parse(fs.readFileSync(this.whitelistFile, 'utf-8'));
                this.workingUAs = new Set(data.workingUserAgents || []);
                console.log(`[ProfileManager] ✅ Loaded ${this.workingUAs.size} known-good User Agents`);
            }
        } catch (e: any) {
            console.warn(`[ProfileManager] ⚠️ Failed to load whitelist: ${e.message}`);
        }
    }

    /**
     * Save whitelist to disk
     */
    private saveWhitelist(): void {
        try {
            const dir = path.dirname(this.whitelistFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const data = {
                workingUserAgents: Array.from(this.workingUAs),
                lastUpdated: new Date().toISOString()
            };

            fs.writeFileSync(this.whitelistFile, JSON.stringify(data, null, 2));
            console.log(`[ProfileManager] 💾 Saved ${this.workingUAs.size} working UAs to disk`);
        } catch (e: any) {
            console.error(`[ProfileManager] ❌ Failed to save whitelist: ${e.message}`);
        }
    }

    /**
     * Mark a User Agent as working (add to whitelist)
     */
    markUAAsWorking(userAgent: string): void {
        if (!this.workingUAs.has(userAgent)) {
            this.workingUAs.add(userAgent);
            this.saveWhitelist();
            console.log(`[ProfileManager] ✅ Marked UA as working: ${userAgent.substring(0, 80)}...`);
        }
    }

    /**
     * Check if a User Agent is in the whitelist
     */
    isWorking(userAgent: string): boolean {
        return this.workingUAs.has(userAgent);
    }

    /**
     * Get count of working UAs
     */
    getWorkingUACount(): number {
        return this.workingUAs.size;
    }
}

// Singleton
let instance: ProfileManager | null = null;

export function getProfileManager(): ProfileManager {
    if (!instance) {
        instance = new ProfileManager();
    }
    return instance;
}
