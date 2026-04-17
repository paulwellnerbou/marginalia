/**
 * Pandoc-style grid tables support.
 *
 * Grid tables look like:
 *
 *   +---------+---------+
 *   | Header1 | Header2 |
 *   +=========+=========+
 *   | cell    | - item  |
 *   | cont.   | - item  |
 *   +---------+---------+
 *
 * We preprocess the Markdown source: scan for grid-table blocks, parse each
 * into columns/rows, render each cell's contents through a supplied async
 * renderer, then emit an HTML <table> in place of the grid-table source.
 * The main unified pipeline then treats each rendered table as a raw HTML
 * block.
 *
 * Limitations in v1:
 * - No rowspan/colspan. Every row must have the same column count as the
 *   header border.
 * - Column alignment is taken from the separator line(s): `:--` left,
 *   `--:` right, `:-:` centered.
 * - Grid tables inside fenced code blocks are left untouched.
 */

export interface GridTableOptions {
  renderCell: (markdown: string) => Promise<string>;
}

export async function preprocessGridTables(
  source: string,
  options: GridTableOptions,
): Promise<string> {
  const lines = source.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Skip fenced code blocks verbatim.
    const fence = fenceStart(line);
    if (fence) {
      out.push(line);
      i++;
      while (i < lines.length && !isFenceEnd(lines[i]!, fence)) {
        out.push(lines[i]!);
        i++;
      }
      if (i < lines.length) {
        out.push(lines[i]!);
        i++;
      }
      continue;
    }

    if (isBorder(line)) {
      const end = findTableEnd(lines, i);
      if (end !== null) {
        const html = await renderGridTable(lines.slice(i, end + 1), options);
        // Pad with surrounding blank lines so remark treats it as its own
        // HTML block.
        out.push('');
        out.push(html);
        out.push('');
        i = end + 1;
        continue;
      }
    }

    out.push(line);
    i++;
  }

  return out.join('\n');
}

// --- scanning --------------------------------------------------------

