## 2026-10-25 - [CRITICAL] Plaintext Password Storage
**Vulnerability:** Passwords are stored in plaintext in the database instead of being hashed. This is evident from `userSchema.methods.comparePassword = async function (candidatePassword) { return candidatePassword === this.password; };` and the lack of a `pre('save')` hook for hashing passwords.
**Learning:** This is a critical security vulnerability. If the database is compromised, all user passwords will be exposed in plaintext.
**Prevention:** Passwords should always be hashed using a strong algorithm like bcrypt before storing them in the database.
