// Example usage of Advanced LinkedIn Client
const { createLinkedInClient } = require('../helpers/advanced_linkedin');

async function exampleUsage() {
  console.log('🚀 Starting Advanced LinkedIn Client Example');
  
  // Create client with session rotation strategy (no residential proxy needed)
  const client = createLinkedInClient('session_rotation');
  
  try {
    // Initialize the client
    await client.initialize();
    
    // Example profile IDs to fetch
    const profileIds = [
      'marchyk-yuriy-446640154',
      'john-doe-123456789',
      'jane-smith-987654321'
    ];
    
    console.log(`📊 Starting to fetch ${profileIds.length} profiles...`);
    
    for (let i = 0; i < profileIds.length; i++) {
      const profileId = profileIds[i];
      console.log(`\n🔍 Processing profile ${i + 1}/${profileIds.length}: ${profileId}`);
      
      try {
        const result = await client.fetchLinkedInProfile(profileId);
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
      
      // Add delay between profiles
      if (i < profileIds.length - 1) {
        const delay = Math.floor(Math.random() * 30000) + 60000; // 1-1.5 minutes
        console.log(`⏳ Waiting ${delay/1000}s before next profile...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Get final stats
    const stats = client.getStats();
    console.log('\n📊 Final Statistics:');
    console.log(JSON.stringify(stats, null, 2));
    
  } catch (error) {
    console.error('❌ Client initialization failed:', error.message);
  }
}

// For residential proxy usage (requires paid service)
async function residentialProxyExample() {
  console.log('🚀 Starting Residential Proxy Example');
  
  // Set environment variables for residential proxy
  process.env.BRIGHTDATA_USERNAME = 'your_username';
  process.env.BRIGHTDATA_PASSWORD = 'your_password';
  
  // Create client with residential proxy strategy
  const client = createLinkedInClient('residential_proxy');
  
  try {
    await client.initialize();
    
    // This will use residential proxies for better success rate
    const result = await client.fetchLinkedInProfile('example-profile-id');
    console.log('✅ Profile fetched with residential proxy');
    
  } catch (error) {
    console.error('❌ Residential proxy example failed:', error.message);
  }
}

// For large-scale scraping (10,000+ requests)
async function largeScaleExample() {
  console.log('🚀 Starting Large Scale Example');
  
  const client = createLinkedInClient('aggressive');
  
  try {
    await client.initialize();
    
    // Create a queue of profile IDs
    const profileIds = []; // Add your 10,000 profile IDs here
    
    // Process in batches
    const batchSize = 50;
    for (let i = 0; i < profileIds.length; i += batchSize) {
      const batch = profileIds.slice(i, i + batchSize);
      
      console.log(`📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(profileIds.length/batchSize)}`);
      
      // Process batch with limited concurrency
      const promises = batch.map(async (profileId, index) => {
        // Add staggered delays
        await new Promise(resolve => setTimeout(resolve, index * 2000));
        return client.fetchLinkedInProfile(profileId);
      });
      
      const results = await Promise.allSettled(promises);
      
      // Log results
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      
      console.log(`✅ Batch completed: ${successful} successful, ${failed} failed`);
      
      // Refresh sessions periodically
      if (i % 200 === 0) {
        await client.refreshSessions();
      }
      
      // Long delay between batches
      if (i + batchSize < profileIds.length) {
        const delay = 300000; // 5 minutes
        console.log(`⏳ Waiting ${delay/1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
  } catch (error) {
    console.error('❌ Large scale example failed:', error.message);
  }
}

// Export functions for use
module.exports = {
  exampleUsage,
  residentialProxyExample,
  largeScaleExample
};

// Run example if this file is executed directly
if (require.main === module) {
  exampleUsage().catch(console.error);
} 