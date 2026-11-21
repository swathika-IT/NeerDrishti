export interface NotificationRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class NotificationRateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  check(key: string, maxAttempts: number, windowMs: number): NotificationRateLimitResult {
    const now = this.now();
    const bucket = (this.buckets.get(key) || []).filter(timestamp => now - timestamp < windowMs);

    if (bucket.length >= maxAttempts) {
      const oldest = bucket[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: maxAttempts - bucket.length, retryAfterSeconds: 0 };
  }

  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }
}

export const notificationRateLimiter = new NotificationRateLimiter();
