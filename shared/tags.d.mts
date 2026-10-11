export declare const MAX_TAGS_PER_DOC: number
export declare const TAG_MAX_LENGTH: number
export declare function compareTags(a: string, b: string): number
export declare function normalizeTag(raw: unknown): { tag: string; error?: undefined } | { error: string; tag?: undefined }
export declare function normalizeTags(list: unknown): { tags: string[]; error?: undefined } | { error: string; tags?: undefined }
