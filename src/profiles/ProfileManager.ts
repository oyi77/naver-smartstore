import { BrowserProfile } from '../proxy/types';

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

    getRandomProfile(): BrowserProfile {
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

    releaseProfile(profile: BrowserProfile): void {
        const index = BROWSER_PROFILES.findIndex(p => p.name === profile.name);
        if (index > -1) {
            this.usedProfiles.delete(index);
        }
    }

    getTotalProfiles(): number {
        return BROWSER_PROFILES.length;
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
