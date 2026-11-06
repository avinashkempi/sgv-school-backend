## 2026-11-06 - [Sentinel]
**Vulnerability:** Passwords were stored in plaintext.
**Learning:** The `src/models/User.js` file explicitly disabled password hashing, likely to maintain backward compatibility with legacy users. We need to implement a solution that correctly identifies legacy users and hashes passwords without affecting them.
**Prevention:** Always use bcrypt for hashing passwords. Enforce a standard to update legacy plaintext passwords upon the next user login.
