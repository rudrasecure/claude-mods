import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'review-pane',
  component: 'Pane',
  requestId: 'review-pane',
  props: {
    title: 'Changes',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('an edit shows as a diff, and a line comment is sent to Claude', async ($, on) => {
  const disk = new Map<string, string>([['/repo/src/app.ts', 'const a = 1\nconst b = 2\nconst c = 3\n']])
  const submitted: string[] = []

  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    const args = e as unknown as { file_path: string; old_string: string; new_string: string }
    disk.set(args.file_path, disk.get(args.file_path)!.replace(args.old_string, args.new_string))
    return { result: { ok: true } as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/src/app.ts',
    old_string: 'const b = 2',
    new_string: 'const b = 42',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      // The file list is its own region: folder, name and counts apart.
      const files = { in: 'files-v5' }
      expect(await ui.find({ type: 'Text', text: 'src/', ...files })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'app.ts', ...files })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '+1', ...files })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '−1', ...files })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Button', text: /src\/app\.ts\s+\+1 -1/ })).toBeDefined()
    }
    // Highlighted by default: each line is a Code element of its own, drawn
    // inside the terminal's mouse region.
    const scope = surface === 'terminal' ? { in: 'diff-v5-0' } : {}
    expect(await ui.find({ type: 'Code', text: /^const b = 42$/, ...scope })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /^const b = 2$/, ...scope })).toBeDefined()
    await ui.press({ key: 'highlight' })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: 'const b = 42', ...scope })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: ' const b = 42' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' const b = 2' })).toBeDefined()
    }
    await ui.press({ key: 'highlight' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Rows: hunk, ctx a, del b, add b, ctx c. The cursor starts on the first
  // change (del b); one step down is the added line.
  await ui.press({ key: 'down' })
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'Why 42? Use a named constant.' })
  expect(await ui.find({ type: 'Text', text: /Why 42\? Use a named constant\./ })).toBeDefined()

  await ui.press({ key: 'send' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('`src/app.ts` L2')
  expect(submitted[0]).toContain('+const b = 42')
  expect(submitted[0]).toContain('Why 42? Use a named constant.')
  expect(await ui.find({ type: 'Text', text: /Why 42\? Use a named constant\./ })).toBeUndefined()
  await ui.unmount()
})

test('a comment sent while Claude is working steers the running turn', async ($, on) => {
  const disk = new Map<string, string>([['/repo/a.txt', 'one\n']])
  const appended: string[] = []
  const submitted: string[] = []

  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.append', ($, e) => {
    appended.push(JSON.stringify(e.message.content))
    return { message: e.message, uuid: 'row-1' } as never
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const args = e as unknown as { file_path: string; content: string }
    disk.set(args.file_path, args.content)
    return { result: { ok: true } as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'two\n' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'keep it as one' })
  await ui.press({ key: 'send' })
  // The kit has no engine beneath a plugin's session.append, so the steer is
  // refused there and the plugin falls back to a prompt of its own.
  expect(toasts.join('\n')).not.toContain('no comments')
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('`a.txt` old L1')
  expect(submitted[0]).toContain('-one')
  expect(submitted[0]).toContain('keep it as one')
  await ui.unmount()
})

