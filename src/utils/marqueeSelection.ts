export interface ContentPoint {
  x: number;
  y: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MountedRowBox {
  orderIndex: number;
  contentLeft: number;
  contentRight: number;
  contentTop: number;
  contentBottom: number;
}

export interface AnchorIndexBounds {
  /** 向下拖选时的起点行索引（第一条 contentBottom >= anchorY 的行；若都在上方则为 totalCount） */
  anchorIndexForDown: number;
  /** 向上拖选时的起点行索引（最后一条 contentTop <= anchorY 的行；若都在下方则为 -1） */
  anchorIndexForUp: number;
  /** 起点正好落在某条记录内时返回该行索引，否则为 null */
  hitRowIndex: number | null;
}

export const DEFAULT_EDGE_SCROLL_ZONE_PX = 68;
export const MAX_EDGE_SCROLL_SPEED_PX_PER_SEC = 1900;

/**
 * 当拖拽指针接近滚动容器顶/底部（或拖出容器边界外）时，计算带符号的垂直自动滚动速度（px/s）。
 * - 负值：向上滚；正值：向下滚；0：处于安全区不滚动。
 * - 平滑二次加速曲线：刚进入热区约 220 px/s，贴近边缘约 1200 px/s，拉出边界最高 1900 px/s。
 */
export function computeEdgeAutoScrollSpeed(
  pointerClientY: number,
  containerTop: number,
  containerBottom: number,
  edgeZonePx = DEFAULT_EDGE_SCROLL_ZONE_PX
): number {
  const height = containerBottom - containerTop;
  if (height <= 0) return 0;
  const zone = Math.max(16, Math.min(edgeZonePx, height * 0.32));

  if (pointerClientY < containerTop + zone) {
    const depth = containerTop + zone - pointerClientY;
    const ratio = Math.min(1.5, Math.max(0, depth / zone));
    const speed = Math.min(MAX_EDGE_SCROLL_SPEED_PX_PER_SEC, 220 + 980 * ratio * ratio);
    return -speed;
  }

  if (pointerClientY > containerBottom - zone) {
    const depth = pointerClientY - (containerBottom - zone);
    const ratio = Math.min(1.5, Math.max(0, depth / zone));
    return Math.min(MAX_EDGE_SCROLL_SPEED_PX_PER_SEC, 220 + 980 * ratio * ratio);
  }

  return 0;
}

/**
 * 将滚动内容坐标系中的选框投影并裁剪到滚动容器可见视口内，防止覆盖层溢出容器或撑大 scrollHeight。
 */
export function computeMarqueeViewportRect(
  anchor: ContentPoint,
  current: ContentPoint,
  scrollLeft: number,
  scrollTop: number,
  clientWidth: number,
  clientHeight: number
): ViewportRect {
  const rawLeft = Math.min(anchor.x, current.x) - scrollLeft;
  const rawRight = Math.max(anchor.x, current.x) - scrollLeft;
  const rawTop = Math.min(anchor.y, current.y) - scrollTop;
  const rawBottom = Math.max(anchor.y, current.y) - scrollTop;

  const left = Math.max(0, Math.min(clientWidth, rawLeft));
  const right = Math.max(0, Math.min(clientWidth, rawRight));
  const top = Math.max(0, Math.min(clientHeight, rawTop));
  const bottom = Math.max(0, Math.min(clientHeight, rawBottom));

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * 在拖拽起点（pointerdown）记录上下两个方向的锚点索引。
 * 因为起点一定位于当前可见视口内，其附近行必然已挂载在 DOM 中；
 * 记录该锚点后，即使后续自动滚动数百行导致起始行被虚拟列表卸载，整段区间依然精确无漏选。
 */
export function computeAnchorIndexBounds(
  mountedRows: MountedRowBox[],
  anchorY: number,
  totalCount: number
): AnchorIndexBounds {
  if (totalCount <= 0 || mountedRows.length === 0) {
    return { anchorIndexForDown: totalCount, anchorIndexForUp: -1, hitRowIndex: null };
  }

  const sorted = [...mountedRows].sort((a, b) => a.orderIndex - b.orderIndex);
  let hitRowIndex: number | null = null;
  let anchorIndexForDown = totalCount;
  let anchorIndexForUp = -1;

  for (const row of sorted) {
    if (anchorY >= row.contentTop && anchorY <= row.contentBottom) {
      hitRowIndex = row.orderIndex;
    }
    if (row.contentBottom >= anchorY && anchorIndexForDown === totalCount) {
      anchorIndexForDown = row.orderIndex;
    }
    if (row.contentTop <= anchorY) {
      anchorIndexForUp = row.orderIndex;
    }
  }

  if (hitRowIndex !== null) {
    return {
      anchorIndexForDown: hitRowIndex,
      anchorIndexForUp: hitRowIndex,
      hitRowIndex,
    };
  }

  return { anchorIndexForDown, anchorIndexForUp, hitRowIndex: null };
}

/**
 * 根据内容坐标系中的选框与当前已挂载行位置，计算虚拟列表安全的连续选中索引区间 [start, end]。
 * - requireHorizontalOverlap=true：桌面矩形选框模式，要求水平方向与行区域有交集。
 * - requireHorizontalOverlap=false：移动端左侧勾选轨竖向滑选模式，仅按垂直跨度计算。
 */
export function computeVirtualSelectionRange(params: {
  anchor: ContentPoint;
  current: ContentPoint;
  anchorBounds: AnchorIndexBounds;
  mountedRows: MountedRowBox[];
  requireHorizontalOverlap: boolean;
}): [number, number] | null {
  const { anchor, current, anchorBounds, mountedRows, requireHorizontalOverlap } = params;
  if (mountedRows.length === 0) return null;

  const minX = Math.min(anchor.x, current.x);
  const maxX = Math.max(anchor.x, current.x);
  const minY = Math.min(anchor.y, current.y);
  const maxY = Math.max(anchor.y, current.y);

  let mountedMinIdx: number | null = null;
  let mountedMaxIdx: number | null = null;

  for (const row of mountedRows) {
    const verticalOverlap = row.contentBottom >= minY && row.contentTop <= maxY;
    if (!verticalOverlap) continue;
    if (requireHorizontalOverlap) {
      const horizontalOverlap = row.contentRight >= minX && row.contentLeft <= maxX;
      if (!horizontalOverlap) continue;
    }
    if (mountedMinIdx === null || row.orderIndex < mountedMinIdx) {
      mountedMinIdx = row.orderIndex;
    }
    if (mountedMaxIdx === null || row.orderIndex > mountedMaxIdx) {
      mountedMaxIdx = row.orderIndex;
    }
  }

  if (mountedMinIdx === null || mountedMaxIdx === null) {
    return null;
  }

  if (current.y >= anchor.y) {
    const start = anchorBounds.anchorIndexForDown;
    const end = mountedMaxIdx;
    if (start > end) return null;
    return [start, end];
  } else {
    const start = mountedMinIdx;
    const end = anchorBounds.anchorIndexForUp;
    if (start > end) return null;
    return [start, end];
  }
}

/**
 * 将单次拖拽的连续区间应用到起始快照集合上（支持正向框选加入或反选移除）。
 */
export function resolveDragSelectedIds(
  orderedIds: string[],
  baseSelectedIds: ReadonlySet<string>,
  range: [number, number] | null,
  mode: 'select' | 'deselect'
): Set<string> {
  const next = new Set(baseSelectedIds);
  if (!range) return next;
  const start = Math.max(0, Math.min(range[0], range[1]));
  const end = Math.min(orderedIds.length - 1, Math.max(range[0], range[1]));
  for (let i = start; i <= end; i += 1) {
    const id = orderedIds[i];
    if (!id) continue;
    if (mode === 'select') {
      next.add(id);
    } else {
      next.delete(id);
    }
  }
  return next;
}
