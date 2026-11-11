// Making a directory that is not a repository yet into one a run can start in.

import type { EngineInterface } from 'claude-code'

import { ensureLines, out, repoRoot, run } from './io'

// Lines a bootstrapped repository ignores before its first commit: secrets and
// noise must not enter a history auto-claude then builds on.
export const BOOTSTRAP_IGNORE = ['.env', '.env.*', '!.env.example', '*.pem', '*.key', '*.p12', '*.pfx', 'node_modules/', '.DS_Store', 'worktrees/', '.claude/settings.local.json']
// A directory with more files than this, or other repositories inside it, is not one project.
export const BOOTSTRAP_MAX_FILES = 3000

// A directory that is not a git repository (or has one with no commit yet) is
// made into one: `git init` on main, a .gitignore for secrets, one initial
// commit of what is there. Returns why it will not, for a directory that is
// plainly not a single project (the home directory, a folder of repositories).
export async function bootstrapRepo($: EngineInterface, dir: string, hasRepo: boolean): Promise<{ root: string; note: string } | { error: string }> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (dir === '/' || dir === home) return { error: `Not a project directory: ${dir}. cd into the project's folder and start there.` }
  const nested = (await run($, ['bash', '-c', 'find . -mindepth 2 -maxdepth 3 -name .git -not -path "./worktrees/*" | head -1'], dir, 30_000)).stdout.trim()
  if (nested !== '') return { error: `Not bootstrapped: ${dir} holds other repositories (${nested}); start inside one of them.` }
  const counted = (await run($, ['bash', '-c', `find . -type f -not -path "./.git/*" -not -path "*/node_modules/*" | head -${BOOTSTRAP_MAX_FILES + 1} | wc -l`], dir, 60_000)).stdout.trim()
  if (Number(counted) > BOOTSTRAP_MAX_FILES) return { error: `Not bootstrapped: ${dir} holds more than ${BOOTSTRAP_MAX_FILES} files, so it is not one project; start in the project's folder, or run git init yourself.` }
  if (!hasRepo) {
    let init = await run($, ['git', '-C', dir, 'init', '-b', 'main'], dir, 30_000)
    // git before 2.28 has no -b.
    if (init.exitCode !== 0) {
      init = await run($, ['git', '-C', dir, 'init'], dir, 30_000)
      if (init.exitCode === 0) await run($, ['git', '-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], dir, 15_000)
    }
    if (init.exitCode !== 0) return { error: `Not bootstrapped: git init failed in ${dir}: ${out(init)}` }
  }
  const root = await repoRoot($, dir)
  if (root === undefined) return { error: `Not bootstrapped: ${dir} is still not a git repository after git init.` }
  await ensureLines($, `${root}/.gitignore`, BOOTSTRAP_IGNORE, '# auto-claude bootstrap')
  await run($, ['git', '-C', root, 'add', '-A'], root, 60_000)
  const staged = (await run($, ['git', '-C', root, 'diff', '--cached', '--name-only'], root, 30_000)).stdout.split('\n').filter(l => l.trim() !== '').length
  const made = await run($, ['git', '-C', root, 'commit', '--allow-empty', '-m', 'Initial commit'], root, 60_000)
  if (made.exitCode !== 0) return { error: `Not bootstrapped: the initial commit failed (is git user.name / user.email set?): ${out(made)}` }
  return { root, note: `${hasRepo ? 'Made the first commit' : 'Initialized a git repository'} here (main, ${staged} file${staged === 1 ? '' : 's'}; secrets and noise are in .gitignore).` }
}
