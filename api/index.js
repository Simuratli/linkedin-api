const express = require("express");
const { v4: uuidv4 } = require('uuid');
try {
  require('dotenv').config();
} catch (e) {
  console.log('dotenv not available, checking environment variables');
}
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");
const fetch = require("node-fetch");
const mongoose = require("mongoose");
const {
  loadJobs, 
  saveJobs, 
  loadUserSessions, 
  saveUserSessions,
  initializeDB,
  Job,
  UserSession,
  DailyStats,
  loadDailyStats,
  saveDailyStats,
  updateDailyStats,
  cleanOldDailyStats,
  getUserCooldownStatus,
  resetUserStats
} = require("../helpers/db");
const { transformToCreateUserRequest } = require("../helpers/transform");
const {
  fetchLinkedInProfile,
  getCurrentHumanPattern,
  isDuringPause,
  HUMAN_PATTERNS,
} = require("../helpers/linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep, chunkArray, getRandomDelay } = require("../helpers/delay");
const { synchronizeJobWithDailyStats } = require("../helpers/syncJobStats");

// Track running background processes to prevent duplicates
const runningProcesses = new Map();

// Professional logging system for debugging background processing
const createProcessingLogger = (jobId) => {
  const logContext = `[JOB:${jobId.slice(-8)}]`;
  return {
    info: (step, data = {}) => console.log(`ℹ️ ${logContext} ${step}:`, data),
    debug: (step, data = {}) => console.log(`🔍 ${logContext} ${step}:`, data),
    warn: (step, data = {}) => console.log(`⚠️ ${logContext} ${step}:`, data),
    error: (step, data = {}) => console.log(`❌ ${logContext} ${step}:`, data),
    checkpoint: (step, extra = '') => console.log(`📍 ${logContext} CHECKPOINT: ${step} ${extra}`),
    contact: (contactIndex, batchIndex, step, data = {}) => 
      console.log(`👤 ${logContext} [B${batchIndex}C${contactIndex}] ${step}:`, data)
  };
};

// Job state tracking for debugging
const updateJobState = async (jobId, state, details = {}) => {
  try {
    const jobs = await loadJobs();
    const job = jobs[jobId];
    if (job) {
      job.debugState = {
        currentState: state,
        timestamp: new Date().toISOString(),
        details,
        ...job.debugState
      };
      job.lastDebugUpdate = new Date().toISOString();
      jobs[jobId] = job;
      await saveJobs(jobs);
    }
  } catch (error) {
    console.log(`Debug state update failed for ${jobId}:`, error.message);
  }
};

// Add this helper function at the top of your file
const checkJobStatusAndExit = async (jobId, checkPoint = "", initialCancelToken = null) => {
  const latestJobs = await loadJobs();
  const latestJob = latestJobs[jobId];
  
  if (!latestJob) {
    console.log(`🛑 Job ${jobId} not found during ${checkPoint}. Exiting.`);
    return true; // Should exit
  }
  
  if (["completed", "cancelled", "failed"].includes(latestJob.status)) {
    console.log(`🛑 Job ${jobId} is ${latestJob.status} during ${checkPoint}. Exiting background processing.`);
    return true; // Should exit
  }
  
  // Check for cancel token change (indicates cancellation request)
  if (initialCancelToken !== null && latestJob.cancelToken && latestJob.cancelToken !== initialCancelToken) {
    console.log(`🛑 Job ${jobId} cancel token changed during ${checkPoint} (${initialCancelToken} -> ${latestJob.cancelToken}). Exiting background processing.`);
    return true; // Should exit
  }
  
  return false; // Can continue
};
// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// ENHANCED DAILY LIMIT CONFIGURATION WITH HUMAN PATTERNS
const DAILY_PROFILE_LIMIT = 180; // Conservative daily limit
const BURST_LIMIT = 20; // Max profiles in one hour (increased from 11 to 20)
const HOUR_IN_MS = 60 * 60 * 1000;

// CRM URL normalization for shared processing
const normalizeCrmUrl = (crmUrl) => {
  if (!crmUrl) return 'unknown_crm';
  try {
    const url = new URL(crmUrl);
    return url.hostname.toLowerCase().replace(/\./g, '_'); // Convert dots to underscores for MongoDB keys
  } catch (error) {
    return crmUrl.toLowerCase().replace(/[^a-z0-9]/g, '_');
  }
};

const debugJobState = (job, context) => {
  console.log(`🔍 DEBUG ${context} for job ${job.jobId}:`);
  console.log(`  Status: ${job.status}`);
  console.log(`  Total contacts: ${job.totalContacts}`);
  console.log(`  Contacts array length: ${job.contacts ? job.contacts.length : 'undefined'}`);
  
  if (job.contacts) {
    const statusCounts = job.contacts.reduce((acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1;
      return acc;
    }, {});
    console.log(`  Contact status breakdown:`, statusCounts);
    
    // Log first few pending contacts
    const pending = job.contacts.filter(c => c.status === "pending");
    console.log(`  First 3 pending contacts:`, pending.slice(0, 3).map(c => ({
      id: c.contactId,
      url: c.linkedinUrl,
      status: c.status
    })));
  }
};

// Ensure data directory exists (keep for backwards compatibility)
const ensureDataDir = async () => {
  try {
    console.log("� Data directory no longer needed - using MongoDB for all storage");
  } catch (error) {
    console.error("❌ Error in ensureDataDir:", error.stack || error);
  }
};

const getTodayKey = () => {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
};

const getHourKey = () => {
  const now = new Date();
  return `${now.toISOString().split("T")[0]}-${now.getHours()}`; // YYYY-MM-DD-HH
};

const getPatternKey = () => {
  const now = new Date();
  const currentPattern = getCurrentHumanPattern();
  return `${getTodayKey()}-${currentPattern.name}`; // YYYY-MM-DD-patternName
};

// Enhanced limit checking with CRM-based sharing
const checkDailyLimit = async (userId, crmUrl) => {
  const stats = await loadDailyStats();
  
  console.log(`🔍 checkDailyLimit called with userId: ${userId}, crmUrl: ${crmUrl}`);
  
  // Get current time-based keys
  const today = new Date().toISOString().split("T")[0];
  const hour = `${today}-${new Date().getHours()}`;
  const currentPattern = getCurrentHumanPattern();
  const pattern = `${today}-${currentPattern.name}`;
  
  console.log(`🔍 Looking for keys: today=${today}, hour=${hour}, pattern=${pattern}`);
  
  let todayCount = 0;
  let hourCount = 0;
  let patternCount = 0;
  
  // Determine which key to use for stats lookup
  let statsKey = userId;
  if (crmUrl) {
    statsKey = normalizeCrmUrl(crmUrl);
    console.log(`🔍 Using CRM-based key: ${statsKey}`);
  }
  
  // Load stats using the appropriate key
  if (stats[statsKey]) {
    todayCount = stats[statsKey][today] || 0;
    hourCount = stats[statsKey][hour] || 0;
    patternCount = stats[statsKey][pattern] || 0;
    console.log(`📊 Stats found for ${statsKey}:`, { todayCount, hourCount, patternCount });
    console.log(`📊 All stats for ${statsKey}:`, stats[statsKey]);
  } else {
    console.log(`⚠️ No stats found for key: ${statsKey}`);
    
    // If using CRM key failed, try user-specific as fallback
    if (crmUrl && stats[userId]) {
      todayCount = stats[userId][today] || 0;
      hourCount = stats[userId][hour] || 0;
      patternCount = stats[userId][pattern] || 0;
      console.log(`📊 Fallback to user ${userId} stats:`, { todayCount, hourCount, patternCount });
    }
  }
  
  // Check if in pause period
  const inPause = isDuringPause();

  // Get pattern-specific limit
  const patternLimit = currentPattern.maxProfiles || 0;

  // Determine if can process based on limits
  const canProcess =
    !inPause &&
    todayCount < DAILY_PROFILE_LIMIT &&
    hourCount < BURST_LIMIT &&
    (patternLimit === 0 || patternCount < patternLimit);

  console.log(`📊 Final limits for ${userId}:`, {
    today: `${todayCount}/${DAILY_PROFILE_LIMIT}`,
    hour: `${hourCount}/${BURST_LIMIT}`,
    pattern: `${patternCount}/${patternLimit || '∞'}`,
    canProcess,
    statsKey
  });

  return {
    canProcess,
    dailyCount: todayCount,
    hourlyCount: hourCount,
    patternCount,
    dailyLimit: DAILY_PROFILE_LIMIT,
    hourlyLimit: BURST_LIMIT,
    patternLimit,
    currentPattern: currentPattern.name,
    inPause,
    nextActivePattern: getNextActivePattern(),
    estimatedResumeTime: getEstimatedResumeTime(),
    crmUrl: crmUrl ? normalizeCrmUrl(crmUrl) : userId,
    sharedLimits: crmUrl ? `Shared with all users of ${normalizeCrmUrl(crmUrl)}` : `User-specific limits`
  };
};

const getNextActivePattern = () => {
  const now = new Date();
  const currentHour = now.getHours();

  // Check all patterns to find the next active one
  const activePatterns = Object.entries(HUMAN_PATTERNS)
    .filter(([name, pattern]) => !pattern.pause)
    .sort((a, b) => a[1].hourStart - b[1].hourStart);

  for (const [name, pattern] of activePatterns) {
    if (pattern.hourStart > currentHour) {
      return { name, ...pattern };
    }
  }

  // If no pattern found today, return first pattern tomorrow
  return {
    name: "morningBurst",
    ...HUMAN_PATTERNS.morningBurst,
    tomorrow: true,
  };
};

// Estimate when processing will resume
const getEstimatedResumeTime = () => {
  const currentPattern = getCurrentHumanPattern();

  if (!currentPattern.pause) {
    return null; // Not in pause, can resume now
  }

  const nextPattern = getNextActivePattern();
  const now = new Date();
  const resumeTime = new Date(now);

  if (nextPattern.tomorrow) {
    resumeTime.setDate(resumeTime.getDate() + 1);
  }

  resumeTime.setHours(nextPattern.hourStart, 0, 0, 0);

  return resumeTime.toISOString();
};

const updateCrmDailyStats = async (crmUrl) => {
  try {
    const normalizedCrm = normalizeCrmUrl(crmUrl);
    console.log(`📊 CRM stats update skipped - stats only update when contacts are saved to database`);
  } catch (error) {
    console.error("❌ Error in updateCrmDailyStats:", error?.message);
  }
};

const updateUserDailyStats = async (userId, crmUrl) => {
  try {
    console.log(`📊 User stats update skipped - stats only update when contacts are saved to database`);
  } catch (error) {
    console.error("❌ Error in updateUserDailyStats:", error?.message);
  }
};

// Enhanced human-like behavior patterns with time awareness
const getHumanPatternDelay = () => {
  const currentPattern = getCurrentHumanPattern();

  if (currentPattern.pause) {
    // During pause periods, wait until next active period
    const nextPattern = getNextActivePattern();
    const now = new Date();
    const resumeTime = new Date(now);

    if (nextPattern.tomorrow) {
      resumeTime.setDate(resumeTime.getDate() + 1);
    }

    resumeTime.setHours(nextPattern.hourStart, 0, 0, 0);

    const waitTime = resumeTime.getTime() - now.getTime();
    return Math.max(waitTime, 5 * 60 * 1000); // Minimum 5 minutes
  }

  // During active periods, use pattern-specific delays
  return (
    Math.floor(
      Math.random() * (currentPattern.maxDelay - currentPattern.minDelay + 1)
    ) + currentPattern.minDelay
  );
};

const shouldTakeBreak = (processedInSession) => {
  const currentPattern = getCurrentHumanPattern();

  // Pattern-aware break logic
  if (currentPattern.pause) {
    return getHumanPatternDelay(); // Wait until next active period
  }

  // More frequent breaks during intensive periods
  if (currentPattern.name === "morningBurst" && processedInSession % 8 === 0) {
    return 2 * 60 * 1000; // 3 minute break every 8 profiles in morning
  }

  if (
    currentPattern.name === "afternoonWork" &&
    processedInSession % 12 === 0
  ) {
    return 3 * 60 * 1000; // 5 minute break every 12 profiles in afternoon
  }

  if (currentPattern.name === "eveningLight" && processedInSession % 5 === 0) {
    return 8 * 60 * 1000; // 8 minute break every 5 profiles in evening
  }

  // Traditional break logic (reduced frequency)
  if (processedInSession % 30 === 0) {
    return 10 * 60 * 1000; // 10 minute break every 30 profiles
  }

  // Random breaks (reduced chance during active periods)
  if (Math.random() <  0.015) {
    // 2% chance (was 5%)
    const breakDuration =
      currentPattern.name === "eveningLight"
        ? Math.random() * 20 * 60 * 1000 // 0-20 min in evening
        : Math.random() * 10 * 60 * 1000; // 0-10 min other times
    return breakDuration;
  }

  return 0;
};

// Generate unique job ID
const generateJobId = () => {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2)}`;
};

// Token refresh helper
const refreshAccessToken = async (
  refreshToken,
  clientId,
  tenantId,
  crmUrl,
  verifier
) => {
  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: {
          "Content-type": "application/x-www-form-urlencoded",
        },
        credentials: "omit",
        body: `client_id=${clientId}&scope=${crmUrl}/.default&grant_type=refresh_token&refresh_token=${refreshToken}&redirect_uri=http://localhost:5678&code_verifier=${verifier}`,
      }
    );

    const data = await response.json();

    if (response.ok && data.access_token) {
      console.log("✅ Token refreshed successfully");
      return data;
    } else {
      throw new Error(data.error_description || "Token refresh failed");
    }
  } catch (error) {
    console.error("❌ Token refresh error:", error.message);
    throw error;
  }
};

// Enhanced API call helper with token refresh
const callDataverseWithRefresh = async (
  url,
  token,
  method = "GET",
  body = null,
  refreshData = null
) => {
  try {
    if (method === "GET") {
      return await getDataverse(url, token);
    } else {
      return await createDataverse(url, token, body, method);
    }
  } catch (error) {
    console.log("🔍 API call failed, checking if token refresh needed...");

    if (error.message.includes("401") && refreshData) {
      try {
        console.log("🔄 Attempting token refresh...");
        const newTokenData = await refreshAccessToken(
          refreshData.refreshToken,
          refreshData.clientId,
          refreshData.tenantId,
          refreshData.crmUrl,
          refreshData.verifier
        );

        // Update user session with new token
        const userSessions = await loadUserSessions();
        if (userSessions[refreshData.userId]) {
          userSessions[refreshData.userId].accessToken = newTokenData.access_token;
          if (newTokenData.refresh_token) {
            userSessions[refreshData.userId].refreshToken = newTokenData.refresh_token;
          }
          await saveUserSessions(userSessions);
          console.log("✅ User session updated with new token");
        }

        console.log("🔄 Retrying API call with refreshed token...");
        if (method === "GET") {
          return await getDataverse(url, newTokenData.access_token);
        } else {
          return await createDataverse(
            url,
            newTokenData.access_token,
            body,
            method
          );
        }
      } catch (refreshError) {
        console.error("❌ Token refresh failed:", refreshError.message);
        throw new Error("TOKEN_REFRESH_FAILED: " + refreshError.message);
      }
    }

    throw error;
  }
};

// Enhanced CORS setup for production
const corsOptions = {
  origin: true, // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept', 
    'Origin',
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Methods'
  ],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// **PREVENT 304 CACHING** - Global no-cache middleware for all API responses
app.use((req, res, next) => {
  // Disable all caching for API endpoints
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  next();
});

