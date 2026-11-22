import type {
  KnowledgeSegment,
  PaperColor,
  StickyNoteItem,
  StickyNoteTimestampConflict,
  StickyNoteTimestampItem,
} from '../types/domain';

export interface ParsedStickyTimestamp {
  raw: string;
  timestampSec: number;
  timestampText: string;
  startOffset: number;
  endOffset: number;
  lineIndex: number;
}

export interface PaperThemeTokens {
  id: PaperColor;
  label: string;
  bodyBg: string;
  bodyBgTranslucent: string;
  headerBg: string;
  footerBg: string;
  border: string;
  borderStrong: string;
  ruleLine: string;
  chipBg: string;
  chipHoverBg: string;
  chipBorder: string;
  chipText: string;
  swatchBg: string;
  gradientMid: string;
  gradientEnd: string;
  edgeAccent: string;
}

export const PAPER_THEME_ORDER: PaperColor[] = ['cream', 'butter', 'sage', 'blush'];

export const PAPER_THEMES: Record<PaperColor, PaperThemeTokens> = {
  cream: {
    id: 'cream',
    label: '暖米纸',
    bodyBg: '#FFFDF2',
    bodyBgTranslucent: 'rgba(255, 253, 242, 0.86)',
    headerBg: '#F7F0D6',
    footerBg: '#FAF5E2',
    border: '#E5D8A8',
    borderStrong: '#D2BC74',
    ruleLine: 'rgba(210, 188, 116, 0.22)',
    chipBg: '#F5EBC4',
    chipHoverBg: '#ECE0AC',
    chipBorder: '#DFC983',
    chipText: '#6F5414',
    swatchBg: '#F7E9B8',
    gradientMid: 'rgba(253, 244, 206, 0.34)',
    gradientEnd: 'rgba(244, 224, 152, 0.82)',
    edgeAccent: '#D4B452',
  },
  butter: {
    id: 'butter',
    label: '鹅黄纸',
    bodyBg: '#FFF9DB',
    bodyBgTranslucent: 'rgba(255, 249, 219, 0.86)',
    headerBg: '#F9EBB3',
    footerBg: '#FCF2C8',
    border: '#E8D27C',
    borderStrong: '#D4B54A',
    ruleLine: 'rgba(212, 181, 74, 0.22)',
    chipBg: '#F6E292',
    chipHoverBg: '#EFD574',
    chipBorder: '#DFC057',
    chipText: '#6B4E0C',
    swatchBg: '#F9E182',
    gradientMid: 'rgba(255, 240, 179, 0.36)',
    gradientEnd: 'rgba(248, 219, 114, 0.84)',
    edgeAccent: '#CFA82E',
  },
  sage: {
    id: 'sage',
    label: '竹青纸',
    bodyBg: '#F2FAF4',
    bodyBgTranslucent: 'rgba(242, 250, 244, 0.86)',
    headerBg: '#DFEFE4',
    footerBg: '#E9F5EC',
    border: '#BDDAC5',
    borderStrong: '#8FBFA0',
    ruleLine: 'rgba(143, 191, 160, 0.24)',
    chipBg: '#D4EBD9',
    chipHoverBg: '#C0E2C8',
    chipBorder: '#9ECBA9',
    chipText: '#215734',
    swatchBg: '#C8E6D0',
    gradientMid: 'rgba(218, 242, 225, 0.36)',
    gradientEnd: 'rgba(181, 224, 194, 0.80)',
    edgeAccent: '#5AA472',
  },
  blush: {
    id: 'blush',
    label: '浅樱纸',
    bodyBg: '#FFF5F6',
    bodyBgTranslucent: 'rgba(255, 245, 246, 0.86)',
    headerBg: '#FBE3E7',
    footerBg: '#FDF0F2',
    border: '#ECC1C9',
    borderStrong: '#DA9AA7',
    ruleLine: 'rgba(218, 154, 167, 0.24)',
    chipBg: '#F7D5DC',
    chipHoverBg: '#F1C1CB',
    chipBorder: '#E3A4B2',
    chipText: '#7D2D3F',
    swatchBg: '#F7CDD6',
    gradientMid: 'rgba(252, 226, 232, 0.36)',
    gradientEnd: 'rgba(244, 194, 206, 0.80)',
    edgeAccent: '#D1788C',
  },
};

