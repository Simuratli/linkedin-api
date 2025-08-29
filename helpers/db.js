const mongoose = require('mongoose');

// MongoDB Job Schema
const jobSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  status: { 
    type: String, 
    required: true,
    enum: ['pending', 'processing', 'paused', 'completed', 'failed']
  },
  createdAt: { type: Date, default: Date.now },
  contacts: [{
    contactId: { type: String, required: true },
    linkedinUrl: { type: String, required: true },
    status: { 
      type: String, 
      required: true,
      enum: ['pending', 'processing', 'completed', 'failed']
    },
    error: String
  }],
  processedCount: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },
  totalContacts: { type: Number, required: true },
  currentBatchIndex: { type: Number, default: 0 },
  startTime: { type: Date, default: Date.now },
  lastProcessedTime: Date,
  lastProcessedAt: Date, // For frontend consistency
  completedAt: Date,
  failedAt: Date,
  errors: [{
    contactId: String,
    error: String,
    timestamp: { type: Date, default: Date.now },
    humanPattern: String
  }],
  humanPatterns: {
    startPattern: String,
    startTime: { type: Date, default: Date.now },
    patternHistory: [{
      pattern: String,
      startTime: Date,
      endTime: Date,
      profilesProcessed: Number
    }]
  },
  dailyStats: {
    startDate: String,
    processedToday: { type: Number, default: 0 },
    patternBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  // Cooldown override fields
  cooldownOverridden: { type: Boolean, default: false },
  overriddenAt: { type: Date },
  overrideReason: { type: String },
  daysSinceCompletionAtOverride: { type: Number }
}, { suppressReservedKeysWarning: true });

// MongoDB User Session Schema
const userSessionSchema = new mongoose.Schema({
  userId: String,
  currentJobId: String,
  li_at: String,
  jsessionid: String,
  accessToken: String,
  refreshToken: String,
  clientId: String,
  tenantId: String,
  verifier: String,
  crmUrl: String,
  lastActivity: Date
});

// MongoDB User Cooldown Schema
const userCooldownSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  allJobsCompleted: { type: Boolean, default: false },
  completedAt: { type: Date },
  cooldownPeriod: { type: Number, default: 30 }, // days
  cooldownEndDate: { type: Date },
  jobsRestarted: { type: Boolean, default: false }
});

// MongoDB Daily Stats Schema
const dailyStatsSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  dateKey: { type: String, required: true }, // YYYY-MM-DD format
  hourKey: String, // YYYY-MM-DD-HH format
  patternKey: String, // YYYY-MM-DD-patternName format
  count: { type: Number, default: 1 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  // Compound index for efficient queries
  indexes: [
    { userId: 1, dateKey: 1 },
    { userId: 1, hourKey: 1 },
    { userId: 1, patternKey: 1 }
  ]
});

// Create models
const Job = mongoose.model('Job', jobSchema);
const UserSession = mongoose.model('UserSession', userSessionSchema);
const UserCooldown = mongoose.model('UserCooldown', userCooldownSchema);
const DailyStats = mongoose.model('DailyStats', dailyStatsSchema);

// Direct Sessions Schema
const directSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  sessionData: { type: Object, required: true },
  userId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  isActive: { type: Boolean, default: true },
  metadata: {
    userAgent: String,
    ipAddress: String,
    requestCount: { type: Number, default: 0 },
    lastUsed: { type: Date, default: Date.now }
  }
});

// Direct Sessions Stats Schema
const directSessionStatsSchema = new mongoose.Schema({
  totalRequests: { type: Number, default: 0 },
  successfulRequests: { type: Number, default: 0 },
  failedRequests: { type: Number, default: 0 },
  sessionsCreated: { type: Number, default: 0 },
  sessionsExpired: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  lastUpdate: { type: Date, default: Date.now }
});

const DirectSession = mongoose.model('DirectSession', directSessionSchema);
const DirectSessionStats = mongoose.model('DirectSessionStats', directSessionStatsSchema);

