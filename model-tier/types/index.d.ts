export type Tier = 'fable' | 'opus' | 'sonnet' | 'haiku'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type TierState = {
  /** The tier the main loop runs on now. */
  tier: Tier
  /** Who set `tier`: the classifier, the model's set_tier call, or /tier. */
  source: 'auto' | 'model' | 'pinned'
  /** The lower tier the classifier keeps proposing, and how many turns in a row. */
  pendingDown?: Tier
  pendingCount: number
  /** Prompt tokens of the last main-loop request (input + cache read + cache write). */
  lastInputTokens: number
  /** The effort requests are sent with; unset keeps the session's own (/effort). */
  effort?: Effort
  /** Who set `effort`: the classifier, the model's set_tier call, or /tier effort. */
  effortSource: 'auto' | 'model' | 'pinned'
  /** The lower effort the classifier keeps proposing, and how many turns in a row. */
  pendingEffortDown?: Effort
  pendingEffortCount: number
  /** The provider that answered most recently (from the step's usage), e.g. anthropic, openai, ollama. */
  lastProvider?: string
  /** The pick the turn note last told the model ("tier·effort"); unset before the first note. */
  notedPick?: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-tier': { tier: Shaped<TierState> }
  }
}
