export declare const EXPIRY_DAYS: readonly number[]
export declare const DEFAULT_EXPIRY_DAYS: number
export declare function normalizeExpiryDays(v: unknown): number | null
export declare function expiresAtFor(days: number | null, now?: number): string | null
