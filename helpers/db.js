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
  }
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

// Create models
const Job = mongoose.model('Job', jobSchema);
const UserSession = mongoose.model('UserSession', userSessionSchema);
const UserCooldown = mongoose.model('UserCooldown', userCooldownSchema);

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
    const operations = Object.entries(jobs).map(([jobId, jobData]) => ({
      updateOne: {
        filter: { jobId },
        update: { $set: jobData },
        upsert: true
      }
    }));

    if (operations.length > 0) {
      await Job.bulkWrite(operations);
      console.log(`💾 Saved ${operations.length} jobs to MongoDB`);
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
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
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

module.exports = {
  Job,
  UserSession,
  UserCooldown,
  loadJobs,
  saveJobs,
  loadUserSessions,
  saveUserSessions,
  initializeDB,
  checkAndSetUserCooldown,
  processUserCooldowns,
  getUserCooldownStatus
};
