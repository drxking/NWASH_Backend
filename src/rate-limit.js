export class RateLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.buckets = new Map();
  }

  check(key, limit, windowMs) {
    const current = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= current) {
      bucket = { count: 0, resetAt: current + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10000) {
      for (const [bucketKey, value] of this.buckets) {
        if (value.resetAt <= current) this.buckets.delete(bucketKey);
      }
    }
    return bucket.count > limit ? Math.max(1, Math.ceil((bucket.resetAt - current) / 1000)) : 0;
  }
}