// Additional CORS headers for compatibility
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, Origin, Access-Control-Allow-Origin, Access-Control-Allow-Headers, Access-Control-Allow-Methods"
  );
  res.header("Access-Control-Max-Age", "86400");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    console.log(`✅ CORS preflight handled for ${req.url}`);
    return res.status(200).end();
  } else {
    next();
  }
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Enhanced endpoint with human pattern awareness
app.post("/start-processing", async (req, res) => {
  // Ensure CORS headers are set
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  try {
    const {
      li_at,
      accessToken,
      refreshToken,
      clientId,
      tenantId,
      verifier,
      crmUrl,
      jsessionid,
      userId,
      resume = false,
    } = req.body;

    console.log("🔍 START-PROCESSING Request received:");
    console.log("📄 Full request body:", JSON.stringify(req.body, null, 2));
    console.log("🔑 Extracted params:", {
      userId,
      hasLiAt: !!li_at,
      hasAccessToken: !!accessToken,
      crmUrl,
      hasJsessionid: !!jsessionid,
      resume
    });

    if (!userId || !jsessionid || !accessToken || !crmUrl || !li_at) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: userId, li_at, accessToken, crmUrl, and jsessionid are required",
      });
    }

    console.log("🔍 Processing request for user:", userId, {
      resume,
      hasRefreshToken: !!refreshToken,
      crmUrl: normalizeCrmUrl(crmUrl)
    });

    // Enhanced limit checking with CRM-based sharing
    const limitCheck = await checkDailyLimit(userId, crmUrl);

    // Load jobs once at the start
    const allJobs = await loadJobs();
    const now = new Date();


    // Check for cooldownOverridden on last completed job
    const userJobsArr = Object.values(allJobs).filter(job => job.userId === userId);
    const completedJobsArr = userJobsArr.filter(job => job.status === "completed" && job.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    const lastCompletedJob = completedJobsArr.length > 0 ? completedJobsArr[0] : null;
    if (lastCompletedJob && lastCompletedJob.cooldownOverridden) {
      return res.status(403).json({
        success: false,
        message: "You cannot start a new job. Cooldown is overridden for this user. Please wait 1 month or contact admin.",
        cooldownOverridden: true,
        overriddenAt: lastCompletedJob.overriddenAt,
        jobId: lastCompletedJob.jobId
      });
    }

    // First check if there's any existing incomplete job
    let currentIncompleteJob = null;
    for (const job of Object.values(allJobs)) {
      if (job.userId === userId && 
          job.status !== "completed" && 
          job.contacts && 
          job.processedCount < job.totalContacts) {
        
        // Check job age - ignore jobs older than 24 hours to prevent old job conflicts
        const jobCreatedAt = new Date(job.createdAt || job.startTime || Date.now());
        const jobAgeInHours = (Date.now() - jobCreatedAt.getTime()) / (1000 * 60 * 60);
        
        console.log(`🔍 Checking incomplete job ${job.jobId} for user ${userId}:`, {
          jobId: job.jobId,
          status: job.status,
          ageInHours: Math.round(jobAgeInHours * 100) / 100,
          isOld: jobAgeInHours > 24
        });
        
        // Skip old jobs (older than 24 hours) to allow fresh starts
        if (jobAgeInHours > 24) {
          console.log(`⏭️ Ignoring old incomplete job ${job.jobId} (${Math.round(jobAgeInHours)}h old), allowing fresh start`);
          continue;
        }
        
        currentIncompleteJob = job;
        break;
      }
    }

    // If there's an incomplete job, force resume that one
    if (currentIncompleteJob && !resume) {
      return res.status(200).json({
        success: false,
        message: `You have an incomplete job (${currentIncompleteJob.processedCount}/${currentIncompleteJob.totalContacts} contacts processed). Please resume this job first.`,
        jobId: currentIncompleteJob.jobId,
        status: currentIncompleteJob.status,
        processedCount: currentIncompleteJob.processedCount,
        totalContacts: currentIncompleteJob.totalContacts,
        canResume: true,
        currentPattern: limitCheck.currentPattern,
        limitInfo: limitCheck
      });
    }

    // Check for cooldown period only if starting a new job
    if (!limitCheck.canProcess && !resume) {
      // 1-month cooldown: block new jobs only if all contacts are updated
      const userJobs = Object.values(allJobs).filter(job => job.userId === userId);
      
      // Find the most recent completed job using the same logic as override endpoint
      const completedJobs = userJobs
        .filter(job => job.status === "completed" && job.completedAt)
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
      
      const lastCompletedJob = completedJobs.length > 0 ? completedJobs[0] : null;
      let hasPendingContacts = false;

      for (const job of userJobs) {
        // Check for any job with pending or unfinished contacts
        if (job.contacts && (
            job.contacts.some(c => c.status === "pending") || 
            job.processedCount < job.totalContacts
        )) {
          hasPendingContacts = true;
        }
      }
      if (!hasPendingContacts && lastCompletedJob) {
        const completedAt = new Date(lastCompletedJob.completedAt);
        const diffDays = (now - completedAt) / (1000 * 60 * 60 * 24);
        
        // Check if cooldown was overridden
        const cooldownOverridden = lastCompletedJob.cooldownOverridden;
        
        console.log(`🔍 Cooldown check for user ${userId}:`, {
          jobId: lastCompletedJob.jobId,
          completedAt: lastCompletedJob.completedAt,
          diffDays: diffDays,
          cooldownOverridden: cooldownOverridden,
          overriddenAt: lastCompletedJob.overriddenAt
        });
        
        if (diffDays < 30 && !cooldownOverridden) {
          return res.status(200).json({
            success: false,
            message: `All contacts were already processed. Please wait ${Math.ceil(30 - diffDays)} more day(s) before running again.`,
            lastCompleted: lastCompletedJob.completedAt,
            jobId: lastCompletedJob.jobId,
            processedCount: lastCompletedJob.processedCount,
            totalContacts: lastCompletedJob.totalContacts,
            canResume: false,
            cooldownActive: true,
            cooldownDaysLeft: Math.ceil(30 - diffDays),
            canOverrideCooldown: true, // Add this flag
            overrideEndpoint: `/override-cooldown/${userId}`, // Provide override endpoint
            currentPattern: limitCheck.currentPattern,
            limitInfo: limitCheck,
          });
        } else if (cooldownOverridden) {
          console.log(`✅ Cooldown was overridden for user ${userId} on ${lastCompletedJob.overriddenAt}, allowing new job`);
        }
      }

      let message = `Cannot process profiles. `;

      if (limitCheck.inPause) {
        const currentPattern = getCurrentHumanPattern();
        message += `Currently in ${limitCheck.currentPattern} (${currentPattern.time}). `;
        if (limitCheck.estimatedResumeTime) {
          const resumeTime = new Date(limitCheck.estimatedResumeTime);
          message += `Will resume at ${resumeTime.toLocaleTimeString()} during ${limitCheck.nextActivePattern.name}.`;
        }
      } else if (limitCheck.patternCount >= limitCheck.patternLimit) {
        message += `Pattern limit reached: ${limitCheck.patternCount}/${limitCheck.patternLimit} for ${limitCheck.currentPattern}. `;
      } else if (limitCheck.dailyCount >= limitCheck.dailyLimit) {
        message += `Daily limit reached: ${limitCheck.dailyCount}/${limitCheck.dailyLimit}. `;
      } else if (limitCheck.hourlyCount >= limitCheck.hourlyLimit) {
        message += `Hourly limit reached: ${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}. `;
      }

      return res.status(429).json({
        success: false,
        message,
        limitInfo: limitCheck,
        currentPattern: limitCheck.currentPattern,
        cooldownActive: false,
      });
    }

    const clientEndpoint = `${crmUrl}/api/data/v9.2`;
    const refreshData =
      refreshToken && clientId && tenantId && verifier
        ? {
            refreshToken,
            clientId,
            tenantId,
            crmUrl,
            verifier,
            userId, // Add userId to refreshData
          }
        : null;

    // Load existing jobs and user sessions
    const jobs = await loadJobs();
    const userSessions = await loadUserSessions();
    
    // Check for existing CRM-wide job (shared across all users of same CRM)
    let existingJob = null;
    let jobId = null;
    const normalizedCrm = normalizeCrmUrl(crmUrl);

    // First, check if there are any incomplete jobs for this CRM (not just user)
    for (const job of Object.values(jobs)) {
      const jobCrmUrl = userSessions[job.userId]?.crmUrl;
      
      // Check job age - ignore jobs older than 24 hours to prevent old job conflicts
      const jobCreatedAt = new Date(job.createdAt || job.startTime || Date.now());
      const jobAgeInHours = (Date.now() - jobCreatedAt.getTime()) / (1000 * 60 * 60);
      
      console.log(`🔍 Checking job ${job.jobId} for CRM sharing:`, {
        jobId: job.jobId,
        status: job.status,
        ageInHours: Math.round(jobAgeInHours * 100) / 100,
        isOld: jobAgeInHours > 24,
        crmMatch: jobCrmUrl && normalizeCrmUrl(jobCrmUrl) === normalizedCrm
      });
      
      // Skip old jobs (older than 24 hours) to avoid conflicts with fresh starts
      if (jobAgeInHours > 24) {
        console.log(`⏭️ Skipping old job ${job.jobId} (${Math.round(jobAgeInHours)}h old)`);
        continue;
      }
      
      if (jobCrmUrl && normalizeCrmUrl(jobCrmUrl) === normalizedCrm && 
          job.status !== "completed" && 
          job.contacts && 
          job.processedCount < job.totalContacts) {
        existingJob = job;
        jobId = job.jobId;
        console.log("📋 Found recent CRM-shared incomplete job:", {
          jobId: job.jobId,
          originalUserId: job.userId,
          currentUserId: userId,
          crmUrl: normalizedCrm,
          status: job.status,
          processed: job.processedCount,
          total: job.totalContacts,
          ageInHours: Math.round(jobAgeInHours * 100) / 100
        });
        break;
      }
    }

    // If we found a CRM-shared job, add current user to the job participants
    if (existingJob) {
      console.log(`🔧 Adding user ${userId} to CRM-shared job ${jobId}`);
      
      // Add current user to job participants (if not already added)
      if (!existingJob.participants) {
        existingJob.participants = [existingJob.userId]; // Add original creator
      }
      if (!existingJob.participants.includes(userId)) {
        existingJob.participants.push(userId);
        console.log(`✅ User ${userId} added to job participants:`, existingJob.participants);
      }
      
      // Update user session with the shared job
      userSessions[userId] = {
        currentJobId: jobId,
        li_at,
        jsessionid,
        accessToken,
        refreshToken,
        clientId,
        tenantId,
        verifier: verifier,
        crmUrl,
        lastActivity: new Date().toISOString()
      };
      
      // Save updated data
      jobs[jobId] = existingJob;
      await saveJobs(jobs);
      await saveUserSessions(userSessions);
      console.log("✅ User session updated with CRM-shared job");

      // If job was paused due to missing session or token issues, resume it
      if (existingJob.status === "paused" && 
          (existingJob.pauseReason === "user_session_missing" || 
           existingJob.pauseReason === "linkedin_session_invalid" ||
           existingJob.pauseReason === "dataverse_session_invalid" ||
           existingJob.pauseReason === "token_refresh_failed")) {
        console.log(`🔄 Resuming paused job with restored session. Previous pause reason: ${existingJob.pauseReason}`);
        
        // Initialize resume history if not exists
        if (!existingJob.resumeHistory) {
          existingJob.resumeHistory = [];
        }

        // Add resume event to history
        const resumeEvent = {
          timestamp: new Date().toISOString(),
          reason: "session_restored",
          previousPauseReason: existingJob.pauseReason,
          pauseDuration: existingJob.pausedAt ? 
            Math.round((new Date() - new Date(existingJob.pausedAt)) / 1000) : null,
          processedCount: existingJob.processedCount,
          totalContacts: existingJob.totalContacts
        };

        existingJob.resumeHistory.push(resumeEvent);
        console.log(`📝 Resume event logged:`, resumeEvent);
        
        existingJob.status = "processing";
        existingJob.resumedAt = new Date().toISOString();
        existingJob.lastProcessedAt = new Date().toISOString();
        delete existingJob.pauseReason;
        delete existingJob.pausedAt;
        delete existingJob.lastError;
        
        // Save updated job
        jobs[jobId] = existingJob;
        await saveJobs(jobs);
        
        // Start background processing
        setImmediate(() => processJobInBackground(jobId));
        
        const currentPattern = getCurrentHumanPattern();
        return res.status(200).json({
          success: true,
          message: "Session restored and job resumed successfully",
          jobId: existingJob.jobId,
          status: "processing",
          processedCount: existingJob.processedCount,
          totalContacts: existingJob.totalContacts,
          currentPattern: currentPattern.name,
          canResume: true,
          resumedAt: new Date().toISOString(),
          sessionRestored: true
        });
      }
    }

    // Check for existing job in user session (legacy check)
    if (userSessions[userId]?.currentJobId) {
      jobId = userSessions[userId].currentJobId;
      if (jobs[jobId]) {
        const job = jobs[jobId];
        
        // Check job age - ignore jobs older than 24 hours to prevent old job conflicts
        const jobCreatedAt = new Date(job.createdAt || job.startTime || Date.now());
        const jobAgeInHours = (Date.now() - jobCreatedAt.getTime()) / (1000 * 60 * 60);
        
        console.log(`� Checking user session job ${jobId}:`, {
          jobId: job.jobId,
          status: job.status,
          ageInHours: Math.round(jobAgeInHours * 100) / 100,
          isOld: jobAgeInHours > 24
        });
        
        // Skip old jobs (older than 24 hours) to avoid conflicts with fresh starts
        if (jobAgeInHours > 24) {
          console.log(`⏭️ Ignoring old user session job ${jobId} (${Math.round(jobAgeInHours)}h old), will create new job`);
          // Clear old job from user session
          delete userSessions[userId].currentJobId;
          await saveUserSessions(userSessions);
        } else {
          existingJob = job;
          console.log("📋 Found recent job via user session:", {
            jobId: existingJob.jobId,
            status: existingJob.status,
            processed: existingJob.processedCount,
            total: existingJob.totalContacts,
            ageInHours: Math.round(jobAgeInHours * 100) / 100
          });
        }
      }
    }

    // If there's an existing job, check its state
    if (existingJob) {
      // Check if job is cancelled and handle restart
      if (existingJob.status === "cancelled" || existingJob.status === "failed") {
        console.log(`🛑 Found cancelled/failed job ${existingJob.jobId} for user ${userId}`);
        
        // Check if user session has cancellation info
        const userSession = userSessions[userId];
        const hasCancellationInfo = userSession?.lastCancellation?.cancelledJobId === existingJob.jobId;
        
        const cancelInfo = {
          jobId: existingJob.jobId,
          status: existingJob.status,
          cancelledAt: existingJob.cancelledAt || existingJob.failedAt,
          reason: existingJob.cancelReason || existingJob.error,
          processedCount: existingJob.processedCount,
          totalContacts: existingJob.totalContacts
        };
        
        return res.status(200).json({
          success: false,
          message: `Previous job was ${existingJob.status}. You can restart processing with your previous contacts.`,
          jobCancelled: true,
          jobStatus: existingJob.status,
          cancelInfo,
          canRestart: true,
          restartEndpoint: `/restart-after-cancel/${userId}`,
          processingBlocked: true,
          hasCancellationInfo,
          currentPattern: limitCheck.currentPattern,
          limitInfo: limitCheck
        });
      }
      
      const hasUnprocessedContacts = existingJob.processedCount < existingJob.totalContacts;
      console.log("📊 Job status check:", {
        hasUnprocessedContacts,
        status: existingJob.status,
        processed: existingJob.processedCount,
        total: existingJob.totalContacts
      });

      if (hasUnprocessedContacts && (existingJob.status === "processing" || existingJob.status === "paused")) {
        // Update user session with new tokens
        userSessions[userId] = {
          ...userSessions[userId],
          currentJobId: existingJob.jobId,
          li_at,
          jsessionid,
          accessToken,
          refreshToken,
          clientId,
          tenantId,
          verifier,
          crmUrl,
          lastActivity: new Date().toISOString()
        };
        
        // Save updated session
        await saveUserSessions(userSessions);
        console.log("✅ User session updated with new tokens");

        // If job was paused, resume it
        if (existingJob.status === "paused") {
          // Initialize resume history if not exists
          if (!existingJob.resumeHistory) {
            existingJob.resumeHistory = [];
          }

          // Add resume event to history
          const resumeEvent = {
            timestamp: new Date().toISOString(),
            reason: "user_reconnected",
            previousPauseReason: existingJob.pauseReason,
            pauseDuration: existingJob.pausedAt ? 
              Math.round((new Date() - new Date(existingJob.pausedAt)) / 1000) : null,
            processedCount: existingJob.processedCount,
            totalContacts: existingJob.totalContacts
          };

          existingJob.resumeHistory.push(resumeEvent);
          console.log(`📝 Resume event logged:`, resumeEvent);
          
          existingJob.status = "processing";
          existingJob.resumedAt = new Date().toISOString();
          await saveJobs(jobs);
          console.log("🔄 Resuming paused job:", existingJob.jobId);
        }
        
        // Start processing in background
        setImmediate(() => processJobInBackground(existingJob.jobId));
        
        const currentPattern = getCurrentHumanPattern();
        return res.status(200).json({
          success: true,
          message: "Session updated and continuing existing job",
          jobId: existingJob.jobId,
          status: "processing", // Always set to processing when resuming
          processedCount: existingJob.processedCount,
          totalContacts: existingJob.totalContacts,
          currentPattern: currentPattern.name,
          canResume: true,
          resumedAt: new Date().toISOString()
        });
      }
      
      // If resuming, start the background process anyway
      if (resume) {
        console.log("🔄 Resuming job processing for:", existingJob.jobId);
        
        // Update job status to processing if it was paused
        if (existingJob.status === "paused") {
          existingJob.status = "processing";
          existingJob.resumedAt = new Date().toISOString();
          await saveJobs(jobs);
        }
        
        // Start processing in background
        setImmediate(() => processJobInBackground(existingJob.jobId));
        
        const currentPattern = getCurrentHumanPattern();
        return res.status(200).json({
          success: true,
          message: "Job resumed successfully",
          jobId: existingJob.jobId,
          status: "processing",
          processedCount: existingJob.processedCount,
          totalContacts: existingJob.totalContacts,
          currentPattern: currentPattern.name,
          canResume: true,
          resumedAt: new Date().toISOString()
        });
      }
      
      return res.status(200).json({
        success: false,
        message: "Job already in progress",
        jobId,
        status: existingJob.status,
        processedCount: existingJob.processedCount,
        totalContacts: existingJob.totalContacts,
        canResume: true,
        currentPattern: limitCheck.currentPattern,
        limitInfo: limitCheck,
      });
    }

    // Create new job if no existing job
    if (!existingJob) {
        // Generate new job ID
        jobId = generateJobId();

        // Get all contacts
        const response = await callDataverseWithRefresh(
          `${clientEndpoint}/contacts`,
          accessToken,
          "GET",
          null,
          refreshData
        );

        if (!response || !response.value) {
          return res.status(400).json({
            success: false,
            message: "No contacts found or invalid response from Dataverse",
          });
        }

        const contacts = response.value.filter((c) => !!c.uds_linkedin);

      const currentPattern = getCurrentHumanPattern();
      existingJob = {
        jobId,
        userId, // Original creator
        participants: [userId], // Track all users sharing this job
        crmUrl: normalizedCrm, // Store normalized CRM URL
        totalContacts: contacts.length,
        contacts: contacts.map((c) => ({
          contactId: c.contactid,
          linkedinUrl: c.uds_linkedin,
          status: "pending", // pending, processing, completed, failed
        })),
        processedCount: 0,
        successCount: 0,
        failureCount: 0,
        status: "pending", // pending, processing, paused, completed, failed
        createdAt: new Date().toISOString(),
        lastProcessedAt: null,
        cancelToken: uuidv4(), // Initialize with a cancelToken for proper cancellation tracking
        errors: [],
        crmUrl: crmUrl, // CRITICAL: Add crmUrl to job for proper stats key generation
        humanPatterns: {
          startPattern: currentPattern.name,
          startTime: new Date().toISOString(),
          patternHistory: [],
        },
        dailyStats: {
          startDate: getTodayKey(),
          processedToday: 0,
          patternBreakdown: {},
          crmBased: true, // Flag to indicate CRM-based processing
        },
      };

      jobs[jobId] = existingJob;
      userSessions[userId] = {
        currentJobId: jobId,
        lastActivity: new Date().toISOString(),
      };

      await saveJobs(jobs);
      await saveUserSessions(userSessions);
    }

    // Update user session with complete fresh data from frontend
    console.log("🔄 Updating user session with fresh frontend data...");
    userSessions[userId] = {
      ...userSessions[userId], // Keep existing data like currentJobId if present
      currentJobId: jobId || userSessions[userId]?.currentJobId,
      accessToken,
      refreshToken,
      clientId,
      tenantId,
      verifier,
      crmUrl,
      li_at,
      jsessionid,
      lastActivity: new Date().toISOString(),
    };
    await saveUserSessions(userSessions);
    console.log("✅ User session updated with fresh authentication data");

    // Start processing in background
    setImmediate(() => processJobInBackground(jobId));

    res.status(200).json({
      success: true,
      message: resume ? "Processing resumed" : "Processing started",
      jobId,
      totalContacts: existingJob.totalContacts,
      processedCount: existingJob.processedCount,
      status: existingJob.status,
      currentPattern: limitCheck.currentPattern,
      limitInfo: limitCheck,
    });
  } catch (error) {
    console.error("❌ Error in /start-processing:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Simple restart endpoint for stuck jobs
app.post("/restart-job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const logger = createProcessingLogger(jobId);
    logger.checkpoint("MANUAL_RESTART_REQUESTED");
    
    const jobs = await loadJobs();
    const job = jobs[jobId];
    
    if (!job) {
      logger.error("JOB_NOT_FOUND_FOR_RESTART", { jobId });
      return res.status(404).json({
        success: false,
        message: "Job not found"
      });
    }
    
    logger.info("JOB_FOUND_FOR_RESTART", {
      status: job.status,
      totalContacts: job.totalContacts,
      processedCount: job.processedCount,
      currentBatchIndex: job.currentBatchIndex || 0
    });
    
    // Reset any processing contacts to pending
    let resetCount = 0;
    if (job.contacts) {
      job.contacts.forEach(contact => {
        if (contact.status === "processing") {
          contact.status = "pending";
          resetCount++;
          logger.debug("CONTACT_RESET_TO_PENDING", { contactId: contact.contactId });
        }
      });
    }
    
    // Reset job state for fresh start
    job.currentBatchIndex = 0;
    job.lastProcessedAt = new Date().toISOString();
    job.restartCount = (job.restartCount || 0) + 1;
    job.lastRestart = new Date().toISOString();
    job.lastRestartReason = "manual_restart_endpoint";
    job.debugState = {
      currentState: "MANUAL_RESTART",
      timestamp: new Date().toISOString(),
      resetContacts: resetCount,
      restartCount: job.restartCount
    };
    
    // Ensure job status is processing
    if (job.status !== "processing") {
      logger.info("SETTING_STATUS_TO_PROCESSING", { previousStatus: job.status });
      job.status = "processing";
      job.resumedAt = new Date().toISOString();
      delete job.pauseReason;
      delete job.pausedAt;
      delete job.lastError;
    }
    
    // Save job
    jobs[jobId] = job;
    await saveJobs(jobs);
    
    logger.info("JOB_STATE_RESET_COMPLETE", {
      resetContacts: resetCount,
      restartCount: job.restartCount,
      currentBatchIndex: job.currentBatchIndex
    });
    
    // Start background processing with enhanced logging
    logger.checkpoint("STARTING_BACKGROUND_PROCESSING");
    setImmediate(() => {
      logger.checkpoint("BACKGROUND_PROCESS_IMMEDIATE_CALLED");
      processJobInBackground(jobId).catch(error => {
        logger.error("BACKGROUND_PROCESSING_FAILED", { error: error.message, stack: error.stack });
      });
    });
    
    return res.status(200).json({
      success: true,
      message: "Job restarted successfully with enhanced logging",
      jobId,
      resetContactsCount: resetCount,
      restartCount: job.restartCount,
      debugInfo: {
        currentBatchIndex: job.currentBatchIndex,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount
      }
    });
    
  } catch (error) {
    console.error("❌ Error restarting job:", error);
    res.status(500).json({
      success: false,
      message: "Error restarting job",
      error: error.message
    });
  }
});

// Force completion endpoint for stuck jobs
app.post("/force-complete-job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🔧 Force completing job ${jobId}...`);
    
    const jobs = await loadJobs();
    const job = jobs[jobId];
    
    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found"
      });
    }
    
    // Check if all contacts are actually completed
    const completedContacts = job.contacts ? job.contacts.filter(c => c.status === "completed").length : 0;
    const failedContacts = job.contacts ? job.contacts.filter(c => c.status === "failed").length : 0;
    const totalProcessed = completedContacts + failedContacts;
    
    console.log(`📊 Job ${jobId} analysis:`, {
      totalContacts: job.totalContacts,
      completedContacts,
      failedContacts,
      totalProcessed,
      processedCount: job.processedCount,
      allContactsDone: totalProcessed >= job.totalContacts
    });
    
    if (totalProcessed >= job.totalContacts || job.processedCount >= job.totalContacts) {
      // Force complete the job
      const now = new Date().toISOString();
      
      job.status = "completed";
      job.completedAt = now;
      job.currentBatchIndex = 0;
      job.completionReason = "force_completed_admin";
      job.lastProcessedAt = now;
      
      // Ensure cooldownOverridden is set to true for natural completion
      job.cooldownOverridden = true;
      job.overriddenAt = now;
      job.overrideReason = "force_completed_admin";
      
      console.log(`🔧 Force completing job ${jobId} with cooldownOverridden: ${job.cooldownOverridden}`);
      
      // Save to memory
      jobs[jobId] = job;
      await saveJobs(jobs);
      
      // Also update MongoDB directly
      try {
        await Job.findOneAndUpdate(
          { jobId: jobId },
          { 
            status: "completed",
            completedAt: new Date(),
            currentBatchIndex: 0,
            completionReason: "force_completed_admin",
            lastProcessedAt: new Date(),
            cooldownOverridden: true,
            overriddenAt: new Date(),
            overrideReason: "force_completed_admin"
          },
          { new: true }
        );
        console.log(`✅ Job ${jobId} force completed in both memory and MongoDB`);
      } catch (mongoError) {
        console.error(`❌ Error updating MongoDB for job ${jobId}:`, mongoError);
      }
      
      return res.status(200).json({
        success: true,
        message: "Job force completed successfully",
        jobId,
        status: "completed",
        completedAt: now,
        cooldownOverridden: job.cooldownOverridden || false,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        completedContacts,
        failedContacts
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "Job cannot be completed - not all contacts are processed",
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        completedContacts,
        failedContacts,
        totalProcessed
      });
    }
  } catch (error) {
    console.error("❌ Error force completing job:", error);
    res.status(500).json({
      success: false,
      message: "Error force completing job",
      error: error.message
    });
  }
});

// Debug endpoint to get detailed job processing state
app.get("/debug-job-state/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobs = await loadJobs();
    const job = jobs[jobId];
    
    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found"
      });
    }
    
    const userSessions = await loadUserSessions();
    const userSession = userSessions[job.userId];
    
    // Analyze job state
    const now = new Date();
    const lastProcessed = job.lastProcessedAt ? new Date(job.lastProcessedAt) : null;
    const timeSinceLastProcess = lastProcessed ? (now - lastProcessed) / 1000 : null;
    
    const pendingContacts = job.contacts ? job.contacts.filter(c => c.status === "pending") : [];
    const processingContacts = job.contacts ? job.contacts.filter(c => c.status === "processing") : [];
    const completedContacts = job.contacts ? job.contacts.filter(c => c.status === "completed") : [];
    const failedContacts = job.contacts ? job.contacts.filter(c => c.status === "failed") : [];
    
    const debugInfo = {
      jobId: job.jobId,
      userId: job.userId,
      status: job.status,
      timestamps: {
        createdAt: job.createdAt,
        lastProcessedAt: job.lastProcessedAt,
        lastRestart: job.lastRestart,
        timeSinceLastProcess: timeSinceLastProcess ? Math.round(timeSinceLastProcess) : null
      },
      counters: {
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        currentBatchIndex: job.currentBatchIndex || 0,
        restartCount: job.restartCount || 0
      },
      contactBreakdown: {
        pending: pendingContacts.length,
        processing: processingContacts.length,
        completed: completedContacts.length,
        failed: failedContacts.length
      },
      userSession: {
        exists: !!userSession,
        hasCrmUrl: !!(userSession?.crmUrl),
        hasAccessToken: !!(userSession?.accessToken),
        hasLinkedInSession: !!(userSession?.li_at && userSession?.jsessionid),
        lastActivity: userSession?.lastActivity
      },
      debugState: job.debugState || null,
      lastError: job.lastError || null,
      pauseReason: job.pauseReason || null,
      isStuck: timeSinceLastProcess > 120 && job.status === "processing" && pendingContacts.length > 0,
      recommendations: []
    };
    
    // Add recommendations based on state
    if (debugInfo.isStuck) {
      debugInfo.recommendations.push("Job appears stuck - use /restart-job/:jobId to restart");
    }
    if (!debugInfo.userSession.exists) {
      debugInfo.recommendations.push("User session missing - user needs to reconnect");
    }
    if (!debugInfo.userSession.hasLinkedInSession) {
      debugInfo.recommendations.push("LinkedIn session invalid - user needs to re-authenticate");
    }
    if (!debugInfo.userSession.hasAccessToken) {
      debugInfo.recommendations.push("Dataverse access token missing - user needs to re-authenticate");
    }
    if (processingContacts.length > 0) {
      debugInfo.recommendations.push(`${processingContacts.length} contacts stuck in processing state - restart will reset them to pending`);
    }
    
    console.log(`🔍 Debug state for job ${jobId}:`, debugInfo);
    
    res.status(200).json({
      success: true,
      debug: debugInfo
    });
    
  } catch (error) {
    console.error("❌ Error getting debug state:", error);
    res.status(500).json({
      success: false,
      message: "Error getting debug state",
      error: error.message
    });
  }
});

