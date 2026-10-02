import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type {
  ChangedFile,
  Composer,
  ContextMenu,
  LspOperation,
  LspView,
  ReviewComment,
  ReviewCursor,
  SymbolRef,
} from '../types'
import type { ViewMessage, ViewProps, ViewRow } from './diff-view'
import type { FileEntry, FileListMessage, FileListProps } from './file-list'
import { countChanges, describeLines, diffRows, rowPrefix, type DiffRow } from './diff'
import { expandTabs, fenceOf, findDeclaration, findUses, isKeyword, wordAt, wordsOf, type SourceFile } from './symbols'

const PANE = 'review-pane'
const TITLE = 'Changes'
const FILE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const MAX_ROWS = 2000
const MAX_SNIPPET_LINES = 20
const MAX_CODE_CHARS = 2000
// Diff rows per mouse region at most: a long diff is several, so the cursor can
// be scrolled to its block; a drag still spans them.
const BLOCK_ROWS = 25
const MAX_VIEW_CHARS = 60_000
// Part of each mouse region's key: a region keeps its instance (and the code
// it was mounted with) while its key stands, so a change to diff-view.tsx
// bumps this to remount them.
const VIEW_VERSION = 5
const LSP_LABELS: Record<LspOperation, string> = {
  hover: 'Definition',
  goToDefinition: 'Go to definition',
  findReferences: 'References',
}

const files = atom({ plugin: 'review-pane', key: 'files' } as const, [] as ChangedFile[])
const comments = atom({ plugin: 'review-pane', key: 'comments' } as const, [] as ReviewComment[])
const cursor = atom({ plugin: 'review-pane', key: 'cursor' } as const, {
  file: 0,
  row: 0,
  anchor: null,
} as ReviewCursor)
const cwd = atom({ plugin: 'review-pane', key: 'cwd' } as const, '')
const isTurnRunning = atom({ plugin: 'review-pane', key: 'isTurnRunning' } as const, false)
const isSteerPending = atom({ plugin: 'review-pane', key: 'isSteerPending' } as const, false)
const isHighlighted = atom({ plugin: 'review-pane', key: 'isHighlighted' } as const, true)
const word = atom({ plugin: 'review-pane', key: 'word' } as const, 0)
const lsp = atom({ plugin: 'review-pane', key: 'lsp' } as const, null as LspView | null)
const menu = atom({ plugin: 'review-pane', key: 'menu' } as const, null as ContextMenu | null)
const composer = atom({ plugin: 'review-pane', key: 'composer' } as const, null as Composer | null)
const editing = atom({ plugin: 'review-pane', key: 'editing' } as const, null as string | null)

// Diffs are recomputed only when a file changes; a reload just recomputes.
const diffCache = new Map<string, DiffRow[]>()
function rowsOf(file: ChangedFile): DiffRow[] {
  const id = `${file.path}\0${file.updatedAt}`
  let rows = diffCache.get(id)
  if (!rows) {
    rows = diffRows(file.before, file.after)
    diffCache.set(id, rows)
  }
  return rows
}

function relative(path: string, root: string): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

