import dotenv from 'dotenv';
dotenv.config();

export class TelegramService {
    private botToken: string;
    private chatId: string;
    private baseUrl: string;

    constructor() {
        this.botToken = process.env.BOT_TOKEN || '';
        this.chatId = process.env.CHAT_ID || '';
        this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;

        if (!this.botToken || !this.chatId) {
            console.warn('[Telegram] ⚠️ Warning: BOT_TOKEN or CHAT_ID not set in .env');
        }
    }

    /**
     * Sends a photo (Base64 string or URL) with a caption (the question)
     */
    async sendCaptcha(imageBase64: string, question: string): Promise<void> {
        console.log(`[Telegram] 📤 Sending CAPTCHA question: "${question}"`);

        // Remove data:image/png;base64, prefix if present for constructing blob if needed,
        // but Telegram API supports multipart/form-data for files.
        // For simplicity with text-only fetch, we can use sendPhoto with a URL (if public) 
        // OR we have to construct a form-data body.
        // Since we don't want to add 'form-data' dependency if possible, let's see.
        // Node's native fetch (Node 18+) supports FormData. If not, we might need a library.
        // BUT, Telegram `sendPhoto` also accepts a file_id or a URL. 
        // We have a base64 string. 
        // Optimally, we construct a multipart request.

        // Alternative: Just send the text first, asking user to check console if image is local?
        // No, user requirement is "send the image".

        // Let's try standard fetch with FormData if environment supports it, 
        // otherwise we might need to use a buffer.

        try {
            // Simplified approach: Send text first, then maybe image if Base64 handling is complex without libs.
            // Actually, let's use the buffer.

            // NOTE: Converting Base64 to Blob/Buffer for fetch in Node.
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
            const buffer = Buffer.from(base64Data, 'base64');

            // Construct multipart manually or use a simple hack? 
            // It's easier to use a library like 'form-data' or just 'node-fetch' extensions, 
            // but we want to avoid deps.
            // Let's assume we can post multipart/form-data relative easy.

            // Wait, puppeteer typically runs in modern Node. Global `FormData` might exist.
            const formData = new FormData();
            formData.append('chat_id', this.chatId);
            formData.append('caption', `CAPTCHA Challenge:\n${question}\n\nReply with the answer.`);

            // Node's FormData needs a Blob.
            const blob = new Blob([buffer], { type: 'image/png' });
            formData.append('photo', blob, 'captcha.png');

            const res = await fetch(`${this.baseUrl}/sendPhoto`, {
                method: 'POST',
                body: formData
            });

            if (!res.ok) {
                const err = await res.text();
                console.error(`[Telegram] ❌ Failed to send photo: ${err}`);
            } else {
                console.log(`[Telegram] ✅ CAPTCHA sent successfully.`);
            }
        } catch (e: any) {
            console.error(`[Telegram] ❌ Error sending captcha: ${e.message}`);
        }
    }

    /**
     * Polls for updates to get the user's answer.
     * Starts checking from the current "latest" update ID.
     */
    async waitForAnswer(timeoutMs: number = 300000): Promise<string | null> {
        console.log(`[Telegram] ⏳ Waiting for answer (timeout: ${timeoutMs / 1000}s)...`);

        const startTime = Date.now();
        let offset = 0;

        // First, get current update offset to ignore old messages?
        // Ideally we only want messages AFTER we sent the captcha.
        // But simple polling is fine. We will look for new messages.

        // Better strategy: sending the captcha returns a message_id? 
        // We can just look for any new text message from the allowed chat_id.

        while (Date.now() - startTime < timeoutMs) {
            try {
                // Determine offset: getUpdates with offset -1 returns the last. 
                // We want new ones.
                // We'll maintain a local offset if this service instance stays alive, 
                // but since it might be ephemeral, we might just look for recent messages.

                const res = await fetch(`${this.baseUrl}/getUpdates?offset=${offset}&limit=10&timeout=5`);
                const data: any = await res.json();

                if (data.ok && data.result.length > 0) {
                    for (const update of data.result) {
                        offset = update.update_id + 1; // Ack this update

                        console.log(`[Telegram] DEBUG: Update: ${JSON.stringify(update)}`);

                        // Normalize: Check message OR channel_post OR edited_message
                        const msg = update.message || update.channel_post || update.edited_message;

                        if (msg) {
                            const msgChatId = String(msg.chat.id);
                            const text = msg.text || '';
                            const msgTime = (msg.date || 0) * 1000;

                            // Relaxed check: Log status
                            if (msgChatId === this.chatId) {
                                if (msgTime > startTime) {
                                    console.log(`[Telegram] 📩 Received answer: "${text}"`);
                                    return text.trim();
                                } else {
                                    console.log(`[Telegram] ⚠️ Ignoring old message from target chat (Time: ${new Date(msgTime).toISOString()})`);
                                }
                            } else {
                                console.log(`[Telegram] ⚠️ Ignored msg from ${msgChatId} (Watching: ${this.chatId}) - Text: "${text}"`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn(`[Telegram] Polling error (ignoring): ${e}`);
            }

            await new Promise(r => setTimeout(r, 2000));
        }

        console.warn('[Telegram] ⚠️ Timed out waiting for answer.');
        return null;
    }
}