// Enhanced background processing with human patterns
const processJobInBackground = async (jobId) => {
  const logger = createProcessingLogger(jobId);
  
  // CRITICAL: Prevent multiple instances for the same job
  if (runningProcesses.has(jobId)) {
    console.log(`🛑 Process already running for job ${jobId}, skipping duplicate`);
    return;
  }
  
  // Mark this job as being processed
  runningProcesses.set(jobId, { startTime: new Date(), processId: Date.now() });
  console.log(`🚀 Starting process for job ${jobId}`);
  
  logger.checkpoint("BACKGROUND_PROCESSING_STARTED");
  
  try {
    await updateJobState(jobId, "BACKGROUND_PROCESSING_STARTED", { timestamp: new Date().toISOString() });
    
    // Initial job load
    logger.checkpoint("LOADING_INITIAL_JOB");
    let jobs = await loadJobs();
    let job = jobs[jobId];

    if (!job) {
      logger.error("JOB_NOT_FOUND", { jobId });
      return;
    }

    logger.info("JOB_LOADED", {
      status: job.status,
      totalContacts: job.totalContacts,
      processedCount: job.processedCount,
      currentBatchIndex: job.currentBatchIndex
    });

    // Cache cancelToken at start
    const initialCancelToken = job.cancelToken;
    logger.debug("CANCEL_TOKEN_CACHED", { initialCancelToken });

    // CRITICAL: Check job status before doing anything
    logger.checkpoint("INITIAL_STATUS_CHECK");
    if (await checkJobStatusAndExit(jobId, "initial check", initialCancelToken)) {
      logger.warn("JOB_EXITED_AT_INITIAL_CHECK");
      return;
    }

    await updateJobState(jobId, "CHECKING_USER_SESSION");
    const userSessions = await loadUserSessions();
    const userSession = userSessions[job.userId];
    
    if (!userSession) {
      logger.error("USER_SESSION_MISSING", { userId: job.userId });
      await updateJobState(jobId, "PAUSED_NO_SESSION");
      
      job.status = "paused";
      job.pauseReason = "user_session_missing";
      job.pausedAt = new Date().toISOString();
      job.lastError = {
        type: "SESSION_ERROR",
        message: "User session not found. Please reconnect through extension.",
        timestamp: new Date().toISOString()
      };
      await saveJobs({ ...jobs, [jobId]: job });
      return;
    }

    logger.info("USER_SESSION_FOUND", {
      userId: job.userId,
      hasCrmUrl: !!userSession.crmUrl,
      hasAccessToken: !!userSession.accessToken,
      hasLinkedInSession: !!(userSession.li_at && userSession.jsessionid)
    });

    await updateJobState(jobId, "PREPARING_PROCESSING", {
      userId: job.userId,
      totalContacts: job.totalContacts,
      processed: job.processedCount
    });

  console.log(`📊 Processing job ${jobId}:`, {
    status: job.status,
    processed: job.processedCount,
    total: job.totalContacts,
    userId: job.userId
  });

  console.log(`🟪 [GLOBAL] processJobInBackground started for jobId: ${jobId}`);
  console.log(`🟪 [GLOBAL] Entered try block for jobId: ${jobId}`);
    // CRITICAL: Always work with fresh job data
    jobs = await loadJobs();
    job = jobs[jobId];
    
    // Check again after reload
    if (await checkJobStatusAndExit(jobId, "after reload", initialCancelToken)) return;
    
    // Update job status to processing ONLY if it's not completed/cancelled
    if (!["completed", "cancelled", "failed"].includes(job.status)) {
      // YENİ: Son bir kez güncel job'ı yükle ve status kontrolü yap
      const latestJobs = await loadJobs();
      const latestJob = latestJobs[jobId];
      if (["completed", "cancelled", "failed"].includes(latestJob.status)) {
        console.log(`🛑 Job ${jobId} was externally set to ${latestJob.status}, exiting before setting processing`);
        return;
      }
      job.status = "processing";
      job.lastProcessedAt = new Date().toISOString();
      job.lastProcessedTime = new Date();
      // Initialize batch index if not exists
      if (!job.currentBatchIndex) {
        job.currentBatchIndex = 0;
      }
      // Make sure timestamps are properly set
      if (!job.createdAt) {
        job.createdAt = job.startTime || new Date().toISOString();
      }
      await saveJobs({ ...jobs, [jobId]: job });
    } else {
      console.log(`⏹️ Job ${jobId} is already ${job.status}. Exiting background processing.`);
      return;
    }

    const BATCH_SIZE = 1;
    let processedInSession = job.processedInSession || 0;
    let currentPatternName = job.currentPatternName || getCurrentHumanPattern().name;

    // CRITICAL: Always get fresh job data for contacts
    jobs = await loadJobs();
    job = jobs[jobId];
    
    // Check if job was cancelled while we were setting up
    if (await checkJobStatusAndExit(jobId, "before processing contacts", initialCancelToken)) return;

    // Get pending contacts from FRESH job data
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    
    // If no pending contacts remain, job is complete
    if (pendingContacts.length === 0) {
      console.log(`✅ No pending contacts found. Job ${jobId} appears to be completed.`);
      
      // Only mark as completed if not already completed by external operation
      if (job.status === "processing") {
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        job.completionReason = "no_pending_contacts_found";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        console.log(`🎉 Job ${jobId} marked as completed - no pending contacts`);
      }
      return;
    }
    
    const contactBatches = chunkArray(pendingContacts, BATCH_SIZE);

    // Continue from current batch index
    let startBatchIndex = job.currentBatchIndex || 0;
    if (startBatchIndex >= contactBatches.length) {
      console.log(`🟥 [BATCH INDEX FIX] currentBatchIndex (${startBatchIndex}) >= contactBatches.length (${contactBatches.length}), resetting to 0`);
      startBatchIndex = 0;
      job.currentBatchIndex = 0;
      await saveJobs({ ...(await loadJobs()), [jobId]: job });
    }

    console.log(`📊 Processing ${pendingContacts.length} remaining contacts in ${contactBatches.length} batches for job ${jobId}`);
    console.log(`🕒 Continuing with ${currentPatternName} pattern from batch ${startBatchIndex + 1}/${contactBatches.length}`);

    for (let batchIndex = startBatchIndex; batchIndex < contactBatches.length; batchIndex++) {
      // KORUMA: currentBatchIndex hiçbir zaman batch sayısından büyük olamaz
      if (job.currentBatchIndex >= contactBatches.length) {
        console.log(`🟥 [BATCH INDEX GUARD] currentBatchIndex (${job.currentBatchIndex}) >= contactBatches.length (${contactBatches.length}), sıfırlanıyor.`);
        job.currentBatchIndex = 0;
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
      }

      // Her batch başında status ve cancelToken kontrolü
      jobs = await loadJobs();
      job = jobs[jobId];
      if (["completed", "cancelled", "failed"].includes(job.status)) {
        console.log(`🛑 [BATCH GUARD] Job status is ${job.status}, exiting batch loop.`);
        return;
      }
      // Cancel token check is now handled by checkJobStatusAndExit function
      console.log(`🟦 [BATCH ${batchIndex + 1}] BEGIN`);
      
      // CRITICAL: Check job status at the beginning of EVERY batch
      console.log(`🟦 [BATCH ${batchIndex + 1}] Starting. Checking job status...`);
      if (await checkJobStatusAndExit(jobId, `batch ${batchIndex + 1}`, initialCancelToken)) {
        console.log(`🟥 [BATCH ${batchIndex + 1}] Exiting due to job status.`);
        return;
      }

      // CRITICAL: Always work with fresh job data
      jobs = await loadJobs();
      job = jobs[jobId];
      console.log(`🟦 [BATCH ${batchIndex + 1}] Loaded job. Status: ${job.status}, cancelToken: ${job.cancelToken}, processedCount: ${job.processedCount}`);

      // Double check after reload
      if (await checkJobStatusAndExit(jobId, `batch ${batchIndex + 1} after reload`, initialCancelToken)) {
        console.log(`🟥 [BATCH ${batchIndex + 1}] Exiting after reload due to job status.`);
        return;
      }

      // Save progress after each batch (currentBatchIndex bir sonraki batch için güncellenir)
      job.currentBatchIndex = batchIndex + 1;
      job.currentPatternName = currentPatternName;
      job.processedInSession = processedInSession;
      await saveJobs({ ...(await loadJobs()), [jobId]: job });
      
      // Check if pattern has changed
      const newPattern = getCurrentHumanPattern();
      if (newPattern.name !== currentPatternName) {
        console.log(`🔄 Pattern changed from ${currentPatternName} to ${newPattern.name}`);

        // Record pattern change
        if (!job.humanPatterns.patternHistory)
          job.humanPatterns.patternHistory = [];
        job.humanPatterns.patternHistory.push({
          pattern: currentPatternName,
          endTime: new Date().toISOString(),
          profilesProcessed: processedInSession,
        });

        currentPatternName = newPattern.name;
        processedInSession = 0; // Reset for new pattern
      }

      // Enhanced limit checking with CRM-based sharing
      const currentUserSessions = await loadUserSessions();
      const currentUserSession = currentUserSessions[job.userId];
      const jobCrmUrl = currentUserSession?.crmUrl;
      const limitCheck = await checkDailyLimit(job.userId, jobCrmUrl);
      
      if (!limitCheck.canProcess) {
        console.log(`🚫 Limits reached for user ${job.userId}. Pausing job.`);
        console.log(`📊 Pattern: ${limitCheck.currentPattern} (${limitCheck.patternCount}/${limitCheck.patternLimit})`);
        console.log(`📊 Today: ${limitCheck.dailyCount}/${limitCheck.dailyLimit}, This hour: ${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}`);

        let pauseReason = "limit_reached";
        let estimatedResume = limitCheck.estimatedResumeTime;

        if (limitCheck.inPause) {
          pauseReason = "pause_period";
          console.log(`⏸️ Currently in ${limitCheck.currentPattern} pause period`);
        } else if (limitCheck.patternCount >= limitCheck.patternLimit) {
          pauseReason = "pattern_limit_reached";
          console.log(`📈 Pattern limit reached for ${limitCheck.currentPattern}`);
        } else if (limitCheck.dailyCount >= limitCheck.dailyLimit) {
          pauseReason = "daily_limit_reached";
        } else if (limitCheck.hourlyCount >= limitCheck.hourlyLimit) {
          pauseReason = "hourly_limit_reached";
        }

        // Initialize pause history if not exists
        if (!job.pauseHistory) {
          job.pauseHistory = [];
        }

        // Add pause event to history
        const pauseEvent = {
          timestamp: new Date().toISOString(),
          reason: pauseReason,
          currentPattern: limitCheck.currentPattern,
          limits: {
            daily: `${limitCheck.dailyCount}/${limitCheck.dailyLimit}`,
            hourly: `${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}`,
            pattern: `${limitCheck.patternCount}/${limitCheck.patternLimit || '∞'}`
          },
          estimatedResumeTime: estimatedResume,
          batchIndex: batchIndex + 1,
          totalBatches: contactBatches.length,
          processedInThisSession: processedInSession
        };

        job.pauseHistory.push(pauseEvent);
        console.log(`📝 Pause event logged:`, pauseEvent);

        job.status = "paused";
        job.pauseReason = pauseReason;
        job.pausedAt = new Date().toISOString();
        job.estimatedResumeTime = estimatedResume;
        job.lastPatternInfo = limitCheck;

        await saveJobs({ ...(await loadJobs()), [jobId]: job });

        if (estimatedResume) {
          const resumeTime = new Date(estimatedResume);
          console.log(`⏰ Job will resume at ${resumeTime.toLocaleString()}`);
        }

        return;
      }

      const batch = contactBatches[batchIndex];

      // Check if user session is still valid - more detailed error checking
      try {
        console.log(`🔍 Kullanıcı oturumu kontrol ediliyor: ${job.userId}`);
        const currentUserSessions = await loadUserSessions();
        const userSessionForValidation = currentUserSessions[job.userId];

        if (!userSessionForValidation) {
          console.error(`❌ Kullanıcı ${job.userId} için oturum bulunamadı`);
          job.status = "paused";
          job.pauseReason = "session_not_found";
          job.lastError = {
            type: "SESSION_ERROR",
            message: "User session not found",
            timestamp: new Date().toISOString()
          };
          await saveJobs({ ...(await loadJobs()), [jobId]: job });
          return;
        }
        
        if (!userSessionForValidation.accessToken) {
          console.error(`❌ Kullanıcı ${job.userId} için Dataverse erişim token'ı yok`);
          job.status = "paused";
          job.pauseReason = "dataverse_session_invalid";
          job.lastError = {
            type: "AUTH_ERROR",
            message: "Dataverse authentication required",
            timestamp: new Date().toISOString()
          };
          await saveJobs({ ...(await loadJobs()), [jobId]: job });
          return;
        }
        
        if (!userSessionForValidation.li_at || !userSessionForValidation.jsessionid) {
          console.error(`❌ Kullanıcı ${job.userId} için LinkedIn oturum bilgisi eksik`);
          job.status = "paused";
          job.pauseReason = "linkedin_session_invalid";
          job.lastError = {
            type: "AUTH_ERROR",
            message: "LinkedIn authentication required",
            timestamp: new Date().toISOString()
          };
          await saveJobs({ ...(await loadJobs()), [jobId]: job });
          return;
        }
        
        console.log(`✅ Kullanıcı oturumu geçerli: ${job.userId}`);
      } catch (sessionError) {
        console.error(`❌ Oturum kontrolü hatası: ${sessionError.message}`);
        job.status = "paused";
        job.pauseReason = "session_check_failed";
        job.lastError = {
          type: "SYSTEM_ERROR",
          message: `Session check failed: ${sessionError.message}`,
          timestamp: new Date().toISOString()
        };
        try {
          await saveJobs({ ...(await loadJobs()), [jobId]: job });
        } catch (saveError) {
          console.error(`❌ İş kaydedilirken hata oluştu: ${saveError.message}`);
        }
        return;
      }

      console.log(`🔄 Processing batch ${batchIndex + 1} of ${contactBatches.length} for job ${jobId} (${currentPatternName} pattern)`);

      try {
        // Process contacts one by one to avoid Promise.allSettled issues
        console.log(`🔄 Batch işlemi başlatılıyor: ${batchIndex + 1}/${contactBatches.length}`);
        
        for (let contactIndex = 0; contactIndex < batch.length; contactIndex++) {
          // KORUMA: currentBatchIndex hiçbir zaman batch sayısından büyük olamaz (contact içinde de kontrol)
          if (job.currentBatchIndex >= contactBatches.length) {
            job.currentBatchIndex = 0;
            await saveJobs({ ...(await loadJobs()), [jobId]: job });
          }

          // Her contact başında status ve cancelToken kontrolü
          jobs = await loadJobs();
          job = jobs[jobId];
          if (["completed", "cancelled", "failed"].includes(job.status)) {
            console.log(`🛑 [CONTACT GUARD] Job status is ${job.status}, exiting contact loop.`);
            return;
          }
          // Cancel token check is now handled by checkJobStatusAndExit function
          console.log(`🟨 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] BEGIN`);
          

          // CRITICAL: Check job status before EVERY contact
          console.log(`🟨 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Checking job status...`);
          if (await checkJobStatusAndExit(jobId, `contact ${contactIndex + 1} in batch ${batchIndex + 1} (before processing)`, initialCancelToken)) {
            console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Exiting due to job status.`);
            return;
          }

          // Fresh job data loaded by checkJobStatusAndExit, get fresh contact data too
          jobs = await loadJobs();
          job = jobs[jobId];
          // Find the current contact in the fresh data
          const originalContact = batch[contactIndex];
          let contact = job.contacts.find(c => c.contactId === originalContact.contactId);

          if (!contact) {
            console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Contact ${originalContact.contactId} not found in fresh job data. Skipping.`);
            continue;
          }

          // Skip if contact is already processed (due to cancel operation)
          if (["completed", "cancelled", "failed"].includes(contact.status)) {
            console.log(`🟩 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Contact ${contact.contactId} already ${contact.status}, skipping.`);
            continue;
          }
          
          // CRITICAL: Also check if contact was marked as completed by cancel-processing
          // Reload fresh job data to check latest contact status
          const freshJobs = await loadJobs();
          const freshJob = freshJobs[jobId];
          const freshContact = freshJob?.contacts?.find(c => c.contactId === originalContact.contactId);
          
          if (freshContact && ["completed", "cancelled", "failed"].includes(freshContact.status)) {
            console.log(`🟩 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Contact ${freshContact.contactId} was externally marked as ${freshContact.status}, skipping.`);
            continue;
          }

          // Ekstra güvenlik: contact'ı processing yapmadan hemen önce tekrar job status kontrolü
          if (await checkJobStatusAndExit(jobId, `contact ${contactIndex + 1} in batch ${batchIndex + 1} (right before processing)`, initialCancelToken)) {
            console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Exiting right before processing due to job status.`);
            return;
          }

          try {
            console.log(`🟨 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] TRY BLOCK ENTERED`);
            console.log(`🟦 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Starting processing for contactId: ${contact.contactId}, status: ${contact.status}, jobStatus: ${job.status}, cancelToken: ${job.cancelToken}`);
            contact.status = "processing";
            console.log(`🟨 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Set status to processing`);
            
            // CRITICAL: Check cancellation immediately after setting status to processing
            if (await checkJobStatusAndExit(jobId, `contact ${contactIndex + 1} in batch ${batchIndex + 1} (after setting processing)`, initialCancelToken)) {
              console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Job was cancelled after setting processing status. Reverting contact status.`);
              contact.status = "pending"; // Revert to pending since we didn't actually process
              // Save the reverted contact status
              const revertJobs = await loadJobs();
              revertJobs[jobId] = job;
              await saveJobs(revertJobs);
              return;
            }
            
            // Hemen sonra tekrar güncel job ve contact'ı kontrol et
            jobs = await loadJobs();
            job = jobs[jobId];
            contact = job.contacts.find(c => c.contactId === originalContact.contactId);
            console.log(`🟨 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Refreshed job/contact after processing set. Status: ${contact ? contact.status : 'undefined'}`);
            if (!contact || ["completed", "cancelled", "failed"].includes(contact.status)) {
              console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Contact ${originalContact.contactId} was externally set to ${contact ? contact.status : "unknown"} after processing started, skipping.`);
              continue;
            }
            console.log(`🟨 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] END`);
  console.log(`🟦 [BATCH ${batchIndex + 1}] END`);

            // Get fresh user session for each contact
            const currentUserSessions = await loadUserSessions();
            const currentUserSession = currentUserSessions[job.userId];

            if (!currentUserSession) {
              console.error(`❌ Kullanıcı ${job.userId} için oturum bulunamadı`);
              throw new Error("User session not found");
            }

            // Store initial contact status to prevent duplicate stats updates
            const initialContactStatus = contact.status;
            console.log(`📊 [CONTACT ${contactIndex + 1}] Initial status: ${initialContactStatus}`);

            // Extract LinkedIn profile ID from URL
            const match = contact.linkedinUrl ? contact.linkedinUrl.match(/\/in\/([^\/]+)/) : null;
            const profileId = match ? match[1] : null;

            if (!profileId) {
              console.error(`❌ Geçersiz LinkedIn URL formatı: ${contact.linkedinUrl}`);
              throw new Error(`Invalid LinkedIn URL format`);
            }

            console.log(`🔍 LinkedIn profil ID'si alındı: ${profileId}`);
            const customCookies = {
              li_at: currentUserSession.li_at,
              jsession: currentUserSession.jsessionid,
            };
            
            if (!currentUserSession.li_at || !currentUserSession.jsessionid) {
              console.error(`❌ LinkedIn oturum bilgileri eksik`);
              throw new Error("LinkedIn session information missing");
            }

            // Handle Dataverse unauthorized errors
            const handleDataverseError = async (error) => {
              if (error.message.includes("401") || error.message.includes("Unauthorized")) {
                console.log("🔒 Dataverse session expired, pausing job...");
                job.status = "paused";
                job.pauseReason = "dataverse_session_invalid";
                job.pausedAt = new Date().toISOString();
                job.lastError = {
                  type: "AUTH_ERROR",
                  message: "Dataverse authentication required. Please re-authenticate through the extension.",
                  timestamp: new Date().toISOString()
                };
                await saveJobs({ ...(await loadJobs()), [jobId]: job });
                throw new Error("DATAVERSE_AUTH_REQUIRED");
              }
              throw error;
            };

            // Add error handling for Dataverse calls
            try {
              // CRITICAL: Check cancellation before making any external API calls
              if (await checkJobStatusAndExit(jobId, `contact ${contactIndex + 1} in batch ${batchIndex + 1} (before LinkedIn API)`, initialCancelToken)) {
                console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Job was cancelled before LinkedIn API call. Stopping processing.`);
                return;
              }
              
              const profileData = await fetchLinkedInProfile(profileId, customCookies);
              
              if (profileData.error && (profileData.error.includes("unauthorized") || profileData.error.includes("not found"))) {
                console.log("🔒 LinkedIn session expired, pausing job...");
                job.status = "paused";
                job.pauseReason = "linkedin_session_invalid";
                job.pausedAt = new Date().toISOString();
                job.lastError = {
                  type: "AUTH_ERROR",
                  message: "LinkedIn authentication required. Please re-authenticate through the extension.",
                  timestamp: new Date().toISOString()
                };
                await saveJobs({ ...(await loadJobs()), [jobId]: job });
                throw new Error("LINKEDIN_AUTH_REQUIRED");
              }

              // Wrap Dataverse calls in try-catch
              try {
                // CRITICAL: Check cancellation before making Dataverse API calls
                if (await checkJobStatusAndExit(jobId, `contact ${contactIndex + 1} in batch ${batchIndex + 1} (before Dataverse API)`, initialCancelToken)) {
                  console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Job was cancelled before Dataverse API call. Stopping processing.`);
                  return;
                }
                
                const convertedProfile = await transformToCreateUserRequest(
                  profileData,
                  `${currentUserSession.crmUrl}/api/data/v9.2`,
                  currentUserSession.accessToken
                );

                const updateUrl = `${currentUserSession.crmUrl}/api/data/v9.2/contacts(${contact.contactId})`;

                // Create refreshData object from currentUserSession
                const refreshData = currentUserSession.refreshToken ? {
                  refreshToken: currentUserSession.refreshToken,
                  clientId: currentUserSession.clientId,
                  tenantId: currentUserSession.tenantId,
                  crmUrl: currentUserSession.crmUrl,
                  verifier: currentUserSession.verifier,
                  userId: job.userId
                } : null;

                // CRITICAL: One final check before the actual API call
                if (await checkJobStatusAndExit(jobId, `contact ${contactIndex + 1} in batch ${batchIndex + 1} (final check before API)`, initialCancelToken)) {
                  console.log(`🟥 [CONTACT ${contactIndex + 1} in BATCH ${batchIndex + 1}] Job was cancelled right before final API call. Stopping processing.`);
                  return;
                }

                await callDataverseWithRefresh(
                  updateUrl,
                  currentUserSession.accessToken,
                  "PATCH",
                  convertedProfile,
                  refreshData
                ).catch(handleDataverseError);

              } catch (dataverseError) {
                await handleDataverseError(dataverseError);
              }

              // After successful contact processing
              contact.status = "completed";
              contact.processedAt = new Date().toISOString();
              contact.humanPattern = profileData.humanPattern || currentPatternName;
              job.successCount++;
              processedInSession++;

              // Update job count
              job.processedCount = job.successCount + job.failureCount;
              
              // Update daily stats using CRM-based key if available - PREVENT DUPLICATES
              const statsKey = job.crmUrl ? normalizeCrmUrl(job.crmUrl) : job.userId;
              const today = new Date().toISOString().split("T")[0];
              const hour = `${today}-${new Date().getHours()}`;
              const currentPattern = getCurrentHumanPattern();
              const pattern = `${today}-${currentPattern.name}`;
              
              // CRITICAL: Only update stats if contact hasn't been recorded yet
              // Check if this contact already has statsRecorded flag
              if (!contact.statsRecorded) {
                await updateDailyStats(statsKey, today, hour, pattern);
                contact.statsRecorded = true; // Mark as recorded to prevent duplicates
                console.log(`📊 Stats updated for NEW completion: ${contact.contactId}`);
                
                // IMMEDIATE SAVE to prevent race conditions
                const immediateJobs = await loadJobs();
                immediateJobs[jobId] = job;
                await saveJobs(immediateJobs);
                console.log(`💾 Immediately saved statsRecorded flag for ${contact.contactId}`);
              } else {
                console.log(`⚠️ Contact ${contact.contactId} stats already recorded, skipping update`);
              }
              
              // Update pattern-specific stats in job object only
              if (!job.dailyStats) {
                job.dailyStats = {
                  startDate: getTodayKey(),
                  processedToday: 0,
                  patternBreakdown: {}
                };
              }
              
              if (!job.dailyStats.patternBreakdown) {
                job.dailyStats.patternBreakdown = {};
              }
              
              if (!job.dailyStats.patternBreakdown[currentPatternName]) {
                job.dailyStats.patternBreakdown[currentPatternName] = 0;
              }
              
              job.dailyStats.patternBreakdown[currentPatternName]++;
              job.dailyStats.processedToday = job.successCount;

              console.log(`✅ Successfully updated contact ${contact.contactId} (${processedInSession} in ${currentPatternName} session)`);
            } catch (error) {
              if (error.message === "LINKEDIN_AUTH_REQUIRED" || error.message === "DATAVERSE_AUTH_REQUIRED") {
                // Stop processing and wait for user re-authentication
                console.log("⏸️ Processing paused - waiting for user authentication");
                return;
              }
              throw error; // Re-throw to be caught by outer catch
            }
          } catch (error) {
            console.error(`❌ Error processing contact ${contact.contactId}:`, error.message);

            // CRITICAL FIX - Always mark contact as failed, never leave in processing state
            contact.status = "failed";
            contact.error = error.message;
            contact.processedAt = new Date().toISOString();
            contact.humanPattern = currentPatternName;
            job.failureCount++;
            
            if (!job.errors) job.errors = [];
            job.errors.push({
              contactId: contact.contactId,
              error: error.message,
              timestamp: new Date().toISOString(),
              humanPattern: currentPatternName,
            });

            // Update processed count even for failed contacts
            job.processedCount = job.successCount + job.failureCount;
            
            // Update daily stats using CRM-based key for failed contacts too - PREVENT DUPLICATES
            const statsKey = job.crmUrl ? normalizeCrmUrl(job.crmUrl) : job.userId;
            const today = new Date().toISOString().split("T")[0];
            const hour = `${today}-${new Date().getHours()}`;
            const currentPattern = getCurrentHumanPattern();
            const pattern = `${today}-${currentPattern.name}`;
            
            // CRITICAL: Only update stats if contact wasn't already counted
            if (!contact.statsRecorded) {
              await updateDailyStats(statsKey, today, hour, pattern);
              contact.statsRecorded = true; // Mark as recorded to prevent duplicates
              console.log(`📊 Stats updated for failed contact ${contact.contactId}`);
              
              // IMMEDIATE SAVE to prevent race conditions
              const immediateJobs = await loadJobs();
              immediateJobs[jobId] = job;
              await saveJobs(immediateJobs);
              console.log(`💾 Immediately saved statsRecorded flag for failed ${contact.contactId}`);
            } else {
              console.log(`⚠️ Stats already recorded for failed contact ${contact.contactId}, skipping`);
            }

            if (error.message.includes("TOKEN_REFRESH_FAILED")) {
              console.log(`⏸️ Pausing job ${jobId} - token refresh failed, waiting for frontend reconnection`);
              job.status = "paused";
              job.pauseReason = "token_refresh_failed";
              job.pausedAt = new Date().toISOString();
              job.lastError = {
                type: "TOKEN_ERROR",
                message: "Token refresh failed. Please reconnect through extension.",
                timestamp: new Date().toISOString()
              };
              await saveJobs({ ...(await loadJobs()), [jobId]: job });
              console.log(`💡 Job ${jobId} will resume when user reconnects with fresh tokens`);
              return; // Stop processing, wait for frontend
            }

            if (error.message.includes("AUTH_REQUIRED")) {
              console.log(`⏸️ Authentication required, stopping processing`);
              return;
            }
          }
          
                   
          
                   
          // CRITICAL: Save job after each contact with fresh data merge
          const currentJobs = await loadJobs();
          currentJobs[jobId] = job;
          await saveJobs(currentJobs);
        }
        
        job.processedCount = job.successCount + job.failureCount;
        console.log(`📊 Güncel işlem durumu: ${job.processedCount}/${job.totalContacts} (${job.successCount} başarılı, ${job.failureCount} başarısız)`);

        // Save progress after each batch
        const currentJobs = await loadJobs();
        currentJobs[jobId] = job;
        await saveJobs(currentJobs);
        console.log(`💾 İşlem durumu kaydedildi`);

        // Human-like behavior: Check for pattern-aware breaks
        const breakTime = shouldTakeBreak(processedInSession);
        if (breakTime > 0) {
          const breakMinutes = Math.round(breakTime / 1000 / 60);
          console.log(`😴 Taking a ${breakMinutes} minute break after ${processedInSession} profiles in ${currentPatternName}...`);
          
          // Initialize break history if not exists
          if (!job.breakHistory) {
            job.breakHistory = [];
          }

          // Add break event to history
          const breakEvent = {
            timestamp: new Date().toISOString(),
            reason: `pattern_break_${currentPatternName}`,
            durationMs: breakTime,
            durationMinutes: breakMinutes,
            processedInSession: processedInSession,
            currentPattern: currentPatternName,
            batchIndex: batchIndex + 1,
            totalBatches: contactBatches.length
          };

          job.breakHistory.push(breakEvent);
          console.log(`📝 Break event logged:`, breakEvent);

          // Save job with break info before actually taking the break
          const jobsBeforeBreak = await loadJobs();
          jobsBeforeBreak[jobId] = job;
          await saveJobs(jobsBeforeBreak);
          
          await new Promise((resolve) => setTimeout(resolve, breakTime));
          console.log(`▶️ Mola tamamlandı, devam ediliyor.`);
          
          // CRITICAL: Check if job completed during break
          if (await checkJobStatusAndExit(jobId, "after break", initialCancelToken)) return;
        }

        // Wait between batches with human pattern timing
        if (batchIndex < contactBatches.length - 1) {
          const waitTime = getHumanPatternDelay();
          console.log(`⏳ Human pattern delay (${currentPatternName}): ${Math.round(waitTime / 1000 / 60)} minutes before next profile...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          console.log(`▶️ Bekleme süresi tamamlandı, sonraki profile geçiliyor.`);
          
          // CRITICAL: Check if job completed during delay
          if (await checkJobStatusAndExit(jobId, "after delay", initialCancelToken)) return;
        }

        console.log(`📈 Progress for job ${jobId}: ${job.processedCount}/${job.totalContacts} contacts processed (${currentPatternName}: ${processedInSession})`);

        // Log pattern breakdown
        if (job.dailyStats.patternBreakdown) {
          const breakdown = Object.entries(job.dailyStats.patternBreakdown)
            .map(([pattern, count]) => `${pattern}: ${count}`)
            .join(", ");
          console.log(`🕒 Pattern breakdown: ${breakdown}`);
        }
      } catch (error) {
        if (error.message.includes("TOKEN_REFRESH_FAILED") || error.message.includes("AUTH_REQUIRED")) {
          break;
        }
        if (error.message.includes("STOP_PROCESSING") || error.message.includes("Job cancelled") || error.message.includes("Job completed")) {
          console.log(`🛑 Stop processing signal received: ${error.message}`);
          console.log(`🏁 Terminating background processing for job ${jobId}`);
          return; // Exit immediately
        }
      }
    }

    // Final completion check - but only if job is still processing
    jobs = await loadJobs();
    job = jobs[jobId];
    
    // Don't override if job was already completed by cancel operation
    if (job.status === "completed") {
      console.log(`✅ Job ${jobId} was already completed by external operation (cancel-processing)`);
      return;
    }

    // Mark job as completed if all contacts processed
    const remainingPending = job.contacts.filter((c) => c.status === "pending").length;
    const totalContactsLength = job.contacts ? job.contacts.length : job.totalContacts;
    const allContactsProcessed = job.processedCount >= totalContactsLength;
    
    console.log(`📊 Job completion check for ${jobId}:`, {
      remainingPending,
      totalContacts: job.totalContacts,
      totalContactsLength,
      processedCount: job.processedCount,
      successCount: job.successCount,
      failureCount: job.failureCount,
      allContactsAccountedFor: (job.successCount + job.failureCount) === totalContactsLength,
      allContactsProcessed
    });
    
    // Complete job if either: no pending contacts OR all contacts have been processed (success + failed)
    if ((remainingPending === 0 || allContactsProcessed) && job.status === "processing") {
      // Same completion logic as cancel-processing endpoint
      const now = new Date().toISOString();
      
      job.status = "completed";
      job.completedAt = now;
      job.currentBatchIndex = 0;
      job.completionReason = allContactsProcessed ? "all_contacts_processed" : "background_processing_completed";
      job.lastProcessedAt = now;
      
      // FIX: Set cooldownOverridden = true for natural completion (background processing)
      job.cooldownOverridden = true;
      job.overriddenAt = now;
      job.overrideReason = "natural_completion_background_processing";

      // Final pattern history entry
      if (!job.humanPatterns.patternHistory)
        job.humanPatterns.patternHistory = [];
      job.humanPatterns.patternHistory.push({
        pattern: currentPatternName,
        endTime: now,
        profilesProcessed: processedInSession,
      });

      console.log(`🎉 Job ${jobId} completed by background processing! Reason: ${job.completionReason}, cooldownOverridden: ${job.cooldownOverridden}, Final pattern breakdown:`, job.dailyStats.patternBreakdown);
      
      // CRITICAL: Also update MongoDB to ensure consistency
      try {
        await Job.findOneAndUpdate(
          { jobId: jobId },
          { 
            status: "completed",
            completedAt: new Date(),
            currentBatchIndex: 0,
            completionReason: job.completionReason,
            humanPatterns: job.humanPatterns,
            dailyStats: job.dailyStats,
            lastProcessedAt: new Date(),
            cooldownOverridden: true,
            overriddenAt: new Date(),
            overrideReason: "natural_completion_background_processing"
          },
          { new: true }
        );
        console.log(`✅ Job ${jobId} completion also saved to MongoDB with cooldownOverridden: true`);
      } catch (mongoError) {
        console.error(`❌ Error updating MongoDB completion for job ${jobId}:`, mongoError);
      }
    } else if (remainingPending > 0) {
      // Check if we've processed all available contacts but some are still pending
      // This can happen if processing was interrupted
    } else if (remainingPending > 0 && !allContactsProcessed) {
      // Only mark as stalled if we haven't processed all contacts yet
      console.log(`⚠️ Job ${jobId} has ${remainingPending} pending contacts remaining after background processing`);
      console.log(`🔍 Investigating stuck contacts...`);
      
      // Get the pending contacts and their details
      const pendingContacts = job.contacts.filter(c => c.status === "pending");
      pendingContacts.forEach((contact, index) => {
        console.log(`📋 Pending contact ${index + 1}: ${contact.contactId} - ${contact.linkedinUrl}`);
      });
      
      // Mark job as stalled and set it up for auto-restart
      job.status = "processing"; // Keep as processing but mark stall time
      job.lastProcessedAt = new Date().toISOString();
      job.stalledAt = new Date().toISOString();
      job.stalledReason = `${remainingPending} contacts remain pending after background processing completed`;
      
      console.log(`🔄 Job ${jobId} marked as stalled, frontend monitoring will trigger restart if needed`);
    } else if (remainingPending > 0 && allContactsProcessed) {
      // All contacts processed but some still marked as pending - this shouldn't happen but let's log it
      console.log(`✅ Job ${jobId} has processed all contacts (${job.processedCount}/${totalContactsLength}) but ${remainingPending} are still marked as pending - job should be completed above`);
    }

    // Final save
    const finalJobs = await loadJobs();
    finalJobs[jobId] = job;
    await saveJobs(finalJobs);

    console.log(`✅ Job ${jobId} processing completed. Status: ${job.status}`);
  } catch (error) {
    console.error(`🟥 [GLOBAL ERROR] Background processing error for job ${jobId}:`, error);
    console.log(`🟪 [GLOBAL] processJobInBackground END for jobId: ${jobId}`);
    
    // Only mark as failed if not already completed/cancelled
    let jobs = await loadJobs();
    let job = jobs[jobId];
    
    if (job && !["completed", "cancelled"].includes(job.status)) {
      job.status = "failed";
      job.error = error.message;
      job.failedAt = new Date().toISOString();
      
      // Also add to the errors array for visibility
      if (!job.errors) job.errors = [];
      job.errors.push({
        contactId: 'SYSTEM',
        error: `Job failed: ${error.message}`,
        timestamp: new Date().toISOString(),
        humanPattern: getCurrentHumanPattern().name
      });

      const errorJobs = await loadJobs();
      errorJobs[jobId] = job;
      await saveJobs(errorJobs);
    }
  } finally {
    // CRITICAL: Always cleanup the running process tracker
    runningProcesses.delete(jobId);
    console.log(`🧹 Cleaned up process tracker for job ${jobId}`);
  }
};
// Enhanced job status endpoint with human pattern info and synchronized stats
app.get("/job-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🔍 JOB STATUS REQUEST - Getting status for job ID: ${jobId}`);
    
    const jobs = await loadJobs();
    const job = jobs[jobId];

    if (!job) {
      console.log(`❌ Job with ID ${jobId} not found`);
      return res.status(404).json({
        success: false,
        message: "Job not found",
      });
    }

    // Check if job is stalled and needs restart
    const now = new Date();
    const lastProcessed = job.lastProcessedAt ? new Date(job.lastProcessedAt) : null;
    const timeSinceLastProcess = lastProcessed ? (now - lastProcessed) / 1000 : 0;
    
    // Enhanced stall detection
    const isStalled = job.status === "processing" && 
                     job.processedCount < job.totalContacts && 
                     (timeSinceLastProcess > 300 || // 5 minutes timeout
                      (job.stalledAt && timeSinceLastProcess > 60)); // 1 minute if marked as stalled
                     
    // Additional check for stuck pending contacts
    const pendingContacts = job.contacts ? job.contacts.filter(c => c.status === "pending") : [];
    const hasStuckContacts = job.status === "processing" && 
                            pendingContacts.length > 0 && 
                            timeSinceLastProcess > 120; // 2 minutes for stuck contacts
                     
    if (isStalled || hasStuckContacts) {
      console.log(`⚠️ Job ${jobId} appears stalled:`, {
        timeSinceLastProcess: Math.round(timeSinceLastProcess),
        pendingContacts: pendingContacts.length,
        reason: isStalled ? 'timeout' : 'stuck_contacts',
        stalledAt: job.stalledAt
      });
      
      if (hasStuckContacts) {
        console.log(`🔍 Stuck contacts found:`, pendingContacts.map(c => ({
          contactId: c.contactId,
          status: c.status,
          linkedinUrl: c.linkedinUrl
        })));
      }
      
      console.log(`🔄 Restarting background processing for job ${jobId}...`);
      
      // Clear stalled flags
      delete job.stalledAt;
      delete job.stalledReason;
      
      // Restart background processing
      setImmediate(() => processJobInBackground(jobId));
      
      // Update job status to indicate restart
      job.restartedAt = now.toISOString();
      job.restartCount = (job.restartCount || 0) + 1;
      job.lastProcessedAt = now.toISOString(); // Update to prevent immediate re-stall
      await saveJobs({ ...jobs, [jobId]: job });
    }

    // ENSURE synchronization happens BEFORE checking limits
    console.log(`🔄 Synchronizing job stats for user ${job.userId} before returning status`);
    await synchronizeJobWithDailyStats(job.userId, job);

    // AUTO-RESUME LOGIC: Check if paused job can be resumed
    if (job.status === "paused" && 
        (job.pauseReason === "hourly_limit_reached" || 
         job.pauseReason === "daily_limit_reached" || 
         job.pauseReason === "pattern_limit_reached")) {
      
      const pausedAt = job.pausedAt ? new Date(job.pausedAt) : null;
      const now = new Date();
      const hoursSincePause = pausedAt ? (now - pausedAt) / (1000 * 60 * 60) : 0;
      
      console.log(`🔍 Checking auto-resume for job ${jobId}:`, {
        pauseReason: job.pauseReason,
        pausedAt: job.pausedAt,
        hoursSincePause: Math.round(hoursSincePause * 100) / 100
      });
      
      // HOURLY LIMIT AUTO-RESUME: Check if hour has changed (hourly count naturally resets)
      if (job.pauseReason === "hourly_limit_reached" && pausedAt) {
        const pausedHour = pausedAt.getHours();
        const currentHour = now.getHours();
        const pausedDate = pausedAt.toISOString().split("T")[0];
        const currentDate = now.toISOString().split("T")[0];
        
        // Resume if it's a different hour or different day
        if (currentHour !== pausedHour || currentDate !== pausedDate) {
          console.log(`🔄 Auto-resuming job ${jobId} - Hour changed from ${pausedHour} to ${currentHour}, hourly limit naturally reset`);
          
          // CRITICAL: Resume the job (don't reset ALL stats, just resume since hourly count naturally reset)
          console.log(`📝 BEFORE RESUME: Job ${jobId} status = ${job.status}, pauseReason = ${job.pauseReason}`);
          job.status = "processing";
          delete job.pauseReason;
          delete job.pausedAt;
          delete job.estimatedResumeTime;
          job.resumedAt = new Date().toISOString();
          job.lastProcessedAt = new Date().toISOString();
          console.log(`📝 AFTER RESUME: Job ${jobId} status = ${job.status}, pauseReason = ${job.pauseReason}`);
          
          // Add automatic resume event to history
          const resumeEvent = {
            type: "resume",
            timestamp: new Date().toISOString(),
            reason: "automatic_hourly_reset",
            icon: "⏰",
            message: `Automatically resumed - new hour started (${pausedHour}:xx → ${currentHour}:xx)`,
            details: {
              waitedMinutes: Math.round(hoursSincePause * 60),
              pausedHour: pausedHour,
              currentHour: currentHour,
              resumeType: "natural_hourly_reset",
              statusChanged: "paused → processing"
            }
          };
          
          if (!job.pauseResumeHistory) job.pauseResumeHistory = [];
          job.pauseResumeHistory.push(resumeEvent);
          console.log(`📝 Automatic hourly resume event logged:`, resumeEvent);
          
          // CRITICAL: Save the job with updated status IMMEDIATELY
          await saveJobs({ ...jobs, [jobId]: job });
          console.log(`💾 Job ${jobId} saved with status: ${job.status}`);
          
          // Restart background processing
          console.log(`🚀 Restarting background processing for auto-resumed job ${jobId} after hourly reset`);
          setImmediate(() => processJobInBackground(jobId));
        }
      }
      // FULL RESET AUTO-RESUME: After 1 MINUTE (test mode), reset ALL limits (for daily/pattern limits or as fallback)
      else if (hoursSincePause >= (1/60)) { // TEST: 1 minute instead of 1 hour
        console.log(`🔄 Auto-resuming job ${jobId} - 1+ MINUTES passed (TEST MODE), resetting ALL limits`);
        
        // Reset ALL user stats to 0
        await resetUserStats(job.userId);
        console.log(`🧹 Cleared all daily stats for user ${job.userId}`);
        
        // CRITICAL: Resume the job with explicit status change
        console.log(`📝 BEFORE FULL RESUME: Job ${jobId} status = ${job.status}, pauseReason = ${job.pauseReason}`);
        job.status = "processing";
        delete job.pauseReason;
        delete job.pausedAt;
        delete job.estimatedResumeTime;
        job.resumedAt = new Date().toISOString();
        job.lastProcessedAt = new Date().toISOString();
        console.log(`📝 AFTER FULL RESUME: Job ${jobId} status = ${job.status}, pauseReason = ${job.pauseReason}`);
        
        // Add automatic resume event to history
        const resumeEvent = {
          type: "resume",
          timestamp: new Date().toISOString(),
          reason: "automatic_limits_reset_1hour",
          icon: "🔄",
          message: "Automatically resumed - all limits reset after 1 hour",
          details: {
            waitedHours: Math.round(hoursSincePause * 100) / 100,
            resetLimits: "daily, hourly, pattern counts all reset to 0",
            previousPauseReason: job.pauseReason,
            statusChanged: "paused → processing"
          }
        };
        
        if (!job.pauseResumeHistory) job.pauseResumeHistory = [];
        job.pauseResumeHistory.push(resumeEvent);
        console.log(`📝 Automatic 1-hour resume event logged:`, resumeEvent);
        
        // CRITICAL: Save the job with updated status IMMEDIATELY
        await saveJobs({ ...jobs, [jobId]: job });
        console.log(`💾 Job ${jobId} saved with status: ${job.status} after full reset`);
        
        // Restart background processing
        console.log(`🚀 Restarting background processing for auto-resumed job ${jobId} after limit reset`);
        setImmediate(() => processJobInBackground(jobId));
      }
    }

    // CHECK FOR COMPLETION - Fix for jobs that finished but status wasn't updated
    if (job.status === "processing") {
      const remainingPending = job.contacts ? job.contacts.filter(c => c.status === "pending").length : 0;
      const allContactsProcessed = job.processedCount >= job.totalContacts;
      
      if (remainingPending === 0 && allContactsProcessed) {
        console.log(`🔧 Auto-completing job ${jobId} - all contacts are done but status was still processing`);
        const now = new Date().toISOString();
        
        job.status = "completed";
        job.completedAt = now;
        job.currentBatchIndex = 0;
        job.completionReason = "auto_completed_by_status_check";
        
        // FIX: Set cooldownOverridden = true for auto-completion as well
        job.cooldownOverridden = true;
        job.overriddenAt = now;
        job.overrideReason = "auto_completion_status_check";
        
        // Save the updated job to both memory and MongoDB
        jobs[jobId] = job;
        await saveJobs(jobs);
        
        // CRITICAL: Also update the MongoDB document directly
        try {
          await Job.findOneAndUpdate(
            { jobId: jobId },
            { 
              status: "completed",
              completedAt: new Date(),
              currentBatchIndex: 0,
              completionReason: "auto_completed_by_status_check",
              cooldownOverridden: true,
              overriddenAt: new Date(),
              overrideReason: "auto_completion_status_check"
            },
            { new: true }
          );
          console.log(`✅ Job ${jobId} auto-completed successfully in both memory and MongoDB with cooldownOverridden: true`);
        } catch (mongoError) {
          console.error(`❌ Error updating MongoDB for job ${jobId}:`, mongoError);
        }
      }
    }

    // Include current pattern and daily limit info
    const userSessions = await loadUserSessions();
    const userSession = userSessions[job.userId];
    const jobCrmUrl = userSession?.crmUrl;
    const limitCheck = await checkDailyLimit(job.userId, jobCrmUrl);
    
    // SIMPLE HOURLY RESUME: Only resume if explicitly paused due to hourly limit and hourly count reset
    if (job.status === "paused" && 
        job.pauseReason === "hourly_limit_reached" && 
        limitCheck && 
        limitCheck.hourlyCount === 0 && 
        limitCheck.canProcess) {
      
      console.log(`🔍 JOB-STATUS PAUSE DEBUG for job ${jobId}:`, {
        status: job.status,
        pauseReason: job.pauseReason,
        hourlyCount: limitCheck.hourlyCount,
        canProcess: limitCheck.canProcess,
        processedCount: job.processedCount,
        totalContacts: job.totalContacts,
        patternCountFromAPI: limitCheck.patternCount
      });
      
      console.log(`🔄 SIMPLE HOURLY RESUME: Job ${jobId} - hourly limit reset, resuming processing`);
      console.log(`📊 Limit check: canProcess=${limitCheck.canProcess}, hourlyCount=${limitCheck.hourlyCount}`);
      
      job.status = "processing";
      delete job.pauseReason;
      delete job.pausedAt;
      job.resumedAt = new Date().toISOString();
      await saveJobs({ ...jobs, [jobId]: job });
      console.log(`✅ Job ${jobId} status changed to processing (hourly count: ${limitCheck.hourlyCount})`);
      setImmediate(() => processJobInBackground(jobId));
    } else if (job.status === "paused") {
      console.log(`⏸️ Job ${jobId} remains paused. Reason: ${job.pauseReason || 'MISSING'}, hourlyCount: ${limitCheck?.hourlyCount}, canProcess: ${limitCheck?.canProcess}`);
      console.log(`📊 Limits: daily=${limitCheck?.dailyCount}/${limitCheck?.dailyLimit}, hourly=${limitCheck?.hourlyCount}/${limitCheck?.hourlyLimit}, pattern=${limitCheck?.patternCount}/${limitCheck?.patternLimit}`);
    }
    
    const currentPattern = getCurrentHumanPattern();
    
    // Format dates properly
    const formatDate = (date) => {
      if (!date) return null;
      try {
        const d = new Date(date);
        // Check if date is valid
        if (isNaN(d.getTime())) return null;
        return d.toISOString();
      } catch (e) {
        console.error("Invalid date:", date, e);
        return null;
      }
    };
    
    // Get most accurate timestamp for each field
    const createdAt = formatDate(job.createdAt) || formatDate(job.startTime) || null;
    const lastProcessedAt = formatDate(job.lastProcessedAt) || formatDate(job.lastProcessedTime) || null;
    const completedAt = formatDate(job.completedAt) || null;
    const failedAt = formatDate(job.failedAt) || null;

    // Calculate hourly wait time if limit is reached
    const calculateHourlyWaitTime = () => {
      if (!limitCheck || limitCheck.hourlyCount < limitCheck.hourlyLimit) {
        return { needsWait: false, waitMinutes: 0, waitUntil: null };
      }
      
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0); // Next hour at :00 minutes
      
      const waitTimeMs = nextHour.getTime() - now.getTime();
      const waitMinutes = Math.ceil(waitTimeMs / (1000 * 60));
      
      return {
        needsWait: true,
        waitMinutes: waitMinutes,
        waitUntil: nextHour.toISOString(),
        waitMessage: `${waitMinutes} minutes until next hour`
      };
    };
    
    const hourlyWaitInfo = calculateHourlyWaitTime();

    console.log(`✅ Returning job status for ${jobId}:`, {
      status: job.status,
      processed: job.processedCount,
      total: job.totalContacts,
      timestamps: { createdAt, lastProcessedAt, completedAt },
      stalled: isStalled,
      timeSinceLastProcess: Math.round(timeSinceLastProcess),
      hourlyLimits: limitCheck ? { 
        current: limitCheck.hourlyCount, 
        limit: limitCheck.hourlyLimit,
        needsWait: hourlyWaitInfo.needsWait,
        waitMinutes: hourlyWaitInfo.waitMinutes
      } : null
    });

    // Function to get user-friendly pause messages
    const getPauseDisplayInfo = (pauseReason, limitCheck) => {
      if (!pauseReason) return null;
      
      const pauseMessages = {
        'hourly_limit_reached': `Saatlik limit aşıldı (${limitCheck?.hourlyCount || 0}/${limitCheck?.hourlyLimit || 20}). Yeni saatte otomatik devam edecek.`,
        'daily_limit_reached': `Günlük limit aşıldı (${limitCheck?.dailyCount || 0}/${limitCheck?.dailyLimit || 180}). Yarın otomatik devam edecek.`,
        'pattern_limit_reached': `Pattern limiti aşıldı (${limitCheck?.currentPattern || 'unknown'}). Sonraki aktif dönemde devam edecek.`,
        'pause_period': `Dinlenme zamanı (${limitCheck?.currentPattern || 'unknown'} pattern). Aktif dönemde otomatik devam edecek.`,
        'limit_reached': 'Genel limit aşıldı. Otomatik olarak devam edecek.',
        'user_session_missing': 'Kullanıcı oturumu eksik. Lütfen extension üzerinden tekrar bağlanın.',
        'linkedin_session_invalid': 'LinkedIn oturumu geçersiz. Lütfen LinkedIn\'e tekrar giriş yapın.',
        'dataverse_session_invalid': 'Dataverse oturumu geçersiz. Lütfen token\'ı yenileyin.',
        'token_refresh_failed': 'Token yenileme başarısız. Lütfen tekrar yetkilendirin.',
        'session_not_found': 'Oturum bulunamadı. Lütfen extension üzerinden tekrar bağlanın.',
        'session_check_failed': 'Oturum kontrolü başarısız. Sistem hatası oluştu.'
      };
      
      return {
        code: pauseReason,
        message: pauseMessages[pauseReason] || `Bilinmeyen sebep: ${pauseReason}`,
        isAutoResumable: ['hourly_limit_reached', 'daily_limit_reached', 'pattern_limit_reached', 'pause_period', 'limit_reached'].includes(pauseReason),
        needsUserAction: ['user_session_missing', 'linkedin_session_invalid', 'dataverse_session_invalid', 'token_refresh_failed', 'session_not_found'].includes(pauseReason)
      };
    };

    const pauseDisplayInfo = getPauseDisplayInfo(job.pauseReason, limitCheck);

    res.status(200).json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        createdAt: createdAt,
        lastProcessedAt: lastProcessedAt,
        completedAt: completedAt,
        failedAt: failedAt,
        errors: job.errors,
        pauseReason: job.pauseReason,
        // ENHANCED: Detailed pause information for frontend
        pauseDisplayInfo: pauseDisplayInfo,
        pausedAt: job.pausedAt,
        // NEW: Unauthorized status flag for frontend
        needsTokenRefresh: job.pauseReason === 'token_refresh_failed',
        authError: job.pauseReason === 'token_refresh_failed' ? {
          type: 'TOKEN_REFRESH_FAILED',
          message: 'Authentication token expired. Please refresh token to continue.',
          lastError: job.lastError
        } : null,
        estimatedResumeTime: job.estimatedResumeTime,
        humanPatterns: job.humanPatterns,
        dailyStats: job.dailyStats,
        currentPattern: currentPattern.name,
        currentPatternInfo: currentPattern,
        dailyLimitInfo: limitCheck,
        // NEW: Hourly limit information
        hourlyLimitInfo: limitCheck ? {
          hourlyCount: limitCheck.hourlyCount,
          hourlyLimit: limitCheck.hourlyLimit,
          hourlyLimitReached: limitCheck.hourlyCount >= limitCheck.hourlyLimit,
          waitInfo: hourlyWaitInfo
        } : null,
        isStalled: isStalled,
        restartCount: job.restartCount || 0,
        timeSinceLastProcess: Math.round(timeSinceLastProcess)
      },
      simpleClientStats: null, // Frontend expects this property
      simpleClientInitialized: true // Frontend expects this property
    });
  } catch (error) {
    console.error("❌ Error getting job status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Enhanced user job endpoint with job age tracking and better memory
app.get("/user-job/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    
    console.log(`🔍 Checking job for user ${userId}:`, 
      userSession ? 
      { hasSession: true, currentJobId: userSession.currentJobId, crmUrl: normalizeCrmUrl(userSession.crmUrl || '') } : 
      { hasSession: false }
    );

    // If no direct session, check for CRM-shared jobs
    let sharedJobId = null;
    if (!userSession || !userSession.currentJobId) {
      if (userSession?.crmUrl) {
        const normalizedCrm = normalizeCrmUrl(userSession.crmUrl);
        const jobs = await loadJobs();
        
        // Look for any job from same CRM
        for (const job of Object.values(jobs)) {
          const jobUserSession = userSessions[job.userId];
          
          // Check job age - ignore jobs older than 24 hours to prevent old job conflicts
          const jobCreatedAt = new Date(job.createdAt || job.startTime || Date.now());
          const jobAgeInHours = (Date.now() - jobCreatedAt.getTime()) / (1000 * 60 * 60);
          
          // Skip old jobs (older than 24 hours) to avoid conflicts with fresh starts
          if (jobAgeInHours > 24) {
            continue;
          }
          
          if (jobUserSession?.crmUrl && 
              normalizeCrmUrl(jobUserSession.crmUrl) === normalizedCrm &&
              job.status !== "completed" &&
              job.contacts && 
              job.processedCount < job.totalContacts) {
            sharedJobId = job.jobId;
            console.log(`📋 Found recent CRM-shared job for user ${userId}:`, {
              jobId: job.jobId,
              originalCreator: job.userId,
              crmUrl: normalizedCrm,
              ageInHours: Math.round(jobAgeInHours * 100) / 100
            });
            break;
          }
        }
      }
      
      if (!sharedJobId) {
        const limitCheck = await checkDailyLimit(userId, userSession?.crmUrl);
        console.log(`❌ No active job found for user ${userId}`);
        
        // **DEBUG: Log why no job was found**
        console.log("🔍 DEBUG: No Job Found Analysis:", {
          userId: userId,
          hasUserSession: !!userSession,
          userSessionJobId: userSession?.currentJobId || null,
          searchedForSharedJob: true,
          foundSharedJob: false,
          totalJobsChecked: jobs ? Object.keys(jobs).length : 0,
          userSessionDetails: userSession ? {
            currentJobId: userSession.currentJobId,
            crmUrl: userSession.crmUrl,
            hasSession: true
          } : { hasSession: false }
        });
        
        return res.status(200).json({
          success: false,
          message: "No active job found for user",
          canResume: false,
          job: null,
          currentPattern: getCurrentHumanPattern().name,
          limitInfo: limitCheck,
        });
      }
    }

    const jobs = await loadJobs();
    const jobId = sharedJobId || userSession.currentJobId;
    const job = jobs[jobId];
    
    console.log("🔍 DEBUG: Memory Load Check for /user-job:", {
      userId: userId,
      totalJobsInMemory: Object.keys(jobs).length,
      userSessionExists: !!userSession,
      currentJobId: userSession?.currentJobId || null,
      sharedJobId: sharedJobId || null,
      finalJobId: jobId,
      jobExistsInMemory: !!jobs[jobId],
      allJobIds: Object.keys(jobs).slice(0, 10) // Show first 10 job IDs
    });
    
    if (!job) {
      console.error(`❌ Job ${jobId} not found for user ${userId}`);
      return res.status(200).json({
        success: false,
        message: `Job with ID ${jobId} not found`,
        canResume: false,
        job: null,
        currentPattern: getCurrentHumanPattern().name,
      });
    }

    // If this is a shared job, make sure user is added to participants
    if (sharedJobId && job.participants && !job.participants.includes(userId)) {
      job.participants.push(userId);
      await saveJobs({ ...jobs, [jobId]: job });
      console.log(`✅ Added user ${userId} to shared job participants`);
    }

    // Calculate job age
    const jobCreatedAt = new Date(job.createdAt || job.startTime || Date.now());
    const jobAgeInDays = Math.floor((Date.now() - jobCreatedAt.getTime()) / (1000 * 60 * 60 * 24));
    const jobAgeInHours = Math.floor((Date.now() - jobCreatedAt.getTime()) / (1000 * 60 * 60));
    
    console.log(`📊 Job age check for ${userId}:`, {
      jobId: job.jobId,
      status: job.status,
      ageInDays: jobAgeInDays,
      ageInHours: jobAgeInHours,
      processedCount: job.processedCount,
      totalContacts: job.totalContacts
    });

    // Synchronize the job stats with daily stats
    console.log(`🔄 Synchronizing job stats for user ${userId}`);
    await synchronizeJobWithDailyStats(userId, job);

    const limitCheck = await checkDailyLimit(userId, userSession?.crmUrl);

    // SIMPLE HOURLY RESUME: Only resume if explicitly paused due to hourly limit and hourly count reset
    if (job.status === "paused" && 
        job.pauseReason === "hourly_limit_reached" && 
        limitCheck && 
        limitCheck.hourlyCount === 0 && 
        limitCheck.canProcess) {
      
      console.log(`🔍 USER-JOB PAUSE DEBUG for job ${jobId}:`, {
        status: job.status,
        pauseReason: job.pauseReason,
        hourlyCount: limitCheck.hourlyCount,
        canProcess: limitCheck.canProcess,
        processedCount: job.processedCount,
        totalContacts: job.totalContacts,
        patternCountFromAPI: limitCheck.patternCount
      });
      
      console.log(`🔄 SIMPLE HOURLY RESUME (user-job): Job ${jobId} - hourly limit reset, resuming processing`);
      console.log(`📊 Limit check: canProcess=${limitCheck.canProcess}, hourlyCount=${limitCheck.hourlyCount}`);
      
      job.status = "processing";
      delete job.pauseReason;
      delete job.pausedAt;
      job.resumedAt = new Date().toISOString();
      await saveJobs({ ...jobs, [jobId]: job });
      console.log(`✅ Job ${jobId} status changed to processing (hourly count: ${limitCheck.hourlyCount})`);
      setImmediate(() => processJobInBackground(jobId));
    } else if (job.status === "paused") {
      console.log(`⏸️ Job ${jobId} remains paused in user-job. Reason: ${job.pauseReason || 'MISSING'}, hourlyCount: ${limitCheck?.hourlyCount}, canProcess: ${limitCheck?.canProcess}`);
      console.log(`📊 Limits: daily=${limitCheck?.dailyCount}/${limitCheck?.dailyLimit}, hourly=${limitCheck?.hourlyCount}/${limitCheck?.hourlyLimit}, pattern=${limitCheck?.patternCount}/${limitCheck?.patternLimit}`);
    }

    // AUTO-RESUME LOGIC: Check if paused job can be resumed
    if (job.status === "paused" && 
        (job.pauseReason === "hourly_limit_reached" || 
         job.pauseReason === "daily_limit_reached" || 
         job.pauseReason === "pattern_limit_reached")) {
      
      const pausedAt = job.pausedAt ? new Date(job.pausedAt) : null;
      const now = new Date();
      const hoursSincePause = pausedAt ? (now - pausedAt) / (1000 * 60 * 60) : 0;
      
      console.log(`🔍 Checking auto-resume for job ${jobId} in user-job endpoint:`, {
        pauseReason: job.pauseReason,
        pausedAt: job.pausedAt,
        hoursSincePause: Math.round(hoursSincePause * 100) / 100
      });
      
      // HOURLY LIMIT AUTO-RESUME: Check if hour has changed (hourly count naturally resets)
      if (job.pauseReason === "hourly_limit_reached" && pausedAt) {
        const pausedHour = pausedAt.getHours();
        const currentHour = now.getHours();
        const pausedDate = pausedAt.toISOString().split("T")[0];
        const currentDate = now.toISOString().split("T")[0];
        
        // Resume if it's a different hour or different day
        if (currentHour !== pausedHour || currentDate !== pausedDate) {
          console.log(`🔄 Auto-resuming job ${jobId} in user-job - Hour changed from ${pausedHour} to ${currentHour}, hourly limit naturally reset`);
          
          // CRITICAL: Resume the job (don't reset ALL stats, just resume since hourly count naturally reset)
          console.log(`📝 USER-JOB BEFORE RESUME: Job ${jobId} status = ${job.status}, pauseReason = ${job.pauseReason}`);
          job.status = "processing";
          delete job.pauseReason;
          delete job.pausedAt;
          delete job.estimatedResumeTime;
          job.resumedAt = new Date().toISOString();
          job.lastProcessedAt = new Date().toISOString();
          console.log(`📝 USER-JOB AFTER RESUME: Job ${jobId} status = ${job.status}, pauseReason = ${job.pauseReason}`);
          
          // Add automatic resume event to history
          const resumeEvent = {
            type: "resume",
            timestamp: new Date().toISOString(),
            reason: "automatic_hourly_reset",
            icon: "⏰",
            message: `Automatically resumed - new hour started (${pausedHour}:xx → ${currentHour}:xx)`,
            details: {
              waitedMinutes: Math.round(hoursSincePause * 60),
              pausedHour: pausedHour,
              currentHour: currentHour,
              resumeType: "natural_hourly_reset",
              statusChanged: "paused → processing",
              endpoint: "user-job"
            }
          };
          
          if (!job.pauseResumeHistory) job.pauseResumeHistory = [];
          job.pauseResumeHistory.push(resumeEvent);
          console.log(`📝 Automatic hourly resume event logged in user-job:`, resumeEvent);
          
          // CRITICAL: Save the job with updated status IMMEDIATELY
          await saveJobs({ ...jobs, [jobId]: job });
          console.log(`💾 USER-JOB: Job ${jobId} saved with status: ${job.status}`);
          
          // Restart background processing
          console.log(`🚀 Restarting background processing for auto-resumed job ${jobId} from user-job after hourly reset`);
          setImmediate(() => processJobInBackground(jobId));
        }
      }
      // FULL RESET AUTO-RESUME: After 1 MINUTE (test mode), reset ALL limits (for daily/pattern limits or as fallback)
      else if (hoursSincePause >= (1/60)) { // TEST: 1 minute instead of 1 hour
        console.log(`🔄 Auto-resuming job ${jobId} in user-job - 1+ MINUTES passed (TEST MODE), resetting ALL limits`);
        
        // Reset ALL user stats to 0
        await resetUserStats(userId);
        console.log(`🧹 Cleared all daily stats for user ${userId} in user-job endpoint`);
        
        // Resume the job
        job.status = "processing";
        delete job.pauseReason;
        delete job.pausedAt;
        delete job.estimatedResumeTime;
        job.resumedAt = new Date().toISOString();
        job.lastProcessedAt = new Date().toISOString();
        
        // Add automatic resume event to history
        const resumeEvent = {
          type: "resume",
          timestamp: new Date().toISOString(),
          reason: "automatic_limits_reset_1hour",
          icon: "🔄",
          message: "Automatically resumed - all limits reset after 1 hour",
          details: {
            waitedHours: Math.round(hoursSincePause * 100) / 100,
            resetLimits: "daily, hourly, pattern counts all reset to 0",
            previousPauseReason: job.pauseReason
          }
        };
        
        if (!job.pauseResumeHistory) job.pauseResumeHistory = [];
        job.pauseResumeHistory.push(resumeEvent);
        console.log(`📝 Automatic 1-hour resume event logged in user-job:`, resumeEvent);
        
        await saveJobs({ ...jobs, [jobId]: job });
        
        // Restart background processing
        console.log(`🚀 Restarting background processing for auto-resumed job ${jobId} from user-job after limit reset`);
        setImmediate(() => processJobInBackground(jobId));
      }
    }

    const currentPattern = getCurrentHumanPattern();

    // Calculate hourly wait time if limit is reached
    const calculateHourlyWaitTime = () => {
      if (!limitCheck || limitCheck.hourlyCount < limitCheck.hourlyLimit) {
        return { needsWait: false, waitMinutes: 0, waitUntil: null };
      }
      
      const now = new Date();
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0); // Next hour at :00 minutes
      
      const waitTimeMs = nextHour.getTime() - now.getTime();
      const waitMinutes = Math.ceil(waitTimeMs / (1000 * 60));
      
      return {
        needsWait: true,
        waitMinutes: waitMinutes,
        waitUntil: nextHour.toISOString(),
        waitMessage: `${waitMinutes} minutes until next hour`
      };
    };
    
    const hourlyWaitInfo = calculateHourlyWaitTime();

    // Format dates properly
    const formatDate = (date) => {
      if (!date) return null;
      try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return null;
        return d.toISOString();
      } catch (e) {
        console.error("Invalid date:", date, e);
        return null;
      }
    };
    
    const createdAt = formatDate(job.createdAt) || formatDate(job.startTime) || null;
    const lastProcessedAt = formatDate(job.lastProcessedAt) || formatDate(job.lastProcessedTime) || null;
    const completedAt = formatDate(job.completedAt) || null;
    const failedAt = formatDate(job.failedAt) || null;
    
    console.log("✅ Sending job data with age tracking:", { 
      jobId: job.jobId,
      ageInDays: jobAgeInDays,
      processedCount: job.processedCount,
      totalContacts: job.totalContacts,
      createdAt, 
      lastProcessedAt, 
      completedAt 
    });

    // Function to get user-friendly pause messages
    const getPauseDisplayInfo = (pauseReason, limitCheck) => {
      if (!pauseReason) return null;
      
      const pauseMessages = {
        'hourly_limit_reached': `Saatlik limit aşıldı (${limitCheck?.hourlyCount || 0}/${limitCheck?.hourlyLimit || 20}). Yeni saatte otomatik devam edecek.`,
        'daily_limit_reached': `Günlük limit aşıldı (${limitCheck?.dailyCount || 0}/${limitCheck?.dailyLimit || 180}). Yarın otomatik devam edecek.`,
        'pattern_limit_reached': `Pattern limiti aşıldı (${limitCheck?.currentPattern || 'unknown'}). Sonraki aktif dönemde devam edecek.`,
        'pause_period': `Dinlenme zamanı (${limitCheck?.currentPattern || 'unknown'} pattern). Aktif dönemde otomatik devam edecek.`,
        'limit_reached': 'Genel limit aşıldı. Otomatik olarak devam edecek.',
        'user_session_missing': 'Kullanıcı oturumu eksik. Lütfen extension üzerinden tekrar bağlanın.',
        'linkedin_session_invalid': 'LinkedIn oturumu geçersiz. Lütfen LinkedIn\'e tekrar giriş yapın.',
        'dataverse_session_invalid': 'Dataverse oturumu geçersiz. Lütfen token\'ı yenileyin.',
        'token_refresh_failed': 'Token yenileme başarısız. Lütfen tekrar yetkilendirin.',
        'session_not_found': 'Oturum bulunamadı. Lütfen extension üzerinden tekrar bağlanın.',
        'session_check_failed': 'Oturum kontrolü başarısız. Sistem hatası oluştu.'
      };
      
      return {
        code: pauseReason,
        message: pauseMessages[pauseReason] || `Bilinmeyen sebep: ${pauseReason}`,
        isAutoResumable: ['hourly_limit_reached', 'daily_limit_reached', 'pattern_limit_reached', 'pause_period', 'limit_reached'].includes(pauseReason),
        needsUserAction: ['user_session_missing', 'linkedin_session_invalid', 'dataverse_session_invalid', 'token_refresh_failed', 'session_not_found'].includes(pauseReason)
      };
    };

    const pauseDisplayInfo = getPauseDisplayInfo(job.pauseReason, limitCheck);

    // **DEBUG: Log exact response before sending**
    const responseObject = {
      success: true,
      canResume: job.status === "paused" || job.status === "processing",
      authStatus: {
        linkedinValid: !job.pauseReason?.includes("linkedin_session"),
        dataverseValid: !job.pauseReason?.includes("dataverse_session"),
        lastError: job.lastError || null,
        needsReauth: job.pauseReason?.includes("_session_invalid") || false
      },
      job: {
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        createdAt: createdAt,
        lastProcessedAt: lastProcessedAt,
        completedAt: completedAt,
        failedAt: failedAt,
        pauseReason: job.pauseReason,
        // ENHANCED: Detailed pause information for frontend
        pauseDisplayInfo: pauseDisplayInfo,
        pausedAt: job.pausedAt,
        // NEW: Unauthorized status flag for frontend
        needsTokenRefresh: job.pauseReason === 'token_refresh_failed',
        authError: job.pauseReason === 'token_refresh_failed' ? {
          type: 'TOKEN_REFRESH_FAILED',
          message: 'Authentication token expired. Please refresh token to continue.',
          lastError: job.lastError
        } : null,
        lastError: job.lastError,
        dailyStats: job.dailyStats,
        humanPatterns: job.humanPatterns,
        currentPattern: currentPattern.name,
        currentPatternInfo: currentPattern,
        dailyLimitInfo: limitCheck,
        // NEW: Hourly limit information
        hourlyLimitInfo: limitCheck ? {
          hourlyCount: limitCheck.hourlyCount,
          hourlyLimit: limitCheck.hourlyLimit,
          hourlyLimitReached: limitCheck.hourlyCount >= limitCheck.hourlyLimit,
          waitInfo: hourlyWaitInfo
        } : null,
        // Enhanced job age tracking
        jobAge: {
          days: jobAgeInDays,
          hours: jobAgeInHours,
          createdTimestamp: jobCreatedAt.getTime(),
          isOld: jobAgeInDays > 1, // Flag jobs older than 1 day
          isVeryOld: jobAgeInDays > 7 // Flag jobs older than 1 week
        },
  // **ADD COOLDOWN OVERRIDE INFO** from job object
  cooldownOverridden: job.cooldownOverridden || false,
  overriddenAt: job.overriddenAt || null
      },
      simpleClientStats: null,
      simpleClientInitialized: true
    };
    
    console.log("🔍 DEBUG: Memory vs Response Debug for /user-job:", {
      userId: userId,
      memoryJobExists: !!job,
      jobFromMemory: job ? {
        jobId: job.jobId,
        status: job.status,
        processedCount: job.processedCount,
        totalContacts: job.totalContacts
      } : null,
      responseSuccess: responseObject.success,
      responseJobExists: !!responseObject.job,
      responseJobId: responseObject.job?.jobId || 'null',
      source: 'file_system_memory',
      timestamp: new Date().toISOString()
    });
    
    console.log("🔍 API Response for /user-job:", JSON.stringify(responseObject, null, 2));

    // **PREVENT 304 CACHING** - Add no-cache headers to force fresh response
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache', 
      'Expires': '0',
      'ETag': `"${Date.now()}-${Math.random()}"` // Unique ETag to prevent 304
    });

    res.status(200).json(responseObject);
  } catch (error) {
    console.error("❌ Error getting user job:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Debug endpoint to check job memory and session persistence
app.get("/debug-job-memory/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const userSessions = await loadUserSessions();
    const jobs = await loadJobs();
    const userSession = userSessions[userId];
    
    const debugInfo = {
      userId,
      timestamp: new Date().toISOString(),
      userSession: {
        exists: !!userSession,
        currentJobId: userSession?.currentJobId || null,
        lastActivity: userSession?.lastActivity || null,
        sessionKeys: userSession ? Object.keys(userSession) : [],
      },
      allUserSessions: {
        totalUsers: Object.keys(userSessions).length,
        userIds: Object.keys(userSessions),
      },
      jobs: {
        totalJobs: Object.keys(jobs).length,
        allJobIds: Object.keys(jobs),
        userJobs: Object.values(jobs).filter(job => job.userId === userId).map(job => ({
          jobId: job.jobId,
          status: job.status,
          createdAt: job.createdAt,
          processedCount: job.processedCount,
          totalContacts: job.totalContacts
        }))
      },
      jobForCurrentSession: null
    };
    
    if (userSession?.currentJobId) {
      const currentJob = jobs[userSession.currentJobId];
      if (currentJob) {
        const jobAge = currentJob.createdAt ? 
          Math.floor((Date.now() - new Date(currentJob.createdAt).getTime()) / (1000 * 60 * 60 * 24)) : 
          'unknown';
          
        debugInfo.jobForCurrentSession = {
          jobId: currentJob.jobId,
          status: currentJob.status,
          ageInDays: jobAge,
          processedCount: currentJob.processedCount,
          totalContacts: currentJob.totalContacts,
          createdAt: currentJob.createdAt,
          lastProcessedAt: currentJob.lastProcessedAt,
          canResume: currentJob.status === "paused" || currentJob.status === "processing"
        };
      } else {
        debugInfo.jobForCurrentSession = {
          error: `Job ${userSession.currentJobId} not found in jobs collection`
        };
      }
    }
    
    console.log("🔍 Debug job memory for user:", userId, debugInfo);
    
    res.status(200).json({
      success: true,
      debug: debugInfo
    });
    
  } catch (error) {
    console.error("Error in debug-job-memory endpoint:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Enhanced daily limits endpoint with pattern info
app.get("/daily-limits/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limitCheck = await checkDailyLimit(userId);
    const currentPattern = getCurrentHumanPattern();

    res.status(200).json({
      success: true,
      limits: limitCheck,
      currentPattern: {
        name: currentPattern.name,
        info: currentPattern,
        isActive: !currentPattern.pause,
      },
      allPatterns: HUMAN_PATTERNS,
    });
  } catch (error) {
    console.error("❌ Error checking daily limits:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Endpoint to synchronize job stats with daily stats
app.post("/synchronize-job-stats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Find the user's current job
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    
    if (!userSession || !userSession.currentJobId) {
      return res.status(404).json({
        success: false,
        message: "No active job found for this user"
      });
    }
    
    const jobs = await loadJobs();
    const job = jobs[userSession.currentJobId];
    
    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found"
      });
    }
    
    // Synchronize the stats
    await synchronizeJobWithDailyStats(userId, job);
    
    res.status(200).json({
      success: true,
      message: "Job stats synchronized successfully",
      job: {
        jobId: job.jobId,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        dailyStats: job.dailyStats
      }
    });
  } catch (error) {
    console.error("❌ Error synchronizing job stats:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

// Yeni endpoint: Polling işlemi için frontend tarafından kullanılacak
// Bu endpoint hem job durumunu kontrol eder hem de gerekirse işlemi devam ettirir
app.get("/job-poll/:userId", async (req, res) => {
  try {
    console.log(`🔄 Job poll request for user: ${req.params.userId}`);
    
    const userId = req.params.userId;
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    
    if (!userSession || !userSession.currentJobId) {
      console.log(`❌ No active job found for user ${userId} during polling`);
      return res.status(200).json({
        success: false,
        message: "No active job found for user",
        canResume: false,
        job: null,
        currentPattern: getCurrentHumanPattern().name,
      });
    }
    
    const jobs = await loadJobs();
    const jobId = userSession.currentJobId;
    const job = jobs[jobId];
    
    console.log(`🔍 Job poll check for ${userId}:`, 
      job ? 
      { 
        jobId: job.jobId, 
        status: job.status, 
        processedCount: job.processedCount, 
        totalContacts: job.totalContacts 
      } : 
      { jobFound: false, jobId: userSession.currentJobId }
    );
    
    if (!job) {
      console.error(`❌ Job ${userSession.currentJobId} not found for user ${userId} during polling`);
      return res.status(200).json({
        success: false,
        message: `Job with ID ${userSession.currentJobId} not found`,
        canResume: false,
        job: null,
        currentPattern: getCurrentHumanPattern().name,
      });
    }
    
    // Synchronize the job stats with daily stats
    await synchronizeJobWithDailyStats(userId, job);
    
    // Check if the job is in "processing" state but actually not running
    // If it's stuck in processing state, restart it
    if (job.status === "processing" && job.processedCount < job.totalContacts) {
      const lastProcessedTime = job.lastProcessedTime ? new Date(job.lastProcessedTime) : null;
      const now = new Date();
      
      // If no processing happened in the last 3 minutes, it might be stuck
      if (!lastProcessedTime || (now - lastProcessedTime > 3 * 60 * 1000)) {
        console.log(`⚠️ Job ${job.jobId} seems stuck in processing state. Restarting...`);
        
        // Use setImmediate to restart processing in background
        setImmediate(() => processJobInBackground(job.jobId));
      }
    }
    
    // If the job is paused, check if it's time to resume
    if (job.status === "paused") {
      // Check if paused due to limits that might have reset
      if (job.pauseReason === "limit_reached" || 
          job.pauseReason === "pattern_limit_reached" ||
          job.pauseReason === "hourly_limit_reached" ||
          job.pauseReason === "daily_limit_reached" ||
          job.pauseReason === "pause_period") {
        
        const limitCheck = await checkDailyLimit(userId);
        
        // If we can process now, resume the job
        if (limitCheck.canProcess) {
          console.log(`✅ Limits have reset, resuming paused job ${job.jobId}`);
          
          // Initialize resume history if not exists
          if (!job.resumeHistory) {
            job.resumeHistory = [];
          }

          // Add automatic resume event to history
          const resumeEvent = {
            timestamp: new Date().toISOString(),
            reason: "automatic_limits_reset",
            previousPauseReason: job.pauseReason,
            pauseDuration: job.pausedAt ? 
              Math.round((new Date() - new Date(job.pausedAt)) / 1000) : null,
            processedCount: job.processedCount,
            totalContacts: job.totalContacts,
            limitStatus: {
              daily: `${limitCheck.dailyCount}/${limitCheck.dailyLimit}`,
              hourly: `${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}`,
              pattern: `${limitCheck.patternCount}/${limitCheck.patternLimit || '∞'}`
            }
          };

          job.resumeHistory.push(resumeEvent);
          console.log(`📝 Automatic resume event logged:`, resumeEvent);
          
          job.status = "processing";
          job.resumedAt = new Date().toISOString();
          await saveJobs({...(await loadJobs()), [jobId]: job});
          
          // Use setImmediate to restart processing in background
          setImmediate(() => processJobInBackground(jobId));
        }
      }
    }
    
    const limitCheck = await checkDailyLimit(userId);
    const currentPattern = getCurrentHumanPattern();

    // Format dates properly
    const formatDate = (date) => {
      if (!date) return null;
      try {
        const d = new Date(date);
        // Check if date is valid
        if (isNaN(d.getTime())) return null;
        return d.toISOString();
      } catch (e) {
        console.error("Invalid date:", date, e);
        return null;
      }
    };
    
    // Get most accurate timestamp for each field
    const createdAt = formatDate(job.createdAt) || formatDate(job.startTime) || null;
    const lastProcessedAt = formatDate(job.lastProcessedAt) || formatDate(job.lastProcessedTime) || null;
    const completedAt = formatDate(job.completedAt) || null;
    const failedAt = formatDate(job.failedAt) || null;
    
    console.log(`📊 Job poll response: ${job.processedCount}/${job.totalContacts}, status: ${job.status}`);
    
    // Format pause/resume history for user display
    const formatPauseResumeHistory = () => {
      const events = [];
      
      // Add pause events
      if (job.pauseHistory && job.pauseHistory.length > 0) {
        job.pauseHistory.forEach(pause => {
          events.push({
            type: "pause",
            timestamp: pause.timestamp,
            reason: pause.reason,
            details: {
              limits: pause.limits,
              pattern: pause.currentPattern,
              estimatedResumeTime: pause.estimatedResumeTime,
              batchProgress: `${pause.batchIndex}/${pause.totalBatches}`,
              processedInSession: pause.processedInThisSession
            },
            displayMessage: getPauseDisplayMessage(pause)
          });
        });
      }
      
      // Add resume events
      if (job.resumeHistory && job.resumeHistory.length > 0) {
        job.resumeHistory.forEach(resume => {
          events.push({
            type: "resume",
            timestamp: resume.timestamp,
            reason: resume.reason,
            details: {
              previousPauseReason: resume.previousPauseReason,
              pauseDuration: resume.pauseDuration,
              processedCount: resume.processedCount,
              limitStatus: resume.limitStatus
            },
            displayMessage: getResumeDisplayMessage(resume)
          });
        });
      }
      
      // Add break events
      if (job.breakHistory && job.breakHistory.length > 0) {
        job.breakHistory.forEach(breakEvent => {
          events.push({
            type: "break",
            timestamp: breakEvent.timestamp,
            reason: breakEvent.reason,
            details: {
              durationMinutes: breakEvent.durationMinutes,
              processedInSession: breakEvent.processedInSession,
              currentPattern: breakEvent.currentPattern,
              batchProgress: `${breakEvent.batchIndex}/${breakEvent.totalBatches}`
            },
            displayMessage: getBreakDisplayMessage(breakEvent)
          });
        });
      }
      
      // Sort by timestamp (newest first)
      return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    };

    const getPauseDisplayMessage = (pause) => {
      const time = new Date(pause.timestamp).toLocaleTimeString('tr-TR');
      switch (pause.reason) {
        case "hourly_limit_reached":
          return `🕐 ${pause.estimatedResumeTime ? Math.ceil((new Date(pause.estimatedResumeTime) - new Date()) / 60000) : 60} minutes`;
        case "daily_limit_reached":
          return `📅 ${pause.estimatedResumeTime ? Math.ceil((new Date(pause.estimatedResumeTime) - new Date()) / 60000) : 1440} minutes`;
        case "pattern_limit_reached":
          return `⏰ ${pause.estimatedResumeTime ? Math.ceil((new Date(pause.estimatedResumeTime) - new Date()) / 60000) : 30} minutes`;
        case "pause_period":
          return `😴 ${pause.estimatedResumeTime ? Math.ceil((new Date(pause.estimatedResumeTime) - new Date()) / 60000) : 15} minutes`;
        case "user_session_missing":
          return `🔐 ${time} - Session expired`;
        case "linkedin_session_invalid":
          return `🔗 ${time} - LinkedIn session invalid`;
        case "dataverse_session_invalid":
          return `💼 ${time} - CRM session invalid`;
        default:
          return `⏸️ ${time} - Paused: ${pause.reason}`;
      }
    };

    const getResumeDisplayMessage = (resume) => {
      const time = new Date(resume.timestamp).toLocaleTimeString('tr-TR');
      const duration = resume.pauseDuration ? `${Math.round(resume.pauseDuration / 60)}` : '';
      
      switch (resume.reason) {
        case "automatic_limits_reset":
          return `✅ ${duration} minutes break completed`;
        case "automatic_limits_reset_1hour":
          return `🔄 1+ hour break completed - all limits reset`;
        case "user_reconnected":
          return `🔄 ${duration} minutes break completed`;
        case "session_restored":
          return `🔐 ${duration} minutes break completed`;
        default:
          return `▶️ ${duration} minutes break completed`;
      }
    };

    const getBreakDisplayMessage = (breakEvent) => {
      const duration = `${breakEvent.durationMinutes}`;
      
      return `☕ ${duration} minutes`;
    };
    
    res.status(200).json({
      success: true,
      canResume: job.status === "paused" || job.status === "processing",
      authStatus: {
        linkedinValid: !job.pauseReason?.includes("linkedin_session"),
        dataverseValid: !job.pauseReason?.includes("dataverse_session"),
        lastError: job.lastError || null,
        needsReauth: job.pauseReason?.includes("_session_invalid") || false
      },
      job: {
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        createdAt: createdAt,
        lastProcessedAt: lastProcessedAt,
        completedAt: completedAt,
        failedAt: failedAt,
        pauseReason: job.pauseReason,
        lastError: job.lastError,
        dailyStats: job.dailyStats,
        humanPatterns: job.humanPatterns,
        currentPattern: currentPattern.name,
        currentPatternInfo: currentPattern,
        dailyLimitInfo: limitCheck,
        // NEW: Pause/Resume history for user display
        pauseResumeHistory: formatPauseResumeHistory(),
        totalPauses: job.pauseHistory ? job.pauseHistory.length : 0,
        totalResumes: job.resumeHistory ? job.resumeHistory.length : 0,
        totalBreaks: job.breakHistory ? job.breakHistory.length : 0,
        // Activity summary for user
        activitySummary: {
          totalPauses: job.pauseHistory ? job.pauseHistory.length : 0,
          totalResumes: job.resumeHistory ? job.resumeHistory.length : 0,
          totalBreaks: job.breakHistory ? job.breakHistory.length : 0,
          lastActivity: job.pauseHistory?.length > 0 || job.resumeHistory?.length > 0 || job.breakHistory?.length > 0 ? 
            Math.max(
              ...(job.pauseHistory || []).map(p => new Date(p.timestamp).getTime()),
              ...(job.resumeHistory || []).map(r => new Date(r.timestamp).getTime()),
              ...(job.breakHistory || []).map(b => new Date(b.timestamp).getTime())
            ) : null
        }
      },
      simpleClientStats: null, // Frontend expects this property
      simpleClientInitialized: true // Frontend expects this property
    });
  } catch (error) {
    console.error(`❌ Error in job polling: ${error}`);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message
    });
  }
});

// New endpoint to get job activity summary
app.get("/job-activity/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobs = await loadJobs();
    const job = jobs[jobId];
    
    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found"
      });
    }

    const pauseEvents = job.pauseHistory || [];
    const resumeEvents = job.resumeHistory || [];
    const breakEvents = job.breakHistory || [];

    // Calculate total pause time
    const totalPauseTime = pauseEvents.reduce((total, pause, index) => {
      const pauseTime = new Date(pause.timestamp);
      const resumeEvent = resumeEvents.find(r => r.timestamp > pause.timestamp);
      if (resumeEvent) {
        const resumeTime = new Date(resumeEvent.timestamp);
        return total + (resumeTime - pauseTime);
      }
      return total;
    }, 0);

    // Calculate total break time
    const totalBreakTime = breakEvents.reduce((total, breakEvent) => {
      return total + (breakEvent.durationMs || 0);
    }, 0);

    // Group pauses by reason
    const pausesByReason = pauseEvents.reduce((acc, pause) => {
      acc[pause.reason] = (acc[pause.reason] || 0) + 1;
      return acc;
    }, {});

    // Group breaks by pattern
    const breaksByPattern = breakEvents.reduce((acc, breakEvent) => {
      acc[breakEvent.currentPattern] = (acc[breakEvent.currentPattern] || 0) + 1;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      jobId: job.jobId,
      activitySummary: {
        totalEvents: pauseEvents.length + resumeEvents.length + breakEvents.length,
        pauses: {
          count: pauseEvents.length,
          totalTimeMs: totalPauseTime,
          totalTimeMinutes: Math.round(totalPauseTime / 60000),
          byReason: pausesByReason
        },
        resumes: {
          count: resumeEvents.length
        },
        breaks: {
          count: breakEvents.length,
          totalTimeMs: totalBreakTime,
          totalTimeMinutes: Math.round(totalBreakTime / 60000),
          byPattern: breaksByPattern
        }
      },
      events: {
        pauses: pauseEvents,
        resumes: resumeEvents,
        breaks: breakEvents
      }
    });
  } catch (error) {
    console.error("❌ Error getting job activity:", error);
    res.status(500).json({
      success: false,
      message: "Error getting job activity",
      error: error.message
    });
  }
});

