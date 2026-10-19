/**
 * Declarations for the host events this plugin subscribes to.
 *
 * The harness declares these on its own Cordis build; this package declares
 * only what it consumes so it compiles against a bare `@deepseek-ai/cordis`
 * and stays loadable across host versions.
 *
 * @module dsh-dotclaude/events
 */

import type { AgentLike, PreToolDecisionLike, ToolExecutionLike } from './host.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A tool call is about to run; a listener may deny it.
     * @mode waterfall
     */
    'tools/pre-execute'(exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>): Promise<PreToolDecisionLike>
    /** A newly registered agent with its live session and completed setup. */
    'agent/created'(payload: { readonly agent: AgentLike }): unknown
    /** An agent is being disposed; its scoped registrations unwind afterwards. */
    'agent/disposed'(payload: { readonly agent: AgentLike }): unknown
  }
}
