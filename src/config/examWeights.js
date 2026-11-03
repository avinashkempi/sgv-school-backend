/**
 * Exam Weightings Configuration by Class
 *
 * Each standardized exam (FA1, FA2, SA1, FA3, FA4, SA2) has a distinct percentage weighting.
 *
 * HOW COMBINING WEIGHTS WORKS:
 * Classes can easily share/combine the exact same weights:
 * - Example A (Weights 1, 2, and 3 same): Assign all three to PRIMARY_WEIGHTS (or write '2': '1', '3': '1')
 * - Example B (Weights 1 and 2 same): Assign '1': PRIMARY_WEIGHTS, '2': PRIMARY_WEIGHTS
 * - Example C (Weights 1, 2, 3, and 4 same): Also assign '4': PRIMARY_WEIGHTS (or '4': '1')
 * - Example D (Unique class weights): Directly specify custom numbers for any class!
 *
 * DEFAULT FALLBACK:
 * If a class is not specifically defined, DEFAULT_EXAM_WEIGHTS will be automatically applied.
 *
 * DATABASE OVERRIDE:
 * If a Class document in MongoDB has `examWeights` defined directly on the class,
 * that database-level configuration takes top priority.
 */

// 1. Reusable / Shared Weight Schemes
// You can edit these numbers or combine classes to use whichever scheme you prefer.
const PRIMARY_WEIGHTS = {
    FA1: 10,
    FA2: 10,
    SA1: 30,
    FA3: 10,
    FA4: 10,
    SA2: 30
};

const MIDDLE_WEIGHTS = {
    FA1: 10,
    FA2: 10,
    SA1: 30,
    FA3: 10,
    FA4: 10,
    SA2: 30
};

const HIGH_WEIGHTS = {
    FA1: 10,
    FA2: 10,
    SA1: 30,
    FA3: 10,
    FA4: 10,
    SA2: 30
};

// Default fallback exam weights applied to any class without a specific configuration
const DEFAULT_EXAM_WEIGHTS = {
    FA1: 10,
    FA2: 10,
    SA1: 30,
    FA3: 10,
    FA4: 10,
    SA2: 30
};

// 2. Class Mappings (Applies to all classes: Pre-Primary through Class 10)
const EXAM_WEIGHTS_BY_CLASS = {
    // Pre-Primary Classes (Playhome, LKG, UKG)
    playhome: PRIMARY_WEIGHTS,
    lkg: PRIMARY_WEIGHTS,
    ukg: PRIMARY_WEIGHTS,

    // Primary & Middle Classes (1 to 7)
    // To combine (e.g. 1, 2, 3 same; or 1, 2, 3, 4 same), simply set them to the same profile or reference:
    '1': PRIMARY_WEIGHTS,
    '2': PRIMARY_WEIGHTS, // Combined with Class 1
    '3': PRIMARY_WEIGHTS, // Combined with Class 1 & 2
    '4': MIDDLE_WEIGHTS,  // (Change to PRIMARY_WEIGHTS or '1' if you want 1, 2, 3, 4 to be identical)
    '5': MIDDLE_WEIGHTS,
    '6': MIDDLE_WEIGHTS,
    '7': MIDDLE_WEIGHTS,

    // High School Classes (8 to 10)
    '8': HIGH_WEIGHTS,
    '9': HIGH_WEIGHTS,
    '10': HIGH_WEIGHTS,

    // Default fallback
    default: DEFAULT_EXAM_WEIGHTS
};

// Attach helpers for direct imports
EXAM_WEIGHTS_BY_CLASS.PRIMARY_WEIGHTS = PRIMARY_WEIGHTS;
EXAM_WEIGHTS_BY_CLASS.MIDDLE_WEIGHTS = MIDDLE_WEIGHTS;
EXAM_WEIGHTS_BY_CLASS.HIGH_WEIGHTS = HIGH_WEIGHTS;
EXAM_WEIGHTS_BY_CLASS.DEFAULT_EXAM_WEIGHTS = DEFAULT_EXAM_WEIGHTS;

module.exports = EXAM_WEIGHTS_BY_CLASS;
