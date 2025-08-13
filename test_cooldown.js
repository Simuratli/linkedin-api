// Test script for cooldown override functionality
// Usage: node test_cooldown.js <userId>

const userId = process.argv[2] || 'test_user';
const API_BASE = 'http://localhost:3000';

async function testCooldownOverride() {
    console.log(`🧪 Testing cooldown override for user: ${userId}\n`);
    
    try {
        // 1. Check current user data
        console.log('📊 1. Getting current user data...');
        const userData = await fetch(`${API_BASE}/admin/user-data/${userId}`);
        const userDataResult = await userData.json();
        console.log('User data:', JSON.stringify(userDataResult, null, 2));
        console.log('');
        
        // 2. Check if can override cooldown
        console.log('🔍 2. Checking if cooldown can be overridden...');
        const canOverride = await fetch(`${API_BASE}/can-override-cooldown/${userId}`);
        const canOverrideResult = await canOverride.json();
        console.log('Can override result:', JSON.stringify(canOverrideResult, null, 2));
        console.log('');
        
        // 3. Try to override cooldown if possible
        if (canOverrideResult.success && canOverrideResult.canOverride) {
            console.log('🔓 3. Attempting to override cooldown...');
            const override = await fetch(`${API_BASE}/override-cooldown/${userId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    reason: 'Test override from debug script',
                    forceOverride: false
                })
            });
            const overrideResult = await override.json();
            console.log('Override result:', JSON.stringify(overrideResult, null, 2));
            console.log('');
            
            // 4. Verify the override worked
            console.log('✅ 4. Verifying override...');
            const verifyData = await fetch(`${API_BASE}/admin/user-data/${userId}`);
            const verifyResult = await verifyData.json();
            console.log('Verification data:', JSON.stringify(verifyResult, null, 2));
            
            if (verifyResult.success && verifyResult.cooldownInfo.overridden) {
                console.log('\n🎉 SUCCESS: Cooldown override working correctly!');
            } else {
                console.log('\n❌ FAILED: Cooldown override not persisted');
            }
        } else {
            console.log('⚠️ Cannot override cooldown (no completed jobs or already overridden)');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

// Helper function for fetch in Node.js
if (typeof fetch === 'undefined') {
    global.fetch = require('node-fetch');
}

testCooldownOverride();