// Load jobs from MongoDB
const loadJobs = async () => {
  try {
    const jobs = await Job.find({});
    const jobsMap = {};
    
    jobs.forEach(job => {
      jobsMap[job.jobId] = job.toObject();
    });
    
    console.log(`📖 Loaded ${Object.keys(jobsMap).length} jobs from MongoDB`);
    return jobsMap;
  } catch (error) {
    console.error("❌ Error loading jobs from MongoDB:", error?.message);
    return {};
  }
};

// Save jobs to MongoDB
const saveJobs = async (jobs) => {
  try {
    // Filter out completed jobs to prevent unnecessary saves
    const jobsToSave = {};
    let skippedCompleted = 0;
    
    for (const [jobId, jobData] of Object.entries(jobs)) {
      if (jobData.status === "completed") {
        console.log(`⏭️ Skipping save for completed job ${jobId}`);
        skippedCompleted++;
      } else {
        jobsToSave[jobId] = jobData;
      }
    }
    
    const operations = Object.entries(jobsToSave).map(([jobId, jobData]) => ({
      updateOne: {
        filter: { jobId },
        update: { $set: jobData },
        upsert: true
      }
    }));

    if (operations.length > 0) {
      await Job.bulkWrite(operations);
      console.log(`💾 Saved ${operations.length} jobs to MongoDB${skippedCompleted > 0 ? ` (${skippedCompleted} completed jobs skipped)` : ''}`);
    } else if (skippedCompleted > 0) {
      console.log(`⏭️ All ${skippedCompleted} jobs were completed - no save needed`);
    }
  } catch (error) {
    console.error("❌ Error saving jobs to MongoDB:", error?.message);
    throw error;
  }
};

// Load user sessions from MongoDB
const loadUserSessions = async () => {
  try {
    const sessions = await UserSession.find({});
    const sessionsMap = {};
    
    sessions.forEach(session => {
      sessionsMap[session.userId] = session.toObject();
    });
    
    console.log(`📖 Loaded ${Object.keys(sessionsMap).length} user sessions from MongoDB`);
    return sessionsMap;
  } catch (error) {
    console.error("❌ Error loading user sessions from MongoDB:", error?.message);
    return {};
  }
};

// Save user sessions to MongoDB
const saveUserSessions = async (sessions) => {
  try {
    const operations = Object.entries(sessions).map(([userId, sessionData]) => ({
      updateOne: {
        filter: { userId },
        update: { $set: sessionData },
        upsert: true
      }
    }));

    if (operations.length > 0) {
      await UserSession.bulkWrite(operations);
      console.log(`💾 Saved ${operations.length} user sessions to MongoDB`);
    }
  } catch (error) {
    console.error("❌ Error saving user sessions to MongoDB:", error?.message);
    throw error;
  }
};

