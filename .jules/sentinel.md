## 2024-10-24 - [ReDoS Vulnerability in Search]
**Vulnerability:** Found unsanitized user input passed directly to `new RegExp()` in multiple search endpoints (e.g. `src/controllers/searchController.js`), which exposed the server to Regular Expression Denial of Service (ReDoS) and NoSQL Regex Injection attacks.
**Learning:** Common pattern to check across the codebase when building dynamic queries for MongoDB using RegExp.
**Prevention:** Always escape user input using a utility like `escapeRegex(str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` before passing it to the `RegExp` constructor.
