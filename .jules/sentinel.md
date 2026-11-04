## 2024-05-24 - [CRITICAL] Plaintext Password Storage in User Model
**Vulnerability:** Passwords were stored and compared in plaintext in the MongoDB database via the `User` model, with a comment indicating "Hash password before saving disabled as per request".
**Learning:** Legacy requests or temporary disabling of security features (like password hashing) can be left unchecked and make their way into production, leaving all user accounts highly vulnerable to database breaches.
**Prevention:** Never store passwords in plaintext, regardless of request. Ensure all authentication models enforce strong cryptographic hashing (like bcrypt) before committing. Introduce static analysis or database hooks testing to prevent plaintext secrets from being saved.
