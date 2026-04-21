import type { DiffLine, DiffOp } from './line-diff.js';

export interface DiffOverviewMarker {
  op: Exclude<DiffOp, 'equal'>;
  startLine: number;
  lineCount: number;
  topPercent: number;
  heightPercent: number;
}

export interface DiffOverviewViewport {
  topPercent: number;
  heightPercent: number;
}

export interface DiffOverviewLineLayout {
  top: number;
  bottom: number;
}

export function buildDiffOverviewMarkers(lines: DiffLine[]): DiffOverviewMarker[] {
  const lineLayouts = lines.map((_, index) => ({ top: index, bottom: index + 1 }));
  return buildMeasuredDiffOverviewMarkers({
    lines,
    lineLayouts,
    scrollHeight: lines.length || 1,
  });
}

export function buildMeasuredDiffOverviewMarkers(params: {
  lines: DiffLine[];
  lineLayouts: Array<DiffOverviewLineLayout | null>;
  scrollHeight: number;
}): DiffOverviewMarker[] {
  const { lines, lineLayouts } = params;
  const totalHeight = Math.max(params.scrollHeight, 1);
  const markers: DiffOverviewMarker[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.op === 'equal') continue;

    const op = line.op;
    const startLine = i;
    let markerTop: number | null = null;
    let markerBottom: number | null = null;

    while (true) {
      const layout = lineLayouts[i];
      if (layout) {
        markerTop ??= layout.top;
        markerBottom = layout.bottom;
      }
      if (i + 1 >= lines.length || lines[i + 1]?.op !== op) break;
      i++;
    }

    if (markerTop === null || markerBottom === null || markerBottom <= markerTop) continue;
    markers.push({
      op,
      startLine,
      lineCount: i - startLine + 1,
      topPercent: (markerTop / totalHeight) * 100,
      heightPercent: ((markerBottom - markerTop) / totalHeight) * 100,
    });
  }

  return markers;
}

export function getDiffOverviewViewport(params: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): DiffOverviewViewport | null {
  const { scrollTop, scrollHeight, clientHeight } = params;
  if (scrollHeight <= 0 || clientHeight <= 0 || scrollHeight <= clientHeight + 1) return null;

  const boundedScrollTop = Math.max(0, Math.min(scrollTop, scrollHeight - clientHeight));
  return {
    topPercent: (boundedScrollTop / scrollHeight) * 100,
    heightPercent: (clientHeight / scrollHeight) * 100,
  };
}
