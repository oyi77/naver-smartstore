import { Page } from 'puppeteer';
import { BrowserProfile } from '../proxy/types';

export class StealthInjector {
    static async inject(page: Page, profile: BrowserProfile) {
        // 1. Set User Agent
        await page.setUserAgent(profile.userAgent);

        // 2. Set Client Hints (Critical for Naver)
        await page.setExtraHTTPHeaders({
            'sec-ch-ua': profile.secChUa || '"Google Chrome";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
            'sec-ch-ua-mobile': profile.userAgent.includes('Mobile') ? '?1' : '?0',
            'sec-ch-ua-platform': profile.secChUaPlatform || '"Windows"',
        });

        // 3. Apply high-fidelity fingerprinting
        await page.evaluateOnNewDocument((profile) => {
            // Navigator platform override
            Object.defineProperty(navigator, 'platform', { get: () => profile.platform });
            // Vendor override
            Object.defineProperty(navigator, 'vendor', { get: () => profile.vendor });
            // Hardware concurrency
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => profile.hardwareConcurrency });
            // Device memory
            Object.defineProperty(navigator, 'deviceMemory', { get: () => profile.deviceMemory });
            // Languages
            Object.defineProperty(navigator, 'languages', { get: () => profile.languages });
            // App Version - derived from UA
            // @ts-ignore
            Object.defineProperty(navigator, 'appVersion', { get: () => profile.userAgent.split('Mozilla/')[1] });

            // Webdriver hide
            Object.defineProperty(navigator, 'webdriver', { get: () => false });

            // Mock chrome object
            // @ts-ignore
            window.chrome = {
                runtime: {},
                loadTimes: function () { },
                csi: function () { },
                app: {}
            };

            // Plugin handling (Desktop usually has PDF viewer, Mobile has none)
            if (profile.platform === 'Win32' || profile.platform === 'MacIntel') {
                const pdfDesc = 'Portable Document Format';
                const pdfFn = 'internal-pdf-viewer';

                const plugins = [
                    { name: 'PDF Viewer', filename: pdfFn, description: pdfDesc },
                    { name: 'Chrome PDF Viewer', filename: pdfFn, description: pdfDesc },
                    { name: 'Chromium PDF Viewer', filename: pdfFn, description: pdfDesc },
                    { name: 'Microsoft Edge PDF Viewer', filename: pdfFn, description: pdfDesc },
                    { name: 'WebKit built-in PDF', filename: pdfFn, description: pdfDesc }
                ];

                // @ts-ignore
                Object.defineProperty(navigator, 'plugins', {
                    // @ts-ignore
                    get: () => plugins
                });
            } else {
                // @ts-ignore
                Object.defineProperty(navigator, 'plugins', { get: () => [] });
            }

        }, profile);

        // 4. Set Viewport
        const isMobile = profile.userAgent.includes('Mobile');
        await page.setViewport({
            width: profile.viewport.width,
            height: profile.viewport.height,
            isMobile: isMobile,
            hasTouch: isMobile
        });
    }
}
