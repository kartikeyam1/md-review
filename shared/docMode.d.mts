export type DocMode = 'publish' | 'review'
export declare const DOC_MODES: readonly DocMode[]
export declare function isDocMode(v: unknown): v is DocMode
export declare function modeOf(v: unknown): DocMode
export declare const MODE_ERROR: Readonly<{ error: string }>
