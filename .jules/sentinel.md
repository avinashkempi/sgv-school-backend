## 2024-10-18 - [Fix plaintext password storage]
**Vulnerability:** Passwords were saved in plain text in `src/models/User.js`.
**Learning:** Legacy codebase used plain text passwords, possibly to easily transition users or due to rapid prototyping.
**Prevention:** Always use a strong hashing algorithm like bcrypt when saving passwords and provide backwards compatibility checks during transition phases.
