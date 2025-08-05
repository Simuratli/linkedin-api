// Free LinkedIn Client Usage Example - No Proxies Needed!
const { initializeFreeLinkedInClient, fetchLinkedInProfile, getStats, refreshSessions } = require('../helpers/free_linkedin_client');

async function freeLinkedInExample() {
  console.log('🚀 Starting Free LinkedIn Client Example');
  
  try {
    // Initialize the client (creates 10 sessions automatically)
    const client = await initializeFreeLinkedInClient();
    
    // Example profile IDs to fetch
    const profileIds = [
      'marchyk-yuriy-446640154',
      'john-doe-123456789',
      'jane-smith-987654321',
      'alex-johnson-555666777',
      'sarah-wilson-111222333'
    ];
    
    console.log(`📊 Starting to fetch ${profileIds.length} profiles...`);
    console.log('💡 This approach uses session rotation instead of proxies!');
    
    for (let i = 0; i < profileIds.length; i++) {
      const profileId = profileIds[i];
      console.log(`\n🔍 Processing profile ${i + 1}/${profileIds.length}: ${profileId}`);
      
      try {
        const result = await fetchLinkedInProfile(profileId);
        console.log(`✅ Successfully fetched profile: ${profileId}`);
        console.log(`📋 Session used: ${result.sessionId}`);
        
        // Process the data as needed
        if (result.profileView) {
          console.log(`👤 Profile data available`);
        }
        
        if (result.contactInfo) {
          console.log(`📞 Contact info available`);
        }
        
      } catch (error) {
        console.error(`❌ Failed to fetch profile ${profileId}:`, error.message);
      }
      
      // Smart delay between profiles (1-3 minutes)
      if (i < profileIds.length - 1) {
        const delay = Math.floor(Math.random() * 120000) + 60000; // 1-3 minutes
        console.log(`⏳ Waiting ${delay/1000}s before next profile...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Get final stats
    const stats = getStats();
    console.log('\n📊 Final Statistics:');
    console.log(JSON.stringify(stats, null, 2));
    
  } catch (error) {
    console.error('❌ Client initialization failed:', error.message);
  }
}

// For large-scale processing (1000+ profiles)
async function largeScaleFreeExample() {
  console.log('🚀 Starting Large Scale Free Example');
  
  try {
    const client = await initializeFreeLinkedInClient();
    
    // Simulate large list of profile IDs
    const profileIds = []; // Add your profile IDs here
    
    // Process in small batches to avoid overwhelming
    const batchSize = 10;
    for (let i = 0; i < profileIds.length; i += batchSize) {
      const batch = profileIds.slice(i, i + batchSize);
      
      console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(profileIds.length/batchSize)}`);
      
      // Process batch sequentially (not parallel) to avoid detection
      for (let j = 0; j < batch.length; j++) {
        const profileId = batch[j];
        
        try {
          console.log(`🔍 Processing: ${profileId} (${i + j + 1}/${profileIds.length})`);
          const result = await fetchLinkedInProfile(profileId);
          console.log(`✅ Success: ${profileId}`);
          
          // Save result to file or database
          // await saveProfileData(result);
          
        } catch (error) {
          console.error(`❌ Failed: ${profileId} - ${error.message}`);
        }
        
        // Smart delay between requests (45 seconds - 2 minutes)
        if (j < batch.length - 1) {
          const delay = Math.floor(Math.random() * 75000) + 45000; // 45s - 2min
          console.log(`⏳ Waiting ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      // Longer delay between batches (5-10 minutes)
      if (i + batchSize < profileIds.length) {
        const batchDelay = Math.floor(Math.random() * 300000) + 300000; // 5-10 minutes
        console.log(`⏳ Batch complete. Waiting ${batchDelay/1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, batchDelay));
        
        // Refresh sessions every few batches
        if (i % 50 === 0) {
          console.log('🔄 Refreshing sessions...');
          await refreshSessions(5);
        }
      }
    }
    
    console.log('🎉 Large scale processing complete!');
    
  } catch (error) {
    console.error('❌ Large scale example failed:', error.message);
  }
}

// For continuous monitoring
async function continuousMonitoringExample() {
  console.log('🚀 Starting Continuous Monitoring Example');
  
  try {
    const client = await initializeFreeLinkedInClient();
    
    // List of profiles to monitor
    const profilesToMonitor = [
      'marchyk-yuriy-446640154',
      'john-doe-123456789'
    ];
    
    let cycle = 1;
    
    while (true) {
      console.log(`\n🔄 Starting monitoring cycle ${cycle}`);
      
      for (const profileId of profilesToMonitor) {
        try {
          console.log(`🔍 Checking profile: ${profileId}`);
          const result = await fetchLinkedInProfile(profileId);
          
          // Check for changes (compare with previous data)
          // await checkForChanges(profileId, result);
          
          console.log(`✅ Profile checked: ${profileId}`);
          
        } catch (error) {
          console.error(`❌ Failed to check ${profileId}:`, error.message);
        }
        
        // Wait between profiles
        const delay = Math.floor(Math.random() * 60000) + 120000; // 2-3 minutes
        console.log(`⏳ Waiting ${delay/1000}s before next profile...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // Long delay between cycles (30-60 minutes)
      const cycleDelay = Math.floor(Math.random() * 1800000) + 1800000; // 30-60 minutes
      console.log(`⏳ Cycle complete. Waiting ${cycleDelay/1000}s before next cycle...`);
      await new Promise(resolve => setTimeout(resolve, cycleDelay));
      
      cycle++;
    }
    
  } catch (error) {
    console.error('❌ Continuous monitoring failed:', error.message);
  }
}

// Export functions
module.exports = {
  freeLinkedInExample,
  largeScaleFreeExample,
  continuousMonitoringExample
};

// Run example if this file is executed directly
if (require.main === module) {
  freeLinkedInExample().catch(console.error);
} 