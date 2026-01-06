/**
 * Load test script for measuring API performance
 * Tests 1000+ products and reports latency, time-to-partial, time-to-full, and error rate
 * 
 * Usage:
 *   API_URL=http://localhost:3000 TARGET_PRODUCTS=1000 CONCURRENT=10 npm run ts-node scripts/load-test.ts
 * 
 * Requires Node.js 18+ for native fetch support
 */

const API_BASE = process.env.API_URL || 'http://localhost:3000';
const TARGET_PRODUCTS = parseInt(process.env.TARGET_PRODUCTS || '1000');
const CONCURRENT_REQUESTS = parseInt(process.env.CONCURRENT || '10');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL || '1000');
const MAX_POLL_ATTEMPTS = parseInt(process.env.MAX_POLL || '60'); // 60 seconds max wait

interface TestResult {
    productUrl: string;
    apiLatencyMs: number;
    timeToPartialMs: number | null;
    timeToFullMs: number | null;
    error: string | null;
    status: 'success' | 'partial' | 'error' | 'timeout';
}

// Sample product URLs for testing (replace with real URLs)
const SAMPLE_PRODUCTS = [
    'https://smartstore.naver.com/rainbows9030/products/11102379008',
    'https://smartstore.naver.com/minibeans/products/8768399445',
    // Add more sample URLs here
];

function generateProductUrls(count: number): string[] {
    // For testing, we'll use a pattern or repeat sample URLs
    // In production, you'd have a list of real product URLs
    const urls: string[] = [];
    for (let i = 0; i < count; i++) {
        // Use sample URLs in rotation
        urls.push(SAMPLE_PRODUCTS[i % SAMPLE_PRODUCTS.length]);
    }
    return urls;
}

async function testProduct(productUrl: string): Promise<TestResult> {
    const startTime = Date.now();
    let timeToPartial: number | null = null;
    let timeToFull: number | null = null;
    let error: string | null = null;
    let status: 'success' | 'partial' | 'error' | 'timeout' = 'error';

    try {
        // Initial request
        const response = await fetch(`${API_BASE}/naver?productUrl=${encodeURIComponent(productUrl)}`);
        const apiLatency = Date.now() - startTime;
        const data = await response.json() as any;

        if (response.status === 200) {
            if (data.data?._isPartial) {
                // Got partial data immediately
                timeToPartial = apiLatency;
                status = 'partial';

                // Poll for full data
                const jobId = data.data.jobId;
                if (jobId) {
                    const fullStart = Date.now();
                    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
                        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                        
                        const pollResponse = await fetch(`${API_BASE}/naver?productUrl=${encodeURIComponent(productUrl)}`);
                        const pollData = await pollResponse.json() as any;
                        
                        if (pollResponse.status === 200 && pollData.data && !pollData.data._isPartial) {
                            timeToFull = Date.now() - fullStart;
                            status = 'success';
                            break;
                        }
                    }
                    
                    if (timeToFull === null) {
                        status = 'timeout';
                        error = 'Timeout waiting for full data';
                    }
                }
            } else {
                // Got full data immediately (cache hit)
                timeToFull = apiLatency;
                status = 'success';
            }
        } else if (response.status === 202) {
            // Job queued, poll for result
            status = 'partial';
            const jobId = data.jobId;
            const pollStart = Date.now();
            
            for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
                await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                
                const pollResponse = await fetch(`${API_BASE}/naver?productUrl=${encodeURIComponent(productUrl)}`);
                const pollData = await pollResponse.json() as any;
                
                if (pollResponse.status === 200) {
                    if (pollData.data?._isPartial) {
                        if (timeToPartial === null) {
                            timeToPartial = Date.now() - pollStart;
                        }
                    } else {
                        timeToFull = Date.now() - pollStart;
                        status = 'success';
                        break;
                    }
                } else if (pollResponse.status === 500) {
                    error = pollData.error?.message || 'Server error';
                    status = 'error';
                    break;
                }
            }
            
            if (timeToFull === null && status !== 'error') {
                status = 'timeout';
                error = 'Timeout waiting for data';
            }
        } else {
            error = data.error?.message || `HTTP ${response.status}`;
            status = 'error';
        }

        return {
            productUrl,
            apiLatencyMs: apiLatency,
            timeToPartialMs: timeToPartial,
            timeToFullMs: timeToFull,
            error,
            status
        };
    } catch (e: any) {
        return {
            productUrl,
            apiLatencyMs: Date.now() - startTime,
            timeToPartialMs: null,
            timeToFullMs: null,
            error: e.message,
            status: 'error'
        };
    }
}

