export type Toggles = {
  arch: boolean
  smells: boolean
  stopAudit: boolean
  llmReview: boolean
}

export type Lang = 'ts' | 'python' | 'rust'

export type Layer = { name: string; paths: string[] }

export type ForbidRule = { layer: string; pattern: string }

export type SmellLimits = {
  maxFunctionLines: number
  maxParams: number
  maxNesting: number
  maxFileLines: number
  minDuplicateLines: number
}

/** `.claude/architecture.json`, validated. */
export type Architecture = {
  layers: Layer[]
  /** Layer name → the other layers it may import. A layer with no entry is not judged. */
  allow: Record<string, string[]>
  /** Import prefix → path relative to the repo root, e.g. "@/": "src/", "intrect_platform": "src/intrect_platform". */
  packages: Record<string, string>
  forbidImports: ForbidRule[]
  smells: SmellLimits
  /** Problems found while reading the file; the rules they touch are dropped. */
  problems: string[]
}

export type RefactorState = {
  /** Violations already reported at a stop in this session (file|spec). */
  noted: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'refactor': {
      toggles: Shaped<Toggles>
      state: Shaped<RefactorState>
    }
  }
}
