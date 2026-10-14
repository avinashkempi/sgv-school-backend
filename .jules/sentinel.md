## 2024-10-14 - Fix ReDoS vulnerabilities in codebase
**Vulnerability:** User inputs were passed directly to `new RegExp()` in multiple files (`searchController.js`, `userController.js`, `classes.js`, `marksImport.js`, `subjects.js`, `studentRatings.js`, `importService.js`).
**Learning:** MongoDB regex queries without properly escaped input are extremely common here and spread across multiple controllers/routes, leading to potential Regex Denial of Service (ReDoS) vulnerabilities.
**Prevention:** Always use the centralized `escapeRegex` function from `src/utils/stringUtils.js` when constructing dynamic regular expressions from user input.
