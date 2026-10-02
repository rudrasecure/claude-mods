export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }

type Op = { kind: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }

const MAX_EDIT_DISTANCE = 4000

// A file's lines; the newline that ends the last one starts no line of its own.
export function splitLines(text: string | null): string[] {
  return text ? text.replace(/\n$/, '').split('\n') : []
}

// Myers' O(ND) diff on the middle left after trimming the common prefix and
// suffix; past MAX_EDIT_DISTANCE the middle is shown as one replacement.
function middleOps(a: string[], b: string[]): ('=' | '-' | '+')[] {
  const n = a.length
  const m = b.length
  if (n === 0) return b.map(() => '+')
  if (m === 0) return a.map(() => '-')
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x]! === b[y]!) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return [...a.map(() => '-' as const), ...b.map(() => '+' as const)]

  const ops: ('=' | '-' | '+')[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!
    const k = x - y
    const prevK =
      k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('=')
      x--
      y--
    }
    if (x === prevX) {
      ops.push('+')
      y--
    } else {
      ops.push('-')
      x--
    }
  }
  while (x > 0 && y > 0) {
    ops.push('=')
    x--
    y--
  }
  return ops.reverse()
}

function allOps(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const marks: ('=' | '-' | '+')[] = [
    ...a.slice(0, start).map(() => '=' as const),
    ...middleOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map(() => '=' as const),
  ]
  const ops: Op[] = []
  let i = 0
  let j = 0
  for (const mark of marks) {
    if (mark === '=') {
      ops.push({ kind: 'ctx', text: a[i]!, oldNo: i + 1, newNo: j + 1 })
      i++
      j++
    } else if (mark === '-') {
      ops.push({ kind: 'del', text: a[i]!, oldNo: i + 1 })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j]!, newNo: j + 1 })
      j++
    }
  }
  return ops
}

// Unified-diff rows with `context` lines around each change.
export function diffRows(before: string | null, after: string | null, context = 3): DiffRow[] {
  const ops = allOps(splitLines(before), splitLines(after))
  const keep = new Uint8Array(ops.length)
  ops.forEach((op, i) => {
    if (op.kind === 'ctx') return
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = 1
  })
  const rows: DiffRow[] = []
  let i = 0
  while (i < ops.length) {
    if (!keep[i]) {
      i++
      continue
    }
    let end = i
    while (end < ops.length && keep[end]) end++
    const hunk = ops.slice(i, end)
    const oldStart = hunk.find(op => op.oldNo !== undefined)?.oldNo ?? 0
    const newStart = hunk.find(op => op.newNo !== undefined)?.newNo ?? 0
    const oldCount = hunk.filter(op => op.kind !== 'add').length
    const newCount = hunk.filter(op => op.kind !== 'del').length
    rows.push({ kind: 'hunk', text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` })
    rows.push(...hunk)
    i = end
  }
  return rows
}

export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const row of rows) {
    if (row.kind === 'add') added++
    else if (row.kind === 'del') removed++
  }
  return { added, removed }
}

// "L12-15" on the new side, or "old L8-9" for a selection of removed lines only.
export function describeLines(rows: DiffRow[]): string {
  const span = (nums: number[]) => {
    const lo = Math.min(...nums)
    const hi = Math.max(...nums)
    return lo === hi ? `L${lo}` : `L${lo}-${hi}`
  }
  const newNos = rows.flatMap(r => (r.kind !== 'hunk' && r.newNo !== undefined ? [r.newNo] : []))
  if (newNos.length > 0) return span(newNos)
  const oldNos = rows.flatMap(r => (r.kind !== 'hunk' && r.oldNo !== undefined ? [r.oldNo] : []))
  return oldNos.length > 0 ? `old ${span(oldNos)}` : 'hunk'
}

export function rowPrefix(row: DiffRow): string {
  return row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : row.kind === 'ctx' ? ' ' : ''
}
