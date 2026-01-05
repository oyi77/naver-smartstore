
import { QueueService } from '../src/services/QueueService';

async function main() {
    console.log('🧪 Verifying Custom Proxy Feature...');

    const targetUrl = 'https://smartstore.naver.com/llovve17';
    // Use a dummy proxy for plumbing test, or valid one if available.
    const customProxy = process.env.TEST_CUSTOM_PROXY || 'http://user:pass@127.0.0.1:8080';

    console.log(`Target: ${targetUrl}`);
    console.log(`Proxy: ${customProxy}`);

    try {
        console.log('1️⃣  Sending request with custom proxy...');

        const params = new URLSearchParams({
            url: targetUrl,
            proxy: customProxy,
            refresh: 'true'
        });

        // Use global fetch
        const response = await fetch(`http://localhost:3000/naver?${params.toString()}`, {
            method: 'GET'
        });

        console.log('✅ Response Status:', response.status);
        const data = await response.json();
        console.log('✅ Response Body:', data);

        if (response.status === 202) {
            console.log('⏳ Job accepted. Check server logs for "[BrowserPool] 🌩️ Creating Ephemeral Browser" message.');
        } else if (response.status === 200) {
            console.log('✅ Job completed immediately (cached?).');
        }

    } catch (error: any) {
        console.error('❌ Request failed:', error.message);
    }
}

main();
