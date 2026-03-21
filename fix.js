const fs = require('fs');
const filePath = 'c:/Users/LENOVO/Desktop/Avinash/School/Mobile app/backend/src/routes/exams.js';
let code = fs.readFileSync(filePath, 'utf8');

const targetLF = `        const subjectwiseSummary = subjects.map(subj => {
            const subjectExams = exams.filter(e => e.subject._id.toString() === subj._id.toString());
            const subjectExamIds = subjectExams.map(e => e._id.toString());
            const subjectMarks = allMarks.filter(m => subjectExamIds.includes(m.exam.toString()));

            let totalMarks = 0;
            let obtainedMarks = 0;

            subjectMarks.forEach(mark => {
                const exam = subjectExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                }
            });

            const avgPercentage = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(2) : 0;

            return {
                subjectId: subj._id,
                subjectName: subj.name,
                examsCount: subjectExams.length,
                avgPercentage: parseFloat(avgPercentage)
            };
        });`;

const targetCRLF = targetLF.replace(/\n/g, '\r\n');

const replacement = `        const subjectNameMap = new Map();

        subjects.forEach(subj => {
            const subjectExams = exams.filter(e => e.subject._id.toString() === subj._id.toString());
            const subjectExamIds = subjectExams.map(e => e._id.toString());
            const subjectMarks = allMarks.filter(m => subjectExamIds.includes(m.exam.toString()));

            let totalMarks = 0;
            let obtainedMarks = 0;

            subjectMarks.forEach(mark => {
                const exam = subjectExams.find(e => e._id.toString() === mark.exam.toString());
                if (exam) {
                    totalMarks += exam.totalMarks;
                    obtainedMarks += mark.marksObtained;
                }
            });

            const name = subj.name.trim();

            if (!subjectNameMap.has(name)) {
                subjectNameMap.set(name, {
                    subjectId: subj._id,
                    subjectName: name,
                    examsCount: 0,
                    totalMarks: 0,
                    obtainedMarks: 0
                });
            }

            const existing = subjectNameMap.get(name);
            existing.examsCount += subjectExams.length;
            existing.totalMarks += totalMarks;
            existing.obtainedMarks += obtainedMarks;
        });

        const subjectwiseSummary = Array.from(subjectNameMap.values()).map(subj => {
            const avgPercentage = subj.totalMarks > 0 ? ((subj.obtainedMarks / subj.totalMarks) * 100).toFixed(2) : 0;
            return {
                subjectId: subj.subjectName,
                subjectName: subj.subjectName,
                examsCount: subj.examsCount,
                avgPercentage: parseFloat(avgPercentage)
            };
        });`;

if (code.includes(targetCRLF)) {
    code = code.replace(targetCRLF, replacement);
    console.log("Replaced with CRLF match");
} else if (code.includes(targetLF)) {
    code = code.replace(targetLF, replacement);
    console.log("Replaced with LF match");
} else {
    console.log("Target not found!");
}

fs.writeFileSync(filePath, code);
