/**
 * Statistics for cohort comparison.
 *
 * The whole point of cohort analysis is finding a group where something is
 * genuinely worse. The failure mode is finding groups where it only *looks*
 * worse because the sample is small, and with a dozen cohorts across a dozen
 * pages you are running hundreds of comparisons, so pure chance will hand you
 * several convincing-looking results every single day.
 *
 * Three guards, all of which must pass before anything is reported:
 *
 *   1. SAMPLE SIZE   A cohort of 12 sessions tells you nothing, whatever the rate.
 *   2. SIGNIFICANCE  Two-proportion z-test, is this difference real?
 *   3. EFFECT SIZE   A statistically significant 1.05× lift is not worth a PR.
 *
 * Plus a Bonferroni correction, because testing many cohorts at p<0.05 means
 * roughly one false positive per twenty tests. Without it the system would
 * confidently raise a fake issue most days and quickly become noise.
 */

/**
 * Normal CDF via the Abramowitz & Stegun 7.1.26 approximation of erf.
 * Accurate to ~1.5e-7, far beyond what this decision needs, and it avoids
 * pulling in a stats dependency for one function.
 */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1 + sign * y);
}

export interface ProportionTest {
  /** Cohort rate, 0..1. */
  rate: number;
  /** Baseline rate, 0..1. */
  baselineRate: number;
  /** How many times worse the cohort is. 2.0 = twice the rate. */
  lift: number;
  /** Two-tailed p-value. */
  pValue: number;
  zScore: number;
  /** Extra affected sessions vs. if the cohort behaved like the baseline. */
  excessSessions: number;
}

/**
 * Two-proportion z-test.
 *
 * Asks: could this cohort's rate differ from the baseline purely by chance?
 * Pooled variance, standard formulation.
 */
export function compareProportions(
  cohortAffected: number,
  cohortTotal: number,
  baselineAffected: number,
  baselineTotal: number,
): ProportionTest {
  const rate = cohortTotal > 0 ? cohortAffected / cohortTotal : 0;
  const baselineRate = baselineTotal > 0 ? baselineAffected / baselineTotal : 0;

  const pooled =
    cohortTotal + baselineTotal > 0
      ? (cohortAffected + baselineAffected) / (cohortTotal + baselineTotal)
      : 0;

  const standardError = Math.sqrt(
    pooled * (1 - pooled) * (1 / Math.max(1, cohortTotal) + 1 / Math.max(1, baselineTotal)),
  );

  const zScore = standardError > 0 ? (rate - baselineRate) / standardError : 0;
  // Two-tailed.
  const pValue = 2 * (1 - normalCdf(Math.abs(zScore)));

  return {
    rate,
    baselineRate,
    lift: baselineRate > 0 ? rate / baselineRate : rate > 0 ? Infinity : 1,
    pValue,
    zScore,
    excessSessions: Math.max(0, Math.round(cohortAffected - baselineRate * cohortTotal)),
  };
}

export interface SignificanceOptions {
  /** Cohorts smaller than this are never reported, whatever the rate. */
  minSessions?: number;
  /** Minimum lift worth acting on. 1.5 = at least 50% worse. */
  minLift?: number;
  /** Family-wise error rate before correction. */
  alpha?: number;
  /** How many comparisons were run, drives the Bonferroni correction. */
  comparisons?: number;
  /** Ignore cohorts where the absolute number of extra affected sessions is trivial. */
  minExcessSessions?: number;
}

export interface Verdict {
  significant: boolean;
  /** Threshold actually applied after correction. */
  correctedAlpha: number;
  /** Why it was rejected, when it was. */
  rejectedBecause?: string;
}

/**
 * Decide whether a cohort difference is worth raising.
 *
 * Deliberately conservative. A false positive here costs a human's afternoon and
 * some trust; a false negative costs one missed issue that the next day's pull
 * will very likely surface again.
 */
export function isSignificant(
  test: ProportionTest,
  cohortTotal: number,
  options: SignificanceOptions = {},
): Verdict {
  const minSessions = options.minSessions ?? 100;
  const minLift = options.minLift ?? 1.5;
  const alpha = options.alpha ?? 0.05;
  const comparisons = Math.max(1, options.comparisons ?? 1);
  const minExcess = options.minExcessSessions ?? 20;

  // Bonferroni: testing 40 cohorts at 0.05 would yield ~2 false positives daily.
  const correctedAlpha = alpha / comparisons;

  if (cohortTotal < minSessions) {
    return {
      significant: false,
      correctedAlpha,
      rejectedBecause: `only ${cohortTotal} sessions (need ${minSessions})`,
    };
  }
  // Only worse-than-baseline is interesting; a cohort doing *better* is not a bug.
  if (test.rate <= test.baselineRate) {
    return { significant: false, correctedAlpha, rejectedBecause: "not worse than baseline" };
  }
  if (test.lift < minLift) {
    return {
      significant: false,
      correctedAlpha,
      rejectedBecause: `lift ${test.lift.toFixed(2)}× below the ${minLift}× threshold`,
    };
  }
  if (test.excessSessions < minExcess) {
    return {
      significant: false,
      correctedAlpha,
      rejectedBecause: `only ${test.excessSessions} excess sessions (need ${minExcess})`,
    };
  }
  if (test.pValue > correctedAlpha) {
    return {
      significant: false,
      correctedAlpha,
      rejectedBecause: `p=${test.pValue.toExponential(2)} above corrected α=${correctedAlpha.toExponential(2)}`,
    };
  }

  return { significant: true, correctedAlpha };
}
