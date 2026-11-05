## 2025-10-19 - [CRITICAL] Plaintext Password Storage
**Vulnerability:** The `User` model was storing passwords in plaintext in the database, and comparing them using strict equality (`candidatePassword === this.password`) instead of secure hashes.
**Learning:** The `User` schema had a commented out section indicating password hashing was "disabled as per request", which represents a critical data exposure risk for sensitive user credentials if the database is ever compromised.
**Prevention:** Always implement a secure password hashing mechanism like `bcrypt` with appropriate salting in the pre-save hook of the database model, and use secure string comparison for logins.
