const mongoose = require('mongoose');
require('dotenv').config();

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sgv-school';
  console.log(`Connecting to MongoDB using URI: ${uri}`);
  try {
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB.');

    const AcademicYear = require('./src/models/AcademicYear');
    const Class = require('./src/models/Class');

    // 1. Get all academic years
    const years = await AcademicYear.find({}).lean();
    console.log('\n--- Academic Years ---');
    years.forEach(y => {
      console.log(`- ID: ${y._id}, Name: ${y.name}, IsActive: ${y.isActive}, Status: ${y.status}`);
    });

    // 2. Find duplicate classes (same value, section, branch, academicYear)
    const classes = await Class.find({}).lean();
    console.log(`\nTotal Classes in DB: ${classes.length}`);

    const classGroups = {};
    classes.forEach(c => {
      const key = `${c.value || ''}_${c.section || ''}_${c.branch || ''}_${c.academicYear ? c.academicYear.toString() : 'null'}`;
      if (!classGroups[key]) {
        classGroups[key] = [];
      }
      classGroups[key].push(c);
    });

    console.log('\n--- Duplicate Class Groups ---');
    let duplicateGroupsFound = 0;
    for (const [key, list] of Object.entries(classGroups)) {
      if (list.length > 1) {
        duplicateGroupsFound++;
        const yearName = years.find(y => y._id.toString() === list[0].academicYear?.toString())?.name || 'Unknown Year';
        console.log(`\nKey: ${key} (Academic Year: ${yearName})`);
        list.forEach(c => {
          console.log(`  - Class ID: ${c._id}, Label: ${c.label}, Name: ${c.name}, Section: ${c.section}, Branch: ${c.branch}`);
        });
      }
    }

    if (duplicateGroupsFound === 0) {
      console.log('No duplicate classes found based on value+section+branch+academicYear.');
    }

    await mongoose.disconnect();
    console.log('\nDatabase connection closed.');
  } catch (err) {
    console.error('Error:', err);
  }
}

main();