// Initialize MongoDB connection
const initializeDB = async () => {
  try {
    // Remove deprecated options
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    // Migrate direct sessions data if needed
    await migrateDirectSessionsData();
    
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Migrate direct sessions from file to MongoDB
const migrateDirectSessionsData = async () => {
  const fs = require('fs/promises');
  const path = require('path');
  
  try {
    const directSessionsPath = path.join(process.cwd(), 'data', 'direct_sessions.json');
    
    // Check if file exists
    try {
      await fs.access(directSessionsPath);
    } catch {
      console.log('📄 No direct_sessions.json file found, skipping migration');
      return;
    }

    // Check if already migrated (if MongoDB has sessions)
    const existingSessions = await DirectSession.countDocuments();
    if (existingSessions > 0) {
      console.log('✅ Direct sessions already migrated to MongoDB');
      return;
    }

    // Read file data
    const fileContent = await fs.readFile(directSessionsPath, 'utf8');
    const directSessionsData = JSON.parse(fileContent);

    console.log('🔄 Migrating direct sessions from file to MongoDB...');
    
    // Save to MongoDB
    await saveDirectSessions(directSessionsData);
    
    console.log('✅ Direct sessions migration completed');
    
    // Optionally backup and remove the file
    const backupPath = `${directSessionsPath}.backup`;
    await fs.copyFile(directSessionsPath, backupPath);
    console.log(`📁 Original file backed up to ${backupPath}`);
    
  } catch (error) {
    console.error('❌ Error migrating direct sessions:', error.message);
    // Don't fail initialization if migration fails
  }
};

// Check if all jobs for a user are completed and set cooldown if needed
const checkAndSetUserCooldown = async (userId) => {
  try {
    // Get all jobs for this user
    const userJobs = await Job.find({ userId });
    
    // Check if there are any jobs and if all are completed
    const allCompleted = userJobs.length > 0 && 
      userJobs.every(job => job.status === 'completed');
    
    if (allCompleted) {
      const now = new Date();
      // Calculate cooldown end date (30 days from now by default)
      const cooldownEnd = new Date();
      cooldownEnd.setDate(cooldownEnd.getDate() + 30); // Default 30 days cooldown
      
      // Update or create cooldown record
      await UserCooldown.updateOne(
        { userId },
        { 
          userId,
          allJobsCompleted: true,
          completedAt: now,
          cooldownEndDate: cooldownEnd,
          jobsRestarted: false
        },
        { upsert: true }
      );
      
      console.log(`✅ All jobs completed for user ${userId}. Cooldown until: ${cooldownEnd.toISOString()}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`❌ Error checking user job status: ${error.message}`);
    return false;
  }
};

// Check for users whose cooldown period has ended and restart their jobs
const processUserCooldowns = async () => {
  try {
    const now = new Date();
    
    // Find users whose cooldown period has ended but jobs haven't been restarted
    const readyUsers = await UserCooldown.find({
      allJobsCompleted: true,
      cooldownEndDate: { $lte: now },
      jobsRestarted: false
    });
    
    for (const user of readyUsers) {
      console.log(`🔄 Cooldown complete for user ${user.userId}. Restarting jobs...`);
      
      // Reset user's jobs to pending
      await Job.updateMany(
        { userId: user.userId },
        { 
          $set: { 
            status: 'pending',
            processedCount: 0,
            successCount: 0,
            failureCount: 0,
            currentBatchIndex: 0,
            startTime: now,
            lastProcessedTime: null,
            completedAt: null,
            'contacts.$[].status': 'pending',
            'contacts.$[].error': null
          }
        }
      );
      
      // Update the cooldown record
      user.allJobsCompleted = false;
      user.jobsRestarted = true;
      await user.save();
      
      console.log(`✅ Successfully restarted jobs for user ${user.userId}`);
    }
    
    return readyUsers.length;
  } catch (error) {
    console.error(`❌ Error processing user cooldowns: ${error.message}`);
    return 0;
  }
};

// Get cooldown status for a user
const getUserCooldownStatus = async (userId) => {
  try {
    const cooldown = await UserCooldown.findOne({ userId });
    if (!cooldown) {
      return null;
    }
    
    return {
      userId: cooldown.userId,
      allJobsCompleted: cooldown.allJobsCompleted,
      completedAt: cooldown.completedAt,
      cooldownPeriod: cooldown.cooldownPeriod,
      cooldownEndDate: cooldown.cooldownEndDate,
      jobsRestarted: cooldown.jobsRestarted,
      // Calculate days remaining in cooldown
      daysRemaining: cooldown.allJobsCompleted && !cooldown.jobsRestarted ? 
        Math.max(0, Math.ceil((cooldown.cooldownEndDate - new Date()) / (1000 * 60 * 60 * 24))) : 0
    };
  } catch (error) {
    console.error(`❌ Error getting user cooldown status: ${error.message}`);
    return null;
  }
};

// Load daily stats from MongoDB (converts to old format for compatibility)
const loadDailyStats = async () => {
  try {
    const stats = await DailyStats.find({});
    const statsMap = {};
    
    // Convert MongoDB format to old file format for compatibility
    stats.forEach(stat => {
      if (!statsMap[stat.userId]) {
        statsMap[stat.userId] = {};
      }
      
      // Add date-based stats
      if (stat.dateKey) {
        statsMap[stat.userId][stat.dateKey] = (statsMap[stat.userId][stat.dateKey] || 0) + stat.count;
      }
      
      // Add hour-based stats  
      if (stat.hourKey) {
        statsMap[stat.userId][stat.hourKey] = (statsMap[stat.userId][stat.hourKey] || 0) + stat.count;
      }
      
      // Add pattern-based stats
      if (stat.patternKey) {
        statsMap[stat.userId][stat.patternKey] = (statsMap[stat.userId][stat.patternKey] || 0) + stat.count;
      }
    });
    
    console.log(`📊 Loaded daily stats for ${Object.keys(statsMap).length} users from MongoDB`);
    return statsMap;
  } catch (error) {
    console.error("❌ Error loading daily stats from MongoDB:", error?.message);
    return {};
  }
};

// Save daily stats to MongoDB (legacy file format no longer used)
const saveDailyStats = async (stats) => {
  try {
    // This function is kept for compatibility but doesn't do anything
    // Stats are now saved directly via updateDailyStats
    console.log(`✅ Daily stats structure maintained in MongoDB (legacy call)`);
  } catch (error) {
    console.error("❌ Error in legacy saveDailyStats:", error?.message);
  }
};

// Update daily stats directly in MongoDB
const updateDailyStats = async (userId, dateKey, hourKey, patternKey) => {
  try {
    const now = new Date();
    const operations = [];
    
    // Update daily count
    if (dateKey) {
      operations.push({
        updateOne: {
          filter: { userId, dateKey },
          update: { 
            $inc: { count: 1 },
            $set: { updatedAt: now },
            $setOnInsert: { userId, dateKey, createdAt: now }
          },
          upsert: true
        }
      });
    }
    
    // Update hourly count
    if (hourKey) {
      operations.push({
        updateOne: {
          filter: { userId, hourKey },
          update: { 
            $inc: { count: 1 },
            $set: { updatedAt: now },
            $setOnInsert: { userId, hourKey, createdAt: now }
          },
          upsert: true
        }
      });
    }
    
    // Update pattern count
    if (patternKey) {
      operations.push({
        updateOne: {
          filter: { userId, patternKey },
          update: { 
            $inc: { count: 1 },
            $set: { updatedAt: now },
            $setOnInsert: { userId, patternKey, createdAt: now }
          },
          upsert: true
        }
      });
    }
    
    if (operations.length > 0) {
      await DailyStats.bulkWrite(operations);
      console.log(`📊 Updated daily stats for user ${userId}`);
    }
  } catch (error) {
    console.error("❌ Error updating daily stats:", error?.message);
  }
};

// Clean old daily stats (older than 7 days) - DISABLED
const cleanOldDailyStats = async () => {
  try {
    // Disabled - keeping all daily stats permanently
    console.log(`📊 Daily stats cleaning disabled - keeping all historical data`);
    return 0;
    
    // Old code commented out:
    // const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // const result = await DailyStats.deleteMany({
    //   createdAt: { $lt: sevenDaysAgo }
    // });
    // if (result.deletedCount > 0) {
    //   console.log(`🧹 Cleaned ${result.deletedCount} old daily stats records`);
    // }
    // return result.deletedCount;
  } catch (error) {
    console.error("❌ Error in cleanOldDailyStats:", error?.message);
    return 0;
  }
};

// Direct Sessions MongoDB fonksiyonları
const loadDirectSessions = async () => {
  try {
    const sessions = await DirectSession.find({ isActive: true });
    const stats = await DirectSessionStats.findOne() || {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      sessionsCreated: 0,
      sessionsExpired: 0,
      lastError: null,
      lastUpdate: new Date()
    };

    return {
      sessions: sessions.map(session => ({
        sessionId: session.sessionId,
        sessionData: session.sessionData,
        userId: session.userId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        metadata: session.metadata
      })),
      stats: {
        totalRequests: stats.totalRequests,
        successfulRequests: stats.successfulRequests,
        failedRequests: stats.failedRequests,
        sessionsCreated: stats.sessionsCreated,
        sessionsExpired: stats.sessionsExpired,
        lastError: stats.lastError,
        lastUpdate: stats.lastUpdate
      }
    };
  } catch (error) {
    console.error('❌ Error loading direct sessions from MongoDB:', error.message);
    // Fallback to empty structure
    return {
      sessions: [],
      stats: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        sessionsCreated: 0,
        sessionsExpired: 0,
        lastError: null,
        lastUpdate: new Date()
      }
    };
  }
};

const saveDirectSessions = async (directSessionsData) => {
  try {
    const { sessions, stats } = directSessionsData;

    // Clear existing sessions
    await DirectSession.deleteMany({});

    // Save new sessions
    if (sessions && sessions.length > 0) {
      await DirectSession.insertMany(sessions.map(session => ({
        sessionId: session.sessionId,
        sessionData: session.sessionData,
        userId: session.userId,
        createdAt: session.createdAt || new Date(),
        expiresAt: session.expiresAt,
        isActive: true,
        metadata: session.metadata || {}
      })));
    }

    // Update stats
    await DirectSessionStats.updateOne(
      {},
      {
        totalRequests: stats.totalRequests || 0,
        successfulRequests: stats.successfulRequests || 0,
        failedRequests: stats.failedRequests || 0,
        sessionsCreated: stats.sessionsCreated || 0,
        sessionsExpired: stats.sessionsExpired || 0,
        lastError: stats.lastError,
        lastUpdate: new Date()
      },
      { upsert: true }
    );

    console.log(`✅ Saved ${sessions ? sessions.length : 0} direct sessions to MongoDB`);
  } catch (error) {
    console.error('❌ Error saving direct sessions to MongoDB:', error.message);
    throw error;
  }
};

const updateDirectSessionStats = async (statUpdate) => {
  try {
    await DirectSessionStats.updateOne(
      {},
      {
        $inc: statUpdate,
        lastUpdate: new Date()
      },
      { upsert: true }
    );
    console.log('✅ Updated direct session stats in MongoDB');
  } catch (error) {
    console.error('❌ Error updating direct session stats:', error.message);
    throw error;
  }
};

const cleanExpiredDirectSessions = async () => {
  try {
    const now = new Date();
    const result = await DirectSession.deleteMany({
      $or: [
        { expiresAt: { $lt: now } },
        { isActive: false }
      ]
    });

    if (result.deletedCount > 0) {
      console.log(`🧹 Cleaned ${result.deletedCount} expired direct sessions from MongoDB`);
      
      // Update stats
      await updateDirectSessionStats({ sessionsExpired: result.deletedCount });
    }

    return result.deletedCount;
  } catch (error) {
    console.error('❌ Error cleaning expired direct sessions:', error.message);
    return 0;
  }
};

module.exports = {
  Job,
  UserSession,
  UserCooldown,
  DailyStats,
  DirectSession,
  DirectSessionStats,
  loadJobs,
  saveJobs,
  loadUserSessions,
  saveUserSessions,
  initializeDB,
  checkAndSetUserCooldown,
  processUserCooldowns,
  getUserCooldownStatus,
  loadDailyStats,
  saveDailyStats,
  updateDailyStats,
  cleanOldDailyStats,
  loadDirectSessions,
  saveDirectSessions,
  updateDirectSessionStats,
  cleanExpiredDirectSessions
};
