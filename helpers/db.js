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
  completedAt: Date,
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

// Create models
const Job = mongoose.model('Job', jobSchema);
const UserSession = mongoose.model('UserSession', userSessionSchema);

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

module.exports = {
  Job,
  UserSession,
  loadJobs,
  saveJobs,
  loadUserSessions,
  saveUserSessions,
  initializeDB
};
