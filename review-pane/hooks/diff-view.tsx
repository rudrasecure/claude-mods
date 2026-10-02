import type { ClientModule, ClientPointerEvent } from 'claude-code'

// One block of diff rows drawn with the mouse in mind: each row is one cell
// tall, so the pointer's `y` is the row. Selection, menus and cards live in the
// hooks module (posted here as props); this module keeps only the hover.

export type ViewRow = {
  kind: 'hunk' | 'ctx' | 'add' | 'del'
  // Tabs already expanded, so a pointer column is a text column.
  text: string
  no: string
  hasComment: boolean
}

export type ViewProps = {
  start: number
  rows: ViewRow[]
  cursor: number
  lo: number
  hi: number
  // What the last row of a marked range offers, e.g. "✎ Comment on L2-4".
  rangeLabel: string
  path: string
  isHighlighted: boolean
  gutter: number
}

// `x` is the pointer's column within the line's text (0 at its first cell),
// negative over the gutter.
export type ViewMessage =
  | { type: 'press'; row: number; x: number; shift: boolean }
  | { type: 'drag'; row: number }
  | { type: 'release'; row: number; x: number }
  | { type: 'context'; row: number; x: number }
  | { type: 'comment'; row: number }

type ViewState = { hover?: number; isDown?: boolean }

const HOVER_LABEL = ' ✎ Comment '

// Cells before a line's text: cursor mark, number, comment mark, range bar.
// Added and removed lines show by the colour of their number, not a sign.
export function textStart(gutter: number): number {
  return gutter + 3
}

const DiffView: ClientModule<ViewProps, ViewState> = (props, surface) => {
  const { Box, Text, Code } = surface.elements
  const state = surface.state ?? {}
  const isRange = props.lo >= 0
  const start = textStart(props.gutter)

  const labelOf = (i: number): string => {
    const at = props.start + i
    const row = props.rows[i]
    if (!row || row.kind === 'hunk') return ''
    if (isRange && at === props.hi) return ` ${props.rangeLabel} `
    return state.hover === i && !(isRange && at >= props.lo && at <= props.hi) ? HOVER_LABEL : ''
  }
  const onLabel = (e: ClientPointerEvent): boolean => {
    const label = labelOf(e.y)
    return label !== '' && surface.columns > 0 && e.x >= surface.columns - label.length
  }
  const inBlock = (e: ClientPointerEvent) => e.y >= 0 && e.y < props.rows.length
  const rowAt = (e: ClientPointerEvent) => props.start + e.y

  surface.onPointer(e => {
    if (e.type === 'leave') {
      if (state.hover !== undefined) surface.setState({ ...state, hover: undefined })
      return
    }
    if (e.type === 'move' && !e.button) {
      const hover = inBlock(e) ? e.y : undefined
      if (hover !== state.hover) surface.setState({ ...state, hover })
      return
    }
    if (e.type === 'down' && inBlock(e)) {
      const row = rowAt(e)
      if (e.button === 'right') {
        surface.post({ type: 'context', row, x: e.x - start } satisfies ViewMessage)
        return
      }
      if (e.button !== 'left') return
      // The comment mark in the gutter, or the label at the line's end.
      if (onLabel(e) || (e.x > props.gutter && e.x < props.gutter + 2)) {
        surface.post({ type: 'comment', row } satisfies ViewMessage)
        return
      }
      surface.setState({ ...state, isDown: true })
      surface.post({ type: 'press', row, x: e.x - start, shift: Boolean(e.shift) } satisfies ViewMessage)
      return
    }
    // Held: moves past the block's edges still arrive, so a drag spans blocks.
    if (e.type === 'move' && e.button === 'left' && state.isDown) {
      surface.post({ type: 'drag', row: rowAt(e) } satisfies ViewMessage)
      return
    }
    if (e.type === 'up' && state.isDown) {
      surface.setState({ ...state, isDown: false })
      surface.post({ type: 'release', row: rowAt(e), x: e.x - start } satisfies ViewMessage)
    }
  })

  return (
    <Box flexDirection="column">
      {props.rows.map((row, i) => {
        const at = props.start + i
        const isSelected = isRange && at >= props.lo && at <= props.hi
        const isCursor = at === props.cursor
        const isHover = state.hover === i
        const label = labelOf(i)
        const textWidth = label && surface.columns > 0 ? Math.max(1, surface.columns - start - label.length) : undefined
        const color = row.kind === 'add' ? 'green' : row.kind === 'del' ? 'red' : undefined
        const gutter = (
          <Text color={color} dimColor={!color && !isCursor && !isHover} bold={isCursor}>
            {`${isCursor ? '›' : ' '}${row.no.padStart(props.gutter)}`}
          </Text>
        )
        const mark = <Text color="yellow">{row.hasComment ? '✎' : ' '}</Text>
        const bar = <Text color="yellow">{isSelected ? '▌' : ' '}</Text>
        const tail = label ? (
          <Text color="blue" bold inverse={isHover}>
            {label}
          </Text>
        ) : null
        if (row.kind === 'hunk') {
          return (
            <Box flexDirection="row" height={1}>
              {gutter}
              {mark}
              {bar}
              <Text color="cyan" wrap="truncate">{` ${row.text}`}</Text>
            </Box>
          )
        }
        const text = props.isHighlighted ? (
          <Code source={row.text || ' '} path={props.path} wrap="truncate-end" />
        ) : (
          <Text color={color} dimColor={row.kind === 'ctx' && !isSelected && !isHover} wrap="truncate">
            {row.text || ' '}
          </Text>
        )
        return (
          <Box flexDirection="row" height={1}>
            {gutter}
            {mark}
            {bar}
            {textWidth === undefined ? (
              <Box flexGrow={1} height={1}>
                {text}
              </Box>
            ) : (
              <Box width={textWidth} height={1}>
                {text}
              </Box>
            )}
            {tail}
          </Box>
        )
      })}
    </Box>
  )
}

export default DiffView
