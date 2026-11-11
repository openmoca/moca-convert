// "Suitable" per the moca-convert design means an OpenAPI document whose
// operations carry real human-readable summary/description fields, not a
// bare machine-generated schema dump -- converting the latter would emit a
// low-value package that merely echoes the raw schema back as prose.
import { collectOperations } from './parse.js';

export const DEFAULT_MIN_DESCRIPTION_RATIO = 0.5;

/**
 * @param {object} doc
 * @param {number} [minRatio]
 * @returns {{ suitable: true } | { suitable: false, reason: string }}
 */
export function checkSuitability(doc, minRatio = DEFAULT_MIN_DESCRIPTION_RATIO) {
  const operations = collectOperations(doc);
  const total = operations.length;

  if (total === 0) {
    return { suitable: false, reason: 'No operations found under "paths".' };
  }

  const described = operations.filter(({ operation }) => hasDescription(operation)).length;
  const ratio = described / total;

  if (ratio < minRatio) {
    return {
      suitable: false,
      reason: `Only ${described}/${total} operation(s) (${Math.round(ratio * 100)}%) have a summary or description; need at least ${Math.round(minRatio * 100)}%.`,
    };
  }

  return { suitable: true };
}

function hasDescription(operation) {
  return isNonEmptyString(operation.summary) || isNonEmptyString(operation.description);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
