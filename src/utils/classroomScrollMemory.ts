export interface PanelScrollSnapshot {
  anchorKey?: string;
  anchorOffsetPx: number;
  anchorUtteranceId?: string;
  anchorUtteranceOffsetPx?: number;
  scrollTop: number;
  atBottom: boolean;
  updatedAt: number;
}

export interface ClassroomScrollRecord {
  transcript?: PanelScrollSnapshot;
  chat?: PanelScrollSnapshot;
  updatedAt: number;
}

export type ClassroomScrollPanel = 'transcript' | 'chat';

const STORAGE_KEY = 'zhiling_classroom_scroll_memory_v1';
const MAX_STORED_SESSIONS = 300;

let memoryCache: Record<string, ClassroomScrollRecord> | null = null;

function readAll(): Record<string, ClassroomScrollRecord> {
  if (memoryCache) return memoryCache;
  if (typeof window === 'undefined') {
    memoryCache = {};
    return memoryCache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      memoryCache = {};
      return memoryCache;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      memoryCache = parsed as Record<string, ClassroomScrollRecord>;
      return memoryCache;
    }
  } catch {
    // ignore corrupted storage
  }
  memoryCache = {};
  return memoryCache;
}

function writeAll(map: Record<string, ClassroomScrollRecord>): void {
  const keys = Object.keys(map);
  if (keys.length > MAX_STORED_SESSIONS) {
    keys.sort((a, b) => (map[b]?.updatedAt ?? 0) - (map[a]?.updatedAt ?? 0));
    const pruned: Record<string, ClassroomScrollRecord> = {};
    for (const k of keys.slice(0, MAX_STORED_SESSIONS)) {
      pruned[k] = map[k];
    }
    memoryCache = pruned;
  } else {
    memoryCache = map;
  }
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryCache));
  } catch {
    // ignore storage quota errors
  }
}

export function loadPanelScroll(
  sessionId: string,
  panel: ClassroomScrollPanel
): PanelScrollSnapshot | null {
  if (!sessionId) return null;
  const record = readAll()[sessionId];
  const snap = record?.[panel];
  if (!snap || typeof snap.scrollTop !== 'number') return null;
  return snap;
}

export function savePanelScroll(
  sessionId: string,
  panel: ClassroomScrollPanel,
  snapshot: PanelScrollSnapshot
): void {
  if (!sessionId) return;
  const all = { ...readAll() };
  const prev = all[sessionId] ?? { updatedAt: snapshot.updatedAt };
  all[sessionId] = {
    ...prev,
    [panel]: snapshot,
    updatedAt: snapshot.updatedAt,
  };
  writeAll(all);
}

export function clearClassroomScroll(sessionId: string): void {
  if (!sessionId) return;
  const all = { ...readAll() };
  if (!(sessionId in all)) return;
  delete all[sessionId];
  writeAll(all);
}