const STICKY_TS_REGEX = /\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]/g;

export function formatStickySec(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function formatStickyBracket(totalSec: number): string {
  return `[${formatStickySec(totalSec)}]`;
}

export function parseStickyTimestamps(content: string): ParsedStickyTimestamp[] {
  if (!content) return [];
  const results: ParsedStickyTimestamp[] = [];
  STICKY_TS_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STICKY_TS_REGEX.exec(content)) !== null) {
    const hrsRaw = match[1];
    const mins = Number(match[2]);
    const secs = Number(match[3]);
    if (secs >= 60) continue;
    if (hrsRaw !== undefined && mins >= 60) continue;
    const hrs = hrsRaw !== undefined ? Number(hrsRaw) : 0;
    const totalSec = hrs * 3600 + mins * 60 + secs;
    const startOffset = match.index;
    const lineIndex = content.slice(0, startOffset).split('\n').length - 1;
    results.push({
      raw: match[0],
      timestampSec: totalSec,
      timestampText: formatStickySec(totalSec),
      startOffset,
      endOffset: startOffset + match[0].length,
      lineIndex,
    });
  }
  return results;
}

export function getStickyNoteDisplayTitle(note: Pick<StickyNoteItem, 'title' | 'content'>, fallbackIndex = 1): string {
  if (note.title && note.title.trim()) {
    return note.title.trim();
  }
  for (const line of (note.content || '').split('\n')) {
    const cleaned = line.trim();
    if (cleaned) return cleaned.slice(0, 22);
  }
  return `课堂便签 #${fallbackIndex}`;
}

export function getStickyLinePreview(content: string, charOffset: number): string {
  if (!content) return '';
  const safeOffset = Math.max(0, Math.min(content.length, charOffset));
  const lineStart = content.lastIndexOf('\n', safeOffset - 1) + 1;
  const nextBreak = content.indexOf('\n', safeOffset);
  const lineEnd = nextBreak === -1 ? content.length : nextBreak;
  return content.slice(lineStart, lineEnd).trim().slice(0, 80);
}

export interface SessionTimestampClaim {
  noteId: string;
  noteTitle: string;
  paperColor: PaperColor;
  timestampSec: number;
  timestampText: string;
  charOffset: number;
  linePreview: string;
  createdAt: string;
}

/**
 * Computes the effective per-second timestamp ownership map across all sticky notes in a session,
 * strictly enforcing first-come-first-served (先来后到).
 */
export function computeSessionTimestampClaims(
  notes: StickyNoteItem[]
): Map<number, SessionTimestampClaim> {
  const claimMap = new Map<number, SessionTimestampClaim>();
  const titleMap = new Map<string, string>();
  notes.forEach((n, idx) => titleMap.set(n.id, getStickyNoteDisplayTitle(n, idx + 1)));

  // First pass: honor persisted server/confirmed timestamps ordered by earliest createdAt (先来后到).
  const persisted: Array<{ note: StickyNoteItem; ts: StickyNoteTimestampItem }> = [];
  for (const note of notes) {
    for (const ts of note.timestamps ?? []) {
      persisted.push({ note, ts });
    }
  }
  persisted.sort((a, b) => a.ts.createdAt.localeCompare(b.ts.createdAt));

  for (const { note, ts } of persisted) {
    if (claimMap.has(ts.timestampSec)) continue;
    claimMap.set(ts.timestampSec, {
      noteId: note.id,
      noteTitle: titleMap.get(note.id) ?? '课堂便签',
      paperColor: note.paperColor,
      timestampSec: ts.timestampSec,
      timestampText: ts.timestampText,
      charOffset: ts.charOffset,
      linePreview: getStickyLinePreview(note.content, ts.charOffset),
      createdAt: ts.createdAt,
    });
  }

  return claimMap;
}

