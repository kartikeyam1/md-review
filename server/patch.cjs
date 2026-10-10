'use strict';
// ── Unified-diff patch applier (validating) ─────────────────────────────────
// Applies hunks in order and REFUSES to apply when a removed/context line does
// not match the source (throws PatchError). Silently mis-applying a patch is
// far worse than rejecting it — the caller can re-read and retry.

class PatchError extends Error {}

function applyPatch(original, patch) {
  const lines = original.split('\n');
  // A trailing newline on the patch text is not an (empty) context line.
  const patchLines = patch.replace(/\n$/, '').split('\n');
  const result = [];
  let srcIdx = 0;
  let hunks = 0;

  const expect = (content) => {
    if (srcIdx >= lines.length) {
      throw new PatchError(`Patch refers to source line ${srcIdx + 1} but the document has only ${lines.length} lines`);
    }
    if (lines[srcIdx] !== content) {
      throw new PatchError(`Patch context mismatch at source line ${srcIdx + 1}: expected ${JSON.stringify(content)}, found ${JSON.stringify(lines[srcIdx])}`);
    }
  };

  for (let i = 0; i < patchLines.length; i++) {
    const hunkMatch = patchLines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!hunkMatch) continue; // diff/---/+++/index headers between hunks
    hunks++;
    // The header's line counts say exactly how many -/+/context lines follow,
    // so a body line that happens to start with "---" or "@@" is never mistaken
    // for a header.
    let srcCount = hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10);
    let dstCount = hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10);
    // Hunks with zero source lines (pure insert into an empty region) use the
    // line *before* the insertion point as their start.
    let srcStart = parseInt(hunkMatch[1], 10) - 1;
    if (srcCount === 0) srcStart += 1;
    if (srcStart < srcIdx) throw new PatchError(`Hunk at source line ${srcStart + 1} overlaps a previous hunk`);
    if (srcStart > lines.length) throw new PatchError(`Hunk starts at source line ${srcStart + 1} beyond end of document (${lines.length} lines)`);
    while (srcIdx < srcStart) result.push(lines[srcIdx++]);

    i++;
    while (i < patchLines.length && (srcCount > 0 || dstCount > 0)) {
      const pl = patchLines[i];
      if (pl.startsWith('\\')) { i++; continue; } // "\ No newline at end of file"
      if (pl.startsWith('-')) {
        expect(pl.slice(1));
        srcIdx++;
        srcCount--;
      } else if (pl.startsWith('+')) {
        result.push(pl.slice(1));
        dstCount--;
      } else {
        // context line: " text" (leading space) or "" (some tools strip the space)
        const content = pl.startsWith(' ') ? pl.slice(1) : pl;
        expect(content);
        result.push(lines[srcIdx++]);
        srcCount--;
        dstCount--;
      }
      i++;
    }
    if (srcCount !== 0 || dstCount !== 0) {
      throw new PatchError('Hunk body does not match the line counts in its @@ header');
    }
    if (i < patchLines.length && patchLines[i].startsWith('\\')) i++;
    i--; // the for-loop's i++ moves onto the line after this hunk
  }
  if (hunks === 0) throw new PatchError('No hunks found in patch (expected "@@ -a,b +c,d @@" headers)');
  while (srcIdx < lines.length) result.push(lines[srcIdx++]);
  return result.join('\n');
}

module.exports = { PatchError, applyPatch };
