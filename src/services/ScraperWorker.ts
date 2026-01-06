import { Page } from 'puppeteer';
import { PreloadCacheService } from './PreloadCacheService';

const preloadCache = PreloadCacheService.getInstance();

export class ScraperWorker {
    static async scrapeProduct(page: Page, productUrl: string, onProgress?: (data: any) => Promise<void>) {
        // 1. Derive Store URL
        const urlParts = productUrl.split('/products/');
        const storeUrl = urlParts[0];
        // Extract Product ID
        const productIdMatch = productUrl.match(/\/products\/(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : '';

        if (!productId) {
            return { error: 'INVALID_PRODUCT_URL' };
        }

        // OPTIMIZATION: Check if channelId is cached - skip store navigation if available
        let channelId = preloadCache.getChannelId(storeUrl);
        let allProductIds: string[] = [];
        let productsMap: Record<string, any> = {};

        if (channelId) {
            console.log(`[Scraper] ⚡ Using cached channelId: ${channelId} (skipping store navigation)`);
            
            // Check if we have preload data for this SPECIFIC product
            const preload = preloadCache.getPreload(storeUrl, productId);
            console.log(`[Scraper] 🔍 Checking preload cache for product ${productId}: ${preload ? 'FOUND' : 'NOT FOUND'}`);
            
            if (preload && onProgress) {
                console.log(`[Scraper] ⚡ Found preload data for TARGET product ${productId}, sending partial update...`);
                console.log(`[Scraper] 📦 Preload data keys: ${Object.keys(preload).slice(0, 10).join(', ')}...`);
                // Ensure the preload has the correct product ID and _isPartial flag
                const partialData = {
                    ...preload,
                    id: productId,
                    _isPartial: true
                };
                await onProgress(partialData).catch(e => console.warn(`[Scraper] Failed to send progress update: ${e.message}`));
            } else if (!preload) {
                // If no preload for this product, we should scrape store page to populate preloads
                // But only if we don't have channelId cached (which we do), so we'll try API first
                console.log(`[Scraper] ⚠️ No preload data found for product ${productId} in cache - will try API first`);
            }

            // Try direct API fetch first (fast path)
            console.log(`[Scraper] 🎯 Fast path: Fetching product ${productId} via API (no store nav needed)...`);
            const fastResult = await this.fetchProductApi(page, productId, channelId, storeUrl);
            
            // If fast path succeeds, return immediately
            if (fastResult.success && fastResult.data) {
                return fastResult;
            }
            
            // If we get 403/429/captcha/network errors, fall through to bootstrap flow
            // Also fall back if we don't have preload data for this product (need to scrape store to get it)
            if (fastResult.error && (
                fastResult.error.includes('403') || 
                fastResult.error.includes('429') || 
                fastResult.error.includes('RATELIMIT') ||
                fastResult.error.includes('FORBIDDEN') ||
                fastResult.error.includes('Failed to fetch') ||
                fastResult.error.includes('NETWORK') ||
                fastResult.error.includes('TIMEOUT')
            )) {
                console.log(`[Scraper] ⚠️ Fast path failed with ${fastResult.error}, falling back to bootstrap flow...`);
                // Fall through to bootstrap - this will scrape store page and populate preloads
                channelId = null; // Reset to force store navigation
            } else if (fastResult.error && !preload) {
                // If API failed AND we don't have preload, scrape store to get preloads
                console.log(`[Scraper] ⚠️ API failed and no preload cache - scraping store to populate preloads...`);
                channelId = null; // Reset to force store navigation
            } else if (fastResult.error) {
                // Other errors when we have preload, return them
                return fastResult;
            } else if (!preload) {
                // If API succeeded but we don't have preload, that's fine - we got full data
                // But if API failed and we don't have preload, we should scrape store
                // (This case is handled above)
            }
        }

        // FALLBACK: Bootstrap flow (store navigation + session establishment)
        console.log(`[Scraper] 🏪 Step 1: Navigate to store page: ${storeUrl}`);

        // Use referer to mimic coming from search engines
        const referers = [
            'https://www.google.com/search?q=naver+smartstore',
            'https://search.naver.com/search.naver?query=smartstore',
            'https://www.google.co.kr/search?q=네이버+스마트스토어'
        ];
        const referer = referers[Math.floor(Math.random() * referers.length)];

        try {
            // Use domcontentloaded instead of networkidle2 for faster loading
            await page.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            console.log(`[Scraper] ✅ Store page loaded (referer: ${referer})`);
            // Perform human-like behavior (scroll/mouse) to warm up the session
            await this.simulateHumanBehavior(page);
        } catch (e: any) {
            console.error(`[Scraper] ❌ Failed to load store page: ${e.message}`);
            return { error: `STORE_NAVIGATION_FAILED: ${e.message}` };
        }

        // STEP 2: Extract channel ID and random product from store page
        const storeData = await this.extractState(page);
        channelId = storeData.channelId;
        allProductIds = storeData.allProductIds || [];
        productsMap = storeData.productsMap || {};

        if (!channelId) {
            console.error('[Scraper] ❌ Could not find Channel ID from store page');
            return { error: 'CHANNEL_ID_NOT_FOUND' };
        }

        console.log(`[Scraper] ✅ Found Channel ID: ${channelId}, Products: ${allProductIds.length}`);

        // Persist store metadata and preloads to cache
        preloadCache.setChannelId(storeUrl, channelId);
        if (Object.keys(productsMap).length > 0) {
            preloadCache.setPreloadsFromMap(storeUrl, productsMap);
            console.log(`[Scraper] 💾 Cached ${Object.keys(productsMap).length} preload entries for store ${storeUrl}`);
        }

        // OPTIONAL: If target product IS in the store page preloaded state, update progress immediately
        console.log(`[Scraper] 🔍 Checking if product ${productId} is in productsMap (${Object.keys(productsMap).length} products found)...`);
        if (productsMap[productId] && onProgress) {
            console.log(`[Scraper] ⚡ Found target product ${productId} in preloaded state. Sending partial update...`);
            console.log(`[Scraper] 📦 Product data keys: ${Object.keys(productsMap[productId]).slice(0, 10).join(', ')}...`);
            // Normalize/Structure partial data if needed
            const partialData = {
                id: productId,
                ...productsMap[productId],
                _isPartial: true
            };
            // Also ensure it's in preload cache (in case batch save failed)
            preloadCache.setPreload(storeUrl, productId, partialData);
            // IMPORTANT: Only send preload for the TARGET product, not other products
            await onProgress(partialData).catch(e => console.warn(`[Scraper] Failed to send progress update: ${e.message}`));
        } else if (onProgress && Object.keys(productsMap).length > 0) {
            // If target product not in preload, but we have preloads, check if we should still notify
            // (This is for cases where we want to indicate progress even if target isn't in preload)
            console.log(`[Scraper] ⚠️ Target product ${productId} not in preloaded state, but found ${Object.keys(productsMap).length} other products`);
            console.log(`[Scraper] 🔍 Sample product IDs found: ${Object.keys(productsMap).slice(0, 5).join(', ')}`);
            console.log(`[Scraper] 🔍 Looking for: "${productId}" (type: ${typeof productId})`);
            console.log(`[Scraper] 🔍 productsMap has key "${productId}": ${productId in productsMap}`);
        } else if (onProgress) {
            console.log(`[Scraper] ⚠️ No products found in preloaded state at all`);
        }

        // STEP 3: Click on a random product (establish session like human behavior)
        if (allProductIds.length > 0) {
            const randomProductId = allProductIds[Math.floor(Math.random() * allProductIds.length)];
            const randomProductUrl = `${storeUrl}/products/${randomProductId}`;

            console.log(`[Scraper] 👆 Step 2: Clicking random product ${randomProductId} to establish session...`);

            try {
                // Try to find a link to the product and click it (more human-like)
                const linkSelector = `a[href*="/products/${randomProductId}"]`;
                const foundLink = await page.$(linkSelector);

                if (foundLink) {
                    console.log(`[Scraper] 🖱️ Found product link, clicking...`);
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),
                        foundLink.click()
                    ]);
                } else {
                    // Fallback to direct navigation if link not found in DOM
                    console.log(`[Scraper] 🔗 Link not in viewport, navigating directly...`);
                    await page.goto(randomProductUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
                }

                console.log(`[Scraper] ✅ Random product page loaded (session established)`);

                // Minimal delay to mimic human behavior (reduced from 1-2s to 0.3-0.8s)
                await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
            } catch (e: any) {
                console.warn(`[Scraper] ⚠️ Random product navigation warning: ${e.message}`);
                // Continue anyway - session might be established
            }
        }

        // STEP 4: Now fetch the target product data via API (session is established)
        console.log(`[Scraper] 🎯 Step 3: Fetching target product ${productId} via API...`);
        const result = await this.fetchProductApi(page, productId, channelId, storeUrl);
        return result;
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

        const storeData = await this.extractState(page);
        
        // Persist store metadata and preloads to cache
        if (storeData.channelId) {
            preloadCache.setChannelId(storeUrl, storeData.channelId);
            console.log(`[Scraper] 💾 Cached channelId for store ${storeUrl}`);
        }
        
        if (storeData.productsMap && Object.keys(storeData.productsMap).length > 0) {
            preloadCache.setPreloadsFromMap(storeUrl, storeData.productsMap);
            console.log(`[Scraper] 💾 Cached ${Object.keys(storeData.productsMap).length} preload entries for store ${storeUrl}`);
        }

        return storeData;
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
                            const match = text.match(/__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/) ||
                                text.match(/__PRELOADED_STATE__\s*=\s*({[\s\S]*})/);
                            if (match) {
                                state = JSON.parse(match[1]);
                                break;
                            }
                        } catch (e) { }
                    }
                }
            }

            if (!state) return { error: 'PRELOADED_STATE not found' };

            // Enhanced recursive harvester that collects both IDs and full Objects
            const harvestedProducts: Record<string, any> = {};

            const harvestData = (obj: any, depth = 0) => {
                if (depth > 15 || !obj || typeof obj !== 'object') return;

                try {
                    // Check if this object looks like a product
                    // It usually has productNo (or id) name, salePrice, etc.
                    if ((obj.productNo || obj.id) && (obj.name || obj.productName || obj.simpleName)) {
                        const pid = String(obj.productNo || obj.id);
                        // Validate ID format (digits, reasonable length)
                        if (/^\d{8,}$/.test(pid)) {
                            // If we haven't seen this ID or this object seems "richer" (more keys), store it
                            if (!harvestedProducts[pid] || Object.keys(obj).length > Object.keys(harvestedProducts[pid]).length) {
                                harvestedProducts[pid] = obj;
                            }
                        }
                    }

                    // Continue recursion
                    for (const key in obj) {
                        const val = obj[key];
                        if (typeof val === 'object' && val !== null) {
                            harvestData(val, depth + 1);
                        }
                    }
                } catch (e) { }
            };

            harvestData(state);

            const allProductIds = Object.keys(harvestedProducts);
            const productsMap = harvestedProducts;

            const channelId = state.smartStoreV2?.channel?.channelUid ||
                state.smartStoreV2?.channel?.channelId ||
                state.smartStore?.channel?.channelId ||
                state.product?.channelId || null;

            return { channelId, allProductIds, productsMap, state: "EXTRACTED" };
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

                let data = await response.json();

                // 2. Fetch Benefits Data (if categoryId exists)
                if (data && data.category && data.category.categoryId) {
                    const catId = data.category.categoryId;
                    const benefitsUrl = `https://smartstore.naver.com/i/v2/channels/${cid}/benefits/by-products/${pid}?categoryId=${catId}`;
                    try {
                        const benResponse = await fetch(benefitsUrl, {
                            method: "GET",
                            headers: {
                                "accept": "application/json, text/plain, */*",
                                "accept-language": "id,id-ID;q=0.9,en-US;q=0.8,en;q=0.7,ms;q=0.6",
                                "priority": "u=1, i",
                                "sec-fetch-dest": "empty",
                                "sec-fetch-mode": "cors",
                                "sec-fetch-site": "same-origin",
                                "x-client-version": "20251223161333"
                            },
                            referrer: pUrl,
                            mode: "cors",
                            credentials: "include"
                        });

                        if (benResponse.ok) {
                            // Check content type to ensure it is JSON
                            const contentType = benResponse.headers.get("content-type");
                            if (contentType && contentType.includes("application/json")) {
                                const benData = await benResponse.json();
                                // Merge logic: Merge benefits data into the main product data
                                if (benData) {
                                    data = { ...data, ...benData };
                                }
                            }
                        }
                    } catch (benErr) {
                        // Silently ignore benefits fetch failure to avoid failing the whole scrape
                    }
                }

                return { success: true, data };
            } catch (e: any) {
                return { success: false, error: e.message };
            }
        }, productId, channelId, refererUrl);
    }
}
