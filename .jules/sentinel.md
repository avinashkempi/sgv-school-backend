## 2024-05-24 - [CRITICAL] Password Storage Vulnerability (Plaintext)
**Vulnerability:** Passwords were saved in plaintext within `src/models/User.js`.
**Learning:** The pre-save hook for password hashing in the User schema was explicitly commented out (`// Hash password before saving disabled as per request`), causing new and updated passwords to be saved in plaintext.
**Prevention:** Always implement password hashing using established libraries like `bcrypt` and ensure secure defaults are not disabled, especially on highly sensitive fields like user passwords.
