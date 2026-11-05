## 2025-02-14 - Fix Plaintext Passwords
**Vulnerability:** Passwords were stored and checked in plaintext in the database because the `bcryptjs` hashing logic was commented out in `src/models/User.js`.
**Learning:** Legacy plaintext passwords might exist in the database. Replacing plain text check with `bcrypt.compare` locks out existing users. A migration strategy or fallback logic is required.
**Prevention:** Implement secure password hashing, and include fallback logic for legacy plaintext passwords to allow existing users to still log in. Ideally, we should also automatically hash legacy passwords when they log in.
