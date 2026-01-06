/**
 * Real test script - makes actual API calls and measures performance
 */

const API_BASE = 'http://localhost:3000';

// Real product URLs for testing
const TEST_PRODUCTS = [
    'https://smartstore.naver.com/rainbows9030/products/11102379008',
    'https://smartstore.naver.com/minibeans/products/8768399445',
];

interface TestResult {
    url: string;
    attempt: number;
    status: number;
    apiLatencyMs: number;
    hasPartial: boolean;
    hasFull: boolean;
    error?: string;
    responseTime?: number;
}

async function testProduct(url: string, attempt: number = 1): Promise<TestResult> {
    const startTime = Date.now();
    
    try {
        const response = await fetch(`${API_BASE}/naver?productUrl=${encodeURIComponent(url)}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });
        
        const apiLatency = Date.now() - startTime;
        const data = await response.json() as any;
        
        const result: TestResult = {
            url,
            attempt,
            status: response.status,
            apiLatencyMs: apiLatency,
            hasPartial: !!(data.data?._isPartial),
            hasFull: !!(data.data && !data.data._isPartial),
            error: data.error?.message
        };
        
        // If we got 202, poll for result
        if (response.status === 202) {
            const jobId = data.jobId;
            console.log(`  ⏳ Job ${jobId} queued, polling for result...`);
            
            let pollCount = 0;
            const maxPolls = 30; // 30 seconds max
            
            while (pollCount < maxPolls) {
                await new Promise(r => setTimeout(r, 1000));
                pollCount++;
                
                const pollResponse = await fetch(`${API_BASE}/naver?productUrl=${encodeURIComponent(url)}`);
                const pollData = await pollResponse.json() as any;
                
                if (pollResponse.status === 200) {
                    result.status = 200;
                    result.hasPartial = !!(pollData.data?._isPartial);
                    result.hasFull = !!(pollData.data && !pollData.data._isPartial);
                    result.responseTime = (pollCount * 1000) + apiLatency;
                    break;
                } else if (pollResponse.status === 500) {
                    result.error = pollData.error?.message || 'Server error';
                    break;
                }
            }
            
            if (result.status === 202) {
                result.error = 'Timeout waiting for result';
            }
        } else if (response.status === 200) {
            result.responseTime = apiLatency;
        }
        
        return result;
    } catch (e: any) {
        return {
            url,
            attempt,
            status: 0,
            apiLatencyMs: Date.now() - startTime,
            hasPartial: false,
            hasFull: false,
            error: e.message
        };
    }
}

async function runTests() {
    console.log('🧪 Starting Real Performance Test\n');
    console.log(`Testing ${TEST_PRODUCTS.length} products against ${API_BASE}\n`);
    
    const results: TestResult[] = [];
    
    for (let i = 0; i < TEST_PRODUCTS.length; i++) {
        const url = TEST_PRODUCTS[i];
        console.log(`\n[${i + 1}/${TEST_PRODUCTS.length}] Testing: ${url}`);
        
        // First request (cache miss expected)
        console.log('  📤 First request (cache miss)...');
        const firstResult = await testProduct(url, 1);
        results.push(firstResult);
        
        console.log(`  ✅ Status: ${firstResult.status}`);
        console.log(`  ⏱️  API Latency: ${firstResult.apiLatencyMs}ms`);
        if (firstResult.hasPartial) {
            console.log(`  📦 Got partial data`);
        }
        if (firstResult.hasFull) {
            console.log(`  ✅ Got full data`);
        }
        if (firstResult.responseTime) {
            console.log(`  ⏱️  Total Time: ${firstResult.responseTime}ms`);
        }
        if (firstResult.error) {
            console.log(`  ❌ Error: ${firstResult.error}`);
        }
        
        // Wait a bit
        await new Promise(r => setTimeout(r, 2000));
        
        // Second request (cache hit expected)
        console.log('  📤 Second request (cache hit expected)...');
        const secondResult = await testProduct(url, 2);
        results.push(secondResult);
        
        console.log(`  ✅ Status: ${secondResult.status}`);
        console.log(`  ⏱️  API Latency: ${secondResult.apiLatencyMs}ms`);
        if (secondResult.hasFull) {
            console.log(`  ✅ Got full data from cache`);
        }
        if (secondResult.error) {
            console.log(`  ❌ Error: ${secondResult.error}`);
        }
        
        // Wait between products
        if (i < TEST_PRODUCTS.length - 1) {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    
    // Print summary
    console.log('\n' + '='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));
    
    const firstRequests = results.filter(r => r.attempt === 1);
    const secondRequests = results.filter(r => r.attempt === 2);
    
    console.log(`\nFirst Requests (Cache Miss):`);
    console.log(`  Total: ${firstRequests.length}`);
    console.log(`  Success (200): ${firstRequests.filter(r => r.status === 200).length}`);
    console.log(`  Queued (202): ${firstRequests.filter(r => r.status === 202).length}`);
    console.log(`  Errors: ${firstRequests.filter(r => r.error).length}`);
    console.log(`  Got Partial: ${firstRequests.filter(r => r.hasPartial).length}`);
    console.log(`  Got Full: ${firstRequests.filter(r => r.hasFull).length}`);
    
    const firstLatencies = firstRequests.map(r => r.apiLatencyMs);
    if (firstLatencies.length > 0) {
        const avg = firstLatencies.reduce((a, b) => a + b, 0) / firstLatencies.length;
        const min = Math.min(...firstLatencies);
        const max = Math.max(...firstLatencies);
        console.log(`  API Latency: avg=${avg.toFixed(0)}ms, min=${min}ms, max=${max}ms`);
    }
    
    const firstResponseTimes = firstRequests.filter(r => r.responseTime).map(r => r.responseTime!);
    if (firstResponseTimes.length > 0) {
        const avg = firstResponseTimes.reduce((a, b) => a + b, 0) / firstResponseTimes.length;
        const min = Math.min(...firstResponseTimes);
        const max = Math.max(...firstResponseTimes);
        console.log(`  Total Time: avg=${avg.toFixed(0)}ms, min=${min}ms, max=${max}ms`);
    }
    
    console.log(`\nSecond Requests (Cache Hit Expected):`);
    console.log(`  Total: ${secondRequests.length}`);
    console.log(`  Success (200): ${secondRequests.filter(r => r.status === 200).length}`);
    console.log(`  Got Full: ${secondRequests.filter(r => r.hasFull).length}`);
    
    const secondLatencies = secondRequests.map(r => r.apiLatencyMs);
    if (secondLatencies.length > 0) {
        const avg = secondLatencies.reduce((a, b) => a + b, 0) / secondLatencies.length;
        const min = Math.min(...secondLatencies);
        const max = Math.max(...secondLatencies);
        console.log(`  API Latency: avg=${avg.toFixed(0)}ms, min=${min}ms, max=${max}ms`);
    }
    
    console.log('\n' + '='.repeat(70));
    
    // Check SLO compliance
    const under6s = firstResponseTimes.filter(t => t < 6000).length;
    const totalWithTime = firstResponseTimes.length;
    if (totalWithTime > 0) {
        console.log(`\n📊 SLO Compliance (<6s): ${under6s}/${totalWithTime} (${(under6s/totalWithTime*100).toFixed(1)}%)`);
    }
    
    const firstUnder200ms = firstLatencies.filter(l => l < 200).length;
    if (firstLatencies.length > 0) {
        console.log(`📊 Fast Response (<200ms): ${firstUnder200ms}/${firstLatencies.length} (${(firstUnder200ms/firstLatencies.length*100).toFixed(1)}%)`);
    }
}

// Wait for server to be ready
async function waitForServer(maxWait = 30) {
    for (let i = 0; i < maxWait; i++) {
        try {
            const response = await fetch(`${API_BASE}/health`);
            if (response.ok) {
                console.log('✅ Server is ready\n');
                return true;
            }
        } catch (e) {
            // Server not ready yet
        }
        await new Promise(r => setTimeout(r, 1000));
        process.stdout.write('.');
    }
    console.log('\n❌ Server did not become ready in time');
    return false;
}

async function main() {
    console.log('⏳ Waiting for server to be ready...');
    const ready = await waitForServer();
    
    if (!ready) {
        process.exit(1);
    }
    
    await runTests();
}

main().catch(console.error);

