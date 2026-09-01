/**
 * Dynamic categories for Vibes.
 * Add new categories here to instantly make them available in the app.
 */
const VIBE_CATEGORIES = [
  { key: "general", label: "General", icon: "auto-awesome" },
  { key: "achievement", label: "Achievement", icon: "emoji-events" },
  { key: "sports", label: "Sports", icon: "sports-soccer" },
  { key: "arts", label: "Arts & Events", icon: "palette" },
  { key: "life", label: "Campus Life", icon: "local-florist" },
  { key: "official", label: "Official", icon: "school", adminOnly: true },
];

module.exports = { VIBE_CATEGORIES };
