import { Page } from 'puppeteer';
import { TelegramService } from './TelegramService';

export class CaptchaSolver {
    private telegram: TelegramService;

    constructor() {
        this.telegram = new TelegramService();
    }

    /**
     * Orchestrates the CAPTCHA solving flow.
     * @param page Puppeteer page instance (for context)
     * @param refererUrl The URL where the captcha was encountered (usually product page)
     */
    async solve(page: Page, refererUrl: string): Promise<boolean> {
        console.log('[CaptchaSolver] 🧩 Initiating CAPTCHA solver sequence...');

        try {
            // 1. Request Session
            const sessionKey = await this.getSessionKey(page, refererUrl);
            if (!sessionKey) {
                console.error('[CaptchaSolver] ❌ Failed to get CAPTCHA session key');
                return false;
            }
            console.log(`[CaptchaSolver] 🔑 Session Key: ${sessionKey}`);

            // 2. Get Question
            const challenge = await this.getQuestion(page, sessionKey, refererUrl);
            if (!challenge) {
                console.error('[CaptchaSolver] ❌ Failed to get CAPTCHA question');
                return false;
            }
            // challenge.image is Base64 data:image/png;base64,...
            // challenge.question is the text

            // 3. Ask Human (via Telegram)
            await this.telegram.sendCaptcha(challenge.image, challenge.question);
            const answer = await this.telegram.waitForAnswer();

            if (!answer) {
                console.error('[CaptchaSolver] ❌ User did not reply in time.');
                return false;
            }

            // 4. Verify Answer
            const verified = await this.verifyAnswer(page, sessionKey, answer, refererUrl);
            if (verified) {
                console.log('[CaptchaSolver] ✅ CAPTCHA Solved Successfully!');
                return true;
            } else {
                console.error('[CaptchaSolver] ❌ CAPTCHA Verification Failed.');
                return false;
            }

        } catch (e: any) {
            console.error(`[CaptchaSolver] 💥 Critical error: ${e.message}`);
            return false;
        }
    }

    private async getSessionKey(page: Page, referer: string): Promise<string | null> {
        return await page.evaluate(async (ref) => {
            try {
                // Naver WCPT Session Endpoint
                const res = await fetch("https://ncpt.naver.com/v1/wcpt/m/challenge/session", {
                    method: "POST",
                    headers: {
                        "content-type": "text/plain;charset=UTF-8",
                        "Referer": ref
                        // User-Agent and Cookies are handled by the browser context
                    },
                    // Payload from doc example, seemingly static or just needs structure? 
                    // The doc example has a specific body: {"lang":"en_US", "domain":... "wtmToken":...}
                    // If wtmToken is dynamic, we might need to scrape it.
                    // However, often these endpoints might accept minimal payloads or generate a fresh one if missing.
                    // Let's try to mimic the structure but we might lack the wtmToken if it's page-specific.
                    // 
                    // STRATEGY: If the captcha page is loaded, the token might be in the DOM.
                    // But assume we are hitting this because an API call failed with 490/Captcha.
                    // Let's try a generic payload. If it fails, we might need to actually NAVIGATE to the captcha page.
                    // For now, let's try the fetch.

                    body: JSON.stringify({
                        lang: "en_US",
                        domain: "m.smartstore.naver.com", // or smartstore.naver.com
                        // wtmToken: "..." // We probably don't have this unless we extract it.
                    })
                });

                if (!res.ok) return null;
                const data: any = await res.json();
                return data.sessionKey || null;
            } catch (e) {
                return null;
            }
        }, referer);
    }

    private async getQuestion(page: Page, key: string, referer: string): Promise<{ question: string, image: string } | null> {
        return await page.evaluate(async (sessionKey, ref) => {
            try {
                const url = `https://ncpt.naver.com/v1/wcpt/m/challenge/receipt/question?key=${sessionKey}`;
                const res = await fetch(url, {
                    method: "GET",
                    headers: { "Referer": ref }
                });

                if (!res.ok) return null;
                const data: any = await res.json();

                if (data.rtn_cd === 200 && data.receiptData) {
                    return {
                        question: data.receiptData.question,
                        image: data.receiptData.image // Base64
                    };
                }
                return null;
            } catch (e) {
                return null;
            }
        }, key, referer);
    }

    private async verifyAnswer(page: Page, key: string, answer: string, referer: string): Promise<boolean> {
        return await page.evaluate(async (sessionKey, ans, ref) => {
            try {
                const url = `https://ncpt.naver.com/v1/wcpt/m/challenge/receipt/verify?key=${sessionKey}&answer=${ans}`;
                const res = await fetch(url, {
                    method: "GET",
                    headers: { "Referer": ref }
                });

                if (!res.ok) return false;
                const data: any = await res.json();
                return data.rtn_cd === 200;
            } catch (e) {
                return false;
            }
        }, key, answer, referer);
    }
}
