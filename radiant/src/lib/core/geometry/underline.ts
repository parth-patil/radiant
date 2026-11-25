import type { BranchSpec } from '../types';

/** Upward arch with horizontal tangents at both ends of a branch underline. */
export function underlineOffset(t: number, rise: number): number {
  return (Math.cos(2 * Math.PI * t) - 1) * rise / 2;
}

/** Y derivative of the arch with respect to t. */
export function underlineSlope(t: number, rise: number): number {
  return -Math.PI * rise * Math.sin(2 * Math.PI * t);
}

/** Curved labels use independent graphemes only for scripts with simple left-to-right shaping. */
export function canCurveText(text: string): boolean {
  return text.length >= 3 && text.length <= 64 &&
    /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]+$/u.test(text) &&
    /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Mark}\p{Number}\p{Punctuation} ]+$/u.test(text);
}

// Limit both the steepest tangent and the turn across one em of text.
const MAX_LABEL_SLOPE = 0.2;
const MAX_LABEL_TURN_PER_EM = 0.35;

export function canCurveUnderline(span: number, rise: number, fontSize: number): boolean {
  if (!(span > 0 && rise > 0 && fontSize > 0)) return false;
  const maxSlope = Math.PI * rise / span;
  const maxCurvature = 2 * Math.PI * maxSlope / span;
  return maxSlope <= MAX_LABEL_SLOPE && maxCurvature * fontSize <= MAX_LABEL_TURN_PER_EM;
}

export function underlineSteps(branch: BranchSpec): number {
  if (!branch.underlineTo || !branch.underlineBend) return 1;
  return Math.max(6, Math.min(18, Math.ceil(Math.abs(branch.underlineTo.x - branch.p1.x) / 12)));
}
