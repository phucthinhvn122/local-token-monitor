import type { RoutingStrategy } from "@cgw/shared";

export interface RoutableProvider {
  id: string;
  name: string;
  priority: number;
  weight: number;
  models: string[];
  isActive: boolean;
  consecutiveErrors: number;
  circuitOpenUntil: Date | null;
}

export interface SelectionContext {
  strategy: RoutingStrategy;
  model?: string | null;
  now?: Date;
  /** Providers already tried and failed during this request. */
  exclude?: ReadonlySet<string>;
}

/** A provider serves a model if it has no allow-list, or the model is on it. */
export function servesModel(provider: RoutableProvider, model?: string | null): boolean {
  if (provider.models.length === 0) return true;
  if (!model) return true;
  return provider.models.some((candidate) => candidate === model || model.startsWith(candidate));
}

export function circuitIsOpen(provider: RoutableProvider, now = new Date()): boolean {
  return provider.circuitOpenUntil !== null && provider.circuitOpenUntil.getTime() > now.getTime();
}

export function eligibleProviders(
  providers: readonly RoutableProvider[],
  context: SelectionContext
): RoutableProvider[] {
  const now = context.now ?? new Date();
  return providers.filter(
    (provider) =>
      provider.isActive &&
      !circuitIsOpen(provider, now) &&
      servesModel(provider, context.model) &&
      !context.exclude?.has(provider.id)
  );
}

/**
 * Deterministic round-robin cursor, shared across requests in this process.
 *
 * Single-instance state. Running more than one gateway replica makes the
 * rotation per-replica rather than global — still correct, just less evenly
 * distributed. Moving this to Redis is the documented path to scaling out.
 */
let roundRobinCursor = 0;

export function resetRoundRobin(): void {
  roundRobinCursor = 0;
}

/**
 * Order the eligible providers into the sequence the request should try.
 * Returning the full ordering (rather than one pick) is what makes automatic
 * failover a plain `for` loop at the call site.
 */
export function orderProviders(
  providers: readonly RoutableProvider[],
  context: SelectionContext
): RoutableProvider[] {
  const eligible = eligibleProviders(providers, context);
  if (eligible.length <= 1) return eligible;

  switch (context.strategy) {
    case "ROUND_ROBIN": {
      // Stable base order keeps the rotation predictable across requests.
      const sorted = [...eligible].sort((a, b) => a.id.localeCompare(b.id));
      const offset = roundRobinCursor++ % sorted.length;
      return [...sorted.slice(offset), ...sorted.slice(0, offset)];
    }

    case "WEIGHTED": {
      // Sample without replacement, weighted — the winner leads, and the rest
      // stay in weighted order so failover also respects the weights.
      const pool = [...eligible];
      const ordered: RoutableProvider[] = [];
      while (pool.length > 0) {
        const total = pool.reduce((sum, provider) => sum + Math.max(1, provider.weight), 0);
        let ticket = Math.random() * total;
        let index = pool.length - 1;
        for (let i = 0; i < pool.length; i++) {
          ticket -= Math.max(1, pool[i].weight);
          if (ticket <= 0) {
            index = i;
            break;
          }
        }
        ordered.push(pool.splice(index, 1)[0]);
      }
      return ordered;
    }

    case "PRIORITY":
    default:
      return [...eligible].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Prefer the healthier provider when priorities tie.
        if (a.consecutiveErrors !== b.consecutiveErrors) return a.consecutiveErrors - b.consecutiveErrors;
        return a.name.localeCompare(b.name);
      });
  }
}

/**
 * Compute the next breaker state after a failure. Returned as data so the
 * caller owns persistence and the rule stays trivially testable.
 */
export function nextBreakerState(
  consecutiveErrors: number,
  options: { threshold: number; cooldownSeconds: number; now?: Date }
): { consecutiveErrors: number; circuitOpenUntil: Date | null; opened: boolean } {
  const now = options.now ?? new Date();
  const errors = consecutiveErrors + 1;
  if (errors < options.threshold) {
    return { consecutiveErrors: errors, circuitOpenUntil: null, opened: false };
  }
  return {
    consecutiveErrors: errors,
    circuitOpenUntil: new Date(now.getTime() + options.cooldownSeconds * 1000),
    opened: true
  };
}

/**
 * Only 5xx, 408, 429 and transport-level failures count against a provider.
 * A 400 from a malformed client request says nothing about provider health and
 * must not be retried against another pool member either.
 */
export function isProviderFailure(statusCode: number | null): boolean {
  if (statusCode === null) return true; // network error / timeout
  return statusCode >= 500 || statusCode === 408 || statusCode === 429;
}
