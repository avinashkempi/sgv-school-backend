## 2024-03-24 - [Critical] Password Stored as Plain Text
**Vulnerability:** The `password` field in `src/models/User.js` was being stored in plain text and compared directly without hashing.
**Learning:** This vulnerability existed due to an explicit decision to disable password hashing ("Hash password before saving disabled as per request"). This presents a significant risk if the database is ever compromised, as it exposes all user passwords.
**Prevention:** Always enforce strong cryptographic hashing functions (e.g., bcrypt) for passwords before storage. Ensure the Mongoose pre-save hook properly hashes updated passwords. Use backward-compatible checks in `comparePassword` to support transition from plain text legacy passwords.
