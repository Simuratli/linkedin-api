const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { transformToCreateUserRequest } = require("../helpers/transform");
const {
  fetchLinkedInProfile,
  getCurrentHumanPattern,
  isDuringPause,
  HUMAN_PATTERNS,
} = require("../helpers/linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep, chunkArray, getRandomDelay } = require("../helpers/delay");
const { safeWrite } = require("../helpers/fileLock");

const app = express();
const PORT = process.env.PORT || 3000;

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "processing_jobs.json");
const USER_SESSIONS_FILE = path.join(DATA_DIR, "user_sessions.json");
const DAILY_STATS_FILE = path.join(DATA_DIR, "daily_stats.json");

// ENHANCED DAILY LIMIT CONFIGURATION WITH HUMAN PATTERNS
const DAILY_PROFILE_LIMIT = 180; // Conservative daily limit
const BURST_LIMIT = 15; // Max profiles in one hour (fallback)
const HOUR_IN_MS = 60 * 60 * 1000;

// Human pattern-based limits
const PATTERN_LIMITS = {
  morningBurst: { max: 60, processed: 0 },
  afternoonWork: { max: 80, processed: 0 },
  eveningLight: { max: 40, processed: 0 },
};

// Ensure data directory exists
const ensureDataDir = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error("Error creating data directory:", error);
  }
};