async function readOrNull($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

function selectedRange(c: ReviewCursor): [number, number] {
  const anchor = c.anchor ?? c.row
  return [Math.min(anchor, c.row), Math.max(anchor, c.row)]
}

// Hunk headers are not lines: the cursor steps over them in the direction it moves.
function landRow(rows: DiffRow[], row: number, by: number): number {
  const count = Math.min(rows.length, MAX_ROWS)
  let at = Math.max(0, Math.min(row, count - 1))
  while (rows[at]?.kind === 'hunk' && at + by >= 0 && at + by < count) at += by
  if (rows[at]?.kind === 'hunk' && at + 1 < count) at++
  return at
}

function firstChange(file: ChangedFile | undefined): number {
  if (!file) return 0
  const rows = rowsOf(file)
  const at = rows.findIndex(r => r.kind === 'add' || r.kind === 'del')
  return landRow(rows, at < 0 ? 0 : at, 1)
}

function clampCursor(c: ReviewCursor, list: ChangedFile[]): ReviewCursor {
  const file = Math.max(0, Math.min(c.file, list.length - 1))
  const all = list[file] ? rowsOf(list[file]!) : []
  const rows = Math.min(all.length, MAX_ROWS)
  const row = landRow(all, c.row, 1)
  const anchor = c.anchor === null ? null : Math.max(0, Math.min(c.anchor, rows - 1))
  return { file, row, anchor }
}

// Code accepts tab and newline as its only control characters.
function codeSource(text: string): string {
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return (clean.length > MAX_CODE_CHARS ? clean.slice(0, MAX_CODE_CHARS) : clean) || ' '
}

async function current($: EngineInterface) {
  const list = await read($, files)
  const c = clampCursor(await read($, cursor), list)
  const file = list[c.file]
  return { list, c, file, rows: file ? rowsOf(file) : [] }
}

async function closePopups($: EngineInterface): Promise<void> {
  if (await read($, menu)) await update($, menu, () => null)
  if (await read($, lsp)) await update($, lsp, () => null)
}

// ── Comments ──────────────────────────────────────────────────────────────

function formatReview(list: ReviewComment[], root: string): string {
  const parts = list.map((c, i) => {
    const where = `\`${relative(c.path, root)}\` ${c.lines}`
    return `${i + 1}. ${where}\n\`\`\`diff\n${c.snippet}\n\`\`\`\n${c.text}`
  })
  return [
    `I reviewed your changes and left ${list.length === 1 ? 'a comment' : `${list.length} comments`} on specific lines:`,
    '',
    parts.join('\n\n'),
    '',
    'Please address each comment, then briefly say what you changed for each.',
  ].join('\n')
}

// Mid-turn the comments are appended to the running conversation (the model
// reads them at its next step); otherwise they start a turn of their own.
async function deliver($: EngineInterface, text: string): Promise<'steered' | 'sent'> {
  if (await read($, isTurnRunning)) {
    try {
      const appended = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (appended.deny === undefined) {
        await update($, isSteerPending, () => true)
        return 'steered'
      }
    } catch {
      // Fall through to a prompt of its own once the turn ends.
    }
  }
  await $.prompt.submit({ text, asUser: true })
  return 'sent'
}

async function sendComments($: EngineInterface): Promise<void> {
  const drafts = await read($, comments)
  if (drafts.length === 0) {
    $.ui.toast('review-pane: no comments to send')
    return
  }
  const how = await deliver($, formatReview(drafts, await read($, cwd)))
  await update($, comments, () => [])
  await update($, editing, () => null)
  $.ui.toast(
    how === 'steered'
      ? `Steered ${drafts.length} comment(s) into the running turn`
      : `Sent ${drafts.length} comment(s) to Claude`,
  )
}

// What the comment box holds as the person types: drawn back as its value,
// so a redraw (a hover, a drag) keeps the text.
let composerText = ''

async function openComposer($: EngineInterface, lo: number, hi: number): Promise<void> {
  composerText = ''
  editText = ''
  await update($, editing, () => null)
  await update($, menu, () => null)
  await update($, lsp, () => null)
  await update($, cursor, cur => ({ ...cur, row: hi, anchor: lo === hi ? null : lo }))
  await update($, composer, () => ({ lo, hi }))
  revealRow($, hi)
  void $.ui.focus({ requestId: PANE, key: 'comment' }).catch(() => {})
}

async function commentOnSelection($: EngineInterface): Promise<void> {
  const { c } = await current($)
  const [lo, hi] = selectedRange(c)
  await openComposer($, lo, hi)
}

async function addComment($: EngineInterface, text: string): Promise<void> {
  const body = text.trim()
  const box = await read($, composer)
  const { c, file, rows } = await current($)
  if (!body || !file) return
  const [lo, hi] = box ? [box.lo, box.hi] : selectedRange(c)
  const picked = rows.slice(lo, hi + 1)
  const lines = picked.filter(r => r.kind !== 'hunk')
  const shown = lines.slice(0, MAX_SNIPPET_LINES).map(r => `${rowPrefix(r)}${r.text}`)
  if (lines.length > MAX_SNIPPET_LINES) shown.push(`… ${lines.length - MAX_SNIPPET_LINES} more lines`)
  const comment: ReviewComment = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    path: file.path,
    lines: describeLines(picked),
    snippet: shown.join('\n'),
    text: body,
  }
  await update($, comments, all => [...all, comment])
  await update($, cursor, cur => ({ ...cur, anchor: null }))
  await closeComposer($, hi)
}

// The row a comment's lines end on, where it is drawn: "L2-4" on the new
// side, "old L3" on a removed line.
function commentRow(comment: ReviewComment, rows: DiffRow[]): number | undefined {
  const m = /^(old )?L(\d+)(?:-(\d+))?$/.exec(comment.lines)
  if (!m) return undefined
  const end = Number(m[3] ?? m[2])
  const isOld = Boolean(m[1])
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    if (row.kind === 'hunk') continue
    if (isOld ? row.kind === 'del' && row.oldNo === end : row.kind !== 'del' && row.newNo === end) return i
  }
  return undefined
}

function coversRow(comment: ReviewComment, row: DiffRow): boolean {
  const m = /^(old )?L(\d+)(?:-(\d+))?$/.exec(comment.lines)
  if (!m || row.kind === 'hunk') return false
  const no = m[1] ? (row.kind === 'del' ? row.oldNo : undefined) : row.kind === 'del' ? undefined : row.newNo
  return no !== undefined && no >= Number(m[2]) && no <= Number(m[3] ?? m[2])
}

// ── Moving around ─────────────────────────────────────────────────────────

// The first row of each mouse region as last drawn, to scroll a row into view.
let blockStarts: number[] = []

async function scrollToRow($: EngineInterface, row: number, block: 'nearest' | 'center' = 'nearest'): Promise<void> {
  const start = [...blockStarts].reverse().find(s => s <= row)
  try {
    const r = await $.ui.scroll({ in: PANE, to: { key: `row-${row}` }, block })
    if (r.deny !== undefined && start !== undefined) await $.ui.scroll({ in: PANE, to: { key: `blk-${start}` }, block })
  } catch {
    // Nothing drawn to scroll to.
  }
}

