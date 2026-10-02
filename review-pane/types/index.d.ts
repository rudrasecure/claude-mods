export type ChangedFile = {
  path: string
  // Content when the conversation first touched it; null when the file did not exist.
  before: string | null
  after: string | null
  edits: number
  updatedAt: number
}

export type ReviewComment = {
  id: string
  path: string
  lines: string
  snippet: string
  text: string
}

export type ReviewCursor = { file: number; row: number; anchor: number | null }

export type LspOperation = 'hover' | 'goToDefinition' | 'findReferences'

// A symbol on a diff row: `line` is its line in the file as it is now (absent
// on a removed line), `column` 1-based in the line's text.
export type SymbolRef = { name: string; row: number; line?: number; column: number }

// The answer about one symbol, drawn as a card under its row; `source` says
// whether a language server answered or the pane searched the text itself.
export type LspView = {
  operation: LspOperation
  symbol: SymbolRef
  text: string
  note?: string
  source: 'lsp' | 'text'
  isError: boolean
  isBusy: boolean
}

// The right-click menu, drawn under `row`.
export type ContextMenu = { row: number; lo: number; hi: number; symbol: SymbolRef | null }

// The inline comment box for rows lo..hi, drawn under hi.
export type Composer = { lo: number; hi: number }

declare module 'claude-code' {
  interface PluginState {
    'review-pane': {
      files: ChangedFile[]
      comments: ReviewComment[]
      cursor: ReviewCursor
      cwd: string
      isTurnRunning: boolean
      isSteerPending: boolean
      isHighlighted: boolean
      word: number
      lsp: LspView | null
      menu: ContextMenu | null
      composer: Composer | null
      // The id of the comment being edited in place.
      editing: string | null
    }
  }
}
