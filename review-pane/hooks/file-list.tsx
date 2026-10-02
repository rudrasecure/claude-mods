import type { ClientModule } from 'claude-code'

// The changed files as a list the mouse picks from, each part in its own
// colour: status, folder (dim) and name, a change bar, +added −removed, and
// the comments left on it. Row 0 is the summary, the files follow.

export type FileEntry = {
  status: 'A' | 'M' | 'D'
  dir: string
  name: string
  added: number
  removed: number
  comments: number
}

export type FileListProps = {
  files: FileEntry[]
  selected: number
  isRunning: boolean
}

export type FileListMessage = { type: 'file'; index: number } | { type: 'send' }

type FileListState = { hover?: number; isOnSend?: boolean }

const STATUS_COLOR = { A: 'green', M: 'yellow', D: 'red' } as const
const BAR_CELLS = 5

function bar(added: number, removed: number): { plus: number; minus: number; rest: number } {
  const total = added + removed
  if (total === 0) return { plus: 0, minus: 0, rest: BAR_CELLS }
  const cells = Math.min(BAR_CELLS, total)
  const plus = Math.round((added / total) * cells)
  return { plus, minus: cells - plus, rest: BAR_CELLS - cells }
}

const FileList: ClientModule<FileListProps, FileListState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? {}
  const added = props.files.reduce((n, f) => n + f.added, 0)
  const removed = props.files.reduce((n, f) => n + f.removed, 0)
  const comments = props.files.reduce((n, f) => n + f.comments, 0)
  // The stats column, as wide as the widest file's.
  const statWidth = Math.max(...props.files.map(f => `+${f.added} −${f.removed}`.length))

  // The summary row's send link spans these columns.
  const summary = `${props.files.length} file${props.files.length === 1 ? '' : 's'} changed  `
  const sendStart = summary.length + `+${added} −${removed}`.length + 3
  const sendText = `➤ Send ${comments} comment${comments === 1 ? '' : 's'} to Claude`
  const isOverSend = (x: number, y: number) => comments > 0 && y === 0 && x >= sendStart && x < sendStart + sendText.length

  surface.onPointer(e => {
    const index = e.y - 1
    if (e.type === 'leave' || (e.type === 'move' && !e.button)) {
      const hover = e.type === 'move' && index >= 0 && index < props.files.length ? index : undefined
      const isOnSend = e.type === 'move' && isOverSend(e.x, e.y)
      if (hover !== state.hover || isOnSend !== Boolean(state.isOnSend)) surface.setState({ ...state, hover, isOnSend })
      return
    }
    if (e.type !== 'down' || e.button !== 'left') return
    if (isOverSend(e.x, e.y)) surface.post({ type: 'send' } satisfies FileListMessage)
    else if (index >= 0 && index < props.files.length) surface.post({ type: 'file', index } satisfies FileListMessage)
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" height={1}>
        <Text bold>{summary}</Text>
        <Text color="green" bold>{`+${added}`}</Text>
        <Text> </Text>
        <Text color="red" bold>{`−${removed}`}</Text>
        {comments > 0 && <Text>{'   '}</Text>}
        {comments > 0 && (
          <Text color="yellow" bold inverse={state.isOnSend}>
            {sendText}
          </Text>
        )}
        {props.isRunning && <Text color="magenta">{'   ● Claude is working (comments will steer)'}</Text>}
      </Box>
      {props.files.map((f, i) => {
        const isSelected = i === props.selected
        const isHover = state.hover === i
        const b = bar(f.added, f.removed)
        const stat = `+${f.added} −${f.removed}`
        return (
          <Box flexDirection="row" height={1}>
            <Text color="blue" bold>{isSelected ? '▌' : ' '}</Text>
            <Text color={STATUS_COLOR[f.status]} bold>{` ${f.status} `}</Text>
            <Box flexGrow={1} height={1}>
              <Text wrap="truncate-start" underline={isHover && !isSelected}>
                <Text dimColor>{f.dir}</Text>
                <Text bold={isSelected} color={isSelected ? 'blue' : undefined}>{f.name}</Text>
              </Text>
            </Box>
            <Text color="yellow">{f.comments ? ` ✎${f.comments}` : ''}</Text>
            <Text>{' '.repeat(Math.max(1, statWidth - stat.length + 2))}</Text>
            <Text color="green">{`+${f.added}`}</Text>
            <Text> </Text>
            <Text color="red">{`−${f.removed}`}</Text>
            <Text> </Text>
            <Text color="green">{'■'.repeat(b.plus)}</Text>
            <Text color="red">{'■'.repeat(b.minus)}</Text>
            <Text dimColor>{'■'.repeat(b.rest)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default FileList
