const fs = require('fs');
const filepath = 'src/models/User.js';
let content = fs.readFileSync(filepath, 'utf8');

if (!content.includes('const bcrypt = require(\'bcryptjs\');')) {
    content = content.replace("const toTitleCase = require('../utils/titleCase');", "const toTitleCase = require('../utils/titleCase');\nconst bcrypt = require('bcryptjs');");
}

const replacePreSave = `// Invalidate existing sessions when account access or password changes
userSchema.pre('save', async function (next) {
  const shouldRevokeSessions = !this.isNew && (
    this.isModified('password') ||
    this.isModified('role') ||
    this.isModified('isActive')
  );

  if (shouldRevokeSessions) {
    this.tokenVersion = (this.tokenVersion ?? 0) + 1;

    if (this.isModified('password')) {
      this.passwordChangedAt = new Date();
    }
  }

  // Hash password before saving
  if (this.isModified('password')) {
    try {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    } catch (error) {
      return next(error);
    }
  }

  next();
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  // Support comparing both bcrypt hashes and legacy plaintext passwords
  if (this.password && this.password.startsWith('$2')) {
    return await bcrypt.compare(candidatePassword, this.password);
  }
  return candidatePassword === this.password;
};`;

content = content.replace(/\/\/ Invalidate existing sessions when account access or password changes[\s\S]*?return candidatePassword === this\.password;\n\};/, replacePreSave);

fs.writeFileSync(filepath, content, 'utf8');