// New endpoint to get human pattern information
app.get("/human-patterns", (req, res) => {
  try {
    const currentPattern = getCurrentHumanPattern();

    res.status(200).json({
      success: true,
      currentPattern: {
        name: currentPattern.name,
        info: currentPattern,
        isActive: !currentPattern.pause,
      },
      allPatterns: HUMAN_PATTERNS,
      nextActivePattern: getNextActivePattern(),
      estimatedResumeTime: getEstimatedResumeTime(),
    });
  } catch (error) {
    console.error("❌ Error getting human patterns:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// New endpoint to get pattern statistics
app.get("/pattern-stats/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const stats = await loadDailyStats();
    const today = getTodayKey();

    const userStats = stats[userId] || {};

    // Get pattern-specific stats for today
    const patternStats = {};
    Object.keys(HUMAN_PATTERNS).forEach((patternName) => {
      const patternKey = `${today}-${patternName}`;
      patternStats[patternName] = {
        processed: userStats[patternKey] || 0,
        limit: HUMAN_PATTERNS[patternName].maxProfiles || null,
        isActive: !HUMAN_PATTERNS[patternName].pause,
      };
    });

    res.status(200).json({
      success: true,
      patternStats,
      dailyTotal: userStats[today] || 0,
      dailyLimit: DAILY_PROFILE_LIMIT,
    });
  } catch (error) {
    console.error("❌ Error getting pattern stats:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Token refresh endpoint
app.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken, clientId, tenantId, crmUrl, verifier } = req.body;

    if (!refreshToken || !clientId || !tenantId || !crmUrl || !verifier) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters for token refresh",
      });
    }

    const newTokenData = await refreshAccessToken(
      refreshToken,
      clientId,
      tenantId,
      crmUrl,
      verifier
    );

    res.status(200).json({
      success: true,
      message: "Token refreshed successfully",
      tokenData: newTokenData,
    });
  } catch (error) {
    console.error("❌ Token refresh failed:", error);
    res.status(401).json({
      success: false,
      message: "Token refresh failed",
      error: error.message,
      needsReauth: true,
    });
  }
});