function revealRow($: EngineInterface, row: number): void {
  void scrollToRow($, row)
}

// Closing the comment box takes away the element holding the focus ring, and
// the ring would land on the pane's last control (Send), scrolling there.
// Park it on the toolbar's Comment, then bring the row back into view.
async function closeComposer($: EngineInterface, row: number): Promise<void> {
  composerText = ''
  await update($, composer, () => null)
  await parkFocus($, row)
}

// Whatever held the focus ring is gone (a closed box, a deleted card): park
// it on the toolbar's Comment and bring the row back into view.
async function parkFocus($: EngineInterface, row: number | undefined): Promise<void> {
  await $.ui.focus({ requestId: PANE, key: 'comment-focus' }).catch(() => {})
  if (row !== undefined) await scrollToRow($, row, 'center')
}

// What the edit box holds as the person types, drawn back as its value.
let editText = ''

async function commentRowOf($: EngineInterface, id: string): Promise<number | undefined> {
  const { rows } = await current($)
  const comment = (await read($, comments)).find(c => c.id === id)
  return comment ? commentRow(comment, rows) : undefined
}

async function startEdit($: EngineInterface, id: string): Promise<void> {
  const comment = (await read($, comments)).find(c => c.id === id)
  if (!comment) return
  editText = comment.text
  await update($, composer, () => null)
  await update($, editing, () => id)
  void $.ui.focus({ requestId: PANE, key: `edit-${id}` }).catch(() => {})
}

async function saveEdit($: EngineInterface, id: string, text: string): Promise<void> {
  const body = text.trim()
  if (!body) {
    $.ui.toast('review-pane: a comment needs text; use Delete to remove it')
    return
  }
  await update($, comments, all => all.map(c => (c.id === id ? { ...c, text: body } : c)))
  await stopEdit($, id)
}

async function stopEdit($: EngineInterface, id: string): Promise<void> {
  editText = ''
  await update($, editing, () => null)
  await parkFocus($, await commentRowOf($, id))
}

async function deleteComment($: EngineInterface, id: string): Promise<void> {
  const row = await commentRowOf($, id)
  await update($, comments, all => all.filter(c => c.id !== id))
  if ((await read($, editing)) === id) await update($, editing, () => null)
  await parkFocus($, row)
}

async function moveRow($: EngineInterface, by: number): Promise<void> {
  const list = await read($, files)
  let next: ReviewCursor | undefined
  await update($, cursor, c => {
    const file = list[c.file]
    const row = file ? landRow(rowsOf(file), c.row + by, by) : 0
    return (next = clampCursor({ ...c, row }, list))
  })
  await update($, word, () => 0)
  if (next) revealRow($, next.row)
}

async function selectFile($: EngineInterface, index: number): Promise<void> {
  const list = await read($, files)
  if (list.length === 0) return
  const file = ((index % list.length) + list.length) % list.length
  await update($, cursor, () => ({ file, row: firstChange(list[file]), anchor: null }))
  await update($, word, () => 0)
  await update($, composer, () => null)
  await closePopups($)
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
}

async function moveFile($: EngineInterface, by: number): Promise<void> {
  await selectFile($, (await read($, cursor)).file + by)
}

async function refreshFromDisk($: EngineInterface): Promise<void> {
  const list = await read($, files)
  const fresh = await Promise.all(list.map(f => readOrNull($, f.path)))
  await update($, files, all =>
    all.map((f, i) => (fresh[i] === f.after ? f : { ...f, after: fresh[i] ?? null, updatedAt: Date.now() })),
  )
}

// ── Symbols and the language server ───────────────────────────────────────

function symbolOn(rows: DiffRow[], index: number, x: number): SymbolRef | null {
  const row = rows[index]
  if (!row || row.kind === 'hunk') return null
  const hit = wordAt(row.text, x)
  if (!hit || isKeyword(hit.name)) return null
  return { name: hit.name, row: index, column: hit.column, ...(row.kind !== 'del' && row.newNo ? { line: row.newNo } : {}) }
}

// The keyboard's symbol: the `word`-th identifier of the cursor's line.
async function cursorSymbol($: EngineInterface): Promise<SymbolRef | null> {
  const { c, rows } = await current($)
  const row = rows[c.row]
  if (!row || row.kind === 'hunk') return null
  const words = wordsOf(row.text)
  if (words.length === 0) return null
  const hit = words[(await read($, word)) % words.length]!
  return { name: hit.name, row: c.row, column: hit.column, ...(row.kind !== 'del' && row.newNo ? { line: row.newNo } : {}) }
}

// Says nothing useful: the call failed or no server is set up for the file.
function isUnanswered(text: string, isError: boolean): boolean {
  return isError || !text.trim() || /no (lsp|language) server|not available|no server|no results? found|^no result/i.test(text)
}

