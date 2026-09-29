import type { RateLimiterRes } from 'rate-limiter-flexible';

/**
 * rate-limiter-flexible signale un dépassement en rejetant un RateLimiterRes,
 * qui porte `remainingPoints`. Toute autre erreur est technique.
 */
export function isRateLimiterRes(error: unknown): error is RateLimiterRes {
  return (
    typeof error === 'object' &&
    error !== null &&
    'remainingPoints' in error &&
    error.remainingPoints !== undefined
  );
}
