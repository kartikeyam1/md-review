export interface MarkedSection {
  /** 0-based line of the opener. */
  start: number
  /** 0-based line of the closer, or the last line when unclosed (inclusive). */
  end: number
  closed: boolean
  /** Plain-text label (agent sections only; '' when none), ≤ 80 chars + '…'. */
  label: string
}
export declare const AGENT_LABEL_MAX: number
export declare function topLevelLines(src: string): boolean[]
export declare function findAgentSections(src: string): MarkedSection[]
export declare function findNotesSections(src: string): MarkedSection[]
export declare function countAgentSections(src: string): number
export declare function removeLineRanges(src: string, sections: readonly { start: number; end: number }[]): string
export declare function stripAgentSections(src: string): { markdown: string; count: number }
