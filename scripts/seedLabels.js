/**
 * Seed script for Labels collection.
 *
 * Re-running this script will update the existing document and bump the version.
 */

require('dotenv').config();
const connectDB = require('../src/config/database');
const Labels = require('../src/models/Labels');
const DEFAULT_LABELS = require('../src/constants/defaultLabels');

async function seed() {
  try {
    await connectDB();
    console.log('Connected to MongoDB');

    const existing = await Labels.findOne();

    if (existing) {
      existing.labels = DEFAULT_LABELS;
      existing.version = (existing.version || 0) + 1;
      await existing.save();
      console.log(`✅ Labels updated successfully (version ${existing.version})`);
    } else {
      const labels = new Labels({
        labels: DEFAULT_LABELS,
        version: 1
      });
      await labels.save();
      console.log('✅ Labels seeded successfully (version 1)');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding labels:', error);
    process.exit(1);
  }
}

seed();
