import { Page } from 'puppeteer';
import { BrowserProfile } from '../proxy/types';

export class StealthInjector {
    static async inject(page: Page, profile: BrowserProfile) {
        // Standardize headers
        await page.setExtraHTTPHeaders({
            'sec-ch-ua': profile.secChUa || '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': profile.secChUaPlatform || '"macOS"',
        });

        // Set User Agent
        await page.setUserAgent(profile.userAgent);

        // Apply high-fidelity fingerprinting manually
        await page.evaluateOnNewDocument((p, v, m, c, l, ua) => {
            // Navigator platform override
            Object.defineProperty(navigator, 'platform', { get: () => p });
            // Vendor override
            Object.defineProperty(navigator, 'vendor', { get: () => v });
            // Hardware concurrency
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => c });
            // Device memory
            Object.defineProperty(navigator, 'deviceMemory', { get: () => m });
            // Languages
            Object.defineProperty(navigator, 'languages', { get: () => l });
            // App Version
            // @ts-ignore
            Object.defineProperty(navigator, 'appVersion', { get: () => ua.split('Mozilla/')[1] });

            // Webdriver hide
            Object.defineProperty(navigator, 'webdriver', { get: () => false });

            // Mock chrome object
            (window as any).chrome = {
                runtime: {},
                loadTimes: function () { },
                csi: function () { },
                app: {}
            };

            // Mock plugins
            const mockPlugins = [
                { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
            ];

            Object.defineProperty(navigator, 'plugins', {
                get: () => mockPlugins.map(p => ({
                    ...p,
                    length: 1,
                    item: () => p,
                    namedItem: () => p
                }))
            });
        }, profile.platform, profile.vendor, profile.deviceMemory, profile.hardwareConcurrency, profile.languages, profile.userAgent);

        // Set viewport
        await page.setViewport(profile.viewport);
    }
}
