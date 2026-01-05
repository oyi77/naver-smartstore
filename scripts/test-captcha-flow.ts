import { TelegramService } from '../src/services/TelegramService';
import dotenv from 'dotenv';
import path from 'path';

// Explicitly load .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function runTest() {
    console.log('🧪 Starting Telegram CAPTCHA Flow Test...');

    const telegram = new TelegramService();

    // 1x1 Red Pixel Base64
    const dummyImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    const question = "TEST (Attempt 2): What is 2 + 2? (Reply '4')";

    console.log('📤 Sending Question...');
    await telegram.sendCaptcha(dummyImage, question);

    console.log('⏳ Waiting for your reply on Telegram (Timeout: 3 mins)...');
    const answer = await telegram.waitForAnswer(180000); // 3 min timeout

    if (answer) {
        console.log(`✅ Received Answer: "${answer}"`);
    } else {
        console.log('❌ No answer received (Timeout)');
    }
}

runTest().catch(console.error);