// Enhanced refresh session endpoint for frontend
app.post("/refresh-session", async (req, res) => {
  try {
    const { jobId, userId } = req.body;
    console.log(`🔄 Frontend refresh request for job ${jobId}, user ${userId}`);

    // Get job and find the actual user
    const jobs = await loadJobs();
    const job = jobs[jobId];
    
    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found",
      });
    }

    const actualUserId = job.userId;
    const userSessions = await loadUserSessions();
    const userSession = userSessions[actualUserId];
    
    if (!userSession || !userSession.refreshToken) {
      return res.status(401).json({
        success: false,
        message: "No session data found for token refresh",
        needsReauth: true,
      });
    }

    // Refresh the token
    const newTokenData = await refreshAccessToken(
      userSession.refreshToken,
      userSession.clientId,
      userSession.tenantId,
      userSession.crmUrl,
      userSession.verifier
    );

    // Update user session
    userSessions[actualUserId].accessToken = newTokenData.access_token;
    if (newTokenData.refresh_token) {
      userSessions[actualUserId].refreshToken = newTokenData.refresh_token;
    }
    await saveUserSessions(userSessions);

    // Clear job pause status
    if (job.pauseReason === 'token_refresh_failed') {
      job.status = 'processing';
      delete job.pauseReason;
      delete job.pausedAt;
      delete job.lastError;
      await saveJobs({ ...jobs, [jobId]: job });
      
      // Restart background processing
      console.log(`🚀 Restarting background processing for job ${jobId} after token refresh`);
      setImmediate(() => processJobInBackground(jobId));
    }

    console.log(`✅ Token refreshed successfully for user ${actualUserId}, job ${jobId}`);
    
    res.status(200).json({
      success: true,
      message: "Token refreshed and job resumed successfully",
    });
  } catch (error) {
    console.error("❌ Session refresh failed:", error);
    res.status(401).json({
      success: false,
      message: "Token refresh failed",
      error: error.message,
      needsReauth: true,
    });
  }
});

