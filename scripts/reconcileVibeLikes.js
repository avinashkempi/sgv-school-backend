/**
 * Database Reconciliation Script: Reconcile Vibe likesCount with VibeLike collection
 *
 * Usage:
 *   cd Backend && node scripts/reconcileVibeLikes.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const Vibe = require('../src/models/Vibe');
const VibeLike = require('../src/models/VibeLike');

async function reconcileVibeLikes() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/sgv-school';
  console.log('Connecting to MongoDB:', mongoUri);
  await mongoose.connect(mongoUri);

  try {
    const vibes = await Vibe.find({}).select('_id caption likesCount').lean();
    console.log(`Found ${vibes.length} total vibes to inspect.`);

    let fixedCount = 0;
    let matchedCount = 0;

    for (const vibe of vibes) {
      const trueCount = await VibeLike.countDocuments({ vibe: vibe._id });
      const currentCount = Number(vibe.likesCount) || 0;

      if (currentCount !== trueCount) {
        console.log(`[DRIFT DETECTED] Vibe ${vibe._id}: DB likesCount was ${currentCount}, true count is ${trueCount}. Correcting...`);
        await Vibe.findByIdAndUpdate(vibe._id, { $set: { likesCount: trueCount } });
        fixedCount++;
      } else {
        matchedCount++;
      }
    }

    console.log('\n--- Reconciliation Summary ---');
    console.log(`Total vibes checked: ${vibes.length}`);
    console.log(`Accurate vibes:       ${matchedCount}`);
    console.log(`Corrected vibes:      ${fixedCount}`);
    console.log('------------------------------\n');
  } catch (err) {
    console.error('Error during reconciliation:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

reconcileVibeLikes();
