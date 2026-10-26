import type { EngineInterface } from 'claude-code'

// This mod's piece of the person's own status line: ~/.claude/statusline-command.sh
// joins ~/.claude/statusline/<sessionId>/<mod>.txt after its own fields, so the
// engine's one-row-per-plugin notices (`$.ui.status`) stay for what needs the
// person's eye. A leading '!' asks the status line to draw the piece in red;
// '' clears it. Copied per mod: a mod imports nothing outside its folder.

const MOD = 'fleet'
let last: string | undefined

export async function segment($: EngineInterface, text: string): Promise<void> {
  if (text === last) return
  last = text
  try {
    const home = await $.env.get('HOME')
    if (home === undefined) return
    await $.fs.write(`${home}/.claude/statusline/${await $.session.id()}/${MOD}.txt`, text)
  } catch {
    // No status line piece is worth failing a hook over.
    last = undefined
  }
}
