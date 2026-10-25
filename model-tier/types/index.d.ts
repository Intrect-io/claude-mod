export type Tier = 'opus' | 'sonnet' | 'haiku'

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
}

declare module 'claude-code' {
  interface PluginState {
    'model-tier': { tier: Shaped<TierState> }
  }
}
