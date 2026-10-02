// Identifiers on a line, and the text search the pane falls back on when no
// language server answers: where a name is declared, and where it is used.

export const TAB_WIDTH = 4

export type Word = { name: string; column: number }

export function wordsOf(text: string): Word[] {
  return [...text.matchAll(/[A-Za-z_$][\w$]*/g)].map(m => ({ name: m[0], column: (m.index ?? 0) + 1 }))
}

export function expandTabs(text: string): string {
  return text.replace(/\t/g, ' '.repeat(TAB_WIDTH))
}

// The word under display column `x` (0-based, tabs expanded), if any.
export function wordAt(text: string, x: number): Word | undefined {
  if (x < 0) return undefined
  let display = 0
  let index = -1
  for (let i = 0; i < text.length; i++) {
    const width = text[i] === '\t' ? TAB_WIDTH : 1
    if (x < display + width) {
      index = i
      break
    }
    display += width
  }
  if (index < 0) return undefined
  return wordsOf(text).find(w => index >= w.column - 1 && index < w.column - 1 + w.name.length)
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'export', 'import', 'from',
  'class', 'new', 'this', 'true', 'false', 'null', 'undefined', 'async', 'await', 'def', 'type',
  'interface', 'extends', 'implements', 'public', 'private', 'static', 'void', 'string', 'number',
])

export function isKeyword(name: string): boolean {
  return KEYWORDS.has(name)
}

function escape(name: string): string {
  return name.replace(/[$]/g, '\\$')
}

function declarationPattern(name: string): RegExp {
  const n = escape(name)
  return new RegExp(
    [
      `\\b(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|module|namespace)\\s+${n}\\b`,
      `(?:^|[\\s,{(])${n}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?(?:function|\\(|[A-Za-z_$][\\w$]*\\s*=>)`,
      `^\\s*(?:(?:public|private|protected|static|async|readonly)\\s+)*${n}\\s*\\([^)]*\\)\\s*[:{]`,
    ].join('|'),
  )
}

export type SourceFile = { path: string; text: string | null }

export type Found = { path: string; line: number; text: string }

function linesOf(text: string | null): string[] {
  return text === null ? [] : text.split('\n')
}

// The first declaration of `name`, searching `files` in order.
export function findDeclaration(name: string, files: SourceFile[]): (Found & { context: string[] }) | undefined {
  const pattern = declarationPattern(name)
  for (const file of files) {
    const lines = linesOf(file.text)
    const i = lines.findIndex(line => pattern.test(line))
    if (i >= 0) return { path: file.path, line: i + 1, text: lines[i]!, context: lines.slice(i, i + 8) }
  }
  return undefined
}

export function findUses(name: string, files: SourceFile[], limit = 30): Found[] {
  const pattern = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`)
  const found: Found[] = []
  for (const file of files) {
    linesOf(file.text).forEach((line, i) => {
      if (found.length < limit && pattern.test(line)) found.push({ path: file.path, line: i + 1, text: line })
    })
  }
  return found
}

const FENCES: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', py: 'python', go: 'go', rs: 'rust',
  rb: 'ruby', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', sh: 'bash', md: 'md',
}

export function fenceOf(path: string): string {
  return FENCES[path.split('.').pop() ?? ''] ?? ''
}
