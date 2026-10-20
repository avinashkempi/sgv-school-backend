## 2024-05-18 - [NoSQL Injection in VibeController]
**Vulnerability:** Found unsanitized input used in MongoDB regex queries in `src/controllers/vibeController.js`. `req.query.search` is directly passed to `$regex` without escaping, which could allow NoSQL injection or Regex DoS (ReDoS).
**Learning:** Even simple search fields need escaping when used in NoSQL queries, especially `$regex`.
**Prevention:** Always use an `escapeRegex` utility before using user input in `$regex` queries.
