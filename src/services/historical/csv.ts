/**
 * Minimal RFC 4180 CSV parser (no dependencies).
 * Handles quoted fields, embedded commas, embedded newlines (CRLF/LF) and escaped quotes ("").
 * Use for offline historical-data import only.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip UTF-8 BOM
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Flush trailing field/row (if the file does not end with a newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop fully empty rows
  return rows.filter(r => r.some(c => c.trim().length > 0));
}

export function normalizeHeader(name: string): string {
  return String(name).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function findColumn(headers: string[], ...candidates: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const idx = normalized.indexOf(normalizeHeader(candidate));
    if (idx !== -1) return idx;
  }
  for (const candidate of candidates) {
    const needle = normalizeHeader(candidate);
    const idx = normalized.findIndex(h => h.includes(needle));
    if (idx !== -1) return idx;
  }
  return -1;
}