// Test route with pattern info
app.get("/simuratli", async (req, res) => {
  const profileId = "simuratli";
  const currentPattern = getCurrentHumanPattern();

  console.log(`🧪 Test route called during ${currentPattern.name} pattern`);

  try {
    const data = await fetchLinkedInProfile(profileId);
    console.log("🔍 Fetched Data:", data);

    res.json({
      profileData: data,
      currentPattern: currentPattern.name,
      patternInfo: currentPattern,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Test route error:", error);
    res.status(500).json({
      error: error.message,
      currentPattern: currentPattern.name,
      patternInfo: currentPattern,
      timestamp: new Date().toISOString(),
    });
  }
});

// Health check endpoint
app.get("/health", async (req, res) => {
  const currentPattern = getCurrentHumanPattern();
  const userId = req.query.userId;
  
  // Basic health response
  const response = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    currentPattern: {
      name: currentPattern.name,
      isActive: !currentPattern.pause,
    },
    server: "LinkedIn Profile Processor with Human Patterns",
  };
  
  // Add cooldown status if userId is provided
  if (userId) {
    try {
      const cooldownStatus = await getUserCooldownStatus(userId);
      if (cooldownStatus) {
        response.cooldownStatus = {
          active: cooldownStatus.allJobsCompleted && !cooldownStatus.jobsRestarted,
          completedAt: cooldownStatus.completedAt ? new Date(cooldownStatus.completedAt).toISOString() : null,
          cooldownEndDate: cooldownStatus.cooldownEndDate ? new Date(cooldownStatus.cooldownEndDate).toISOString() : null,
          daysRemaining: cooldownStatus.daysRemaining || 0
        };
      }
    } catch (error) {
      console.error(`❌ Error getting cooldown status: ${error.message}`);
    }
  }

  res.status(200).json(response);
});

// Endpoint to check user cooldown status
app.get("/user-cooldown/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    // Aktif iş var mı kontrol et (paused jobs da dahil!)
    const activeJob = await Job.findOne({ userId, status: { $in: ["processing", "pending", "paused"] } });
    if (activeJob) {
      console.log(`🔍 Active job found for ${userId}: ${activeJob.jobId} (status: ${activeJob.status})`);
      return res.status(200).json({
        success: true,
        cooldownStatus: {
          userId,
          hasCooldown: false,
          completedAt: null,
          cooldownEndDate: null,
          daysRemaining: 0,
          cooldownPeriod: 30
        }
      });
    }
    const cooldownStatus = await getUserCooldownStatus(userId);
    if (!cooldownStatus) {
      return res.status(200).json({
        success: true,
        cooldownStatus: {
          userId,
          hasCooldown: false,
          completedAt: null,
          cooldownEndDate: null,
          daysRemaining: 0,
          cooldownPeriod: 30
        },
        message: "No cooldown found for this user"
      });
    }
    const formattedStatus = {
      userId: cooldownStatus.userId,
      hasCooldown: cooldownStatus.allJobsCompleted && !cooldownStatus.jobsRestarted,
      completedAt: cooldownStatus.completedAt ? new Date(cooldownStatus.completedAt).toISOString() : null,
      cooldownEndDate: cooldownStatus.cooldownEndDate ? new Date(cooldownStatus.cooldownEndDate).toISOString() : null,
      daysRemaining: cooldownStatus.daysRemaining || 0,
      cooldownPeriod: cooldownStatus.cooldownPeriod || 30
    };
    res.status(200).json({
      success: true,
      cooldownStatus: formattedStatus
    });
  } catch (error) {
    console.error(`❌ Error checking cooldown status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error checking cooldown status",
      error: error.message
    });
  }
});

// Endpoint to get all jobs history for a user
app.get("/user-jobs-history/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const jobs = await loadJobs();
    
    // Filter jobs for this specific user
    const userJobs = Object.values(jobs)
      .filter(job => job.userId === userId)
      .map(job => ({
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
        lastProcessedAt: job.lastProcessedAt ? new Date(job.lastProcessedAt).toISOString() : null,
        cooldownOverridden: job.cooldownOverridden || false,
        overriddenAt: job.overriddenAt ? new Date(job.overriddenAt).toISOString() : null,
        overrideReason: job.overrideReason || null
      }))
      // Sort by creation date (newest first)
      .sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
        const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
        return dateB.getTime() - dateA.getTime();
      });
    
    console.log(`Found ${userJobs.length} jobs for user ${userId}`);
    
    // Calculate cooldown status
    const lastCompletedJob = userJobs.find(job => job.status === 'completed');
    let cooldownInfo = { active: false };
    
    if (lastCompletedJob) {
      const completedAt = new Date(lastCompletedJob.completedAt);
      const now = new Date();
      const diffDays = (now - completedAt) / (1000 * 60 * 60 * 24);
      
      cooldownInfo = {
        active: diffDays < 30 && !lastCompletedJob.cooldownOverridden,
        daysLeft: Math.max(0, Math.ceil(30 - diffDays)),
        completedAt: lastCompletedJob.completedAt,
        overridden: lastCompletedJob.cooldownOverridden || false,
        overriddenAt: lastCompletedJob.overriddenAt || null,
        overrideReason: lastCompletedJob.overrideReason || null,
        jobId: lastCompletedJob.jobId
      };
    }
    
    res.status(200).json({
      success: true,
      currentJobId: userSession?.currentJobId,
      jobs: userJobs,
      cooldownInfo
    });
  } catch (error) {
    console.error(`❌ Error getting user job history: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error retrieving user job history",
      error: error.message
    });
  }
});

