1. **Fix Password Storage Vulnerability in `src/models/User.js`**:
   - Currently, passwords are saved in plaintext because the pre-save hook for hashing was explicitly disabled.
   - Update `userSchema.pre('save')` to hash passwords using `bcryptjs` if `this.isModified('password')` is true.
   - Update `userSchema.methods.comparePassword` to support comparing both `bcrypt` hashes (if the password string starts with `$2`) and legacy plaintext passwords for backward compatibility.
2. **Document Findings in `.jules/sentinel.md`**:
   - Create or update `.jules/sentinel.md` to document this critical security learning, noting that password hashing was intentionally disabled at some point, leading to plaintext passwords in the database.
3. **Run Pre-Commit Checks**:
   - Execute the steps provided by `pre_commit_instructions` to ensure proper testing, verification, review, and reflection are done.
4. **Submit Changes**:
   - Commit and submit the code with a standard security PR format as described in Sentinel's instructions.
