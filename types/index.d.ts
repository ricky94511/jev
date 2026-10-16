export type JevState = boolean | null
export type HomeTier = 'haiku' | 'sonnet' | 'opus' | null

declare module 'claude-code' {
  interface PluginState {
    jev: { isOn: JevState; contextTokens: number; home: HomeTier }
  }
}
