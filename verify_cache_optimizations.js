const assert = require('assert');

console.log('--- Testing File Syntaxes & Requires ---');
try {
    require('./src/controllers/dashboardController');
    console.log('✅ dashboardController loaded successfully');
    require('./src/controllers/notificationController');
    console.log('✅ notificationController loaded successfully');
    require('./src/controllers/schoolInfoController');
    console.log('✅ schoolInfoController loaded successfully');
    require('./src/routes/fees');
    console.log('✅ fees route loaded successfully');
    require('./src/routes/attendance');
    console.log('✅ attendance route loaded successfully');
    require('./src/routes/marks');
    console.log('✅ marks route loaded successfully');
    require('./src/routes/classes');
    console.log('✅ classes route loaded successfully');
    require('./src/routes/subjects');
    console.log('✅ subjects route loaded successfully');
} catch (err) {
    console.error('❌ Syntax or require error:', err);
    process.exit(1);
}

console.log('\n--- Testing Scoped Dashboard Invalidation Methods ---');
const dashboardController = require('./src/controllers/dashboardController');

assert.strictEqual(typeof dashboardController.invalidateDashboardCaches, 'function');
assert.strictEqual(typeof dashboardController.invalidateAdminDashboard, 'function');
assert.strictEqual(typeof dashboardController.invalidateTeacherDashboard, 'function');
assert.strictEqual(typeof dashboardController.invalidateStudentDashboard, 'function');
assert.strictEqual(typeof dashboardController.invalidateMultipleStudentDashboards, 'function');

async function testInvalidators() {
    // Should run safely even without Redis connected
    await dashboardController.invalidateAdminDashboard();
    await dashboardController.invalidateTeacherDashboard('t_123');
    await dashboardController.invalidateStudentDashboard('s_456');
    await dashboardController.invalidateMultipleStudentDashboards(['s_1', 's_2', 's_3']);
    await dashboardController.invalidateDashboardCaches();
    console.log('✅ All scoped dashboard invalidators execute safely and gracefully');
}

testInvalidators().then(() => {
    console.log('\n--- All Cache Optimization Verifications Passed! ---');
    process.exit(0);
}).catch(err => {
    console.error('❌ Error testing invalidators:', err);
    process.exit(1);
});
