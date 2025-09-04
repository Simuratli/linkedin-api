/**
 * Migration Script: Convert existing MongoDB jobs from userId-centric to CRM-centric structure
 * 
 * This script will:
 * 1. Find all jobs in MongoDB that have userId but no originalCreator
 * 2. Convert userId to originalCreator  
 * 3. Add crmUrl field from user sessions if available
 * 4. Initialize participants array with original creator
 * 5. Keep userId for backward compatibility
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/linkedin-api';

// Import the schemas
const { Job, UserSession } = require('./helpers/db');

async function migrateToCrmCentric() {
  try {
    console.log('🚀 Starting migration to CRM-centric job structure...');
    
    // Connect to MongoDB using mongoose
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    // Get all user sessions to map userId to crmUrl
    const sessions = await UserSession.find({}).lean();
    const userCrmMap = {};
    
    sessions.forEach(session => {
      if (session.userId && session.crmUrl) {
        // Normalize CRM URL (same logic as in the main app)
        const normalizedCrmUrl = session.crmUrl
          .replace(/https?:\/\//, '')
          .replace(/\/$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9.-]/g, '_');
        
        userCrmMap[session.userId] = {
          originalCrmUrl: session.crmUrl,
          normalizedCrmUrl: normalizedCrmUrl
        };
      }
    });
    
    console.log(`📊 Found ${Object.keys(userCrmMap).length} user-CRM mappings`);
    
    // Find all jobs that need migration (have userId but no originalCreator)
    const jobsToMigrate = await Job.find({
      userId: { $exists: true },
      originalCreator: { $exists: false }
    }).lean();
    
    console.log(`🔍 Found ${jobsToMigrate.length} jobs to migrate`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    
    for (const job of jobsToMigrate) {
      try {
        const userId = job.userId;
        const userCrm = userCrmMap[userId];
        
        const updateFields = {
          originalCreator: userId,
          participants: job.participants || [userId],
          // Keep userId for backward compatibility
          userId: userId
        };
        
        // Add CRM URL if we found it in user sessions
        if (userCrm) {
          updateFields.crmUrl = userCrm.normalizedCrmUrl;
          console.log(`🔗 Job ${job.jobId}: Adding CRM URL ${userCrm.normalizedCrmUrl} for user ${userId}`);
        } else {
          console.log(`⚠️  Job ${job.jobId}: No CRM URL found for user ${userId}`);
        }
        
        // Update the job using mongoose
        const result = await Job.updateOne(
          { _id: job._id },
          { $set: updateFields }
        );
        
        if (result.modifiedCount === 1) {
          migratedCount++;
          console.log(`✅ Migrated job ${job.jobId} (${job.status}, ${job.processedCount}/${job.totalContacts})`);
        } else {
          skippedCount++;
          console.log(`⏭️  Skipped job ${job.jobId} (no changes needed)`);
        }
        
      } catch (error) {
        console.error(`❌ Error migrating job ${job.jobId}:`, error.message);
        skippedCount++;
      }
    }
    
    console.log('\n🎉 Migration completed!');
    console.log(`✅ Migrated: ${migratedCount} jobs`);
    console.log(`⏭️  Skipped: ${skippedCount} jobs`);
    console.log(`📊 Total processed: ${jobsToMigrate.length} jobs`);
    
    // Verify migration
    const verifyCount = await Job.countDocuments({
      originalCreator: { $exists: true },
      participants: { $exists: true }
    });
    
    console.log(`\n🔍 Verification: ${verifyCount} jobs now have CRM-centric structure`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  migrateToCrmCentric()
    .then(() => {
      console.log('✅ Migration script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateToCrmCentric };
