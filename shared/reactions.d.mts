export interface ReactionDef { readonly code: string; readonly emoji: string; readonly label: string }
export declare const REACTIONS: readonly ReactionDef[]
export declare const REACTION_CODES: readonly string[]
export declare const READER_ID_RE: RegExp
export declare const SECTION_RE: RegExp
export declare const READER_NAME_MAX: number
export declare function normalizeReaderName(v: unknown): string | null