async function askServer(
  $: EngineInterface,
  operation: LspOperation,
  path: string,
  symbol: SymbolRef,
): Promise<{ text: string; isError: boolean }> {
  if (symbol.line === undefined) return { text: 'removed line: not in the file now', isError: true }
  // The engine lists the LSP tool only while an LSP plugin is loaded; one
  // installed mid-session loads with the next start.
  const tools = await $.tool.list().catch(() => [])
  if (!tools.some(t => t.name === 'LSP')) {
    return { text: 'not loaded (install an LSP plugin, then restart Claude Code)', isError: true }
  }
  try {
    const ran = await $.tool.call({ tool: 'LSP', operation, filePath: path, line: symbol.line, character: symbol.column })
    if (ran.deny !== undefined) return { text: ran.deny, isError: true }
    const text = ran.text ?? (ran.result as { result?: string } | undefined)?.result ?? ''
    return { text: text.trim(), isError: Boolean(ran.isError) }
  } catch (err) {
    const text = String(err).replace(/^HooksError:\s*/, '').replace(/^review-pane:\s*/, '')
    return { text, isError: true }
  }
}

// What a text search of the changed files finds, said the way a hover card is.
function searchText(operation: LspOperation, symbol: SymbolRef, file: ChangedFile, list: ChangedFile[], root: string) {
  const sources: SourceFile[] = [
    { path: file.path, text: file.after },
    ...list.filter(f => f.path !== file.path).map(f => ({ path: f.path, text: f.after })),
    { path: file.path, text: file.before },
  ]
  const fence = (path: string) => fenceOf(path)
  if (operation === 'findReferences') {
    const uses = findUses(symbol.name, sources.slice(0, -1))
    if (uses.length === 0) return { text: `No uses of \`${symbol.name}\` in the changed files.`, isError: false }
    const lines = uses.map(u => `${relative(u.path, root)}:${u.line}  ${u.text.trim()}`)
    return { text: `**${uses.length}** use${uses.length === 1 ? '' : 's'} of \`${symbol.name}\`\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``, isError: false }
  }
  const found = findDeclaration(symbol.name, sources)
  if (!found) return { text: `No declaration of \`${symbol.name}\` in the changed files.`, isError: false }
  const body = operation === 'hover' ? found.text.trim() : found.context.join('\n')
  return {
    text: `\`\`\`${fence(found.path)}\n${body}\n\`\`\`\n${relative(found.path, root)}:${found.line}`,
    isError: false,
  }
}

async function lookUp($: EngineInterface, operation: LspOperation, symbol: SymbolRef | null): Promise<void> {
  await update($, menu, () => null)
  if (!symbol) {
    $.ui.toast('review-pane: no symbol there')
    return
  }
  const { list, file } = await current($)
  if (!file) return
  const base = { operation, symbol }
  await update($, lsp, () => ({ ...base, text: '', source: 'lsp', isError: false, isBusy: true }))
  const answer = await askServer($, operation, file.path, symbol)
  let view: LspView
  if (!isUnanswered(answer.text, answer.isError)) {
    view = { ...base, text: answer.text, source: 'lsp', isError: false, isBusy: false }
  } else {
    const found = searchText(operation, symbol, file, list, await read($, cwd))
    const reason = answer.text.split('\n')[0]?.slice(0, 120) || 'no answer'
    view = { ...base, ...found, source: 'text', note: `text search · language server: ${reason}`, isBusy: false }
  }
  // Only if the card is still the one asked for (a click elsewhere closed it).
  await update($, lsp, cur => (cur && cur.symbol.row === symbol.row && cur.operation === operation ? view : cur))
}

async function runLsp($: EngineInterface, operation: LspOperation): Promise<void> {
  await lookUp($, operation, await cursorSymbol($))
}

// ── The mouse ─────────────────────────────────────────────────────────────

// Where a press went down, so a drag knows its other end and a release knows
// it was a click. A reload mid-drag forgets it, which only ends that drag.
let press: { anchor: number; row: number; x: number; isShift: boolean; isDragged: boolean } | undefined

async function onViewMessage($: EngineInterface, message: ViewMessage): Promise<void> {
  const { c, file, rows } = await current($)
  if (!file) return
  const row = landRow(rows, message.row, 1)
  const [lo, hi] = selectedRange(c)
  const isInRange = c.anchor !== null && row >= lo && row <= hi

  if (message.type === 'press') {
    // A shift-click extends from the anchor, which a drag then keeps.
    const anchor = message.shift ? (c.anchor ?? c.row) : row
    press = { anchor, row, x: message.x, isShift: message.shift, isDragged: false }
    await closePopups($)
    await update($, cursor, cur => ({ ...cur, row, anchor: anchor === row ? null : anchor }))
    await update($, word, () => 0)
    return
  }
  if (message.type === 'drag') {
    if (!press || row === press.row) return
    press = { ...press, row, isDragged: true }
    await update($, cursor, cur => ({ ...cur, row, anchor: row === press!.anchor ? null : press!.anchor }))
    return
  }
  if (message.type === 'release') {
    const done = press
    press = undefined
    if (!done) return
    if (done.isDragged) {
      await update($, cursor, cur => ({ ...cur, row, anchor: row === done.anchor ? null : done.anchor }))
      return
    }
    // A plain click on a name: what it is, as an editor's hover shows it.
    if (!done.isShift) {
      const symbol = symbolOn(rows, done.row, done.x)
      if (symbol) await lookUp($, 'hover', symbol)
    }
    return
  }
  if (message.type === 'context') {
    press = undefined
    await update($, lsp, () => null)
    const [mlo, mhi] = isInRange ? [lo, hi] : [row, row]
    if (!isInRange) await update($, cursor, cur => ({ ...cur, row, anchor: null }))
    await update($, menu, () => ({ row: isInRange ? hi : row, lo: mlo, hi: mhi, symbol: symbolOn(rows, row, message.x) }))
    return
  }
  // The comment mark or the "Comment" label: the range when inside it.
  press = undefined
  await (isInRange ? openComposer($, lo, hi) : openComposer($, row, row))
}

// ── Restoring what came before ────────────────────────────────────────────

type PastEdit = { tool: string; input: Record<string, unknown>; result?: unknown }

// The file's content before an edit, as the tool's record kept it, or the
// edit reversed from `after` when the record has none.
function beforeOf(edit: PastEdit, after: string | null): string | null {
  const record = edit.result as { originalFile?: string | null; type?: string } | undefined
  if (record && 'originalFile' in record) return record.type === 'create' ? null : (record.originalFile ?? null)
  if (edit.tool === 'Write') return null
  const oldString = edit.input.old_string
  const newString = edit.input.new_string
  if (typeof oldString !== 'string' || typeof newString !== 'string' || after === null) return after
  return edit.input.replace_all === true ? after.split(newString).join(oldString) : after.replace(newString, oldString)
}

// Rebuilds the list from the conversation's earlier file-tool calls: after a
// restart or a resume the session's state starts empty though the edits stand.
async function backfill($: EngineInterface): Promise<void> {
  if ((await read($, files)).length > 0) return
  const rows = await $.session.messages().catch(() => [])
  if (!Array.isArray(rows)) return
  const firstEdit = new Map<string, PastEdit>()
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const use of row.toolUses ?? []) {
      if (!FILE_TOOLS.test(use.tool) || use.isError) continue
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string') continue
      if (!firstEdit.has(path)) firstEdit.set(path, use)
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
  }
  if (firstEdit.size === 0) return
  const found: ChangedFile[] = []
  for (const [path, edit] of firstEdit) {
    const after = await readOrNull($, path)
    found.push({ path, before: beforeOf(edit, after), after, edits: counts.get(path) ?? 1, updatedAt: Date.now() })
  }
  await update($, files, list => (list.length > 0 ? list : found))
  const first = (await read($, files))[0]
  await update($, cursor, () => ({ file: 0, row: firstChange(first), anchor: null }))
}

