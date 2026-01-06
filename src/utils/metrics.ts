/**
 * Simple metrics tracking for performance monitoring
 */
export interface Metrics {
    apiLatencyMs: number[];
    timeToPartialMs: number[];
    timeToFullMs: number[];
    errors: number;
    totalRequests: number;
}

class MetricsCollector {
    private static instance: MetricsCollector | null = null;
    private metrics: Metrics = {
        apiLatencyMs: [],
        timeToPartialMs: [],
        timeToFullMs: [],
        errors: 0,
        totalRequests: 0
    };

    static getInstance(): MetricsCollector {
        if (!MetricsCollector.instance) {
            MetricsCollector.instance = new MetricsCollector();
        }
        return MetricsCollector.instance;
    }

    recordApiLatency(ms: number) {
        this.metrics.apiLatencyMs.push(ms);
        this.metrics.totalRequests++;
    }

    recordTimeToPartial(ms: number) {
        this.metrics.timeToPartialMs.push(ms);
    }

    recordTimeToFull(ms: number) {
        this.metrics.timeToFullMs.push(ms);
    }

    recordError() {
        this.metrics.errors++;
    }

    getMetrics(): Metrics {
        return { ...this.metrics };
    }

    getStats() {
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

        return {
            totalRequests: this.metrics.totalRequests,
            errors: this.metrics.errors,
            errorRate: this.metrics.totalRequests > 0 
                ? (this.metrics.errors / this.metrics.totalRequests * 100).toFixed(2) + '%'
                : '0%',
            apiLatency: {
                mean: mean(this.metrics.apiLatencyMs).toFixed(2),
                p50: percentile(this.metrics.apiLatencyMs, 50).toFixed(2),
                p95: percentile(this.metrics.apiLatencyMs, 95).toFixed(2),
                p99: percentile(this.metrics.apiLatencyMs, 99).toFixed(2)
            },
            timeToPartial: {
                mean: mean(this.metrics.timeToPartialMs).toFixed(2),
                p50: percentile(this.metrics.timeToPartialMs, 50).toFixed(2),
                p95: percentile(this.metrics.timeToPartialMs, 95).toFixed(2),
                count: this.metrics.timeToPartialMs.length
            },
            timeToFull: {
                mean: mean(this.metrics.timeToFullMs).toFixed(2),
                p50: percentile(this.metrics.timeToFullMs, 50).toFixed(2),
                p95: percentile(this.metrics.timeToFullMs, 95).toFixed(2),
                p99: percentile(this.metrics.timeToFullMs, 99).toFixed(2),
                count: this.metrics.timeToFullMs.length
            }
        };
    }

    reset() {
        this.metrics = {
            apiLatencyMs: [],
            timeToPartialMs: [],
            timeToFullMs: [],
            errors: 0,
            totalRequests: 0
        };
    }
}

export const metrics = MetricsCollector.getInstance();

