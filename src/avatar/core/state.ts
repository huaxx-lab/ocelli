/**
 * AssistantState — the semantic layer.
 *
 * Design note (fused from the three references):
 *   - KK: one discrete "expression" enum drives everything, and the renderer
 *     only ever reads a flat parameter set — never the state name itself.
 *   - AURA: a single layered `phase` int + a few behaviour flags (speaking,
 *     sleeping, listening) that outrank the phase.
 *   - Grok Orb: no state at all, only a controlled expression API.
 *
 * We keep AURA's "one phase + overrides" shape but make the phase a string
 * union so the Web Lab, the future StopWatch firmware and the (future) real
 * agent events all speak the same vocabulary.
 *
 * This module is PURE: no DOM, no React, no timers. It is written to be
 * transliterated into C++ for renderer/stopwatch/.
 */

export const ASSISTANT_STATES = [
  'idle',
  'listening',
  'thinking',
  'working',
  'speaking',
  'waiting_input',
  'waiting_approval',
  'success',
  'error',
  'sleeping',
] as const;

export type AssistantState = (typeof ASSISTANT_STATES)[number];

/** AURA-style priority ladder. Higher number wins when overrides compete. */
export const STATE_PRIORITY: Record<AssistantState, number> = {
  sleeping: 0,
  idle: 10,
  success: 20,
  // `error` sits above the busy states so a failure is never masked…
  error: 25,
  thinking: 30,
  working: 35,
  listening: 40,
  speaking: 45,
  waiting_input: 50,
  // …but a pending decision outranks everything short of a hard failure.
  waiting_approval: 60,
};

/**
 * Presentation-only channel used by the Lab for copy such as
 * "Reading Gmail…". It never influences animation directly (the Avatar must
 * express the state on its own); it is metadata for the surrounding UI.
 */
export interface StateContext {
  /** Short contextual label, e.g. "Reading Gmail…". */
  label?: string;
  /** Optional 0..1 progress for WORKING's progress ring. `undefined` = indeterminate. */
  progress?: number;
}

export function isAssistantState(value: unknown): value is AssistantState {
  return typeof value === 'string' && (ASSISTANT_STATES as readonly string[]).includes(value);
}

/** States that count as "the assistant is doing something" (AURA's busy gate). */
export const BUSY_STATES: ReadonlySet<AssistantState> = new Set<AssistantState>([
  'listening',
  'thinking',
  'working',
  'speaking',
  'waiting_input',
  'waiting_approval',
  'success',
  'error',
]);

/** States in which the character is engaged enough to suppress idle gestures. */
export function isEngaged(state: AssistantState): boolean {
  return state !== 'idle' && state !== 'sleeping';
}
