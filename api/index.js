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
  getUserCooldownStatus
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
const BURST_LIMIT = 15; // Max profiles in one hour (fallback)
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

// CRM-based key generation functions for shared limits
const getTodayCrmKey = (crmUrl) => {
  const normalizedCrm = normalizeCrmUrl(crmUrl);
  return `${normalizedCrm}_${new Date().toISOString().split("T")[0]}`; // crm_YYYY-MM-DD
};

const getHourCrmKey = (crmUrl) => {
  const normalizedCrm = normalizeCrmUrl(crmUrl);
  const now = new Date();
  return `${normalizedCrm}_${now.toISOString().split("T")[0]}-${now.getHours()}`; // crm_YYYY-MM-DD-HH
};

const getPatternCrmKey = (crmUrl) => {
  const normalizedCrm = normalizeCrmUrl(crmUrl);
  const now = new Date();
  const currentPattern = getCurrentHumanPattern();
  return `${normalizedCrm}_${new Date().toISOString().split("T")[0]}-${currentPattern.name}`; // crm_YYYY-MM-DD-patternName
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
  
  // Get current time-based keys
  const today = new Date().toISOString().split("T")[0]; // 2025-08-31
  const hour = `${today}-${new Date().getHours()}`; // 2025-08-31-20
  const currentPattern = getCurrentHumanPattern();
  const pattern = `${today}-${currentPattern.name}`; // 2025-08-31-afternoonWork
  
  let todayCount = 0;
  let hourCount = 0;
  let patternCount = 0;
  
  // First try user-specific stats
  if (stats[userId]) {
    todayCount = stats[userId][today] || 0;
    hourCount = stats[userId][hour] || 0;
    patternCount = stats[userId][pattern] || 0;
    console.log(`📊 User ${userId} stats found:`, { todayCount, hourCount, patternCount });
  }
  
  // If no user stats, try CRM-based keys
  if (todayCount === 0 && hourCount === 0 && patternCount === 0 && crmUrl) {
    const normalizedCrm = normalizeCrmUrl(crmUrl);
    if (stats[normalizedCrm]) {
      todayCount = stats[normalizedCrm][today] || 0;
      hourCount = stats[normalizedCrm][hour] || 0;
      patternCount = stats[normalizedCrm][pattern] || 0;
      console.log(`📊 CRM ${normalizedCrm} stats found:`, { todayCount, hourCount, patternCount });
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
    canProcess
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

// Get next active (non-pause) pattern
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
    const todayKey = getTodayCrmKey(crmUrl);
    const hourKey = getHourCrmKey(crmUrl);
    const patternKey = getPatternCrmKey(crmUrl);
    const normalizedCrm = normalizeCrmUrl(crmUrl);
    
    // Use CRM-based keys instead of user-based keys
    await updateDailyStats(normalizedCrm, todayKey, hourKey, patternKey);
    
    console.log(`📊 Updated CRM daily stats for ${normalizedCrm}: day=${todayKey}, hour=${hourKey}, pattern=${patternKey}`);
  } catch (error) {
    console.error("❌ Error updating CRM daily stats:", error?.message);
  }
};

const updateUserDailyStats = async (userId, crmUrl) => {
  try {
    if (crmUrl) {
      // Use CRM-based stats for shared processing
      await updateCrmDailyStats(crmUrl);
    } else {
      // Fallback to user-based stats for backward compatibility
      const today = getTodayKey();
      const hourKey = getHourKey();
      const patternKey = getPatternKey();
      
      await updateDailyStats(userId, today, hourKey, patternKey);
      console.log(`📊 Updated user daily stats for ${userId}: ${today}, ${hourKey}, ${patternKey}`);
    }
  } catch (error) {
    console.error("❌ Error updating daily stats:", error?.message);
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

// CORS setup
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, Origin"
  );
  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  } else {
    next();
  }
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Enhanced endpoint with human pattern awareness
app.post("/start-processing", async (req, res) => {
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
      if (jobCrmUrl && normalizeCrmUrl(jobCrmUrl) === normalizedCrm && 
          job.status !== "completed" && 
          job.contacts && 
          job.processedCount < job.totalContacts) {
        existingJob = job;
        jobId = job.jobId;
        console.log("📋 Found CRM-shared incomplete job:", {
          jobId: job.jobId,
          originalUserId: job.userId,
          currentUserId: userId,
          crmUrl: normalizedCrm,
          status: job.status,
          processed: job.processedCount,
          total: job.totalContacts
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
        existingJob = jobs[jobId];
        console.log("📋 Found existing job via user session:", {
          jobId: existingJob.jobId,
          status: existingJob.status,
          processed: existingJob.processedCount,
          total: existingJob.totalContacts
        });
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
            console.log(`🟥 [CONTACT BATCH INDEX GUARD] currentBatchIndex (${job.currentBatchIndex}) >= contactBatches.length (${contactBatches.length}), sıfırlanıyor.`);
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

            const match = contact.linkedinUrl.match(/\/in\/([^\/]+)/);
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

              contact.status = "completed";
              contact.processedAt = new Date().toISOString();
              contact.humanPattern = profileData.humanPattern || currentPatternName;
              job.successCount++;
              processedInSession++;

              // Update job count and synchronize with daily stats
              job.processedCount = job.successCount + job.failureCount;
              await synchronizeJobWithDailyStats(job.userId, job);

              // Update pattern-specific stats
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

              // Update CRM-based daily stats (shared across users)
              const userSessionForStats = await (async () => {
                const sessions = await loadUserSessions();
                return sessions[job.userId];
              })();
              
              if (userSessionForStats?.crmUrl) {
                await updateUserDailyStats(job.userId, userSessionForStats.crmUrl);
              } else {
                await updateUserDailyStats(job.userId); // Fallback to user-based
              }

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
    
    console.log(`📊 Job completion check for ${jobId}:`, {
      remainingPending,
      totalContacts: job.totalContacts,
      processedCount: job.processedCount,
      successCount: job.successCount,
      failureCount: job.failureCount,
      allContactsAccountedFor: (job.successCount + job.failureCount) === job.totalContacts
    });
    
    if (remainingPending === 0 && job.status === "processing") {
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.currentBatchIndex = 0; // İş bittiğinde sıfırla
      job.completionReason = "background_processing_completed";

      // Final pattern history entry
      if (!job.humanPatterns.patternHistory)
        job.humanPatterns.patternHistory = [];
      job.humanPatterns.patternHistory.push({
        pattern: currentPatternName,
        endTime: new Date().toISOString(),
        profilesProcessed: processedInSession,
      });

      console.log(`🎉 Job ${jobId} completed by background processing! Final pattern breakdown:`, job.dailyStats.patternBreakdown);
    } else if (remainingPending > 0) {
      // Check if we've processed all available contacts but some are still pending
      // This can happen if processing was interrupted
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
  }
};
// Enhanced job status endpoint with human pattern info and synchronized stats
app.get("/job-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    console.log(`🔍 JOB STATUS REQUEST - Getting status for job ID: ${jobId}`);
    console.log(`🔍 Request headers:`, req.headers['user-agent']);
    console.log(`🔍 Request from IP: ${req.ip}`);
    
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

    // Synchronize the job stats with daily stats to ensure consistency
    console.log(`🔄 Synchronizing job stats for user ${job.userId}`);
    await synchronizeJobWithDailyStats(job.userId, job);

    // Include current pattern and daily limit info
    const userSessions = await loadUserSessions();
    const userSession = userSessions[job.userId];
    const jobCrmUrl = userSession?.crmUrl;
    const limitCheck = await checkDailyLimit(job.userId, jobCrmUrl);
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

    console.log(`✅ Returning job status for ${jobId}:`, {
      status: job.status,
      processed: job.processedCount,
      total: job.totalContacts,
      timestamps: { createdAt, lastProcessedAt, completedAt },
      stalled: isStalled,
      timeSinceLastProcess: Math.round(timeSinceLastProcess)
    });

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
        estimatedResumeTime: job.estimatedResumeTime,
        humanPatterns: job.humanPatterns,
        dailyStats: job.dailyStats,
        currentPattern: currentPattern.name,
        currentPatternInfo: currentPattern,
        dailyLimitInfo: limitCheck,
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
          if (jobUserSession?.crmUrl && 
              normalizeCrmUrl(jobUserSession.crmUrl) === normalizedCrm &&
              job.status !== "completed" &&
              job.contacts && 
              job.processedCount < job.totalContacts) {
            sharedJobId = job.jobId;
            console.log(`📋 Found CRM-shared job for user ${userId}:`, {
              jobId: job.jobId,
              originalCreator: job.userId,
              crmUrl: normalizedCrm
            });
            break;
          }
        }
      }
      
      if (!sharedJobId) {
        const limitCheck = await checkDailyLimit(userId, userSession?.crmUrl);
        console.log(`❌ No active job found for user ${userId}`);
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
    const currentPattern = getCurrentHumanPattern();

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
    });
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
    const job = jobs[userSession.currentJobId];
    
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
          job.status = "processing";
          job.resumedAt = new Date().toISOString();
          await saveJobs({...(await loadJobs()), [job.jobId]: job});
          
          // Use setImmediate to restart processing in background
          setImmediate(() => processJobInBackground(job.jobId));
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
    // Aktif iş var mı kontrol et
    const activeJob = await Job.findOne({ userId, status: { $in: ["processing", "pending"] } });
    if (activeJob) {
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
        canOverride: diffDays < 30 && !lastCompletedJob.cooldownOverridden
      };
    }
    
    // Get user session to determine current job
    const userSessions = await loadUserSessions();
    const currentJobId = userSessions[userId]?.currentJobId;
    
    res.status(200).json({
      success: true,
      currentJobId,
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
      
      // Get contacts from the previous job and reset them
      const previousContacts = lastCompletedJob.contacts || [];
      const freshContacts = previousContacts.map(contact => ({
        contactId: contact.contactId,
        linkedinUrl: contact.linkedinUrl,
        status: 'pending',  // Reset all to pending
        error: null
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
      
      // Create new job
      const newJob = {
        jobId: newJobId,
        userId: userId,
        status: 'pending',
        contacts: freshContacts,
        totalContacts: freshContacts.length,
        processedCount: 0,
        successCount: 0,
        failureCount: 0,
        currentBatchIndex: 0,
        createdAt: now.toISOString(),
        startTime: now.toISOString(),
        errors: [],
        humanPatterns: {
          startPattern: null,
          startTime: now.toISOString(),
          patternHistory: []
        },
        dailyStats: {
          startDate: now.toISOString().split('T')[0],
          processedToday: 0,
          patternBreakdown: {}
        }
      };
      
      // Save the new job
      const allJobs = await loadJobs();
      allJobs[newJobId] = newJob;
      await saveJobs(allJobs);
      
      // Update user session with new job ID
      userSession.currentJobId = newJobId;
      await saveUserSessions(userSessions);
      
      console.log(`✅ New job ${newJobId} created automatically with ${freshContacts.length} contacts reset to pending`);
      
      // Start background processing for the new job
      setImmediate(() => {
        console.log(`🔄 Starting background processing for new job ${newJobId}`);
        processJobInBackground(newJobId);
      });
      
      res.status(200).json({
        success: true,
        message: `Cooldown overridden and new job started automatically`,
        overriddenJob: {
          jobId: lastCompletedJob.jobId,
          completedAt: lastCompletedJob.completedAt,
          overriddenAt: lastCompletedJob.overriddenAt,
          daysRemaining: 30 - daysSinceCompletion
        },
        newJob: {
          jobId: newJobId,
          status: 'pending',
          totalContacts: freshContacts.length,
          processedCount: 0,
          message: 'New job started automatically with all contacts reset to pending'
        },
        autoStarted: true,
        canStartNewJob: true
      });
      
    } catch (autoStartError) {
      console.error(`❌ Error auto-starting new job after override: ${autoStartError.message}`);
      
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
        autoStartFailed: autoStartError.message,
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

// Clean override endpoint - removes all jobs and starts fresh
app.post("/override-cooldown-clean/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason = "Clean override - fresh start" } = req.body;
    
    console.log(`🧹 Clean cooldown override requested for user ${userId}`);
    
    // 1. Remove ALL jobs for this user from MongoDB
    const jobs = await loadJobs();
    const userJobIds = Object.keys(jobs).filter(jobId => jobs[jobId].userId === userId);
    
    console.log(`🗑️ Removing ${userJobIds.length} existing jobs for user ${userId}`);
    
    // Remove from jobs object
    userJobIds.forEach(jobId => {
      delete jobs[jobId];
    });
    
    // Save updated jobs (without user's jobs)
    await saveJobs(jobs);
    
    // 2. Clear user session
    const userSessions = await loadUserSessions();
    if (userSessions[userId]) {
      delete userSessions[userId];
      await saveUserSessions(userSessions);
      console.log(`🗑️ Cleared user session for ${userId}`);
    }
    
    // 3. Clear other user data
    try {
      // Daily stats
      const dailyStats = await require('./helpers/fileLock').readJsonFile('./data/daily_stats.json');
      if (dailyStats[userId]) {
        delete dailyStats[userId];
        await require('./helpers/fileLock').writeJsonFile('./data/daily_stats.json', dailyStats);
      }
      
      // Daily rate limits
      const rateLimits = await require('./helpers/fileLock').readJsonFile('./data/daily_rate_limits.json');
      if (rateLimits[userId]) {
        delete rateLimits[userId];
        await require('./helpers/fileLock').writeJsonFile('./data/daily_rate_limits.json', rateLimits);
      }
    } catch (cleanupError) {
      console.log(`⚠️ Optional cleanup warning: ${cleanupError.message}`);
    }
    
    console.log(`✅ All data cleared for user ${userId}. User can now start completely fresh.`);
    
    res.status(200).json({
      success: true,
      message: `All jobs and data cleared for user ${userId}. You can now start fresh from 0.`,
      clearedJobs: userJobIds.length,
      clearedJobIds: userJobIds,
      overrideReason: reason,
      overriddenAt: new Date().toISOString(),
      canStartFresh: true,
      nextStep: "Import contacts and start a new job - everything starts from 0"
    });
    
  } catch (error) {
    console.error(`❌ Error in clean override: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error in clean override",
      error: error.message
    });
  }
});

// Complete reset endpoint - nuclear option
app.post("/admin/reset-user-completely/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { confirmReset = false } = req.body;
    
    if (!confirmReset) {
      return res.status(400).json({
        success: false,
        message: "Please confirm reset by sending confirmReset: true",
        warning: "This will completely remove ALL data for this user"
      });
    }
    
    console.log(`🔥 COMPLETE RESET requested for user ${userId}`);
    
    // Remove all jobs
    const jobs = await loadJobs();
    const userJobIds = Object.keys(jobs).filter(jobId => jobs[jobId].userId === userId);
    userJobIds.forEach(jobId => delete jobs[jobId]);
    await saveJobs(jobs);
    
    // Remove user session
    const userSessions = await loadUserSessions();
    delete userSessions[userId];
    await saveUserSessions(userSessions);
    
    // Remove from all data files
    const dataFiles = [
      './data/daily_stats.json',
      './data/daily_rate_limits.json',
      './data/user_sessions.json',
      './data/direct_sessions.json',
      './data/free_sessions.json'
    ];
    
    for (const file of dataFiles) {
      try {
        const data = await require('./helpers/fileLock').readJsonFile(file);
        if (data[userId]) {
          delete data[userId];
          await require('./helpers/fileLock').writeJsonFile(file, data);
          console.log(`🗑️ Removed ${userId} from ${file}`);
        }
      } catch (fileError) {
        console.log(`⚠️ Could not clean ${file}: ${fileError.message}`);
      }
    }
    
    console.log(`🔥 COMPLETE RESET completed for user ${userId}`);
    
    res.status(200).json({
      success: true,
      message: `User ${userId} has been completely reset. All data removed.`,
      removedJobs: userJobIds.length,
      resetAt: new Date().toISOString(),
      status: "User can start completely fresh as if they never used the system"
    });
    
  } catch (error) {
    console.error(`❌ Error in complete reset: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Error in complete reset",
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
// Simple override endpoint without verification (for testing)
app.post("/override-cooldown-simple/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason = "Simple override" } = req.body;
    
    console.log(`🔓 Simple cooldown override requested for user ${userId}`);
    
    // İLK ÖNCE CRM'DAN CONTACTLARI ÇEK VE LOGLA
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    
    if (!userSession || !userSession.crmUrl || !userSession.accessToken) {
      return res.status(400).json({
        success: false,
        message: "User session, CRM URL veya access token bulunamadı"
      });
    }
    
    console.log(`📥 CRM'dan contactları çekiyorum...`);
    console.log(`🔗 CRM URL: ${userSession.crmUrl}`);
    
    try {
      const { fetchContactsFromDataverse } = require('../helpers/dynamics');
      
      const freshContactsFromCRM = await fetchContactsFromDataverse(
        userSession.accessToken,
        userSession.crmUrl,
        userSession.tenantId
      );
      
      console.log(`📋 CRM'dan gelen RAW contactlar: ${freshContactsFromCRM ? freshContactsFromCRM.length : 0}`);
      
      if (freshContactsFromCRM && freshContactsFromCRM.length > 0) {
        console.log(`🔍 === TÜM CRM CONTACTLARI ===`);
        freshContactsFromCRM.forEach((contact, index) => {
          console.log(`Contact ${index + 1}:`, {
            contactid: contact.contactid,
            id: contact.id,
            firstname: contact.firstname,
            lastname: contact.lastname,
            uds_linkedin: contact.uds_linkedin,
            linkedinurl: contact.linkedinurl,
            linkedin_url: contact.linkedin_url,
            websiteurl: contact.websiteurl
          });
        });
        console.log(`🔍 === CRM CONTACTLARI SONU ===`);
      } else {
        console.log(`❌ CRM'dan contact gelmedi!`);
        return res.status(400).json({
          success: false,
          message: "CRM'dan contact alınamadı"
        });
      }
    } catch (crmError) {
      console.error(`❌ CRM contact fetch hatası: ${crmError.message}`);
      return res.status(500).json({
        success: false,
        message: `CRM'dan contact çekerken hata: ${crmError.message}`
      });
    }
    
    // Load jobs
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
    const now = new Date();
    
    // Simply set the override flags
    lastCompletedJob.cooldownOverridden = true;
    lastCompletedJob.overriddenAt = now.toISOString();
    lastCompletedJob.overrideReason = reason;
    
    // Save without verification
    jobs[lastCompletedJob.jobId] = lastCompletedJob;
    await saveJobs(jobs);
    
    console.log(`✅ Simple override completed for user ${userId}, job ${lastCompletedJob.jobId}`);
    
    // Auto-start new job after simple override
    try {
      console.log(`🚀 Yeni job başlatılıyor...`);
      
      // CRM'dan gelen contactları job formatına çevir
      const freshContactsFromCRM = await fetchContactsFromDataverse(
        userSession.accessToken,
        userSession.crmUrl,
        userSession.tenantId
      );
      
      console.log(`📋 CRM'dan gelen ${freshContactsFromCRM.length} contact işleniyor...`);
      
      const updatedContacts = freshContactsFromCRM.map((contact, index) => {
        const contactId = contact.contactid;
        const fullName = contact.fullname || `${contact.firstname || ''} ${contact.lastname || ''}`.trim();
        
        // LinkedIn URL'ini al (CRM'da uds_linkedin alanında)
        let linkedinUrl = contact.uds_linkedin;
        
        // LinkedIn URL temizleme ve doğrulama
        if (linkedinUrl) {
          // URL'yi normalize et
          linkedinUrl = linkedinUrl.trim();
          if (!linkedinUrl.startsWith('http')) {
            linkedinUrl = 'https://' + linkedinUrl;
          }
          
          // LinkedIn kontrolü
          if (!linkedinUrl.includes('linkedin.com')) {
            console.log(`⚠️ Contact ${index + 1} (${fullName}): LinkedIn URL geçersiz - "${linkedinUrl}"`);
            linkedinUrl = null;
          } else {
            console.log(`✅ Contact ${index + 1} (${fullName}): LinkedIn URL geçerli - "${linkedinUrl}"`);
          }
        } else {
          console.log(`⚠️ Contact ${index + 1} (${fullName}): LinkedIn URL bulunamadı`);
        }
        
        return {
          contactId,
          fullName,
          linkedinUrl,
          status: 'pending',
          error: null
        };
      });
      
      // Tüm contactları dahil et (LinkedIn URL olmayanları da)
      const validContacts = updatedContacts.filter(contact => contact.linkedinUrl);
      
      console.log(`📊 Contact Özeti:`);
      console.log(`   Toplam CRM Contact: ${freshContactsFromCRM.length}`);
      console.log(`   LinkedIn URL'li Contact: ${validContacts.length}`);
      console.log(`   İşlenecek Contact: ${validContacts.length}`);
      
      if (validContacts.length === 0) {
        console.log(`❌ Hiç geçerli LinkedIn URL'li contact bulunamadı!`);
        return res.status(400).json({
          success: false,
          message: "CRM'da geçerli LinkedIn URL'li contact bulunamadı"
        });
      }
      
      // Create new job with fresh contacts
      const newJobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date();
        
        const newJob = {
          jobId: newJobId,
          userId: userId,
          status: 'pending',
          contacts: validContacts,
          totalContacts: validContacts.length,
          processedCount: 0,
          successCount: 0,
          failureCount: 0,
          currentBatchIndex: 0,
          createdAt: now.toISOString(),
          startTime: now.toISOString(),
          errors: [],
          humanPatterns: {
            startPattern: null,
            startTime: now.toISOString(),
            patternHistory: []
          },
          dailyStats: {
            startDate: now.toISOString().split('T')[0],
            processedToday: 0,
            patternBreakdown: {}
          }
        };
        
        jobs[newJobId] = newJob;
        await saveJobs(jobs);
        
        userSession.currentJobId = newJobId;
        await saveUserSessions(userSessions);
        
        // Start processing
        setImmediate(() => processJobInBackground(newJobId));
        
        res.status(200).json({
          success: true,
          message: `Cooldown overridden and new job started automatically (simple method)`,
          overriddenJob: {
            jobId: lastCompletedJob.jobId,
            completedAt: lastCompletedJob.completedAt,
            overriddenAt: lastCompletedJob.overriddenAt,
            overrideReason: lastCompletedJob.overrideReason
          },
          newJob: {
            jobId: newJobId,
            status: 'pending',
            totalContacts: validContacts.length,
            processedCount: 0
          },
          autoStarted: true,
          canStartNewJob: true,
          contactSummary: {
            totalFromCRM: freshContactsFromCRM.length,
            validLinkedInContacts: validContacts.length,
            contactDetails: validContacts.map(c => ({
              name: c.fullName,
              hasLinkedIn: !!c.linkedinUrl
            }))
          }
        });
        
    } catch (error) {
      console.error(`❌ Job oluşturma hatası: ${error.message}`);
      res.status(500).json({
        success: false,
        message: "Job oluşturulurken hata oluştu",
        error: error.message
      });
    }
    
  } catch (error) {
    console.error(`❌ Override cooldown hatası: ${error.message}`);
    res.status(500).json({
      success: false,
      message: "Override cooldown işleminde hata",
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
    const daysRemaining = Math.max(0, 30 - daysSinceCompletion);

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

// Endpoint to clean up and reset user data (for debugging cooldown issues)
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
      } catch (error) {
        console.log(`⚠️ Some optional cleanup failed: ${error.message}`);
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