/**
 * Exam Weight Resolver Utility
 *
 * Resolves distinct per-class exam weights and calculates weighted marks percentages.
 * Priority:
 * 1. Database Class document `examWeights`
 * 2. Class-specific config from `Backend/src/config/examWeights.js` (Classes 1, 2, 3...)
 * 3. Default school exam weights
 */

const EXAM_WEIGHTS_BY_CLASS = require('../config/examWeights');

const STANDARDIZED_EXAM_TYPES = ['FA1', 'FA2', 'SA1', 'FA3', 'FA4', 'SA2'];

/**
 * Normalizes a class value, name, or label string to extract class grade identifier.
 * Accurately handles:
 * - Digits 1-12, e.g. "1", "10", "1st Standard", "10th Standard", "Class 10", "Grade 4", "10 - A"
 * - Pre-Primary: "Playhome", "Playhome_U", "LKG", "LKG_U", "UKG", "UKG_U", "Nursery"
 * - ObjectIds: Rejects raw 24-hex ObjectId strings to prevent false-positive digit matching
 */
function normalizeClassKey(classIdentifier) {
    if (!classIdentifier) return null;

    if (typeof classIdentifier === 'object') {
        return normalizeClassKey(classIdentifier.value || classIdentifier.name || classIdentifier.label);
    }

    let str = String(classIdentifier).trim().toLowerCase();

    // Reject raw 24-character hex ObjectIds to avoid matching embedded numbers
    if (/^[0-9a-fA-F]{24}$/.test(str)) {
        return null;
    }

    // Strip branch and location identifiers
    str = str.replace(/_u$/i, '')
        .replace(/\(ugar\)/i, '')
        .replace(/\(mangasuli\)/i, '')
        .trim();

    // 1. Keyword checks for Pre-Primary
    if (str.includes('playhome') || str.includes('nursery')) return 'playhome';
    if (str.includes('lkg') || str.includes('l.k.g')) return 'lkg';
    if (str.includes('ukg') || str.includes('u.k.g')) return 'ukg';

    // 2. Normalize separators to spaces for boundary analysis
    const clean = str.replace(/[^a-z0-9]/g, ' ');

    // 3. Extract Arabic grade numerals (1 to 12).
    // Note: Larger numbers (1[0-2]) are checked before single digits ([1-9]) to avoid "10" matching "1"
    const numMatch = clean.match(/\b(1[0-2]|[1-9])(?:st|nd|rd|th)?\b/);
    if (numMatch) {
        return numMatch[1];
    }

    return clean.replace(/\s+/g, '_');
}

/**
 * Helper to recursively resolve aliases (e.g. '2': '1') or direct profile objects.
 */
function resolveWeightsFromMap(key, visited = new Set()) {
    if (!key || visited.has(key)) return null;
    visited.add(key);

    const val = EXAM_WEIGHTS_BY_CLASS[key];
    if (!val) return null;

    if (typeof val === 'string') {
        // Alias reference pointing to another class key (e.g. '2': '1')
        return resolveWeightsFromMap(val, visited) || EXAM_WEIGHTS_BY_CLASS.default;
    }
    if (typeof val === 'object') {
        return val;
    }
    return null;
}

/**
 * Resolves the distinct exam weights for a class object or ID.
 * Supports:
 * 1. Database-level custom class weights (`classObj.examWeights`)
 * 2. Class-specific config from `examWeights.js` (Classes 1-10, Playhome, LKG, UKG, aliases)
 * 3. Default school exam weights fallback
 *
 * @param {Object|string} classObj - Class document, plain object, or class name/value string
 * @returns {Object} examWeights map { FA1: number, FA2: number, ... }
 */
function getClassExamWeights(classObj) {
    const defaultWeights = EXAM_WEIGHTS_BY_CLASS.default || EXAM_WEIGHTS_BY_CLASS.DEFAULT_EXAM_WEIGHTS;

    if (!classObj) {
        return { ...defaultWeights };
    }

    // 1. Check if class document has explicit DB-level weights
    if (typeof classObj === 'object' && classObj.examWeights && typeof classObj.examWeights === 'object') {
        const dbWeights = classObj.examWeights;
        const hasCustom = STANDARDIZED_EXAM_TYPES.some(t => typeof dbWeights[t] === 'number');
        if (hasCustom) {
            const resolved = {};
            STANDARDIZED_EXAM_TYPES.forEach(t => {
                resolved[t] = typeof dbWeights[t] === 'number'
                    ? dbWeights[t]
                    : (defaultWeights[t] || 0);
            });
            return resolved;
        }
    }

    // If string passed directly (e.g. "1st Standard", "1")
    if (typeof classObj === 'string') {
        const directKey = normalizeClassKey(classObj);
        const resolvedDirect = resolveWeightsFromMap(directKey);
        if (resolvedDirect) {
            return { ...resolvedDirect };
        }
        return { ...defaultWeights };
    }

    // 2. Check if class value matches config or alias
    const keyFromValue = normalizeClassKey(classObj.value);
    const resolvedFromValue = resolveWeightsFromMap(keyFromValue);
    if (resolvedFromValue) {
        return { ...resolvedFromValue };
    }

    // 3. Check if class name or label matches config or alias
    const keyFromName = normalizeClassKey(classObj.name || classObj.label);
    const resolvedFromName = resolveWeightsFromMap(keyFromName);
    if (resolvedFromName) {
        return { ...resolvedFromName };
    }

    // 4. Fallback to default
    return { ...defaultWeights };
}

/**
 * Computes dynamically normalized weighted percentage for completed standardized exams.
 * @param {Object} completedTypeScores - Map of completed exam type to score percentage, e.g. { FA1: 85, SA1: 90 }
 * @param {Object} examWeights - Distinct weights for the class, e.g. { FA1: 20, FA2: 20, ... }
 * @returns {number|null} Weighted percentage (0-100) rounded to 1 decimal place, or null if no exams completed
 */
function computeClassWeightedMarks(completedTypeScores, examWeights) {
    if (!completedTypeScores || typeof completedTypeScores !== 'object') {
        return null;
    }

    const completedKeys = Object.keys(completedTypeScores).filter(
        type => typeof completedTypeScores[type] === 'number' && !isNaN(completedTypeScores[type])
    );

    if (completedKeys.length === 0) {
        return null;
    }

    const weights = examWeights || EXAM_WEIGHTS_BY_CLASS.default;

    const totalCompletedWeight = completedKeys.reduce(
        (sum, type) => sum + (weights[type] || 0),
        0
    );

    if (totalCompletedWeight === 0) {
        // Equal unweighted fallback if weights sum to 0
        const simpleAvg = completedKeys.reduce((sum, type) => sum + completedTypeScores[type], 0) / completedKeys.length;
        return parseFloat(simpleAvg.toFixed(1));
    }

    const weightedSum = completedKeys.reduce(
        (sum, type) => sum + (completedTypeScores[type] * (weights[type] || 0)),
        0
    );

    return parseFloat((weightedSum / totalCompletedWeight).toFixed(1));
}

module.exports = {
    STANDARDIZED_EXAM_TYPES,
    normalizeClassKey,
    getClassExamWeights,
    computeClassWeightedMarks,
    EXAM_WEIGHTS_BY_CLASS
};