function fenceStart(line: string): { marker: string; indent: number } | null {
  const m = line.match(/^(\s*)(`{3,}|~{3,})/);
  if (!m) return null;
  return { marker: m[2]!, indent: m[1]!.length };
}

function isFenceEnd(line: string, fence: { marker: string; indent: number }): boolean {
  const re = new RegExp(`^\\s{0,${fence.indent}}${fence.marker[0]}{${fence.marker.length},}\\s*$`);
  return re.test(line);
}

function isBorder(line: string): boolean {
  // A border is `+`, at least one of `-`/`=`/`:`, possibly more segments
  // separated by internal `+`s, ending with `+`. Must contain at least one
  // `-` or `=` so that `+++` alone isn't matched.
  if (!/^\s*\+[-=+:]+\+\s*$/.test(line)) return false;
  return /[-=]/.test(line);
}

function isContentRow(line: string): boolean {
  const t = line.trimEnd();
  return t.startsWith('|') && t.endsWith('|') && t.length >= 2;
}

/**
 * A grid table starts at a border line. It extends as long as the block
 * alternates border and content rows and all rows have matching column
 * positions (determined by the first border). Returns the index of the
 * final border line, or null if the block is malformed.
 */
function findTableEnd(lines: string[], start: number): number | null {
  const firstBorder = lines[start]!;
  const boundaries = columnBoundaries(firstBorder);
  if (boundaries.length < 2) return null;

  let i = start + 1;
  let sawContent = false;
  let lastBorder = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBorder(line)) {
      if (columnBoundariesMatch(line, boundaries)) {
        lastBorder = i;
        i++;
        continue;
      }
      break;
    }
    if (isContentRow(line) && contentMatchesBoundaries(line, boundaries)) {
      sawContent = true;
      i++;
      continue;
    }
    break;
  }

  if (!sawContent) return null;
  return lastBorder;
}

/**
 * `+---+---+---+` → positions of each `+`.
 */
function columnBoundaries(line: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '+') positions.push(i);
  }
  return positions;
}

function columnBoundariesMatch(line: string, boundaries: number[]): boolean {
  const found = columnBoundaries(line);
  if (found.length !== boundaries.length) return false;
  for (let i = 0; i < found.length; i++) {
    if (found[i] !== boundaries[i]) return false;
  }
  return true;
}

function contentMatchesBoundaries(line: string, boundaries: number[]): boolean {
  for (const b of boundaries) {
    if (line[b] !== '|') return false;
  }
  return true;
}

// --- rendering -------------------------------------------------------

interface ParsedTable {
  columnAligns: Array<'left' | 'right' | 'center' | 'default'>;
  header: string[][] | null;
  body: string[][][];
}

async function renderGridTable(
  block: string[],
  options: GridTableOptions,
): Promise<string> {
  const boundaries = columnBoundaries(block[0]!);
  const parsed = parseTable(block, boundaries);
  return renderAsHtml(parsed, options);
}

function parseTable(block: string[], boundaries: number[]): ParsedTable {
  const cols = boundaries.length - 1;
  const columnAligns: ParsedTable['columnAligns'] = new Array(cols).fill('default');

  // Rows are split at each border line. A row's cells are the slices
  // between boundary columns, across all its physical lines, joined with
  // newlines and then dedented.
  type Row = { kind: 'border' | 'content'; line: string; isHeaderSep?: boolean };
  const rows: Row[] = block.map((line) => {
    if (isBorder(line)) {
      const isHeaderSep = /=/.test(line);
      return { kind: 'border', line, isHeaderSep };
    }
    return { kind: 'content', line };
  });

  // Extract per-column alignment from the last border before header-end
  // (or first border if there's no header).
  const headerSepIdx = rows.findIndex((r) => r.kind === 'border' && r.isHeaderSep);
  const alignSource = headerSepIdx >= 0 ? rows[headerSepIdx]!.line : rows[0]!.line;
  for (let c = 0; c < cols; c++) {
    const l = boundaries[c]! + 1;
    const r = boundaries[c + 1]!;
    const segment = alignSource.slice(l, r);
    const left = segment.startsWith(':');
    const right = segment.endsWith(':');
    columnAligns[c] =
      left && right ? 'center' : right ? 'right' : left ? 'left' : 'default';
  }

  // Collect physical content rows between each pair of borders.
  // A "logical row" is the cluster of content lines between two borders.
  const groups: string[][] = [];
  let current: string[] = [];
  let headerEnd = -1;
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    if (row.kind === 'border') {
      if (current.length > 0) {
        groups.push(current);
        if (row.isHeaderSep) headerEnd = groups.length - 1;
        current = [];
      }
    } else {
      current.push(row.line);
    }
  }
  if (current.length > 0) groups.push(current);

  // Convert each logical row into cell strings.
  const logicalRows: string[][] = groups.map((physLines) => {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const l = boundaries[c]! + 1;
      const r = boundaries[c + 1]!;
      const cellLines = physLines.map((line) => line.slice(l, r));
      cells.push(dedent(cellLines).trim());
    }
    return cells;
  });

  const header = headerEnd >= 0 ? logicalRows[headerEnd] ?? null : null;
  const body =
    headerEnd >= 0 ? logicalRows.slice(headerEnd + 1) : logicalRows;

  return {
    columnAligns,
    header: header ? [header] : null,
    body: body.map((r) => [r]),
  };
}

/**
 * Remove a common leading whitespace prefix from cell lines.
 */
function dedent(lines: string[]): string {
  if (lines.length === 0) return '';
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const m = line.match(/^(\s*)/);
    const len = m ? m[1]!.length : 0;
    if (len < min) min = len;
  }
  if (!isFinite(min)) min = 0;
  return lines.map((l) => l.slice(min)).join('\n');
}

async function renderAsHtml(
  table: ParsedTable,
  options: GridTableOptions,
): Promise<string> {
  const parts: string[] = [];
  parts.push('<table class="grid-table">');

  if (table.header) {
    parts.push('<thead>');
    for (const row of table.header) {
      parts.push('<tr>');
      for (let c = 0; c < row.length; c++) {
        const cell = row[c]!;
        const html = await options.renderCell(cell);
        parts.push(`<th${alignAttr(table.columnAligns[c]!)}>${html}</th>`);
      }
      parts.push('</tr>');
    }
    parts.push('</thead>');
  }

  if (table.body.length > 0) {
    parts.push('<tbody>');
    for (const rowCluster of table.body) {
      for (const row of rowCluster) {
        parts.push('<tr>');
        for (let c = 0; c < row.length; c++) {
          const cell = row[c]!;
          const html = await options.renderCell(cell);
          parts.push(`<td${alignAttr(table.columnAligns[c]!)}>${html}</td>`);
        }
        parts.push('</tr>');
      }
    }
    parts.push('</tbody>');
  }

  parts.push('</table>');
  return parts.join('');
}

function alignAttr(a: 'left' | 'right' | 'center' | 'default'): string {
  return a === 'default' ? '' : ` align="${a}"`;
}
