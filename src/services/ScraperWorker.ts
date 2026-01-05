import { Page } from 'puppeteer';

export class ScraperWorker {
    static async scrapeProduct(page: Page, productUrl: string) {
        // 1. Derive Store URL
        const urlParts = productUrl.split('/products/');
        const storeUrl = urlParts[0];
        // Extract Product ID
        const productIdMatch = productUrl.match(/\/products\/(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : '';

        if (!productId) {
            return { error: 'INVALID_PRODUCT_URL' };
        }

        // 2. Visit Store Page first (Mimic Human Entry)
        console.log(`[Scraper] 🏪 Visiting store first: ${storeUrl}`);
        try {
            await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.simulateHumanBehavior(page);
        } catch (e: any) {
            console.warn(`[Scraper] Store navigation warning: ${e.message}`);
            // If store load fails hard, we might stop here, but let's try to proceed if page is somewhat alive
        }

        // 3. Find a random product to click (Mimic Browsing)
        // This establishes "trust" by generating a real navigation event with Referer
        try {
            console.log('[Scraper] 🖱️ Looking for a random product to click...');
            // Try common selectors for product links in Naver SmartStore
            const productSelectors = [
                'a[href*="/products/"]',
                'div._2kRKWS_t1E a',
                'ul.w-css-style a'
            ];

            let clicked = false;
            for (const selector of productSelectors) {
                const links = await page.$$(selector);
                if (links.length > 0) {
                    const randomLink = links[Math.floor(Math.random() * links.length)];
                    const href = await page.evaluate(el => el.getAttribute('href'), randomLink);

                    if (href && href.includes('/products/')) {
                        console.log(`[Scraper] 🖱️ Clicking random product: ${href}`);
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { }),
                            randomLink.click()
                        ]);
                        clicked = true;
                        break;
                    }
                }
            }

            if (clicked) {
                await this.simulateHumanBehavior(page);
            } else {
                console.warn('[Scraper] ⚠️ Could not find a random product to click. Proceeding...');
            }

        } catch (e: any) {
            console.warn(`[Scraper] Random product click failed: ${e.message}`);
        }

        // 4. Extract Channel ID from the CURRENT page (Store or Random Product)
        // State should be present on any page of the store
        const stateResult = await this.extractState(page);
        if (!stateResult || !stateResult.channelId) {
            console.error('[Scraper] ❌ Could not find Channel ID (Proxy might be blocked or page broken)');
            return { error: 'CHANNEL_ID_NOT_FOUND' };
        }

        console.log(`[Scraper] ✅ Found Channel ID: ${stateResult.channelId}`);

