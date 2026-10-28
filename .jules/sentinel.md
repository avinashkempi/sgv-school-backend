## 2024-10-27 - [Password Hashing]
**Vulnerability:** Plaintext password storage in MongoDB.
**Learning:** `src/models/User.js` explicitly disabled password hashing (`// Hash password before saving disabled as per request`), likely to aid testing or development, introducing a CRITICAL security vulnerability in production.
**Prevention:** Remove test configurations from production models. Always use bcrypt or argon2 for password storage, and incorporate fallback logic (`startsWith('$2a$')` or similar) to allow smooth migrations of legacy plaintext data. Ensure `this.password` is explicitly checked for existence before using string methods, as Mongoose schemas with SSO or `select: false` might leave it undefined.
