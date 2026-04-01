const mongoose = require('mongoose');
require('dotenv').config();
const Event = require('./src/models/Event');
const connectDB = require('./src/config/database');

async function test() {
    await connectDB();
    const events = await Event.find().sort({date: -1}).limit(5);
    console.log("Recent events in DB:");
    events.forEach(e => {
        console.log(`- ${e.title} : ${e.date.toISOString()} (Local: ${e.date.toString()})`);
    });
    process.exit(0);
}

test().catch(console.error);
