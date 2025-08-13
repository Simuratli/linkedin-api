const express = require("express");
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
  cleanOldDailyStats
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
  
  // CRM-based keys for shared limits
  const todayCrmKey = getTodayCrmKey(crmUrl);
  const hourCrmKey = getHourCrmKey(crmUrl);
  const patternCrmKey = getPatternCrmKey(crmUrl);
  const currentPattern = getCurrentHumanPattern();
  const normalizedCrm = normalizeCrmUrl(crmUrl);

  // Get CRM-wide counts (shared across all users of same CRM)
  const todayCount = stats[todayCrmKey] || 0;
  const hourCount = stats[hourCrmKey] || 0;
  const patternCount = stats[patternCrmKey] || 0;

  // Check if in pause period
  const inPause = isDuringPause();

  // Get pattern-specific limit
  const patternLimit = currentPattern.maxProfiles || 0;

  // Determine if can process based on CRM-wide limits
  const canProcess =
    !inPause &&
    todayCount < DAILY_PROFILE_LIMIT &&
    hourCount < BURST_LIMIT &&
    (patternLimit === 0 || patternCount < patternLimit);

  console.log(`📊 CRM ${normalizedCrm} limits:`, {
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
    crmUrl: normalizedCrm,
    sharedLimits: `Shared with all users of ${normalizedCrm}`
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

// Enhanced background processing with human patterns
const processJobInBackground = async (jobId) => {
  console.log(`🔄 Starting background processing for job: ${jobId}`);
  
  const jobs = await loadJobs();
  const userSessions = await loadUserSessions();
  const job = jobs[jobId];

  if (!job) {
    console.error(`❌ No job found with ID ${jobId}`);
    return;
  }

  if (job.status === "completed") {
    console.log(`⏹️ Job ${jobId} is already completed`);
    return;
  }

  const userSession = userSessions[job.userId];
  if (!userSession) {
    console.error(`❌ No user session found for job ${jobId} (userId: ${job.userId})`);
    console.log(`🔧 Job exists but user session is missing. This usually happens after server restart.`);
    console.log(`💡 Solution: User needs to reconnect through extension or use debug-restart-job endpoint`);
    
    // Mark job as paused with specific reason
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

  console.log(`📊 Processing job ${jobId}:`, {
    status: job.status,
    processed: job.processedCount,
    total: job.totalContacts,
    userId: job.userId
  });

  try {
    // Update job status to processing
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

    const BATCH_SIZE = 1;
    let processedInSession = job.processedInSession || 0;
    let currentPatternName = job.currentPatternName || getCurrentHumanPattern().name;

    // Get pending contacts
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    const contactBatches = chunkArray(pendingContacts, BATCH_SIZE);

    // Continue from current batch index
    const startBatchIndex = job.currentBatchIndex || 0;

    console.log(
      `📊 Processing ${pendingContacts.length} remaining contacts in ${contactBatches.length} batches for job ${jobId}`
    );
    console.log(`🕒 Continuing with ${currentPatternName} pattern from batch ${startBatchIndex + 1}/${contactBatches.length}`);

    for (let batchIndex = startBatchIndex; batchIndex < contactBatches.length; batchIndex++) {
      // Save progress after each batch
      job.currentBatchIndex = batchIndex;
      job.currentPatternName = currentPatternName;
      job.processedInSession = processedInSession;
      await saveJobs({ ...(await loadJobs()), [jobId]: job });
      
      // Check if pattern has changed
      const newPattern = getCurrentHumanPattern();
      if (newPattern.name !== currentPatternName) {
        console.log(
          `🔄 Pattern changed from ${currentPatternName} to ${newPattern.name}`
        );

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
        console.log(
          `📊 Pattern: ${limitCheck.currentPattern} (${limitCheck.patternCount}/${limitCheck.patternLimit})`
        );
        console.log(
          `📊 Today: ${limitCheck.dailyCount}/${limitCheck.dailyLimit}, This hour: ${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}`
        );

        let pauseReason = "limit_reached";
        let estimatedResume = limitCheck.estimatedResumeTime;

        if (limitCheck.inPause) {
          pauseReason = "pause_period";
          console.log(
            `⏸️ Currently in ${limitCheck.currentPattern} pause period`
          );
        } else if (limitCheck.patternCount >= limitCheck.patternLimit) {
          pauseReason = "pattern_limit_reached";
          console.log(
            `📈 Pattern limit reached for ${limitCheck.currentPattern}`
          );
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

      console.log(
        `🔄 Processing batch ${batchIndex + 1} of ${contactBatches.length} for job ${jobId} (${currentPatternName} pattern)`
      );

      // Her işlem için detaylı log kayıtları tutacak şekilde yapıyı değiştiriyorum
      const batchPromises = batch.map(async (contact) => {
        try {
          console.log(`🔄 Kişi işlemi başlatılıyor: ${contact.contactId}`);
          contact.status = "processing";

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

            console.log(
              `✅ Successfully updated contact ${contact.contactId} (${processedInSession} in ${currentPatternName} session)`
            );
          } catch (error) {
            if (error.message === "LINKEDIN_AUTH_REQUIRED" || error.message === "DATAVERSE_AUTH_REQUIRED") {
              // Stop processing and wait for user re-authentication
              console.log("⏸️ Processing paused - waiting for user authentication");
              return;
            }
            console.error(
              `❌ Error processing contact ${contact.contactId}:`,
              error.message
            );

            contact.status = "failed";
            contact.error = error.message;
            contact.humanPattern = currentPatternName;
            job.failureCount++;
            job.errors.push({
              contactId: contact.contactId,
              error: error.message,
              timestamp: new Date().toISOString(),
              humanPattern: currentPatternName,
            });

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
          }
        } catch (error) {
          console.error(`❌ Batch processing error:`, error.message);
          if (error.message.includes("AUTH_REQUIRED")) {
            throw error;
          }
        }
      });

      try {
        // Promise.allSettled yerine her bir promisi tek tek izleme için değiştiriyorum
        console.log(`🔄 Batch işlemi başlatılıyor: ${batchIndex + 1}/${contactBatches.length}`);
        const results = await Promise.allSettled(batchPromises);
        
        // Sonuçları kontrol et
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            console.error(`❌ Batch promise ${index} başarısız oldu:`, result.reason);
          }
        });
        
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
          console.log(
            `😴 Taking a ${breakMinutes} minute break after ${processedInSession} profiles in ${currentPatternName}...`
          );
          await new Promise((resolve) => setTimeout(resolve, breakTime));
          console.log(`▶️ Mola tamamlandı, devam ediliyor.`);
        }

        // Wait between batches with human pattern timing
        if (batchIndex < contactBatches.length - 1) {
          const waitTime = getHumanPatternDelay();
          console.log(
            `⏳ Human pattern delay (${currentPatternName}): ${Math.round(waitTime / 1000 / 60)} minutes before next profile...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          console.log(`▶️ Bekleme süresi tamamlandı, sonraki profile geçiliyor.`);
        }

        console.log(
          `📈 Progress for job ${jobId}: ${job.processedCount}/${job.totalContacts} contacts processed (${currentPatternName}: ${processedInSession})`
        );

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
      }
    }

    // Mark job as completed if all contacts processed
    const remainingPending = job.contacts.filter(
      (c) => c.status === "pending"
    ).length;
    if (remainingPending === 0) {
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      
      // Check if we should set user cooldown after job completion
      try {
        await checkAndSetUserCooldown(job.userId);
      } catch (error) {
        console.error(`❌ Error setting user cooldown: ${error.message}`);
      }

      // Final pattern history entry
      if (!job.humanPatterns.patternHistory)
        job.humanPatterns.patternHistory = [];
      job.humanPatterns.patternHistory.push({
        pattern: currentPatternName,
        endTime: new Date().toISOString(),
        profilesProcessed: processedInSession,
      });

      console.log(
        `🎉 Job ${jobId} completed! Final pattern breakdown:`,
        job.dailyStats.patternBreakdown
      );
    }

    // Final save
    const finalJobs = await loadJobs();
    finalJobs[jobId] = job;
    await saveJobs(finalJobs);

    console.log(`✅ Job ${jobId} processing completed. Status: ${job.status}`);
  } catch (error) {
    console.error(`❌ Background processing error for job ${jobId}:`, error);
    
    // Store the error details more comprehensively
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
    
    // If job is in processing state but hasn't been updated for 5 minutes, restart it
    const isStalled = job.status === "processing" && 
                     job.processedCount < job.totalContacts && 
                     timeSinceLastProcess > 300; // 5 minutes
                     
    if (isStalled) {
      console.log(`⚠️ Job ${jobId} appears stalled (${Math.round(timeSinceLastProcess)}s since last update), restarting...`);
      
      // Restart background processing
      setImmediate(() => processJobInBackground(jobId));
      
      // Update job status to indicate restart
      job.restartedAt = now.toISOString();
      job.restartCount = (job.restartCount || 0) + 1;
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
        }
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
    const cooldownStatus = await getUserCooldownStatus(userId);
    
    if (!cooldownStatus) {
      return res.status(200).json({
        success: true,
        hasCooldown: false,
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
    
    // Save the updated job
    jobs[lastCompletedJob.jobId] = lastCompletedJob;
    await saveJobs(jobs);
    
    // Verify the save worked by reloading
    const reloadedJobs = await loadJobs();
    const verifyJob = reloadedJobs[lastCompletedJob.jobId];
    console.log(`✅ Verification - Job ${lastCompletedJob.jobId} cooldownOverridden: ${verifyJob?.cooldownOverridden}`);
    
    if (!verifyJob?.cooldownOverridden) {
      console.error(`❌ Override save failed! Job ${lastCompletedJob.jobId} cooldownOverridden is still: ${verifyJob?.cooldownOverridden}`);
      return res.status(500).json({
        success: false,
        message: "Failed to save override. Please try again.",
        error: "Save verification failed"
      });
    }
    
    console.log(`✅ Cooldown overridden for user ${userId}. Job ${lastCompletedJob.jobId} marked as override.`);
    
    res.status(200).json({
      success: true,
      message: `Cooldown period overridden. You can now start new processing.`,
      overriddenJob: {
        jobId: lastCompletedJob.jobId,
        completedAt: lastCompletedJob.completedAt,
        overriddenAt: lastCompletedJob.overriddenAt,
        daysSinceCompletion,
        daysRemaining: 30 - daysSinceCompletion
      },
      canStartNewJob: true
    });
    
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