// Daily stats management
const loadDailyStats = async () => {
  try {
    const data = await fs.readFile(DAILY_STATS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const saveDailyStats = async (stats) => {
  try {
    await fs.writeFile(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error("Error saving daily stats:", error);
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

// Enhanced limit checking with human patterns
const checkDailyLimit = async (userId) => {
  const stats = await loadDailyStats();
  const today = getTodayKey();
  const hourKey = getHourKey();
  const patternKey = getPatternKey();
  const currentPattern = getCurrentHumanPattern();

  const userStats = stats[userId] || {};
  const todayCount = userStats[today] || 0;
  const hourCount = userStats[hourKey] || 0;
  const patternCount = userStats[patternKey] || 0;

  // Check if in pause period
  const inPause = isDuringPause();

  // Get pattern-specific limit
  const patternLimit = currentPattern.maxProfiles || 0;

  // Determine if can process based on multiple factors
  const canProcess =
    !inPause &&
    todayCount < DAILY_PROFILE_LIMIT &&
    hourCount < BURST_LIMIT &&
    (patternLimit === 0 || patternCount < patternLimit);

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

const updateDailyStats = async (userId) => {
  const stats = await loadDailyStats();
  const today = getTodayKey();
  const hourKey = getHourKey();
  const patternKey = getPatternKey();

  if (!stats[userId]) stats[userId] = {};

  stats[userId][today] = (stats[userId][today] || 0) + 1;
  stats[userId][hourKey] = (stats[userId][hourKey] || 0) + 1;
  stats[userId][patternKey] = (stats[userId][patternKey] || 0) + 1;

  // Clean old data (keep only last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cutoffDate = sevenDaysAgo.toISOString().split("T")[0];

  for (const key of Object.keys(stats[userId])) {
    if (key < cutoffDate) {
      delete stats[userId][key];
    }
  }

  await saveDailyStats(stats);
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

const getWorkingHoursDelay = () => {
  // This is now handled by getHumanPatternDelay, but keeping for compatibility
  return getHumanPatternDelay();
};

const shouldTakeBreak = (processedInSession) => {
  const currentPattern = getCurrentHumanPattern();

  // Pattern-aware break logic
  if (currentPattern.pause) {
    return getHumanPatternDelay(); // Wait until next active period
  }

  // More frequent breaks during intensive periods
  if (currentPattern.name === "morningBurst" && processedInSession % 8 === 0) {
    return 3 * 60 * 1000; // 3 minute break every 8 profiles in morning
  }

  if (
    currentPattern.name === "afternoonWork" &&
    processedInSession % 12 === 0
  ) {
    return 5 * 60 * 1000; // 5 minute break every 12 profiles in afternoon
  }

  if (currentPattern.name === "eveningLight" && processedInSession % 5 === 0) {
    return 8 * 60 * 1000; // 8 minute break every 5 profiles in evening
  }

  // Traditional break logic (reduced frequency)
  if (processedInSession % 30 === 0) {
    return 10 * 60 * 1000; // 10 minute break every 30 profiles
  }

  // Random breaks (reduced chance during active periods)
  if (Math.random() < 0.02) {
    // 2% chance (was 5%)
    const breakDuration =
      currentPattern.name === "eveningLight"
        ? Math.random() * 20 * 60 * 1000 // 0-20 min in evening
        : Math.random() * 10 * 60 * 1000; // 0-10 min other times
    return breakDuration;
  }

  return 0;
};

// Load/Save processing jobs
const loadJobs = async () => {
  try {
    const data = await fs.readFile(JOBS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const saveJobs = async (jobs) => {
  try {
     await safeWrite(JOBS_FILE, jobs);
  } catch (error) {
    console.error("Error saving jobs:", error);
  }
};

// Load/Save user sessions
const loadUserSessions = async () => {
  try {
    const data = await fs.readFile(USER_SESSIONS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const saveUserSessions = async (sessions) => {
  try {
    await fs.writeFile(USER_SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (error) {
    console.error("Error saving user sessions:", error);
  }
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

// Initialize data directory on startup
ensureDataDir();

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

    // Enhanced limit checking with human patterns
    const limitCheck = await checkDailyLimit(userId);
    const currentPattern = getCurrentHumanPattern();

    if (!limitCheck.canProcess && !resume) {
      let message = `Cannot process profiles. `;

      if (limitCheck.inPause) {
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
        currentPattern: currentPattern,
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
          }
        : null;

    // Load existing jobs and user sessions
    const jobs = await loadJobs();
    const userSessions = await loadUserSessions();

    let jobId;
    let existingJob = null;

    // Check for existing job for this user
    if (resume && userSessions[userId]) {
      jobId = userSessions[userId].currentJobId;
      existingJob = jobs[jobId];
    }

    if (existingJob && existingJob.status === "processing") {
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

    if (!existingJob) {
      // Create new job
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

      existingJob = {
        jobId,
        userId,
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

    // Update user session with new tokens
    userSessions[userId] = {
      ...userSessions[userId],
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
  const jobs = await loadJobs();
  const userSessions = await loadUserSessions();
  const job = jobs[jobId];

  if (!job || job.status === "completed") {
    return;
  }

  const userSession = userSessions[job.userId];

  if (!userSession) {
    console.error(`❌ No user session found for job ${jobId}`);
    return;
  }

  try {
    job.status = "processing";
    job.lastProcessedAt = new Date().toISOString();
    await saveJobs(jobs);

    const BATCH_SIZE = 1;
    let processedInSession = 0;
    let currentPatternName = getCurrentHumanPattern().name;

    // Get pending contacts
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    const contactBatches = chunkArray(pendingContacts, BATCH_SIZE);

    console.log(
      `📊 Processing ${pendingContacts.length} remaining contacts in ${contactBatches.length} batches for job ${jobId}`
    );
    console.log(`🕒 Starting with ${currentPatternName} pattern`);

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
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

      // Enhanced limit checking with human patterns
      const limitCheck = await checkDailyLimit(job.userId);
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

      // Check if user session is still valid
      const currentUserSessions = await loadUserSessions();
      const currentUserSession = currentUserSessions[job.userId];

      if (!currentUserSession || !currentUserSession.accessToken) {
        console.log(`⏸️ Pausing job ${jobId} - user session invalid`);
        job.status = "paused";
        job.pauseReason = "session_invalid";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }

      console.log(
        `🔄 Processing batch ${batchIndex + 1} of ${contactBatches.length} for job ${jobId} (${currentPatternName} pattern)`
      );

      const batchPromises = batch.map(async (contact) => {
        try {
          contact.status = "processing";

          const match = contact.linkedinUrl.match(/\/in\/([^\/]+)/);
          const profileId = match ? match[1] : null;

          if (!profileId) {
            throw new Error(`Invalid LinkedIn URL format`);
          }

          const customCookies = {
            li_at: currentUserSession.li_at,
            jsession: currentUserSession.jsessionid,
          };

          const profileData = await fetchLinkedInProfile(
            profileId,
            customCookies
          );

          if (profileData.error) {
            throw new Error(`LinkedIn API error: ${profileData.error}`);
          }

          // Log which pattern was used for this profile
          console.log(
            `🕒 Profile ${profileId} processed with ${profileData.humanPattern || currentPatternName} pattern`
          );

          const convertedProfile = await transformToCreateUserRequest(
            profileData,
            `${currentUserSession.crmUrl}/api/data/v9.2`,
            currentUserSession.accessToken
          );

          const updateUrl = `${currentUserSession.crmUrl}/api/data/v9.2/contacts(${contact.contactId})`;

          const refreshData = currentUserSession.refreshToken
            ? {
                refreshToken: currentUserSession.refreshToken,
                clientId: currentUserSession.clientId,
                tenantId: currentUserSession.tenantId,
                crmUrl: currentUserSession.crmUrl,
                verifier: currentUserSession.verifier,
              }
            : null;

          await callDataverseWithRefresh(
            updateUrl,
            currentUserSession.accessToken,
            "PATCH",
            convertedProfile,
            refreshData
          );

          contact.status = "completed";
          contact.humanPattern = profileData.humanPattern || currentPatternName;
          job.successCount++;
          processedInSession++;

          // Update pattern-specific stats
          if (!job.dailyStats.patternBreakdown)
            job.dailyStats.patternBreakdown = {};
          if (!job.dailyStats.patternBreakdown[currentPatternName]) {
            job.dailyStats.patternBreakdown[currentPatternName] = 0;
          }
          job.dailyStats.patternBreakdown[currentPatternName]++;

          // Update daily stats
          await updateDailyStats(job.userId);

          console.log(
            `✅ Successfully updated contact ${contact.contactId} (${processedInSession} in ${currentPatternName} session)`
          );
        } catch (error) {
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
            console.log(`⏸️ Pausing job ${jobId} - token refresh failed`);
            job.status = "paused";
            job.pauseReason = "token_refresh_failed";
            throw error;
          }
        }
      });

      try {
        await Promise.allSettled(batchPromises);
        job.processedCount = job.successCount + job.failureCount;

        // Save progress after each batch
        const currentJobs = await loadJobs();
        currentJobs[jobId] = job;
        await saveJobs(currentJobs);

        // Human-like behavior: Check for pattern-aware breaks
        const breakTime = shouldTakeBreak(processedInSession);
        if (breakTime > 0) {
          const breakMinutes = Math.round(breakTime / 1000 / 60);
          console.log(
            `😴 Taking a ${breakMinutes} minute break after ${processedInSession} profiles in ${currentPatternName}...`
          );
          await new Promise((resolve) => setTimeout(resolve, breakTime));
        }

        // Wait between batches with human pattern timing
        if (batchIndex < contactBatches.length - 1) {
          const waitTime = getHumanPatternDelay();
          console.log(
            `⏳ Human pattern delay (${currentPatternName}): ${Math.round(waitTime / 1000 / 60)} minutes before next profile...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
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
        if (error.message.includes("TOKEN_REFRESH_FAILED")) {
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

// Enhanced job status endpoint with human pattern info
app.get("/job-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobs = await loadJobs();
    const job = jobs[jobId];

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found",
      });
    }

    // Include current pattern and daily limit info
    const limitCheck = await checkDailyLimit(job.userId);
    const currentPattern = getCurrentHumanPattern();

    res.status(200).json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        createdAt: job.createdAt,
        lastProcessedAt: job.lastProcessedAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
        errors: job.errors,
        pauseReason: job.pauseReason,
        estimatedResumeTime: job.estimatedResumeTime,
        humanPatterns: job.humanPatterns,
        dailyStats: job.dailyStats,
        currentPattern: currentPattern.name,
        currentPatternInfo: currentPattern,
        dailyLimitInfo: limitCheck,
      },
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

// Enhanced user job endpoint with pattern info
app.get("/user-job/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];

    if (!userSession || !userSession.currentJobId) {
      const limitCheck = await checkDailyLimit(userId);
      return res.status(200).json({
        success: false,
        message: "No active job found for user",
        canResume: false,
        job: null,
        currentPattern: getCurrentHumanPattern().name,
        limitInfo: limitCheck,
      });
    }

    const jobs = await loadJobs();
    const job = jobs[userSession.currentJobId];

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found",
      });
    }

    const limitCheck = await checkDailyLimit(userId);
    const currentPattern = getCurrentHumanPattern();

    res.status(200).json({
      success: true,
      canResume: job.status === "paused" || job.status === "processing",
      job: {
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        createdAt: job.createdAt,
        lastProcessedAt: job.lastProcessedAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
        pauseReason: job.pauseReason,
        estimatedResumeTime: job.estimatedResumeTime,
        humanPatterns: job.humanPatterns,
        dailyStats: job.dailyStats,
        currentPattern: currentPattern.name,
        currentPatternInfo: currentPattern,
        dailyLimitInfo: limitCheck,
      },
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

// Legacy endpoint (for backward compatibility)
app.post("/update-contacts-post", async (req, res) => {
  // Redirect to new endpoint with userId
  const userId = req.body.userId || `legacy_${Date.now()}`;

  req.body.userId = userId;
  req.body.resume = false;

  // Forward to new endpoint
  return app._router.handle(
    { ...req, url: "/start-processing", method: "POST" },
    res
  );
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

  const data = await fetchLinkedInProfile(profileId);
  console.log("🔍 Fetched Data:", data);

  res.json({
    profileData: data,
    currentPattern: currentPattern.name,
    patternInfo: currentPattern,
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  const currentPattern = getCurrentHumanPattern();

  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    currentPattern: {
      name: currentPattern.name,
      isActive: !currentPattern.pause,
    },
    server: "LinkedIn Profile Processor with Human Patterns",
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`🕒 Starting with ${getCurrentHumanPattern().name} pattern`);
  console.log(`📊 Human patterns enabled:`, Object.keys(HUMAN_PATTERNS));
});
