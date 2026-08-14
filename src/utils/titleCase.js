/**
 * Convert a string to Title Case.
 * Handles ALL CAPS, mixed case, and preserves small connector words
 * when they are not the first word.
 *
 * @param {string} str - The input string
 * @returns {string} Title-cased string
 *
 * @example
 * toTitleCase('JOHN DOE')        // 'John Doe'
 * toTitleCase('aman kumar')      // 'Aman Kumar'
 * toTitleCase('ravi s/o ramesh') // 'Ravi S/O Ramesh'
 */
function toTitleCase(str) {
    if (!str || typeof str !== 'string') return str || '';
    return str
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((word, index) => {
            // Always capitalize the first word; capitalize others unless they are connectors
            const SMALL_WORDS = new Set(['of', 'and', 'the', 'in', 'at', 'to', 'for', 'on', 'by']);
            if (index > 0 && SMALL_WORDS.has(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
}

module.exports = toTitleCase;