        // 5. Fetch Target Product Data using API
        // We use the current page's URL as Referer which is now a valid internal page
        return await this.fetchProductApi(page, productId, stateResult.channelId, page.url());
    }

    static async scrapeStore(page: Page, storeUrl: string) {
        console.log(`[Scraper] 📄 Navigating to ${storeUrl}...`);
        try {
            await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.simulateHumanBehavior(page);
        } catch (e: any) {
            console.error(`[Scraper] ❌ Navigation failed: ${e.message}`);
            return { error: `NAVIGATION_FAILED: ${e.message}` };
        }

        return await this.extractState(page);
    }

    private static async simulateHumanBehavior(page: Page) {
        try {
            const viewport = await page.viewport();
            const width = viewport?.width || 1920;
            const height = viewport?.height || 1080;

            // 1. Initial "Look around" mouse move
            const mx = Math.floor(Math.random() * width);
            const my = Math.floor(Math.random() * height);
            await page.mouse.move(mx, my, { steps: 15 });

            // 2. Scroll in chunks
            let currentHeight = 0;
            // Scroll at least a bit, max 800px or full page
            let scrollLimit = 800 + Math.random() * 500;

            while (currentHeight < scrollLimit) {
                const scrollAmt = Math.floor(Math.random() * 200) + 150;
                await page.evaluate((y: number) => window.scrollBy(0, y), scrollAmt);
                currentHeight += scrollAmt;

                // Random small delay
                const delay = 300 + Math.random() * 500;
                await new Promise(r => setTimeout(r, delay));

                // Occasional mouse jiggle
                if (Math.random() > 0.6) {
                    await page.mouse.move(
                        Math.floor(Math.random() * width),
                        Math.floor(Math.random() * height),
                        { steps: 5 }
                    );
                }
            }
        } catch (e) {
            // Ignore simulation errors
        }
    }

    private static async extractState(page: Page) {
        return await page.evaluate(() => {
            let state: any = null;

            // 1. Check window directly
            if ((window as any).__PRELOADED_STATE__) {
                state = (window as any).__PRELOADED_STATE__;
            }

            // 2. Search scripts
            if (!state) {
                const scripts = Array.from(document.querySelectorAll('script'));
                for (const s of scripts) {
                    const text = s.textContent || '';
                    if (text.includes('__PRELOADED_STATE__')) {
                        try {
                            const match = text.match(/__PRELOADED_STATE__\s*=\s*({.*?});/s) ||
                                text.match(/__PRELOADED_STATE__\s*=\s*({.*})/s);
                            if (match) {
                                state = JSON.parse(match[1]);
                                break;
                            }
                        } catch (e) { }
                    }
                }
            }

            if (!state) return { error: 'PRELOADED_STATE not found' };

            const harvestAllSecretProducts = (obj: any, depth = 0): string[] => {
                if (depth > 15 || !obj || typeof obj !== 'object') return [];
                let found: string[] = [];
                try {
                    for (const key in obj) {
                        const val = obj[key];
                        if (key.toLowerCase().includes('productno') && val && (typeof val === 'string' || typeof val === 'number')) {
                            const strVal = String(val);
                            if (strVal.length >= 10 && /^\d+$/.test(strVal)) found.push(strVal);
                        }
                        if (typeof val === 'object' && val !== null) {
                            found = found.concat(harvestAllSecretProducts(val, depth + 1));
                        }
                    }
                } catch (e) { }
                return found;
            };

            const allProductIds = Array.from(new Set(harvestAllSecretProducts(state)));
            const channelId = state.smartStoreV2?.channel?.channelUid ||
                state.smartStoreV2?.channel?.channelId ||
                state.smartStore?.channel?.channelId ||
                state.product?.channelId || null;

            return { channelId, allProductIds, state: "EXTRACTED" };
        });
    }

    static async fetchProductApi(page: Page, productId: string, channelId: string, refererUrl: string) {
        // NOTE: We now use `refererUrl` explicitly (passed from scrapeProduct logic)

        return await page.evaluate(async (pid: string, cid: string, pUrl: string) => {
            const endpoint = `https://smartstore.naver.com/i/v2/channels/${cid}/products/${pid}?withWindow=false`;
            try {
                const response = await fetch(endpoint, {
                    method: 'GET',
                    mode: 'cors',
                    credentials: 'include',
                    headers: {
                        'accept': 'application/json, text/plain, */*',
                        'accept-language': 'en-US,en;q=0.5',
                        'content-type': 'application/json',
                        'x-client-version': '20251223161333',
                        'sec-fetch-dest': 'empty',
                        'sec-fetch-mode': 'cors',
                        'sec-fetch-site': 'same-origin',
                        'pragma': 'no-cache',
                        'cache-control': 'no-cache',
                        'referer': pUrl
                    }
                });

                if (response.status === 204) return { success: false, error: '204_NO_CONTENT' };
                if (response.status === 429) return { success: false, error: 'RATELIMIT' };
                if (response.status === 403) return { success: false, error: 'FORBIDDEN_403' };
                if (!response.ok) return { success: false, error: `HTTP_${response.status}` };

                const data = await response.json();
                return { success: true, data };
            } catch (e: any) {
                return { success: false, error: e.message };
            }
        }, productId, channelId, refererUrl);
    }
}
