# claude-mods

Mods for [Claude Code](https://claude.com/claude-code) by Rudra Secure.

| Mod | What it does |
| --- | --- |
| [`review-pane`](./review-pane) | A side pane that shows every file Claude changed in the conversation as a diff. Mark lines, comment on them, and send the comments back to Claude, which answers each one. |

## review-pane

Review Claude's changes the way you review a pull request, without leaving the session.

- **Every change in the conversation.** Each file Claude touches with Edit, Write, MultiEdit or NotebookEdit is listed with its status (`A` added, `M` modified, `D` deleted), `+added −removed` counts and a change bar. Edits made before a restart or a resume are rebuilt from the conversation.
- **Readable diffs.** Syntax highlighting per language; added and removed lines are marked by the colour of their line number.
- **Comment on lines.** Click a line, drag or shift-click for a range, then click **✎ Comment** at the end of the line or the selection. The comment box opens right under the lines. Saved comments show as cards under their lines, with **Edit** and **Delete**.
- **Send to Claude.** **➤ Send** (on any comment card, the file list's summary row, or the toolbar) sends all comments as one message, each with the file, the lines and the diff snippet. While Claude is working, the comments are delivered into the running turn so it can change course; otherwise they start a new turn.
- **Code intelligence.** Click a name to see its definition, the way an editor's hover does. Right-click a line or a name for **Comment**, **Show definition**, **Go to definition** and **Find references**. Answers come from a language server when one is set up (see [Language servers](#language-servers-optional)), and from a text search of the changed files otherwise.

### Requirements

- Claude Code with mods (function-hook plugins). Built and tested on **2.1.287**. The mod API is early access and may change between releases.
- The **fullscreen terminal layout** for the mouse (click, drag, right-click, hover). Set `"tui": "fullscreen"` in `~/.claude/settings.json`, or pick it in `/config`. Elsewhere the pane still works with the keyboard and clickable line numbers.
- A terminal at least **144 columns** wide for the pane to dock beside the transcript on its own. `/changes` opens it at any width.

### Install

**From the marketplace (recommended)**

In Claude Code:

```
/plugin marketplace add rudrasecure/claude-mods
/plugin install review-pane@claude-mods
```

or from a shell:

```sh
claude plugin marketplace add rudrasecure/claude-mods
claude plugin install review-pane@claude-mods
```

Then restart Claude Code. To update later:

```sh
claude plugin marketplace update claude-mods
claude plugin update review-pane@claude-mods
```

and restart again.

**From a clone**

```sh
git clone https://github.com/rudrasecure/claude-mods.git
claude --plugin-dir ./claude-mods/review-pane
```

To load it in every session without the flag, add the folder to `~/.claude/settings.json`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/claude-mods/review-pane" }
}
```

### Use

Run **`/changes`** to open the pane. It also opens by itself after Claude's first edit when the terminal is wide enough.

**Mouse** (fullscreen terminal)

| Do | To |
| --- | --- |
| Click a file in the list | Show its diff |
| Click a line | Move the cursor there |
| Drag, or shift-click | Select a range of lines |
| Click **✎ Comment** at the end of a hovered line or a selection | Comment on it |
| Click a function, variable or type name | See its definition |
| Right-click a line, a selection or a name | Comment, show definition, go to definition, find references |
| Click **➤ Send** | Send all comments to Claude |

**Keyboard** (once the pane has focus: click it, or open it with `/changes`)

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `j` / `k` | Next / previous line | `n` / `p` | Next / previous file |
| `v` | Start or clear a range | `c` | Comment on the line or range |
| `s` | Send all comments | `x` | Discard all comments |
| `w` | Next name on the line | `h` | Definition of that name |
| `g` | Go to its definition | `f` | Find its references |
| `t` | Highlighting on or off | `r` | Re-read files from disk |

Comments are drafts until you send them. Sent comments read like this to Claude:

````
I reviewed your changes and left a comment on specific lines:

1. `src/app.ts` L12-15
```diff
+const retries = 42
```
Use a named constant instead of 42.

Please address each comment, then briefly say what you changed for each.
````

### Language servers (optional)

Without a language server the pane finds definitions and references by searching the text of the changed files, and says so on the card. For real answers, install a language server and its Claude Code plugin from the official marketplace:

| Language | Server (install it yourself) | Claude Code plugin |
| --- | --- | --- |
| TypeScript / JavaScript | `npm install -g typescript-language-server typescript@5` | `typescript-lsp@claude-plugins-official` |
| Python | `npm install -g pyright` | `pyright-lsp@claude-plugins-official` |
| Go | `go install golang.org/x/tools/gopls@latest` (put `$(go env GOPATH)/bin` on your `PATH`) | `gopls-lsp@claude-plugins-official` |
| C / C++ | `clangd` from your package manager | `clangd-lsp@claude-plugins-official` |
| Rust | `rustup component add rust-analyzer` | `rust-analyzer-lsp@claude-plugins-official` |
| Lua | `lua-language-server` from your package manager | `lua-lsp@claude-plugins-official` |

```sh
claude plugin install typescript-lsp@claude-plugins-official   # and so on, per language
```

Then restart Claude Code fully. Things we ran into:

- **TypeScript must be 5.x.** `npm install -g typescript` now installs TypeScript 7, the native rewrite, which `typescript-language-server` cannot drive.
- **A full restart.** If your sessions run in the background daemon, `/exit` followed by `claude --continue` reattaches to the same process. Run `claude daemon stop --any` in between.
- **The `LSP` tool.** On some builds the tool Claude Code exposes to plugins is only listed when `ENABLE_LSP_TOOL=1` is set. If cards keep saying `language server: not loaded`, add it to `~/.claude/settings.json` and restart:

  ```json
  { "env": { "ENABLE_LSP_TOOL": "1" } }
  ```

### Limitations

- Changes made outside the file tools (for example by a shell command) are not picked up; press `r` to re-read listed files from disk.
- Comments not yet sent are kept for the session only: a restart loses them.
- Each line is highlighted on its own, so a construct spanning lines (a block comment, a multi-line string) can be coloured wrongly after its first line.
- Right-click needs a terminal that reports it, and shift-click one that reports modifiers (tmux may not pass them through).
- Diffs longer than 2,000 rows are cut off.

## Development

Each mod is a plugin folder: `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the hooks module, the module itself, and `types/index.d.ts` declaring the state it keeps.

```
review-pane/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json        # names register.tsx
│   ├── register.tsx      # the hooks: tracking edits, the pane, comments, sending, LSP
│   ├── diff-view.tsx     # mouse region drawing diff rows (click, drag, hover, right-click)
│   ├── file-list.tsx     # mouse region drawing the file list
│   ├── diff.ts           # line diff (Myers) into unified hunks
│   ├── symbols.ts        # names on a line; the text-search fallback
│   └── review.test.tsx   # tests, run with `claude plugin test`
├── types/index.d.ts      # the mod's $.state contract
└── tsconfig.json
```

```sh
claude plugin validate review-pane    # what the engine will load, and anything it would refuse
claude plugin test review-pane        # the tests
claude --plugin-dir ./review-pane     # try it; edits reload when the folder goes quiet
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes (with the API's types) each time it loads the mod, so `tsc -p review-pane` type-checks it after one load. That folder is generated and not committed.

## License

[MIT](./LICENSE) © Rudra Secure