// Endpoint to override cooldown and allow new processing
app.post("/override-cooldown/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { forceOverride = false, reason = "Manual override" } = req.body;
    
    console.log(`🔓 Cooldown override requested for user ${userId}:`, { forceOverride, reason });
    
    // Load jobs to check current status
    const jobs = await loadJobs();
    const userJobs = Object.values(jobs).filter(job => job.userId === userId);
    
    if (userJobs.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No jobs found for this user"
      });
    }
    
    // Find the most recent completed job
    const completedJobs = userJobs
      .filter(job => job.status === "completed" && job.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    
    if (completedJobs.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No completed jobs found to override cooldown for"
      });
    }
    
    const lastCompletedJob = completedJobs[0];
    const completedAt = new Date(lastCompletedJob.completedAt);
    const now = new Date();
    const daysSinceCompletion = Math.floor((now - completedAt) / (1000 * 60 * 60 * 24));
    
    // Check if already overridden
    if (lastCompletedJob.cooldownOverridden) {
      return res.status(200).json({
        success: false,
        message: "Cooldown has already been overridden for this user",
        alreadyOverridden: true,
        overriddenAt: lastCompletedJob.overriddenAt,
        overrideReason: lastCompletedJob.overrideReason,
        canStartNewJob: true
      });
    }
    
    // Check if override is needed
    if (daysSinceCompletion >= 30) {
      return res.status(200).json({
        success: false,
        message: "Cooldown period has already ended naturally. You can start new processing.",
        daysSinceCompletion,
        cooldownNeeded: false,
        canStartNewJob: true
      });
    }
    
    // Perform the override
    console.log(`🔧 Updating job ${lastCompletedJob.jobId} with override flags for user ${userId}`);
    
    // Add override flag to the job
    lastCompletedJob.cooldownOverridden = true;
    lastCompletedJob.overriddenAt = now.toISOString();
    lastCompletedJob.overrideReason = reason;
    lastCompletedJob.daysSinceCompletionAtOverride = daysSinceCompletion;
    
    console.log(`🔧 Override data:`, {
      cooldownOverridden: lastCompletedJob.cooldownOverridden,
      overriddenAt: lastCompletedJob.overriddenAt,
      overrideReason: lastCompletedJob.overrideReason
    });
    
    // Save the updated job with better error handling
    try {
      jobs[lastCompletedJob.jobId] = lastCompletedJob;
      await saveJobs(jobs);
      console.log(`💾 Saved override for job ${lastCompletedJob.jobId}`);
      
      // Add a small delay to ensure MongoDB write is complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Verify the save worked by reloading with retry logic
      let verifyJob = null;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        const reloadedJobs = await loadJobs();
        verifyJob = reloadedJobs[lastCompletedJob.jobId];
        
        if (verifyJob?.cooldownOverridden === true) {
          console.log(`✅ Verification successful on attempt ${retryCount + 1} - Job ${lastCompletedJob.jobId} cooldownOverridden: ${verifyJob.cooldownOverridden}`);
          break;
        }
        
        retryCount++;
        if (retryCount < maxRetries) {
          console.log(`⏳ Verification failed on attempt ${retryCount}, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      if (!verifyJob?.cooldownOverridden && retryCount >= maxRetries) {
        console.error(`❌ Override save verification failed after ${maxRetries} attempts! Job ${lastCompletedJob.jobId} cooldownOverridden is: ${verifyJob?.cooldownOverridden}`);
        
        // Even if verification fails, the job was saved, so let's proceed with a warning
        console.log(`⚠️ Proceeding with override despite verification failure - job was updated in memory`);
      }
      
    } catch (saveError) {
      console.error(`❌ Failed to save override: ${saveError.message}`);
      return res.status(500).json({
        success: false,
        message: "Failed to save override to database",
        error: saveError.message
      });
    }
    
    console.log(`✅ Cooldown overridden for user ${userId}. Job ${lastCompletedJob.jobId} marked as override.`);
    
    // After successful override, automatically start a new job
    console.log(`🚀 Starting new job automatically after cooldown override for user ${userId}`);
    
    try {
      // Get user session to check for CRM URL and contacts
      const userSessions = await loadUserSessions();
      const userSession = userSessions[userId];
      
      if (!userSession || !userSession.crmUrl) {
        console.log(`⚠️ No user session or CRM URL found for ${userId}, cannot auto-start new job`);
        return res.status(200).json({
          success: true,
          message: `Cooldown period overridden successfully`,
          overriddenJob: {
            jobId: lastCompletedJob.jobId,
            completedAt: lastCompletedJob.completedAt,
            overriddenAt: lastCompletedJob.overriddenAt,
            daysRemaining: 30 - daysSinceCompletion
          },
          canStartNewJob: true,
          autoStartFailed: "No user session or CRM URL found",
          nextStep: "Please start a new job manually"
        });
      }
      
      // Create a new job with fresh contacts
      const newJobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();
      
      // Get contacts from the previous job and FULLY reset them
      const previousContacts = lastCompletedJob.contacts || [];
      const freshContacts = previousContacts.map(contact => ({
        contactId: contact.contactId,
        linkedinUrl: contact.linkedinUrl,
        fullName: contact.fullName,
        status: 'pending',  // Reset ALL contacts to pending (0/12 restart)
        error: null,
        processedAt: null,
        attempts: 0,
        linkedinData: null
      }));
      
      if (freshContacts.length === 0) {
        console.log(`⚠️ No contacts found in previous job ${lastCompletedJob.jobId}, cannot auto-start`);
        return res.status(200).json({
          success: true,
          message: `Cooldown period overridden successfully`,
          overriddenJob: {
            jobId: lastCompletedJob.jobId,
            completedAt: lastCompletedJob.completedAt,
            overriddenAt: lastCompletedJob.overriddenAt,
            daysRemaining: 30 - daysSinceCompletion
          },
          canStartNewJob: true,
          autoStartFailed: "No contacts found in previous job",
          nextStep: "Please add contacts and start a new job manually"
        });
      }
      
      // Create new job with COMPLETE RESET (0/12 start)
      const newJob = {
        jobId: newJobId,
        userId: userId,
        status: 'processing',  // Start processing immediately
        contacts: freshContacts,
        totalContacts: freshContacts.length,
        processedCount: 0,       // RESET: Start from 0
        successCount: 0,         // RESET: Start from 0
        failureCount: 0,         // RESET: Start from 0
        currentBatchIndex: 0,    // RESET: Start from beginning
        createdAt: now.toISOString(),
        startTime: now.toISOString(),
        lastProcessedAt: now.toISOString(),
        errors: [],
        crmUrl: userSession.crmUrl, // CRITICAL: Add crmUrl to job for proper stats key generation
        humanPatterns: {
          startPattern: null,
          startTime: now.toISOString(),
          patternHistory: []
        },
        dailyStats: {
          startDate: now.toISOString().split('T')[0],
          processedToday: 0,
          patternBreakdown: {}
        },
        // Override job metadata
        isOverrideJob: true,
        originalJobId: lastCompletedJob.jobId,
        overrideReason: reason
      };
      
      // Save the new job
      const allJobs = await loadJobs();
      allJobs[newJobId] = newJob;
      await saveJobs(allJobs);
      
      // Update user session with new job ID
      userSession.currentJobId = newJobId;
      await saveUserSessions(userSessions);
      
      console.log(`✅ New job ${newJobId} created automatically with ${freshContacts.length} contacts FULLY RESET to pending (0/${freshContacts.length})`);
      
      // Start background processing for the new job IMMEDIATELY
      setImmediate(() => {
        console.log(`🔄 Starting background processing for RESET job ${newJobId} - processing from 0/${freshContacts.length}`);
        processJobInBackground(newJobId);
      });
      
      res.status(200).json({
        success: true,
        message: `Cooldown overridden and new job started from 0/${freshContacts.length}`,
        overriddenJob: {
          jobId: lastCompletedJob.jobId,
          completedAt: lastCompletedJob.completedAt,
          overriddenAt: lastCompletedJob.overriddenAt,
          daysRemaining: 30 - daysSinceCompletion
        },
        newJob: {
          jobId: newJobId,
          status: 'processing',
          totalContacts: freshContacts.length,
          processedCount: 0,  // Start from 0
          successCount: 0,    // Start from 0
          failureCount: 0,    // Start from 0
          isOverrideJob: true,
          originalJobId: lastCompletedJob.jobId
        },
        autoStarted: true,
        canStartNewJob: true,
        resetToZero: true,  // Flag indicating complete reset
        contactSummary: {
          totalFromCRM: freshContacts.length,
          validLinkedInContacts: freshContacts.length,
          allContactsResetToPending: true,
          contactDetails: freshContacts.map(c => ({
            name: c.fullName,
            hasLinkedIn: !!c.linkedinUrl,
            status: 'pending'  // All contacts are pending
          }))
        }
      });
      
    } catch (error) {
      console.error(`❌ Error auto-starting new job after override: ${error.message}`);
      
      // Still return success for the override, but mention auto-start failed
      res.status(200).json({
        success: true,
        message: `Cooldown overridden successfully, but auto-start failed`,
        overriddenJob: {
          jobId: lastCompletedJob.jobId,
          completedAt: lastCompletedJob.completedAt,
          overriddenAt: lastCompletedJob.overriddenAt,
          daysRemaining: 30 - daysSinceCompletion
        },
        canStartNewJob: true,
        autoStartFailed: error.message,
        nextStep: "Please start a new job manually"
      });
    }
    
  } catch (error) {
    console.error(`❌ Error overriding cooldown: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error overriding cooldown",
      error: error.message
    });
  }
});

// Endpoint to check if cooldown can be overridden
app.get("/can-override-cooldown/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    const jobs = await loadJobs();
    const userJobs = Object.values(jobs).filter(job => job.userId === userId);
    
    // Eğer aktif bir job varsa override butonu gösterilmesin
    const activeJob = userJobs.find(job => 
      job.status === "processing" || job.status === "pending" || job.status === "paused"
    );
    if (activeJob) {
      return res.status(200).json({
        success: true,
        canOverride: false,
        inCooldown: false,
        reason: "Active job exists",
        activeJobId: activeJob.jobId
      });
    }

    // Find the most recent completed job
    const completedJobs = userJobs
      .filter(job => job.status === "completed" && job.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

    if (completedJobs.length === 0) {
      return res.status(200).json({
        success: true,
        canOverride: false,
        reason: "No completed jobs found",
        inCooldown: false
      });
    }
    
    const lastCompletedJob = completedJobs[0];
    const completedAt = new Date(lastCompletedJob.completedAt);
    const now = new Date();
    const daysSinceCompletion = Math.floor((now - completedAt) / (1000 * 60 * 60 * 24));
    const daysRemaining = Math.max(0, Math.ceil(30 - daysSinceCompletion));

    // Check if already overridden
    const alreadyOverridden = lastCompletedJob.cooldownOverridden;

    // Check if in cooldown period
    const inCooldown = daysSinceCompletion < 30 && !alreadyOverridden;

    res.status(200).json({
      success: true,
      canOverride: inCooldown,
      inCooldown,
      alreadyOverridden,
      daysSinceCompletion,
      daysRemaining,
      lastCompletedJob: {
        jobId: lastCompletedJob.jobId,
        completedAt: lastCompletedJob.completedAt,
        processedCount: lastCompletedJob.processedCount,
        totalContacts: lastCompletedJob.totalContacts
      }
    });
    
  } catch (error) {
    console.error(`❌ Error checking cooldown override status: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error checking cooldown override status",
      error: error.message
    });
  }
});

// Debug endpoint to manually restart a stuck job
app.post("/debug-restart-job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobs = await loadJobs();
    const job = jobs[jobId];
    
    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }
    
    console.log(`🔄 Manually restarting job ${jobId}`);
    
    // Check if user session exists for this job
    const userSessions = await loadUserSessions();
    const userSession = userSessions[job.userId];
    
    if (!userSession || userSession.currentJobId !== jobId) {
      console.log(`⚠️ User session missing for job ${jobId}, creating placeholder session`);
      
      // Get real data from request body if available
      const { li_at, jsessionid, accessToken, refreshToken, clientId, tenantId, verifier, crmUrl } = req.body;
      
      // Create user session with real data or placeholders
      userSessions[job.userId] = {
        currentJobId: jobId,
        lastActivity: new Date().toISOString(),
        // Use real data from frontend if provided, otherwise placeholders
        accessToken: accessToken || "PLACEHOLDER_NEEDS_UPDATE",
        li_at: li_at || "PLACEHOLDER_NEEDS_UPDATE", 
        jsessionid: jsessionid || "PLACEHOLDER_NEEDS_UPDATE",
        crmUrl: crmUrl || "PLACEHOLDER_NEEDS_UPDATE",
        refreshToken: refreshToken || "PLACEHOLDER_REFRESH_TOKEN",
        clientId: clientId || "PLACEHOLDER_CLIENT_ID",
        tenantId: tenantId || "PLACEHOLDER_TENANT_ID",
        verifier: verifier || "PLACEHOLDER_VERIFIER"
      };
      
      await saveUserSessions(userSessions);
      console.log(`✅ Created placeholder user session for ${job.userId}`);
    }
    
    // Reset job state
    job.lastProcessedAt = new Date().toISOString();
    job.restartedAt = new Date().toISOString();
    job.restartCount = (job.restartCount || 0) + 1;
    job.status = "processing";
    
    // Clear any pause reasons
    delete job.pauseReason;
    delete job.pausedAt;
    delete job.lastError;
    
    // Save job
    jobs[jobId] = job;
    await saveJobs(jobs);
    
    // Restart background processing
    setImmediate(() => processJobInBackground(jobId));
    
    res.json({ 
      success: true, 
      message: `Job ${jobId} restarted manually`,
      restartCount: job.restartCount,
      userSessionRestored: !userSession || userSession.currentJobId !== jobId
    });
  } catch (error) {
    console.error("❌ Error restarting job:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to clean up and reset user data (for debugging)
app.post("/admin/cleanup-user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { resetJobs = false, resetSessions = false, resetAll = false } = req.body;
    
    console.log(`🧹 Cleanup requested for user ${userId}:`, { resetJobs, resetSessions, resetAll });
    
    let cleanedItems = [];
    
    if (resetAll || resetJobs) {
      // Clean up processing jobs
      const jobs = await loadJobs();
      const userJobIds = Object.keys(jobs).filter(jobId => jobs[jobId].userId === userId);
      
      userJobIds.forEach(jobId => {
        delete jobs[jobId];
      });
      
      await saveJobs(jobs);
      cleanedItems.push(`${userJobIds.length} processing jobs`);
      console.log(`🗑️ Removed ${userJobIds.length} jobs for user ${userId}`);
    }
    
    if (resetAll || resetSessions) {
      // Clean up user sessions
      const userSessions = await loadUserSessions();
      if (userSessions[userId]) {
        delete userSessions[userId];
        await saveUserSessions(userSessions);
        cleanedItems.push('user session');
        console.log(`🗑️ Removed session for user ${userId}`);
      }
    }
    
    if (resetAll) {
      // Clean up other data files that might reference this user
      try {
        // Daily stats
        const dailyStats = await require('./helpers/fileLock').readJsonFile('./data/daily_stats.json');
        if (dailyStats[userId]) {
          delete dailyStats[userId];
          await require('./helpers/fileLock').writeJsonFile('./data/daily_stats.json', dailyStats);
          cleanedItems.push('daily stats');
        }
        
        // Daily rate limits
        const rateLimits = await require('./helpers/fileLock').readJsonFile('./data/daily_rate_limits.json');
        if (rateLimits[userId]) {
          delete rateLimits[userId];
          await require('./helpers/fileLock').writeJsonFile('./data/daily_rate_limits.json', rateLimits);
          cleanedItems.push('rate limits');
        }
      } catch (cleanupError) {
        console.log(`⚠️ Some optional cleanup failed: ${cleanupError.message}`);
      }
    }
    
    res.status(200).json({
      success: true,
      message: `User ${userId} data cleaned up successfully`,
      cleanedItems,
      canStartFresh: true
    });
    
  } catch (error) {
    console.error(`❌ Error during cleanup: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error during cleanup",
      error: error.message
    });
  }
});