const COMMAND = {
  name: 'changes',
  description: 'Open the changes pane: review diffs from this conversation and comment on lines',
}

async function ensureCommand($: EngineInterface): Promise<void> {
  const before = await $.command.list().catch(() => [])
  const mine = before.find(c => c.name === COMMAND.name)
  if (!mine || mine.plugin !== 'review-pane') await $.command.register(COMMAND)
}

async function openPane($: EngineInterface, focus: boolean): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, ...(focus ? { focus: true as const } : {}) })
  if (!opened.isPlaced) $.ui.toast('review-pane: widen the terminal (or run /changes) to see the pane')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await update($, cwd, () => e.cwd)
    await ensureCommand($)
    await backfill($).catch(() => {})
    return next(e)
  })

  // A reload or restart can leave the command unlisted; put it back each turn.
  on('prompt.submit', async ($, e, next) => {
    void ensureCommand($).catch(() => {})
    return next(e)
  })

  on('command.run', { command: 'changes' }, async $ => {
    await backfill($).catch(() => {})
    await openPane($, true)
    return {
      text: 'Changes pane opened. Click a line, drag for a range, right-click for actions, click a name for its definition.',
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, files, () => [])
      await update($, comments, () => [])
      await update($, cursor, () => ({ file: 0, row: 0, anchor: null }))
      await update($, composer, () => null)
      await closePopups($)
    }
    return next(e)
  })

  on('tool.call', { tool: /^(Edit|Write|MultiEdit|NotebookEdit)$/ }, async ($, e, next) => {
    const args = e as unknown as { file_path?: string; notebook_path?: string }
    const path = args.file_path ?? args.notebook_path
    if (!path) return next(e)
    const known = (await read($, files)).find(f => f.path === path)
    const before = known ? known.before : await readOrNull($, path)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const after = await readOrNull($, path)
    const isFirst = (await read($, files)).length === 0
    await update($, files, list => {
      const i = list.findIndex(f => f.path === path)
      const entry: ChangedFile = {
        path,
        before: i >= 0 ? list[i]!.before : before,
        after,
        edits: (i >= 0 ? list[i]!.edits : 0) + 1,
        updatedAt: Date.now(),
      }
      return i >= 0 ? list.map((f, k) => (k === i ? entry : f)) : [...list, entry]
    })
    if (isFirst) {
      const row = firstChange((await read($, files))[0])
      await update($, cursor, () => ({ file: 0, row, anchor: null }))
      void openPane($, false)
    }
    return ran
  })

  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
    return next(e)
  })

  // A step that starts after a steer has read it.
  on('turn.step', async function* ($, e, next) {
    if (await read($, isSteerPending)) await update($, isSteerPending, () => false)
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if ((e as { agentId?: string }).agentId) return done
    await update($, isTurnRunning, () => false)
    if (await read($, isSteerPending)) {
      // The turn ended before any step read the steer: ask for it explicitly.
      await update($, isSteerPending, () => false)
      void $.prompt.submit({
        text: 'Please address the review comments I sent above.',
        asUser: true,
      })
    }
    return done
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    if (e.element.startsWith('files-')) {
      const message = e.data as FileListMessage
      if (message.type === 'file') await selectFile($, message.index)
      if (message.type === 'send') await sendComments($)
      return {}
    }
    await onViewMessage($, e.data as ViewMessage)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const Code = 'Code' in elements ? elements.Code : undefined
    const Markdown = 'Markdown' in elements ? elements.Markdown : undefined
    const Client = 'Client' in elements ? elements.Client : undefined
    const highlight = (await read($, isHighlighted)) && Code !== undefined
    const stored = await read($, lsp)
    // A card kept from an older version of the pane has another shape.
    const card = stored && typeof stored.symbol === 'object' ? stored : null
    const contextMenu = await read($, menu)
    const box = await read($, composer)
    const list = await read($, files)
    const drafts = await read($, comments)
    const root = await read($, cwd)
    const running = await read($, isTurnRunning)
    const width = Math.max(20, e.props.bodyColumns ?? e.viewport?.columns ?? 80)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No file changes in this conversation yet.</Text>
          <Text dimColor>Edits Claude makes with Edit/Write show up here.</Text>
        </Box>
      )
    }

    const c = clampCursor(await read($, cursor), list)
    const file = list[c.file]!
    const allRows = rowsOf(file)
    const rows = allRows.slice(0, MAX_ROWS)
    const [lo, hi] = selectedRange(c)
    const isRange = c.anchor !== null
    const fileDrafts = drafts.filter(d => d.path === file.path)
    const gutter = String(Math.max(1, ...rows.map(r => (r.kind === 'hunk' ? 0 : (r.newNo ?? r.oldNo ?? 0))))).length
    const target = describeLines(rows.slice(lo, hi + 1))
    const keySymbol = await cursorSymbol($)

    const fileList: FileListProps = {
      selected: c.file,
      isRunning: running,
      files: list.map((f): FileEntry => {
        const { added, removed } = countChanges(rowsOf(f))
        const shown = relative(f.path, root)
        const cut = shown.lastIndexOf('/') + 1
        return {
          status: f.before === null ? 'A' : f.after === null ? 'D' : 'M',
          dir: shown.slice(0, cut),
          name: shown.slice(cut),
          added,
          removed,
          comments: drafts.filter(d => d.path === f.path).length,
        }
      }),
    }

    const fileButtons = list.map((f, i) => {
      const { added, removed } = countChanges(rowsOf(f))
      const status = f.before === null ? 'A' : f.after === null ? 'D' : 'M'
      const count = drafts.filter(d => d.path === f.path).length
      const label = `${i === c.file ? '▸' : ' '} ${status} ${relative(f.path, root)}  +${added} -${removed}${count ? `  ✎${count}` : ''}`
      return (
        <Button
          key={`file-${i}`}
          plain
          dimColor={i !== c.file}
          label={label.length > width ? `…${label.slice(label.length - width + 1)}` : label}
          onPress={() => selectFile($, i)}
        />
      )
    })

    // ── What sits under a row: its comments, the comment box, a card, a menu.
    const inline = new Map<number, RenderElement[]>()
    const place = (row: number, element: RenderElement) => inline.set(row, [...(inline.get(row) ?? []), element])
    const unplaced: ReviewComment[] = []

    const sendLabel =
      drafts.length === 1 ? '➤ Send comment to Claude' : `➤ Send all ${drafts.length} comments to Claude`
    const editingId = await read($, editing)
    const draftCard = (d: ReviewComment): RenderElement =>
      editingId === d.id && Input ? (
        <Box key={`draft-${d.id}`} flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
          <Text color="blue" bold>{`✎ Editing the comment on ${d.lines}`}</Text>
          <Input
            key={`edit-${d.id}`}
            autoFocus
            submitLabel="save"
            value={editText}
            onInput={(text: string) => {
              editText = text
            }}
            onSubmit={(text: string) => saveEdit($, d.id, text)}
          />
          <Box flexDirection="row" gap={1}>
            <Button key={`save-${d.id}`} variant="primary" label="Save" onPress={() => saveEdit($, d.id, editText)} />
            <Button key={`cancel-${d.id}`} label="Cancel" onPress={() => stopEdit($, d.id)} />
          </Box>
        </Box>
      ) : (
        <Box key={`draft-${d.id}`} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text wrap="wrap">
            <Text color="yellow" bold>{`✎ ${d.lines}  `}</Text>
            {d.text}
          </Text>
          <Box flexDirection="row" gap={2}>
            {/* Sends every draft, on every file, as one message. */}
            <Button key={`send-${d.id}`} plain label={sendLabel} onPress={() => sendComments($)} />
            <Button key={`edit-btn-${d.id}`} plain dimColor label="Edit" onPress={() => startEdit($, d.id)} />
            <Button key={`drop-${d.id}`} plain dimColor label="Delete" onPress={() => deleteComment($, d.id)} />
          </Box>
        </Box>
      )
    for (const d of fileDrafts) {
      const at = commentRow(d, rows)
      if (at === undefined) unplaced.push(d)
      else place(at, draftCard(d))
    }

    if (box && Input && rows[box.hi]) {
      place(
        box.hi,
        <Box key="composer" flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
          <Text color="blue" bold>{`✎ Comment on ${describeLines(rows.slice(box.lo, box.hi + 1))}`}</Text>
          <Input
            key="comment"
            autoFocus
            placeholder="Write a comment for Claude, Enter to add"
            submitLabel="add"
            value={composerText}
            onInput={(text: string) => {
              composerText = text
            }}
            onSubmit={(text: string) => addComment($, text)}
          />
          <Box flexDirection="row" gap={1}>
            <Button key="composer-add" variant="primary" label="Add comment" onPress={() => addComment($, composerText)} />
            <Button
              key="composer-cancel"
              label="Cancel"
              onPress={() => closeComposer($, box.hi)}
            />
          </Box>
        </Box>,
      )
    }

    if (card && rows[card.symbol.row]) {
      place(
        card.symbol.row,
        <Box key="card" flexDirection="column" borderStyle="round" borderColor={card.isError ? 'red' : 'cyan'} paddingX={1}>
          <Box flexDirection="row">
            <Box flexGrow={1}>
              <Text bold color="cyan">{`${LSP_LABELS[card.operation]} · ${card.symbol.name}`}</Text>
            </Box>
            <Button key="lsp-close" plain dimColor label="✕" onPress={() => update($, lsp, () => null)} />
          </Box>
          {card.isBusy ? (
            <Text dimColor>Looking it up…</Text>
          ) : Markdown && !card.isError ? (
            <Markdown text={card.text} />
          ) : (
            <Text color={card.isError ? 'red' : undefined} wrap="wrap">{card.text}</Text>
          )}
          {card.note && <Text dimColor wrap="truncate">{card.note}</Text>}
          {!card.isBusy && (
            <Box flexDirection="row" gap={1}>
              {card.operation !== 'goToDefinition' && (
                <Button key="card-definition" plain label="Go to definition" onPress={() => lookUp($, 'goToDefinition', card.symbol)} />
              )}
              {card.operation !== 'findReferences' && (
                <Button key="card-references" plain label="Find references" onPress={() => lookUp($, 'findReferences', card.symbol)} />
              )}
              <Button
                key="card-comment"
                plain
                label="✎ Comment"
                onPress={() => openComposer($, card.symbol.row, card.symbol.row)}
              />
            </Box>
          )}
        </Box>,
      )
    }

    if (contextMenu && rows[contextMenu.row]) {
      const lines = describeLines(rows.slice(contextMenu.lo, contextMenu.hi + 1))
      const s = contextMenu.symbol
      place(
        contextMenu.row,
        <Box key="menu" flexDirection="column" borderStyle="round" paddingX={1}>
          <Button
            key="menu-comment"
            plain
            autoFocus
            label={`✎ Comment on ${lines}`}
            onPress={() => openComposer($, contextMenu.lo, contextMenu.hi)}
          />
          {s && <Button key="menu-peek" plain label={`Show definition of ${s.name}`} onPress={() => lookUp($, 'hover', s)} />}
          {s && <Button key="menu-definition" plain label="Go to definition" onPress={() => lookUp($, 'goToDefinition', s)} />}
          {s && <Button key="menu-references" plain label="Find references" onPress={() => lookUp($, 'findReferences', s)} />}
          <Button key="menu-close" plain dimColor label="Cancel" onPress={() => update($, menu, () => null)} />
        </Box>,
      )
    }

    // ── The rows themselves: mouse regions on the terminal, split where
    // something sits under a row; rows of Buttons elsewhere.
    const viewRows: ViewRow[] = rows.map(row => ({
      kind: row.kind,
      text: expandTabs(codeSource(row.text)).slice(0, Math.max(width, 40)),
      no: row.kind === 'hunk' ? '' : String(row.newNo ?? row.oldNo ?? ''),
      hasComment: fileDrafts.some(d => coversRow(d, row)),
    }))
    const viewChars = viewRows.reduce((n, r) => n + r.text.length + r.no.length + 8, 0)
    const useMouse = Client !== undefined && e.surface === 'terminal' && viewChars <= MAX_VIEW_CHARS
    const body: RenderElement[] = []

    if (useMouse && Client) {
      const starts: number[] = []
      let start = 0
      const flush = (end: number) => {
        if (end <= start) return
        const props: ViewProps = {
          start,
          rows: viewRows.slice(start, end),
          cursor: c.row,
          lo: isRange ? lo : -1,
          hi: isRange ? hi : -1,
          rangeLabel: `✎ Comment on ${target}`,
          path: file.path,
          isHighlighted: highlight,
          gutter,
        }
        starts.push(start)
        body.push(
          <Box key={`blk-${start}`} flexDirection="column">
            <Client key={`diff-v${VIEW_VERSION}-${start}`} module="./diff-view.tsx" props={props} height={end - start} />
          </Box>,
        )
        start = end
      }
      for (let i = 0; i < viewRows.length; i++) {
        const under = inline.get(i)
        if (under || i + 1 - start >= BLOCK_ROWS) {
          flush(i + 1)
          if (under) body.push(...under)
        }
      }
      flush(viewRows.length)
      blockStarts = starts
    } else {
      blockStarts = []
      rows.forEach((row, i) => {
        const isSelected = i >= lo && i <= hi
        const isCursor = i === c.row
        const no = row.kind === 'hunk' ? ' '.repeat(gutter) : String(row.newNo ?? row.oldNo ?? '').padStart(gutter)
        const color = row.kind === 'add' ? 'green' : row.kind === 'del' ? 'red' : row.kind === 'hunk' ? 'cyan' : undefined
        body.push(
          <Box key={`line-${i}`} flexDirection="row">
            <Button
              key={`row-${i}`}
              plain
              dimColor={!isCursor}
              label={`${isCursor ? '›' : ' '}${no}`}
              onPress={() => update($, cursor, cur => ({ ...cur, row: landRow(rows, i, 1), anchor: null }))}
            />
            {highlight && Code !== undefined && row.kind !== 'hunk' ? (
              <>
                <Text color={isSelected ? 'yellow' : undefined}>{isSelected ? '▌' : ' '}</Text>
                <Box flexGrow={1}>
                  <Code source={codeSource(row.text)} path={file.path} wrap="truncate-end" />
                </Box>
              </>
            ) : (
              <Text color={color} dimColor={row.kind === 'ctx' && !isSelected} inverse={isSelected} wrap="truncate">
                {` ${row.text}`}
              </Text>
            )}
          </Box>,
        )
        body.push(...(inline.get(i) ?? []))
      })
    }

    return (
      <Box flexDirection="column">
        {Client && e.surface === 'terminal' ? (
          <Client key={`files-v${VIEW_VERSION}`} module="./file-list.tsx" props={fileList} height={list.length + 1} />
        ) : (
          <Box flexDirection="column">
            <Text bold>
              {`${list.length} file${list.length === 1 ? '' : 's'} changed`}
              {running ? '  · Claude is working (comments will steer)' : ''}
            </Text>
            {fileButtons}
          </Box>
        )}
        <Text dimColor>{'─'.repeat(width)}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {/* Sending sits up here, by the file list's count, and on each draft. */}
          {drafts.length > 0 && (
            <Button key="send" hotkey="s" variant="primary" label={`➤ Send ${drafts.length}`} onPress={() => sendComments($)} />
          )}
          {drafts.length > 0 && (
            <Button key="clear" hotkey="x" plain dimColor label="discard all" onPress={() => update($, comments, () => [])} />
          )}
          <Button key="comment-focus" hotkey="c" plain label={`✎ Comment on ${target}`} onPress={() => commentOnSelection($)} />
          <Button key="prev-file" hotkey="p" plain dimColor label="◂ file" onPress={() => moveFile($, -1)} />
          <Button key="next-file" hotkey="n" plain dimColor label="file ▸" onPress={() => moveFile($, 1)} />
          <Button key="refresh" hotkey="r" plain dimColor label="refresh" onPress={() => refreshFromDisk($)} />
          {Code && (
            <Button
              key="highlight"
              hotkey="t"
              plain
              dimColor
              label={highlight ? 'plain' : 'highlight'}
              onPress={() => update($, isHighlighted, was => !was)}
            />
          )}
          {/* Keyboard only: the mouse does these on the lines themselves. */}
          <Button key="up" hotkey="k" plain dimColor label="↑" onPress={() => moveRow($, -1)} />
          <Button key="down" hotkey="j" plain dimColor label="↓" onPress={() => moveRow($, 1)} />
          <Button
            key="mark"
            hotkey="v"
            plain
            dimColor
            label={isRange ? 'unmark' : 'mark'}
            onPress={() => update($, cursor, cur => ({ ...cur, anchor: cur.anchor === null ? cur.row : null }))}
          />
          <Button key="next-symbol" hotkey="w" plain dimColor label={`word: ${keySymbol?.name ?? '–'}`} onPress={() => update($, word, n => n + 1)} />
          <Button key="hover" hotkey="h" plain dimColor label="def" onPress={() => runLsp($, 'hover')} />
          <Button key="definition" hotkey="g" plain dimColor label="go" onPress={() => runLsp($, 'goToDefinition')} />
          <Button key="references" hotkey="f" plain dimColor label="refs" onPress={() => runLsp($, 'findReferences')} />
        </Box>
        {useMouse && (
          <Text dimColor wrap="truncate">click a name for its definition · drag to select · right-click for actions</Text>
        )}
        {rows.length === 0 && <Text dimColor>No textual changes (file identical to its original).</Text>}
        {body}
        {allRows.length > MAX_ROWS && <Text dimColor>{`… ${allRows.length - MAX_ROWS} more diff rows not shown`}</Text>}
        <Text dimColor>{'─'.repeat(width)}</Text>
        {unplaced.map(draftCard)}
      </Box>
    )
  })
}
