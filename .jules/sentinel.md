## 2024-05-20 - [Fix Plaintext Passwords]
**Vulnerability:** User passwords were saved and compared in plaintext in the Mongoose schema.
**Learning:** The previous implementation explicitly disabled password hashing in the pre('save') hook.
**Prevention:** Ensured all new and updated passwords use bcrypt hashing and fallback checking for old users to maintain backward compatibility.
