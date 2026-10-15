## 2024-05-18 - [CRITICAL] Fix plaintext password storage
**Vulnerability:** User passwords were saved and stored in plaintext in the database instead of being hashed.
**Learning:** The previous implementation had explicitly disabled password hashing with a comment indicating it was disabled per request. This compromised the security of all user accounts.
**Prevention:** Always use a strong hashing algorithm like bcrypt when saving passwords. Implement migration strategies in authentication handlers (e.g. falling back to plain text comparison only if the string does not match the hash pattern, then re-hashing) to avoid breaking existing legacy passwords instead of disabling password hashing entirely.