/**
 * Reconciles a single note's live draft content against the rest of the session's notes
 * for instant UI feedback before server round-trip completes.
 */
export function reconcileNoteDraftTimestamps(
  note: StickyNoteItem,
  nextContent: string,
  allNotes: StickyNoteItem[]
): { timestamps: StickyNoteTimestampItem[]; conflicts: StickyNoteTimestampConflict[] } {
  const titleMap = new Map<string, string>();
  allNotes.forEach((n, idx) => titleMap.set(n.id, getStickyNoteDisplayTitle(n, idx + 1)));

  const otherOwners = new Map<number, { noteId: string; title: string }>();
  for (const other of allNotes) {
    if (other.id === note.id) continue;
    for (const ts of other.timestamps ?? []) {
      if (!otherOwners.has(ts.timestampSec)) {
        otherOwners.set(ts.timestampSec, {
          noteId: other.id,
          title: titleMap.get(other.id) ?? '课堂便签',
        });
      }
    }
  }

  const prevOwnedBySec = new Map<number, StickyNoteTimestampItem>();
  for (const ts of note.timestamps ?? []) {
    prevOwnedBySec.set(ts.timestampSec, ts);
  }

  const timestamps: StickyNoteTimestampItem[] = [];
  const conflicts: StickyNoteTimestampConflict[] = [];
  const seenSelf = new Set<number>();
  const seenConflict = new Set<number>();
  const nowIso = new Date().toISOString();

  for (const match of parseStickyTimestamps(nextContent)) {
    const other = otherOwners.get(match.timestampSec);
    if (other) {
      if (!seenConflict.has(match.timestampSec)) {
        seenConflict.add(match.timestampSec);
        conflicts.push({
          timestampSec: match.timestampSec,
          timestampText: match.timestampText,
          ownerNoteId: other.noteId,
          ownerNoteTitle: other.title,
        });
      }
      continue;
    }
    if (seenSelf.has(match.timestampSec)) {
      if (!seenConflict.has(match.timestampSec)) {
        seenConflict.add(match.timestampSec);
        conflicts.push({
          timestampSec: match.timestampSec,
          timestampText: match.timestampText,
          ownerNoteId: note.id,
          ownerNoteTitle: titleMap.get(note.id) ?? '当前便签',
        });
      }
      continue;
    }
    seenSelf.add(match.timestampSec);
    const prev = prevOwnedBySec.get(match.timestampSec);
    timestamps.push({
      id: prev?.id ?? `local-ts-${note.id}-${match.timestampSec}`,
      noteId: note.id,
      timestampSec: match.timestampSec,
      timestampText: match.timestampText,
      charOffset: match.startOffset,
      createdAt: prev?.createdAt ?? nowIso,
    });
  }

  return { timestamps, conflicts };
}

export interface UtteranceStickyAnchor {
  noteId: string;
  noteTitle: string;
  paperColor: PaperColor;
  timestampSec: number;
  timestampText: string;
  charOffset: number;
  linePreview: string;
}

/**
 * Maps every active sticky-note timestamp in the session to the best matching UtteranceRow.
 */
export function mapStickyAnchorsToUtterances(
  notes: StickyNoteItem[],
  segments: KnowledgeSegment[]
): Map<string, UtteranceStickyAnchor[]> {
  const result = new Map<string, UtteranceStickyAnchor[]>();
  const claims = computeSessionTimestampClaims(notes);
  if (claims.size === 0 || segments.length === 0) return result;

  const flatUtterances: Array<{ id: string; startTimeMs: number; endTimeMs: number }> = [];
  for (const seg of segments) {
    for (const utt of seg.utterances) {
      flatUtterances.push({
        id: utt.id,
        startTimeMs: utt.startTimeMs,
        endTimeMs: utt.endTimeMs,
      });
    }
  }
  if (flatUtterances.length === 0) return result;

  for (const claim of claims.values()) {
    const targetMs = claim.timestampSec * 1000;
    let matchedId: string | null = null;

    // 1. Exact start-second match first (so [00:20] always lands on the 00:20 utterance, matching reverse jump)
    for (const u of flatUtterances) {
      if (Math.floor(u.startTimeMs / 1000) === claim.timestampSec) {
        matchedId = u.id;
        break;
      }
    }

    // 2. Half-open range match: startTimeMs <= targetMs < endTimeMs
    if (!matchedId) {
      for (const u of flatUtterances) {
        if (targetMs >= u.startTimeMs && targetMs < u.endTimeMs) {
          matchedId = u.id;
          break;
        }
      }
    }

    // 3. Fallback: latest utterance starting at or before targetMs
    if (!matchedId) {
      let bestStart = -1;
      for (const u of flatUtterances) {
        if (u.startTimeMs <= targetMs && u.startTimeMs >= bestStart) {
          bestStart = u.startTimeMs;
          matchedId = u.id;
        }
      }
    }

    // 4. Final fallback: closest utterance overall
    if (!matchedId) {
      let bestDist = Number.POSITIVE_INFINITY;
      for (const u of flatUtterances) {
        const dist = Math.abs(u.startTimeMs - targetMs);
        if (dist < bestDist) {
          bestDist = dist;
          matchedId = u.id;
        }
      }
    }

    if (matchedId) {
      const list = result.get(matchedId) ?? [];
      list.push({
        noteId: claim.noteId,
        noteTitle: claim.noteTitle,
        paperColor: claim.paperColor,
        timestampSec: claim.timestampSec,
        timestampText: claim.timestampText,
        charOffset: claim.charOffset,
        linePreview: claim.linePreview,
      });
      result.set(matchedId, list);
    }
  }

  for (const list of result.values()) {
    list.sort((a, b) => a.timestampSec - b.timestampSec);
  }
  return result;
}

export function clampStickyBounds(
  rect: { posX: number; posY: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number
): { posX: number; posY: number; width: number; height: number } {
  const minW = 290;
  const minH = 230;
  const maxW = Math.max(minW, Math.floor(viewportWidth * 0.82));
  const maxH = Math.max(minH, Math.floor((viewportHeight - 72) * 0.84));
  const width = Math.min(maxW, Math.max(minW, Math.round(rect.width)));
  const height = Math.min(maxH, Math.max(minH, Math.round(rect.height)));

  const minTop = 68;
  const maxLeft = Math.max(12, viewportWidth - Math.min(width, viewportWidth - 24) - 12);
  const maxTop = Math.max(minTop, viewportHeight - Math.min(height, viewportHeight - minTop - 12) - 12);

  const posX = Math.min(maxLeft, Math.max(12, Math.round(rect.posX)));
  const posY = Math.min(maxTop, Math.max(minTop, Math.round(rect.posY)));
  return { posX, posY, width, height };
}

export function computeCascadeStickyPosition(
  existingNotes: StickyNoteItem[],
  viewportWidth: number,
  viewportHeight: number
): { posX: number; posY: number; width: number; height: number } {
  const openCount = existingNotes.filter((n) => n.isOpen).length;
  const width = 348;
  const height = 316;
  const baseX = Math.max(24, Math.round(viewportWidth - width - 40));
  const baseY = 82;
  const step = (openCount % 6) * 28;
  return clampStickyBounds(
    {
      posX: baseX - step,
      posY: baseY + step,
      width,
      height,
    },
    viewportWidth,
    viewportHeight
  );
}
