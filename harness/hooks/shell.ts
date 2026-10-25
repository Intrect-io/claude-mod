// Small, pure helpers for reading a Bash command the way the guards need it.
// Not a shell parser: good enough to catch honest mistakes, not evasion.

// Message arguments and heredoc bodies are prose, not commands: a commit
// message that mentions "rm -rf" or "git push --force" must not be refused.
// Other quoted strings (bash -c "...") are still checked.
const MESSAGE_ARG = /(\s(?:-m|--message|--body|--title))(=|\s+)("(?:\\.|[^"\\])*"|'[^']*')/g
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g

export function stripProse(command: string): string {
  return command.replace(MESSAGE_ARG, "$1$2''").replace(HEREDOC, "<<'$2'\n$2")
}

// Simple commands of a command line, split on && || ; | and newlines.
export function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map(part => part.trim())
    .filter(part => part !== '')
}

// The words of one simple command, quotes removed, with leading variable
// assignments and wrappers (env, time, exec, command, nohup) skipped so the
// first word is the program.
export function commandWords(segment: string): string[] {
  const words = (segment.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? []).map(unquote)
  let at = 0
  while (at < words.length) {
    const word = words[at] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || ['env', 'time', 'exec', 'command', 'nohup', '('].includes(word)) {
      at++
      continue
    }
    break
  }

  return words.slice(at)
}

export function unquote(word: string): string {
  if (word.length >= 2 && ((word.startsWith('"') && word.endsWith('"')) || (word.startsWith("'") && word.endsWith("'")))) {
    return word.slice(1, -1)
  }

  return word
}

export function programOf(words: readonly string[]): string {
  const first = words[0] ?? ''

  return first.split('/').pop() ?? first
}

// Expands a leading ~ or $HOME so paths can be compared.
export function expandHome(path: string, home: string | undefined): string {
  if (home === undefined) return path
  if (path === '~' || path.startsWith('~/')) return `${home}${path.slice(1)}`
  if (path.startsWith('$HOME/') || path === '$HOME') return `${home}${path.slice(5)}`
  if (path.startsWith('${HOME}')) return `${home}${path.slice(7)}`

  return path
}

export function isInside(path: string, dir: string): boolean {
  const base = dir.endsWith('/') ? dir : `${dir}/`

  return path === dir || path.startsWith(base)
}
