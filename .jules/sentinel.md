## 2023-11-01 - 🛡️ Sentinel: [CRITICAL] Fix plaintext password storage
**Vulnerability:** Passwords were being stored in plaintext without any hashing mechanism.
**Learning:** Legacy systems might have historically stored passwords in plaintext. Hashing should always be applied before saving sensitive data to the database, ensuring backward compatibility during the transition.
**Prevention:** Enforce password hashing (e.g., using `bcryptjs`) through database middleware like Mongoose's `pre('save')` hook.