// Get user data overview (for debugging)
app.get("/admin/user-data/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get jobs
    const jobs = await loadJobs();
    const userJobs = Object.values(jobs).filter(job => job.userId === userId);
    
    // Get sessions
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    
    // Get completed jobs info
    const completedJobs = userJobs
      .filter(job => job.status === "completed" && job.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    
    const lastCompletedJob = completedJobs.length > 0 ? completedJobs[0] : null;
    
    let cooldownInfo = { active: false };
    if (lastCompletedJob) {
      const completedAt = new Date(lastCompletedJob.completedAt);
      const now = new Date();
      const diffDays = (now - completedAt) / (1000 * 60 * 60 * 24);
      
      cooldownInfo = {
        active: diffDays < 30 && !lastCompletedJob.cooldownOverridden,
        daysLeft: Math.max(0, Math.ceil(30 - diffDays)),
        completedAt: lastCompletedJob.completedAt,
        overridden: lastCompletedJob.cooldownOverridden || false,
        overriddenAt: lastCompletedJob.overriddenAt || null,
        overrideReason: lastCompletedJob.overrideReason || null,
        jobId: lastCompletedJob.jobId
      };
    }
    
    res.status(200).json({
      success: true,
      userId,
      jobsCount: userJobs.length,
      completedJobsCount: completedJobs.length,
      hasSession: !!userSession,
      currentJobId: userSession?.currentJobId,
      cooldownInfo,
      jobs: userJobs.map(job => ({
        jobId: job.jobId,
        status: job.status,
        completedAt: job.completedAt,
        cooldownOverridden: job.cooldownOverridden,
        overriddenAt: job.overriddenAt,
        processedCount: job.processedCount,
        totalContacts: job.totalContacts
      }))
    });
    
  } catch (error) {
    console.error(`❌ Error getting user data: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error getting user data",
      error: error.message
    });
  }
});

// Cancel all processing for a user - STOP button functionality
app.post("/cancel-processing/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason = "User cancelled processing" } = req.body;
    
    console.log(`🛑 CANCEL PROCESSING requested for user ${userId}`, { reason });
    
    // Reset daily/hourly/pattern counts to 0
    await resetUserStats(userId);
    
    // Load jobs and find active jobs for this user
    const jobs = await loadJobs();
    const userActiveJobs = Object.values(jobs).filter(job => 
      job.userId === userId && 
      (job.status === "processing" || job.status === "paused" || job.status === "pending")
    );
    
    if (userActiveJobs.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No active jobs to cancel",
        cancelledJobs: []
      });
    }
    
    console.log(`🛑 Found ${userActiveJobs.length} active jobs for user ${userId}`);
    
    const cancelledJobs = [];
    const now = new Date().toISOString();
    
    // Complete each active job
    for (const job of userActiveJobs) {
      // Set a new cancelToken to break any running background loops
      const newCancelToken = uuidv4();
      const oldCancelToken = job.cancelToken;
      job.cancelToken = newCancelToken;
      
      console.log(`🛑 Setting new cancelToken for job ${job.jobId}: ${oldCancelToken} -> ${newCancelToken}`);
      console.log(`✅ Completing job ${job.jobId} (via cancel-processing)`);
      // Mark all remaining pending/processing contacts as completed
      let newlyCompletedCount = 0;
      if (job.contacts) {
        job.contacts.forEach(contact => {
          if (contact.status === "pending" || contact.status === "processing") {
            contact.status = "completed";
            contact.completedAt = now;
            contact.error = null;
            newlyCompletedCount++;
          }
        });
      }
      // Update job counts
      job.successCount = (job.successCount || 0) + newlyCompletedCount;
      job.processedCount = job.successCount + (job.failureCount || 0);
      // Mark job as complet
      job.status = "completed";
      job.completedAt = now;
      job.completionReason = reason;
      job.manualCompletion = true;
      job.lastProcessedAt = now;
      // Mark cooldown as overridden to prevent unwanted restart
      job.cooldownOverridden = true;
      job.overriddenAt = now;
      jobs[job.jobId] = job;
      cancelledJobs.push({
        jobId: job.jobId,
        status: job.status,
        processedCount: job.processedCount,
        totalContacts: job.totalContacts,
        newlyCompletedCount
      });
      console.log(`✅ Job ${job.jobId} completed: ${newlyCompletedCount} contacts marked as successful, cooldown overridden`);
    }
    await saveJobs(jobs);

    // Clear current job ID from user session and set cooldownOverridden
    const userSessions = await loadUserSessions();
    if (userSessions[userId]) {
      userSessions[userId].currentJobId = null;
      userSessions[userId].lastActivity = now;
      userSessions[userId].cooldownOverridden = true;
      userSessions[userId].overriddenAt = now;
    }
    await saveUserSessions(userSessions);

    // Cancelled jobları completed yaptıktan sonra cooldown kaydını oluştur
    try {
      const { checkAndSetUserCooldown } = require("../helpers/db");
      await checkAndSetUserCooldown(userId);
      console.log(`✅ checkAndSetUserCooldown çağrıldı: ${userId}`);
    } catch (cooldownError) {
      console.error(`❌ checkAndSetUserCooldown hatası: ${cooldownError.message}`);
    }

    res.status(200).json({
      success: true,
      message: "Processing completed successfully. All remaining contacts marked as successful.",
      completedJobs: cancelledJobs,
      debugInfo: {
        jobsCompleted: cancelledJobs.length,
        cooldownOverridden: true,
        userSessionUpdated: !!userSessions[userId],
        nextStep: "Reload the extension to see updated status"
      }
    });
    
  } catch (error) {
    console.error(`❌ Error cancelling processing: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error cancelling processing",
      error: error.message
    });
  }
});
// Simple restart endpoint - reset counts to 0 and disable cooldown
app.post("/restart-processing/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason = "Manual restart", updateContacts = true } = req.body;

    console.log(`🔄 Restart processing requested for user ${userId}`);

    // Load jobs
    const jobs = await loadJobs();
    const userJobs = Object.values(jobs).filter(job => job.userId === userId);

    if (userJobs.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No jobs found for this user"
      });
    }

    // Find the most recent job (completed or not)
    const sortedJobs = userJobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const currentJob = sortedJobs[0];

    console.log(`🔧 Resetting job ${currentJob.jobId} counts to 0 and disabling cooldown`);

    // Get user session for CRM access
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];

    // Update contacts from CRM if requested and session exists
    if (updateContacts && userSession && userSession.crmUrl && userSession.accessToken) {
      try {
        console.log(`📥 Fetching updated contacts from CRM for user ${userId}`);
        console.log(`🔗 CRM URL: ${userSession.crmUrl}`);

        // Import the function to fetch contacts from CRM
        const { fetchContactsFromDataverse } = require('../helpers/dynamics');

        // Fetch fresh contacts from CRM
        const freshContactsFromCRM = await fetchContactsFromDataverse(
          userSession.accessToken,
          userSession.crmUrl,
          userSession.tenantId
        );

        console.log(freshContactsFromCRM,'freshContactsFromCRM')

        if (freshContactsFromCRM && freshContactsFromCRM.length > 0) {
          console.log(`📋 Raw contacts from CRM: ${freshContactsFromCRM.length}`);

          // Log sample contact structure for debugging
          if (freshContactsFromCRM.length > 0) {
            console.log(`📝 Sample contact structure:`, Object.keys(freshContactsFromCRM[0]));
            console.log(`📝 Sample contact data:`, JSON.stringify(freshContactsFromCRM[0], null, 2));
          }

          // Convert CRM contacts to job format with detailed logging
          const updatedContacts = freshContactsFromCRM.map((contact, index) => {
            const contactId = contact.contactid || contact.id;
            const fullName = contact.fullname || `${contact.firstname || ''} ${contact.lastname || ''}`.trim();

            // Try multiple possible field names for LinkedIn URL with priority order
            const linkedinUrl = contact.uds_linkedin || 
                               contact.linkedinurl || 
                               contact.linkedin_url || 
                               contact.linkedinprofileurl ||
                               contact.uds_linkedinprofileurl ||
                               contact.uds_linkedinurl ||
                               contact.websiteurl; // websiteurl as last resort

            // Get all LinkedIn-related fields for debugging
            const linkedinFields = Object.keys(contact).filter(key => 
              key.toLowerCase().includes('linkedin') || 
              key.toLowerCase().includes('website') ||
              key.includes('uds_')
            ).reduce((obj, field) => {
              obj[field] = contact[field];
              return obj;
            }, {});

            console.log(`Contact ${index + 1}/${freshContactsFromCRM.length} - ${fullName}:`, {
              contactId,
              fullName,
              linkedinUrl: linkedinUrl || 'NOT_FOUND',
              hasLinkedIn: !!linkedinUrl,
              linkedinFields,
              email: contact.emailaddress1
            });

            return {
              contactId,
              fullName,
              linkedinUrl,
              email: contact.emailaddress1,
              status: 'pending',
              error: null
            };
          });

          // More flexible filtering - include contacts with any LinkedIn-like URL or include all contacts for manual processing
          const contactsWithLinkedIn = updatedContacts.filter(contact => {
            // Include contacts with any non-empty LinkedIn URL
            const hasLinkedInUrl = contact.linkedinUrl && 
                                  contact.linkedinUrl.trim() !== '' && 
                                  contact.linkedinUrl !== 'null' &&
                                  contact.linkedinUrl !== 'undefined';

            // Also include contacts that have email but no LinkedIn (they might be processed manually)
            const hasEmail = contact.email && contact.email.trim() !== '';

            // Accept if has LinkedIn URL or if has email (more flexible approach)
            const shouldInclude = hasLinkedInUrl || hasEmail;

            if (!shouldInclude) {
              console.log(`⚠️ Filtering out contact ${contact.contactId} (${contact.fullName}): no LinkedIn URL and no email`);
            } else if (hasLinkedInUrl) {
              console.log(`✅ Valid contact ${contact.contactId} (${contact.fullName}): LinkedIn URL: "${contact.linkedinUrl}"`);
            } else {
              console.log(`📧 Including contact ${contact.contactId} (${contact.fullName}): Email only: "${contact.email}"`);
            }

            return shouldInclude;
          });

          const oldContactCount = currentJob.contacts ? currentJob.contacts.length : 0;
          const totalFromCRM = freshContactsFromCRM.length;
          const validContactCount = contactsWithLinkedIn.length;

          console.log(`📊 Contact processing summary:`, {
            totalFromCRM,
            validContacts: validContactCount,
            filteredOut: totalFromCRM - validContactCount,
            oldCount: oldContactCount,
            updateType: 'CRM_REFRESH'
          });


          if (contactsWithLinkedIn.length > 0) {
            // Update job with fresh contacts
            currentJob.contacts = contactsWithLinkedIn;
            currentJob.totalContacts = validContactCount;

            console.log(`✅ Updated job contacts: ${oldContactCount} → ${validContactCount} contacts from CRM`);
          } else {
            console.log(`⚠️ No valid LinkedIn URLs found in ${totalFromCRM} CRM contacts, keeping existing contacts`);

            // Reset existing contacts to pending
            if (currentJob.contacts) {
              currentJob.contacts.forEach(contact => {
                contact.status = 'pending';
                contact.error = null;
              });
              currentJob.totalContacts = currentJob.contacts.length;
              currentJob.status = 'processing'; // Ensure job status is pending
            } else {
              currentJob.contacts = [];
              currentJob.totalContacts = 0;
            }
          }

        } else {
          console.log(`⚠️ No contacts returned from CRM API for user ${userId}, keeping existing contacts`);
          console.log(currentJob,'currentjhob')

          // Reset existing contacts to pending
          if (currentJob.contacts && currentJob.contacts.length > 0) {
            currentJob.contacts.forEach(contact => {
              contact.status = 'pending';
              contact.error = null;
            });
            // Keep the existing contact count - DON'T set to 0
            currentJob.totalContacts = currentJob.contacts.length;
            currentJob.status = 'processing'; 
            currentJob.successCount = 0; 
            currentJob.processedCount = 0; 
            currentJob.currentBatchIndex = 0; 
            currentJob.cooldownOverridden = false;

            console.log(`✅ Reset ${currentJob.contacts.length} existing contacts to pending status`);
          } else {
            currentJob.contacts = [];
            currentJob.totalContacts = 0;
            console.log(`⚠️ No existing contacts found to reset`);
          }
        }

      } catch (crmError) {
        console.error(`❌ Error fetching contacts from CRM: ${crmError.message}`);
        console.log(`⚠️ CRM Error details:`, crmError);
        console.log(`⚠️ Falling back to resetting existing contacts to pending`);

        // Fallback: Reset existing contacts to pending
        if (currentJob.contacts && currentJob.contacts.length > 0) {
          currentJob.contacts.forEach(contact => {
            contact.status = 'pending';
            contact.error = null;
          });
          // Keep the existing contact count - DON'T set to 0
          currentJob.totalContacts = currentJob.contacts.length;
          currentJob.status = 'processing';
          currentJob.successCount = 0; 
          currentJob.processedCount = 0; 
          currentJob.currentBatchIndex = 0;

          console.log(`✅ Fallback: Reset ${currentJob.contacts.length} existing contacts to pending status`);
        } else {
          currentJob.contacts = [];
          currentJob.totalContacts = 0;
          console.log(`⚠️ Fallback: No existing contacts found to reset`);
        }
      }
    } else {
      console.log(`📝 Resetting existing contacts to pending (updateContacts: ${updateContacts})`);

      // Reset existing contacts to pending and update total count
      if (currentJob.contacts && currentJob.contacts.length > 0) {
        currentJob.contacts.forEach(contact => {
          contact.status = 'pending';
          contact.error = null;
        });

        // Update total contacts count based on actual contacts array
        const actualContactCount = currentJob.contacts.length;
        if (currentJob.totalContacts !== actualContactCount) {
          console.log(`📊 Updating totalContacts from ${currentJob.totalContacts} to ${actualContactCount}`);
          currentJob.totalContacts = actualContactCount;
        }

        // Reset other job counters
        currentJob.successCount = 0; 
        currentJob.processedCount = 0; 
        currentJob.currentBatchIndex = 0;
        currentJob.status = 'processing';

        console.log(`✅ Reset ${actualContactCount} existing contacts to pending status`);
      } else {
        console.log(`⚠️ No contacts array found in job ${currentJob.jobId}`);
        currentJob.contacts = [];
        currentJob.totalContacts = 0;
      }
    }

    // **CLEAR COOLDOWN AND MARK AS OVERRIDDEN**
    if (userSession) {
      // Clear cooldown settings and mark as overridden
      userSession.cooldownActive = false;
      userSession.cooldownEndDate = null;
      userSession.lastJobCompleted = null;
      userSession.currentJobId = null; // Clear current job reference
      userSession.cooldownOverridden = true; // Mark as overridden
      userSession.overriddenAt = new Date().toISOString();

      userSessions[userId] = userSession;
      await saveUserSessions(userSessions);
      console.log(`✅ Cooldown cleared and marked as overridden for user ${userId} - ready for new processing`);
    }

    // **ALSO MARK ALL COMPLETED JOBS AS OVERRIDDEN** - This prevents reload restart
    const allUserJobs = Object.values(jobs).filter(job => job.userId === userId);
    let markedJobs = 0;

    for (const job of allUserJobs) {
      if (job.status === "completed") {
        job.cooldownOverridden = true;
        job.overriddenAt = new Date().toISOString();
        jobs[job.jobId] = job;
        markedJobs++;
        console.log(`🔓 Marked job ${job.jobId} as cooldown overridden`);
      }
    }

    // Mevcut job'ı tamamen sıfırla ve yeniden başlat
    currentJob.currentBatchIndex = 0;
    currentJob.cooldownOverridden = false;
    currentJob.successCount = 0;
    currentJob.processedCount = 0;
    currentJob.failureCount = 0;
    currentJob.status = 'processing';
    currentJob.lastProcessedAt = null;
    currentJob.completedAt = null;
    currentJob.overriddenAt = null;
    currentJob.overrideReason = null;
    if (currentJob.contacts && currentJob.contacts.length > 0) {
      currentJob.contacts.forEach(contact => {
        contact.status = 'pending';
        contact.error = null;
        contact.completedAt = null;
      });
    }
    // Pattern breakdown ve dailyStats da sıfırlansın
    if (currentJob.dailyStats && currentJob.dailyStats.patternBreakdown) {
      Object.keys(currentJob.dailyStats.patternBreakdown).forEach(key => {
        currentJob.dailyStats.patternBreakdown[key] = 0;
      });
      currentJob.dailyStats.processedToday = 0;
    }
    jobs[currentJob.jobId] = currentJob;
    await saveJobs(jobs);

    // User session'da currentJobId'yi güncelle
    if (userSession) {
      userSession.currentJobId = currentJob.jobId;
      await saveUserSessions(userSessions);
      console.log(`✅ User session currentJobId güncellendi: ${currentJob.jobId}`);
    }

    if (markedJobs > 0) {
      console.log(`✅ Marked ${markedJobs} completed jobs as overridden to prevent reload restart`);
    }

    console.log(`✅ Job resetlendi ve yeniden başlatıldı: ${currentJob.jobId}`);
    console.log(`📊 Final job state: ${currentJob.totalContacts} total contacts, ${currentJob.contacts ? currentJob.contacts.length : 0} contacts in array`);

    // **ADD MISSING BACKGROUND PROCESSING START**
    console.log(`🚀 Starting background processing for restarted job: ${currentJob.jobId}`);
    processJobInBackground(currentJob.jobId).catch(error => {
      console.error(`❌ Background processing failed for job ${currentJob.jobId}:`, error);
    });

    res.status(200).json({
      success: true,
      message: "Job resetlendi ve yeniden başlatıldı.",
      restarted: true,
      processingStarted: true,
      readyForNewJob: false,
      jobStatus: {
        totalContacts: currentJob.totalContacts,
        contactsInArray: currentJob.contacts ? currentJob.contacts.length : 0,
        status: currentJob.status
      }
    });

  } catch (error) {
    console.error(`❌ Error restarting processing: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error restarting processing",
      error: error.message
    });
  }
});

// Force run endpoint - Reset all limits and resume processing
app.post("/force-run/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`🚀 Force run requested for user ${userId}`);
    
    // Load user sessions and jobs
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    const jobs = await loadJobs();
    
    if (!userSession) {
      return res.status(404).json({
        success: false,
        message: "User session not found"
      });
    }
    
    // Find user's current job
    let jobId = userSession.currentJobId;
    let job = jobs[jobId];
    
    // If no job or job is completed/failed, look for any resumable job for this user
    if (!job || ["completed", "failed"].includes(job.status)) {
      // Look for any paused job for this user
      const userJobs = Object.values(jobs).filter(j => j.userId === userId);
      const pausedJob = userJobs.find(j => j.status === "paused");
      
      if (pausedJob) {
        job = pausedJob;
        jobId = pausedJob.jobId;
        console.log(`📋 Found paused job ${jobId} for force run`);
      } else {
        return res.status(404).json({
          success: false,
          message: "No pausable/resumable job found for user"
        });
      }
    }
    
    // Only allow force run for paused jobs or when no active job (ready state)
    if (job.status !== "paused") {
      return res.status(400).json({
        success: false,
        message: `Cannot force run job in ${job.status} state. Only paused jobs can be force-run.`
      });
    }
    
    // Reset ALL user stats to 0 using the helper function
    await resetUserStats(userId);
    console.log(`🧹 Cleared all daily stats for user ${userId} via force run`);
    
    // Force resume the job by changing status to processing
    job.status = "processing";
    delete job.pauseReason;
    delete job.pausedAt;
    delete job.estimatedResumeTime;
    job.resumedAt = new Date().toISOString();
    job.lastProcessedAt = new Date().toISOString();
    job.forceRunAt = new Date().toISOString();
    job.forceRunReason = "manual_force_run_limits_reset";
    
    // Add force run event to history
    const forceRunEvent = {
      type: "resume",
      timestamp: new Date().toISOString(),
      reason: "manual_force_run",
      icon: "🚀",
      message: "Force run - All limits reset and job resumed manually",
      details: {
        resetLimits: "daily, hourly, pattern counts all reset to 0",
        previousStatus: "paused",
        actionType: "manual_force_run",
        resetBy: "user_request"
      }
    };
    
    if (!job.pauseResumeHistory) job.pauseResumeHistory = [];
    job.pauseResumeHistory.push(forceRunEvent);
    
    // Save updated job
    await saveJobs({ ...jobs, [jobId]: job });
    console.log(`✅ Job ${jobId} force-run completed - status changed to processing, all limits reset`);
    
    // Start background processing immediately
    console.log(`🚀 Starting background processing for force-run job ${jobId}`);
    setImmediate(() => processJobInBackground(jobId));
    
    res.status(200).json({
      success: true,
      message: "Job force-run successful - all limits reset and processing resumed",
      job: {
        jobId: job.jobId,
        status: job.status,
        processedCount: job.processedCount,
        totalContacts: job.totalContacts,
        forceRunAt: job.forceRunAt,
        resumedAt: job.resumedAt
      }
    });
    
  } catch (error) {
    console.error(`❌ Error in force run: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error performing force run",
      error: error.message
    });
  }
});

// Initialize data directory, MongoDB and start server
(async () => {
  try {
    // First ensure data directory exists (legacy)
    await ensureDataDir();
    console.log("✅ Data directory initialization complete");
    
    // Then initialize MongoDB
    await initializeDB();
    
    // Daily stats cleaning disabled - keeping all historical data
    console.log(`📊 Daily stats cleaning disabled - all historical data will be preserved`);
    
    // Start server
    app.listen(PORT, () => {
      const currentPattern = getCurrentHumanPattern();
      console.log(`✅ Server is running on http://localhost:${PORT}`);
      console.log(`🕒 Starting with ${currentPattern.name} pattern`);
      console.log(`🔄 Active patterns:`, Object.entries(HUMAN_PATTERNS)
        .filter(([_, p]) => !p.pause)
        .map(([name]) => name)
        .join(', '));
      console.log(`💾 All data now stored in MongoDB (no more file storage)`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize application:', error);
    process.exit(1);
  }
})();

// Debug endpoint to check and clear stats
app.get("/debug/stats", async (req, res) => {
  try {
    const { DailyStats } = require("./helpers/db");
    
    // Get all stats
    const allStats = await DailyStats.find({}).lean();
    
    // Group by userId
    const statsByUser = {};
    allStats.forEach(stat => {
      if (!statsByUser[stat.userId]) {
        statsByUser[stat.userId] = [];
      }
      statsByUser[stat.userId].push({
        dateKey: stat.dateKey,
        hourKey: stat.hourKey,
        patternKey: stat.patternKey,
        count: stat.count,
        createdAt: stat.createdAt
      });
    });
    
    res.json({
      totalDocuments: allStats.length,
      statsByUser,
      summary: Object.keys(statsByUser).map(userId => ({
        userId,
        documentCount: statsByUser[userId].length,
        totalCount: statsByUser[userId].reduce((sum, stat) => sum + (stat.count || 1), 0)
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Debug endpoint to clear all stats
app.post("/debug/clear-stats", async (req, res) => {
  try {
    const { DailyStats } = require("./helpers/db");
    
    const result = await DailyStats.deleteMany({});
    
    res.json({
      success: true,
      deletedCount: result.deletedCount,
      message: "All stats cleared"
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});