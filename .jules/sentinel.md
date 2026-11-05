## 2024-05-23 - Plaintext Password Storage Legacy Support
**Vulnerability:** Passwords were being stored and verified in plaintext despite `bcryptjs` being in dependencies.
**Learning:** Legacy systems might have missing security integrations even if the dependency is present. When adding hashing, backward compatibility for legacy plaintext passwords must be temporarily preserved in the comparison method so users don't get locked out.
**Prevention:** Ensure new authentication methods always enforce hashing and deprecate plaintext checking progressively.
