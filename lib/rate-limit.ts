// A small in-memory rate limiter for the billing endpoints. Each serverless instance keeps its own counts, so this is
// a brake against accidental double-clicks and simple abuse rather than a global guarantee; Stripe has its own limits
// and every billing action is idempotent. Pure apart from the clock, so it is unit-tested.
export type Limiter = { allow(key: string, now?: number): boolean };

export function makeLimiter(max: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= max) { hits.set(key, recent); return false; }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k); // keep memory bounded
      return true;
    },
  };
}
