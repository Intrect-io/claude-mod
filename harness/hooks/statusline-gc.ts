import type { EngineInterface } from 'claude-code'

// Each mod writes '' to its piece at session.end, but the session's folder under
// ~/.claude/statusline stays. The status line reads only the running session's
// folder, so the rest are litter: moved to ~/.claude/trash (never deleted).

export type PieceFolder = { id: string; newestMtimeMs: number; allEmpty: boolean }

export const DAY_MS = 24 * 60 * 60_000
// A folder that still holds text belongs to a session that crashed before its
// session.end, or to a live one idle that long; two weeks rules out the second.
const EMPTY_AFTER_MS = DAY_MS
const FILLED_AFTER_MS = 14 * DAY_MS
export const MAX_MOVES = 200

// The ids to move, oldest first, never the running session's.
export function staleFolders(folders: readonly PieceFolder[], now: number, currentId: string, cap = MAX_MOVES): string[] {
  return folders
    .filter(folder => folder.id !== currentId && now - folder.newestMtimeMs > (folder.allEmpty ? EMPTY_AFTER_MS : FILLED_AFTER_MS))
    .sort((a, b) => a.newestMtimeMs - b.newestMtimeMs)
    .slice(0, cap)
    .map(folder => folder.id)
}

export async function gatherFolders($: EngineInterface, root: string): Promise<PieceFolder[]> {
  const entries = await $.fs.list(root).catch(() => [])
  const folders: PieceFolder[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue
    const dir = `${root}/${entry.name}`
    const files = (await $.fs.list(dir).catch(() => undefined))?.filter(file => file.kind === 'file')
    if (files === undefined) continue
    // The listing gives a directory no time; an empty folder takes its own.
    const newestMtimeMs = files.length > 0 ? Math.max(...files.map(file => file.mtimeMs)) : (await $.fs.stat(dir).catch(() => undefined))?.mtimeMs
    if (newestMtimeMs === undefined) continue
    folders.push({ id: entry.name, newestMtimeMs, allEmpty: files.every(file => file.size === 0) })
  }

  return folders
}

// Returns how many folders were moved.
export async function sweepStatusline($: EngineInterface, home: string, now: number, currentId: string): Promise<number> {
  const root = `${home}/.claude/statusline`
  const ids = staleFolders(await gatherFolders($, root), now, currentId)
  if (ids.length === 0) return 0
  const trash = `${home}/.claude/trash/statusline`
  await $.process.run(['mkdir', '-p', trash])
  let moved = 0
  for (const id of ids) {
    // A swept folder can come back (a later piece write recreates it); mv onto
    // the earlier copy would nest inside it.
    const target = (await $.fs.exists(`${trash}/${id}`)) ? `${trash}/${id}-${now}` : `${trash}/${id}`
    const result = await $.process.run(['mv', `${root}/${id}`, target])
    if (result.exitCode === 0) moved++
  }

  return moved
}