test('hover asks the LSP tool about the symbol under the cursor', async ($, on) => {
  const disk = new Map<string, string>()
  const asked: unknown[] = []

  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const args = e as unknown as { file_path: string; content: string }
    disk.set(args.file_path, args.content)
    return { result: { ok: true } as never }
  })
  on('tool.list', () => ({ value: [{ name: 'LSP' }] }) as never)
  on('tool.call', { tool: 'LSP' }, ($, e) => {
    asked.push(e)
    return { result: { operation: 'hover', result: '`const greet: number`', filePath: '/repo/m.ts' } as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/m.ts', content: 'export const greet = 1\n' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Cursor on the added line; symbols: export, const, greet.
  await ui.press({ key: 'next-symbol' })
  await ui.press({ key: 'next-symbol' })
  expect(await ui.find({ type: 'Button', text: 'word: greet' })).toBeDefined()
  await ui.press({ key: 'hover' })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ operation: 'hover', filePath: '/repo/m.ts', line: 1, character: 14 })
  expect(await ui.find({ type: 'Text', text: 'Definition · greet' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /const greet: number/ })).toBeDefined()
  await ui.press({ key: 'lsp-close' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('edits made before a restart are rebuilt from the conversation', async ($, on) => {
  const disk = new Map<string, string>([
    ['/repo/hello.ts', 'export const hi = 1\n'],
    ['/repo/old.ts', 'a\nB\nc\n'],
  ])
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('command.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool_use_id: 'w1',
            tool: 'Write',
            input: { file_path: '/repo/hello.ts', content: 'export const hi = 1\n' },
            result: { type: 'create', originalFile: null },
          },
          {
            tool_use_id: 'e1',
            tool: 'Edit',
            input: { file_path: '/repo/old.ts', old_string: 'b', new_string: 'B' },
            result: { originalFile: 'a\nb\nc\n' },
          },
          { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/repo/x.ts' } },
        ],
      },
    ],
  }) as never)

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const files = { in: 'files-v5' }
  expect(await ui.find({ type: 'Text', text: '2 files changed  ', ...files })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' A ', ...files })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'hello.ts', ...files })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' M ', ...files })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'old.ts', ...files })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'x.ts', ...files })).toBeUndefined()
  // A click on a file's row opens it: row 0 is the summary.
  await ui.pointer({ ...files, type: 'down', x: 5, y: 2, button: 'left' })
  expect(await ui.find({ in: 'diff-v5-0', type: 'Text', text: /old\.ts|^\s*2$/ })).toBeDefined()
  await ui.unmount()
})

