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

    console.log('\n--- 4. Testing buildFeeData with Last Year Fees ---');
    const { buildFeeData } = require('../src/services/importService');
    const mockRow = {
        'Total Fees': '₹12,900',
        'Last Year Fees': '₹3,000',
        'To pay': '₹12,900', // Simulating sheet where formula wasn't modified
        'Total Paid': '₹9,000',
        'Pending': '₹3,900',  // Simulating sheet where formula wasn't modified
        'Concession': '',
        'Inst 1 Amount': '₹6,000',
        'Inst 1 Date': '02-07-2026',
        'Inst 1 Invoice': '1036',
        'Inst 2 Amount': '₹3,000',
        'Inst 2 Date': '02-09-2026',
        'Inst 2 Invoice': '1195'
    };

    const feeData = buildFeeData('mockStudentId', mockRow, null, 'mockClassId', 'Mangasuli');
    console.log('Calculated feeData:');
    console.log(' - totalFees:', feeData.totalFees, '(expected: 12900)');
    console.log(' - arrears:', feeData.arrears, '(expected: 3000)');
    console.log(' - toPay:', feeData.toPay, '(expected: 15900 = 12900 + 3000)');
    console.log(' - totalPaid:', feeData.totalPaid, '(expected: 9000)');
    console.log(' - pendingAmount:', feeData.pendingAmount, '(expected: 6900 = 15900 - 9000)');

    const passed = (
        feeData.totalFees === 12900 &&
        feeData.arrears === 3000 &&
        feeData.toPay === 15900 &&
        feeData.totalPaid === 9000 &&
        feeData.pendingAmount === 6900
    );

    if (passed) {
        console.log('\n✅ TEST PASSED: Last Year Fees correctly added to toPay and pendingAmount!');
    } else {
        console.error('\n❌ TEST FAILED: Calculations do not match expected values.');
        process.exit(1);
    }
}

test();
