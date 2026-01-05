import 'dotenv/config';
import { QueueService } from '../src/services/QueueService';
import { CacheService } from '../src/services/CacheService';

async function main() {
    console.log('🚀 Starting Verification...');

    // 1. Initialize Queue (This spins up browsers)
    const queue = QueueService.getInstance();
    await queue.initialize(); // This should trigger browser launch and warmup

    console.log('✅ Queue Initialized. Browsers should be warm.');

    // 2. Add a Job
    const TEST_URL = 'https://smartstore.naver.com/llovve17';
    console.log(`📥 Adding Job for ${TEST_URL}...`);

    const job = queue.addJob(TEST_URL, 'STORE');
    console.log(`Job Created: ID=${job.id}, Status=${job.status}`);

    // 3. Poll for completion
    let attempts = 0;
    while (attempts < 60) {
        await new Promise(r => setTimeout(r, 2000));
        const status = job.status;
        console.log(`[${attempts}] Job Status: ${status}`);

        if (status === 'COMPLETED' || status === 'FAILED') break;
        attempts++;
    }

    if (job.status === 'COMPLETED') {
        console.log('🎉 Job Completed Successfully!');
        console.log('Result Keys:', Object.keys(job.result || {}));

        // 4. Verify Cache
        const cache = new CacheService();
        const cached = cache.get(TEST_URL);
        if (cached) {
            console.log('✅ Verifying Cache: HIT');
            console.log('Cached Data Keys:', Object.keys(cached));
        } else {
            console.error('❌ Cache Verification FAILED: Miss');
        }

    } else {
        console.error('❌ Job Failed or Timed Out:', job.error);
    }

    // Shutdown
    await queue.shutdown();
}

main().catch(console.error);
