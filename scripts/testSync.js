require('dotenv').config();
const { fetchSheetData, isConfigured } = require('../src/services/googleSheetsService');

const { runFeeSync } = require('../src/services/feeSyncService');

async function test() {
    console.log('--- 1. Checking Configuration ---');
    const config = isConfigured();
    console.log('Config status:', config);
    if (!config.configured) {
        console.error('Configuration failed:', config.reason);
        process.exit(1);
    }

    console.log('\n--- 2. Fetching Sheet Data ---');
    try {
        const rows = await fetchSheetData();
        console.log(`Successfully fetched ${rows.length} rows!`);
        if (rows.length > 0) {
            console.log('\nHeaders detected:', Object.keys(rows[0]));
            console.log('\nSample Row 1:');
            console.log(JSON.stringify(rows[0], null, 2));
        }
    } catch (err) {
        console.error('Error fetching sheet data:', err.message);
        if (err.errors) {
            console.error('Detailed errors:', err.errors);
        }
        process.exit(1);
    }

    console.log('\n--- 3. Testing feeSyncService (dryRun mode) ---');
    try {
        const result = await runFeeSync({ dryRun: true, trigger: 'test_script' });
        console.log('Dry run result:');
        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('Dry run error:', err.message);
    }
}

test();
