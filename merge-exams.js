const fs = require('fs');
const path = require('path');

const dir = __dirname;
const examsPath = path.join(dir, 'src', 'routes', 'exams.js');
const examsNewPath = path.join(dir, 'src', 'routes', 'examsNew.js');
const indexPath = path.join(dir, 'index.js');

let examsCode = fs.readFileSync(examsPath, 'utf8');
let examsNewCode = fs.readFileSync(examsNewPath, 'utf8');
let indexCode = fs.readFileSync(indexPath, 'utf8');

// Add yearContext import if missing
if (!examsCode.includes('yearContext')) {
    examsCode = examsCode.replace(
        "const { authenticateToken: auth } = require('../middleware/auth');",
        "const { authenticateToken: auth } = require('../middleware/auth');\nconst { yearContext, requireOpenYear } = require('../middleware/yearContext');"
    );
}

// Extract routes from examsNew
const newRoutes = examsNewCode.substring(
    examsNewCode.indexOf('// @route'),
    examsNewCode.lastIndexOf('module.exports = router;')
);

// Append routes right before module.exports in exams
examsCode = examsCode.replace('module.exports = router;', newRoutes + '\nmodule.exports = router;');

fs.writeFileSync(examsPath, examsCode);
fs.unlinkSync(examsNewPath);

// Remove from index.js
indexCode = indexCode.replace(/app\.use\('\/api\/exams',\s*require\('\.\/src\/routes\/examsNew'\)\);\n?/, "");
fs.writeFileSync(indexPath, indexCode);

console.log('Merge complete!');