test('the mouse: drag a range, comment from its label, right-click and click names', async ($, on) => {
  const disk = new Map<string, string>()
  const asked: { operation?: string }[] = []
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('command.list', () => ({ value: [] }) as never)
  on('tool.list', () => ({ value: [{ name: 'LSP' }] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const args = e as unknown as { file_path: string; content: string }
    disk.set(args.file_path, args.content)
    return { result: { ok: true } as never }
  })
  // No language server: the pane falls back on searching the text.
  on('tool.call', { tool: 'LSP' }, ($, e) => {
    asked.push(e as never)
    return { result: { result: 'No LSP server available for file type: .ts' } as never, isError: true } as never
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({
    tool: 'Write',
    file_path: '/repo/n.ts',
    content: 'const alpha = 1\nconst beta = alpha + 1\nc\nd\n',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ in: 'diff-v5-0', columns: 60, rows: 5 })
  // Rows: 0 hunk, 1-4 the added lines. The gutter is 1 digit: the comment
  // mark is x 2 and the text starts at x 4.
  await ui.pointer({ in: 'diff-v5-0', type: 'down', x: 6, y: 2, button: 'left' })
  await ui.pointer({ in: 'diff-v5-0', type: 'move', x: 6, y: 4, button: 'left' })
  await ui.pointer({ in: 'diff-v5-0', type: 'up', x: 6, y: 4, button: 'left' })
  // The range's last row offers a comment at its end.
  expect(await ui.find({ in: 'diff-v5-0', type: 'Text', text: /✎ Comment on L2-4/ })).toBeDefined()
  expect(await ui.find({ key: 'comment' })).toBeUndefined()
  await ui.pointer({ in: 'diff-v5-0', type: 'down', x: 59, y: 4, button: 'left' })
  await ui.pointer({ in: 'diff-v5-0', type: 'up', x: 59, y: 4, button: 'left' })
  expect(await ui.find({ type: 'Text', text: '✎ Comment on L2-4' })).toBeDefined()
  await ui.input({ key: 'comment', text: 'range note' })
  expect(await ui.find({ type: 'Text', text: /range note/ })).toBeDefined()
  expect(await ui.find({ key: 'comment' })).toBeUndefined()

  // Hovering a line offers a comment too; the gutter mark opens one.
  await ui.pointer({ in: 'diff-v5-0', type: 'move', x: 10, y: 1 })
  expect(await ui.find({ in: 'diff-v5-0', type: 'Text', text: ' ✎ Comment ' })).toBeDefined()
  await ui.pointer({ in: 'diff-v5-0', type: 'down', x: 2, y: 1, button: 'left' })
  // Cancel closes it and parks the focus on the toolbar, not on Send.
  await ui.press({ key: 'composer-cancel' })
  expect(await ui.find({ key: 'comment' })).toBeUndefined()
  await ui.pointer({ in: 'diff-v5-0', type: 'down', x: 2, y: 1, button: 'left' })
  await ui.input({ key: 'comment', text: 'first line' })
  expect(await ui.find({ type: 'Text', text: /first line/ })).toBeDefined()
  // Each draft offers to send them all.
  expect(await ui.findAll({ type: 'Button', text: '➤ Send all 2 comments to Claude' })).toHaveLength(2)

  // Comments now sit under rows 1 and 4, so the diff is split there: rows
  // 0-1 are region diff-v5-0, rows 2-4 region diff-v5-2.
  await ui.resize({ in: 'diff-v5-2', columns: 60, rows: 3 })
  // Right-click a name: comment, definition and references.
  // "const beta = alpha + 1": alpha starts at index 13.
  await ui.pointer({ in: 'diff-v5-2', type: 'down', x: 4 + 14, y: 0, button: 'right' })
  expect(await ui.find({ type: 'Button', text: /Comment on L2/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Show definition of alpha' })).toBeDefined()
  await ui.press({ key: 'menu-definition' })
  expect(asked.at(-1)).toMatchObject({ operation: 'goToDefinition', line: 2, character: 14 })
  expect(await ui.find({ type: 'Markdown', text: /const alpha = 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /text search · language server: No LSP server/ })).toBeDefined()
  await ui.press({ key: 'menu-references' }).catch(() => {})

  // A plain click on a name shows what it is, as an editor's hover does.
  await ui.pointer({ in: 'diff-v5-0', type: 'down', x: 4 + 7, y: 1, button: 'left' })
  await ui.pointer({ in: 'diff-v5-0', type: 'up', x: 4 + 7, y: 1, button: 'left' })
  expect(asked.at(-1)).toMatchObject({ operation: 'hover', line: 1, character: 7 })
  expect(await ui.find({ type: 'Text', text: 'Definition · alpha' })).toBeDefined()
  await ui.press({ key: 'card-references' })
  expect(await ui.find({ type: 'Markdown', text: /2\*\* uses of `alpha`/ })).toBeDefined()

  // A click on a keyword or blank shows nothing and closes the card.
  await ui.pointer({ in: 'diff-v5-2', type: 'down', x: 4 + 1, y: 1, button: 'left' })
  await ui.pointer({ in: 'diff-v5-2', type: 'up', x: 4 + 1, y: 1, button: 'left' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('with no LSP tool loaded, a click says so and falls back on text search', async ($, on) => {
  const disk = new Map<string, string>()
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('command.list', () => ({ value: [] }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const args = e as unknown as { file_path: string; content: string }
    disk.set(args.file_path, args.content)
    return { result: { ok: true } as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/k.ts', content: 'function kite() {}\nkite()\n' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Row 2 is "kite()"; the text starts at x 4.
  await ui.pointer({ in: 'diff-v5-0', type: 'down', x: 5, y: 2, button: 'left' })
  await ui.pointer({ in: 'diff-v5-0', type: 'up', x: 5, y: 2, button: 'left' })
  expect(await ui.find({ type: 'Markdown', text: /function kite\(\) \{\}/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /language server: not loaded \(install an LSP plugin, then restart/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /HooksError/ })).toBeUndefined()
  await ui.unmount()
})

test("a draft's send button sends every draft as one message", async ($, on) => {
  const disk = new Map<string, string>()
  const submitted: string[] = []
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('command.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const args = e as unknown as { file_path: string; content: string }
    disk.set(args.file_path, args.content)
    return { result: { ok: true } as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/q.ts', content: 'one\ntwo\n' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'first' })
  expect(await ui.find({ type: 'Button', text: '➤ Send comment to Claude' })).toBeDefined()
  await ui.press({ key: 'down' })
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'second' })
  const sends = await ui.findAll({ type: 'Button', text: '➤ Send all 2 comments to Claude' })
  expect(sends).toHaveLength(2)
  await ui.press({ key: sends[0]!.key! })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('first')
  expect(submitted[0]).toContain('second')
  // With nothing left to send, no send control shows.
  expect(await ui.findAll({ type: 'Button', text: /Send/ })).toHaveLength(0)
  expect(await ui.find({ in: 'files-v5', type: 'Text', text: /Send/ })).toBeUndefined()

  // The summary row's count sends too.
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'third' })
  const link = await ui.find({ in: 'files-v5', type: 'Text', text: '➤ Send 1 comment to Claude' })
  expect(link).toBeDefined()
  // "1 file changed  " (16) + "+2 −0" (5) + 3 spaces: the link starts at x 24.
  await ui.pointer({ in: 'files-v5', type: 'down', x: 26, y: 0, button: 'left' })
  expect(submitted).toHaveLength(2)
  expect(submitted[1]).toContain('third')
  await ui.unmount()
})

test('a comment can be edited in place and deleted', async ($, on) => {
  const disk = new Map<string, string>()
  const submitted: string[] = []
  const toasts: string[] = []
  on('fs.read', ($, e) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined as never }))
  on('command.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', ($, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', { tool: 'Write' }, ($, e) => {
    const args = e as unknown as { file_path: string; content: string }
    disk.set(args.file_path, args.content)
    return { result: { ok: true } as never }
  })

  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/e.ts', content: 'one\ntwo\n' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'typo here' })
  const edit = await ui.find({ type: 'Button', text: 'Edit' })
  expect(edit).toBeDefined()

  // Edit: the card becomes a box holding the text; Cancel leaves it as it was.
  await ui.press({ key: edit!.key! })
  expect(await ui.find({ type: 'Text', text: '✎ Editing the comment on L1' })).toBeDefined()
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'Cancel' }))!.key! })
  expect(await ui.find({ type: 'Text', text: /typo here/ })).toBeDefined()

  // Edit and save.
  await ui.press({ key: edit!.key! })
  // The only field showing is the edit box.
  const box = await ui.find({ type: 'Input' })
  expect(box?.key).toMatch(/^edit-/)
  await ui.input({ key: box!.key!, text: 'fixed wording' })
  expect(await ui.find({ type: 'Text', text: /fixed wording/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /typo here/ })).toBeUndefined()

  // An empty edit is refused, the text kept.
  await ui.press({ key: edit!.key! })
  await ui.input({ key: box!.key!, text: '   ' })
  expect(toasts.at(-1)).toContain('use Delete')
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'Cancel' }))!.key! })

  // What is sent is the edited text.
  await ui.press({ key: 'down' })
  await ui.press({ key: 'comment-focus' })
  await ui.input({ key: 'comment', text: 'to be deleted' })
  const deletes = await ui.findAll({ type: 'Button', text: 'Delete' })
  expect(deletes).toHaveLength(2)
  await ui.press({ key: deletes[1]!.key! })
  expect(await ui.find({ type: 'Text', text: /to be deleted/ })).toBeUndefined()
  await ui.press({ key: 'send' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('fixed wording')
  expect(submitted[0]).not.toContain('typo here')
  expect(submitted[0]).not.toContain('to be deleted')
  await ui.unmount()
})