async function runBatch(urls: string[], batchSize: number): Promise<TestResult[]> {
    const results: TestResult[] = [];
    
    for (let i = 0; i < urls.length; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        console.log(`\n[Load Test] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(urls.length / batchSize)} (${batch.length} products)...`);
        
        const batchResults = await Promise.all(batch.map(url => testProduct(url)));
        results.push(...batchResults);
        
        // Progress update
        const success = batchResults.filter(r => r.status === 'success').length;
        const partial = batchResults.filter(r => r.status === 'partial').length;
        const errors = batchResults.filter(r => r.status === 'error').length;
        console.log(`  ✓ Success: ${success}, Partial: ${partial}, Errors: ${errors}`);
    }
    
    return results;
}

function printStats(results: TestResult[]) {
    const success = results.filter(r => r.status === 'success');
    const partial = results.filter(r => r.status === 'partial');
    const errors = results.filter(r => r.status === 'error' || r.status === 'timeout');
    
    const apiLatencies = results.map(r => r.apiLatencyMs);
    const timeToPartials = results.filter(r => r.timeToPartialMs !== null).map(r => r.timeToPartialMs!);
    const timeToFulls = results.filter(r => r.timeToFullMs !== null).map(r => r.timeToFullMs!);
    
    const percentile = (arr: number[], p: number): number => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    };
    
    const mean = (arr: number[]): number => {
        if (arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    };
    
    console.log('\n' + '='.repeat(60));
    console.log('LOAD TEST RESULTS');
    console.log('='.repeat(60));
    console.log(`Total Requests: ${results.length}`);
    console.log(`Success (Full Data): ${success.length} (${(success.length / results.length * 100).toFixed(1)}%)`);
    console.log(`Partial Only: ${partial.length} (${(partial.length / results.length * 100).toFixed(1)}%)`);
    console.log(`Errors/Timeouts: ${errors.length} (${(errors.length / results.length * 100).toFixed(1)}%)`);
    console.log(`Error Rate: ${(errors.length / results.length * 100).toFixed(2)}%`);
    
    console.log('\nAPI Latency (Initial Response):');
    console.log(`  Mean: ${mean(apiLatencies).toFixed(2)}ms`);
    console.log(`  P50: ${percentile(apiLatencies, 50).toFixed(2)}ms`);
    console.log(`  P95: ${percentile(apiLatencies, 95).toFixed(2)}ms`);
    console.log(`  P99: ${percentile(apiLatencies, 99).toFixed(2)}ms`);
    
    if (timeToPartials.length > 0) {
        console.log('\nTime to Partial Data:');
        console.log(`  Mean: ${mean(timeToPartials).toFixed(2)}ms`);
        console.log(`  P50: ${percentile(timeToPartials, 50).toFixed(2)}ms`);
        console.log(`  P95: ${percentile(timeToPartials, 95).toFixed(2)}ms`);
        console.log(`  Count: ${timeToPartials.length}`);
    }
    
    if (timeToFulls.length > 0) {
        console.log('\nTime to Full Data:');
        console.log(`  Mean: ${mean(timeToFulls).toFixed(2)}ms`);
        console.log(`  P50: ${percentile(timeToFulls, 50).toFixed(2)}ms`);
        console.log(`  P95: ${percentile(timeToFulls, 95).toFixed(2)}ms`);
        console.log(`  P99: ${percentile(timeToFulls, 99).toFixed(2)}ms`);
        console.log(`  Count: ${timeToFulls.length}`);
    }
    
    console.log('\n' + '='.repeat(60));
}

async function main() {
    console.log('🚀 Starting Load Test');
    console.log(`API Base: ${API_BASE}`);
    console.log(`Target Products: ${TARGET_PRODUCTS}`);
    console.log(`Concurrent Requests: ${CONCURRENT_REQUESTS}`);
    
    const urls = generateProductUrls(TARGET_PRODUCTS);
    const startTime = Date.now();
    
    const results = await runBatch(urls, CONCURRENT_REQUESTS);
    
    const totalTime = Date.now() - startTime;
    console.log(`\n⏱️  Total Test Time: ${(totalTime / 1000).toFixed(2)}s`);
    
    printStats(results);
}

main().catch(console.error);

