const escapeRegex = (string) => {
    return string.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

module.exports = {
    escapeRegex
};
