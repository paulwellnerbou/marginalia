import { Text } from '@radix-ui/themes';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  type DiffOverviewLineLayout,
  buildDiffOverviewMarkers,
  buildMeasuredDiffOverviewMarkers,
  getDiffOverviewViewport,
} from '../lib/diff-overview.js';
import { type DiffLine, diffLines } from '../lib/line-diff.js';

interface Props {
  before: string;
  after: string;
  /**
   * When false, layout-measuring effects are skipped. Useful when the diff is
   * rendered inside a Dialog that may keep content mounted while closed.
   * Defaults to true.
   */
  active?: boolean;
}

export function DiffView({ before, after, active = true }: Props) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const hasChanges = lines.some((line) => line.op !== 'equal');
  const renderedLines = useMemo(() => buildRenderableLines(lines), [lines]);
  const renderLineKeys = useMemo(() => renderedLines.map(({ key }) => key), [renderedLines]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScroller(node);
  }, []);
  const [scrollMetrics, setScrollMetrics] = useState({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const [lineLayoutState, setLineLayoutState] = useState<{
    keys: string[];
    layouts: Array<DiffOverviewLineLayout | null>;
  }>({
    keys: [],
    layouts: [],
  });

  const overviewMarkers = useMemo(() => {
    const fallbackMarkers = buildDiffOverviewMarkers(lines);
    if (!areStringArraysEqual(lineLayoutState.keys, renderLineKeys)) return fallbackMarkers;

    const measuredMarkers = buildMeasuredDiffOverviewMarkers({
      lines,
      lineLayouts: lineLayoutState.layouts,
      scrollHeight: scrollMetrics.scrollHeight,
    });
    return measuredMarkers.length ? measuredMarkers : fallbackMarkers;
  }, [lineLayoutState, lines, renderLineKeys, scrollMetrics.scrollHeight]);

  useLayoutEffect(() => {
    if (!active || !scroller) return;

    const syncScrollMetrics = () => {
      setScrollMetrics((prev) => {
        const next = {
          scrollTop: scroller.scrollTop,
          scrollHeight: Math.max(scroller.scrollHeight, 1),
          clientHeight: scroller.clientHeight,
        };
        if (
          prev.scrollTop === next.scrollTop &&
          prev.scrollHeight === next.scrollHeight &&
          prev.clientHeight === next.clientHeight
        ) {
          return prev;
        }
        return next;
      });
    };
    const syncOverviewLayouts = () => {
      const nextLayouts = renderedLines.map(({ key }) =>
        measureDiffLineLayout(lineRefs.current.get(key), scroller),
      );
      setLineLayoutState((prev) => {
        if (
          areStringArraysEqual(prev.keys, renderLineKeys) &&
          areLineLayoutsEqual(prev.layouts, nextLayouts)
        ) {
          return prev;
        }
        return { keys: renderLineKeys, layouts: nextLayouts };
      });
    };
    const syncLayoutState = () => {
      syncScrollMetrics();
      syncOverviewLayouts();
    };

    syncLayoutState();
    const frame = window.requestAnimationFrame(syncLayoutState);
    scroller.addEventListener('scroll', syncScrollMetrics);
    window.addEventListener('resize', syncLayoutState);

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncLayoutState);
    observer?.observe(scroller);
    if (contentRef.current) observer?.observe(contentRef.current);

    return () => {
      window.cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', syncScrollMetrics);
      window.removeEventListener('resize', syncLayoutState);
      observer?.disconnect();
    };
  }, [active, scroller, renderLineKeys, renderedLines]);

  const overviewViewport = useMemo(() => getDiffOverviewViewport(scrollMetrics), [scrollMetrics]);
  const overviewCenterRatio = overviewViewport
    ? overviewViewport.topPercent / 100 + overviewViewport.heightPercent / 200
    : 0;

  function scrollToOverviewPosition(ratio: number) {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const maxScrollTop = Math.max(scroller.scrollHeight - scroller.clientHeight, 0);
    if (maxScrollTop <= 0) return;

    const desiredTop = ratio * scroller.scrollHeight - scroller.clientHeight / 2;
    const targetTop = Math.max(0, Math.min(desiredTop, maxScrollTop));
    scroller.scrollTo({ top: targetTop, behavior: 'smooth' });
  }

  function handleOverviewClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = Math.max(0, Math.min((event.clientY - rect.top) / rect.height, 1));
    scrollToOverviewPosition(ratio);
  }

  function handleOverviewKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    let nextRatio: number | null = null;

    switch (event.key) {
      case 'Home':
        nextRatio = 0;
        break;
      case 'End':
        nextRatio = 1;
        break;
      case 'PageUp':
        nextRatio = overviewCenterRatio - 0.25;
        break;
      case 'PageDown':
        nextRatio = overviewCenterRatio + 0.25;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextRatio = overviewCenterRatio - 0.1;
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        nextRatio = overviewCenterRatio + 0.1;
        break;
      case ' ':
        nextRatio = overviewCenterRatio + (event.shiftKey ? -0.25 : 0.25);
        break;
      case 'Enter':
        nextRatio = overviewCenterRatio;
        break;
      default:
        return;
    }

    event.preventDefault();
    scrollToOverviewPosition(Math.max(0, Math.min(nextRatio, 1)));
  }

  return (
    <section className="diff-view" aria-label="Diff">
      <div ref={setScrollNode} className={`diff-scroll${hasChanges ? '' : ' diff-scroll-empty'}`}>
        <div ref={contentRef}>
          {hasChanges ? (
            renderedLines.map(({ key, line }) => (
              <div
                key={key}
                ref={(node) => {
                  if (node) lineRefs.current.set(key, node);
                  else lineRefs.current.delete(key);
                }}
                className={`diff-line diff-${line.op}`}
              >
                <span className="diff-marker">
                  {line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}
                </span>
                <span className="diff-text">{renderLineText(line)}</span>
              </div>
            ))
          ) : (
            <Text size="1" color="gray">
              (no changes)
            </Text>
          )}
        </div>
      </div>
      {overviewMarkers.length ? (
        <div className="diff-overview" aria-label="Diff overview">
          <button
            type="button"
            className="diff-overview-track"
            onClick={handleOverviewClick}
            onKeyDown={handleOverviewKeyDown}
            aria-label="Jump through diff overview"
          >
            {overviewMarkers.map((marker) => (
              <span
                key={`${marker.op}-${marker.startLine}-${marker.lineCount}`}
                className={`diff-overview-marker diff-overview-marker-${marker.op}`}
                style={{
                  top: `${marker.topPercent}%`,
                  height: `${marker.heightPercent}%`,
                }}
              />
            ))}
            {overviewViewport ? (
              <div
                className="diff-overview-viewport"
                style={{
                  top: `${overviewViewport.topPercent}%`,
                  height: `${overviewViewport.heightPercent}%`,
                }}
              />
            ) : null}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function renderLineText(line: DiffLine): React.ReactNode {
  if (!line.text) return ' ';
  if (!line.segments?.length) return line.text;

  const occurrences = new Map<string, number>();
  return line.segments.map((segment) => {
    const signature = `${segment.changed ? '1' : '0'} ${segment.text}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const key = `${signature} ${occurrence}`;

    return segment.changed ? (
      <span key={key} className="diff-inline-change">
        {segment.text}
      </span>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
}

function buildRenderableLines(lines: DiffLine[]): Array<{ key: string; line: DiffLine }> {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const signature = `${line.op} ${line.text}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return { key: `${signature} ${occurrence}`, line };
  });
}

function measureDiffLineLayout(
  line: HTMLDivElement | null | undefined,
  scroller: HTMLDivElement,
): DiffOverviewLineLayout | null {
  if (!line || !scroller.contains(line)) return null;

  // Use offsetTop walked up to the scroller. Layout-based offsets are immune
  // to ancestor CSS transforms (Radix Dialog scales during its open animation),
  // unlike getBoundingClientRect which returns transformed coordinates and
  // would mix incompatibly with scroller.scrollTop.
  let top = 0;
  let el: HTMLElement | null = line;
  while (el && el !== scroller) {
    top += el.offsetTop;
    el = el.offsetParent as HTMLElement | null;
  }
  if (el !== scroller) return null;

  const bottom = top + line.offsetHeight;
  if (bottom <= top) return null;

  return { top, bottom };
}

function areLineLayoutsEqual(
  prev: Array<DiffOverviewLineLayout | null>,
  next: Array<DiffOverviewLineLayout | null>,
): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const prevLayout = prev[i];
    const nextLayout = next[i];
    if (prevLayout === nextLayout) continue;
    if (!prevLayout || !nextLayout) return false;
    if (prevLayout.top !== nextLayout.top || prevLayout.bottom !== nextLayout.bottom) return false;
  }
  return true;
}

function areStringArraysEqual(prev: string[], next: string[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}
