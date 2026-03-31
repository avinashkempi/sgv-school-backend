const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
    console.log('Connected to DB');
    const Exam = require('./src/models/Exam.js');
    
    // Find all standardized exams
    const allExams = await Exam.find({ isStandardized: true });
    console.log(`Total standardized exams: ${allExams.length}`);
    
    const seen = new Set();
    const duplicates = [];
    
    for (let e of allExams) {
        const key = `${e.class}-${e.subject}-${e.standardizedType}-${e.academicYear}`;
        if (seen.has(key)) {
            duplicates.push(e._id);
        } else {
            seen.add(key);
        }
    }
    
    console.log(`Found ${duplicates.length} duplicates.`);
    if (duplicates.length > 0) {
        const Marks = require('./src/models/Marks.js');
        await Marks.deleteMany({ exam: { $in: duplicates } });
        console.log('Duplicate Marks deleted.');
        await Exam.deleteMany({ _id: { $in: duplicates } });
        console.log('Duplicates deleted.');
    }
    
    // Clear cache
    const redis = require('redis');
    const redisClient = redis.createClient({ url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' });
    try {
        await redisClient.connect();
        console.log('Clearing cache patterns...');
        
        const keys1 = await redisClient.keys('*teacherDashboard*');
        if (keys1.length > 0) await redisClient.del(keys1);
        
        const initKeys = await redisClient.keys('*adminClassesInit*');
        if (initKeys.length > 0) await redisClient.del(initKeys);
        
        const examKeys = await redisClient.keys('*adminExamSchedule*');
        if (examKeys.length > 0) await redisClient.del(examKeys);
        
        const allPending = await redisClient.keys('*');
        console.log('Keys remaining:', allPending.length);
        
        console.log('Cache cleared.');
        await redisClient.quit();
    } catch(e) {
        console.log('Redis error', e.message);
    }
    
    process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
