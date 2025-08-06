const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { transformToCreateUserRequest } = require("../helpers/transform");
const { fetchLinkedInProfile } = require("../helpers/linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep, chunkArray, getRandomDelay } = require("../helpers/delay");

const app = express();
const PORT = process.env.PORT || 3000;

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "processing_jobs.json");
const USER_SESSIONS_FILE = path.join(DATA_DIR, "user_sessions.json");
const DAILY_STATS_FILE = path.join(DATA_DIR, "daily_stats.json");

// DAILY LIMIT CONFIGURATION
const DAILY_PROFILE_LIMIT = 180; // Conservative daily limit
const BURST_LIMIT = 15; // Max profiles in one hour
const HOUR_IN_MS = 60 * 60 * 1000;

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
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
};

const getHourKey = () => {
  const now = new Date();
  return `${now.toISOString().split('T')[0]}-${now.getHours()}`; // YYYY-MM-DD-HH
};

const checkDailyLimit = async (userId) => {
  const stats = await loadDailyStats();
  const today = getTodayKey();
  const hourKey = getHourKey();
  
  const userStats = stats[userId] || {};
  const todayCount = userStats[today] || 0;
  const hourCount = userStats[hourKey] || 0;

  return {
    canProcess: todayCount < DAILY_PROFILE_LIMIT && hourCount < BURST_LIMIT,
    dailyCount: todayCount,
    hourlyCount: hourCount,
    dailyLimit: DAILY_PROFILE_LIMIT,
    hourlyLimit: BURST_LIMIT
  };
};

const updateDailyStats = async (userId) => {
  const stats = await loadDailyStats();
  const today = getTodayKey();
  const hourKey = getHourKey();
  
  if (!stats[userId]) stats[userId] = {};
  
  stats[userId][today] = (stats[userId][today] || 0) + 1;
  stats[userId][hourKey] = (stats[userId][hourKey] || 0) + 1;
  
  // Clean old data (keep only last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cutoffDate = sevenDaysAgo.toISOString().split('T')[0];
  
  for (const key of Object.keys(stats[userId])) {
    if (key < cutoffDate) {
      delete stats[userId][key];
    }
  }
  
  await saveDailyStats(stats);
};

// Human-like behavior patterns
const getHumanLikeDelay = () => {
  const baseDelay = 2 * 60 * 1000; // 2 minutes base
  const maxDelay = 5 * 60 * 1000;  // 5 minutes max
  
  // Create more human-like distribution
  const random1 = Math.random();
  const random2 = Math.random();
  const random3 = Math.random();
  
  // Use multiple randoms for more natural distribution
  const combined = (random1 + random2 + random3) / 3;
  
  return Math.floor(baseDelay + (maxDelay - baseDelay) * combined);
};

const getWorkingHoursDelay = () => {
  const now = new Date();
  const hour = now.getHours();
  
  // Working hours: 9 AM - 6 PM (more active)
  if (hour >= 9 && hour <= 18) {
    return getHumanLikeDelay();
  }
  
  // Evening hours: 6 PM - 11 PM (slower)
  if (hour >= 18 && hour <= 23) {
    return getHumanLikeDelay() * 1.5;
  }
  
  // Night hours: 11 PM - 9 AM (much slower)
  return getHumanLikeDelay() * 3;
};

const shouldTakeBreak = (processedInSession) => {
  // Take breaks after processing certain amounts
  if (processedInSession % 20 === 0) {
    return 10 * 60 * 1000; // 10 minute break every 20 profiles
  }
  
  if (processedInSession % 50 === 0) {
    return 30 * 60 * 1000; // 30 minute break every 50 profiles
  }
  
  // Random breaks (5% chance)
  if (Math.random() < 0.05) {
    return Math.random() * 15 * 60 * 1000; // 0-15 minute random break
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
    await fs.writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
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

// New endpoint to start/resume processing
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

    // Check daily limits
    const limitCheck = await checkDailyLimit(userId);
    if (!limitCheck.canProcess && !resume) {
      return res.status(429).json({
        success: false,
        message: `Daily limit reached. Processed: ${limitCheck.dailyCount}/${limitCheck.dailyLimit} profiles today. Hourly: ${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}`,
        limitInfo: limitCheck
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
        dailyStats: {
          startDate: getTodayKey(),
          processedToday: 0
        }
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
      dailyLimitInfo: limitCheck
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

// Background processing function with human behavior
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

    // Get pending contacts
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    const contactBatches = chunkArray(pendingContacts, BATCH_SIZE);

    console.log(
      `📊 Processing ${pendingContacts.length} remaining contacts in ${contactBatches.length} batches for job ${jobId}`
    );

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
      // Check daily limits before each batch
      const limitCheck = await checkDailyLimit(job.userId);
      if (!limitCheck.canProcess) {
        console.log(`🚫 Daily/hourly limit reached for user ${job.userId}. Pausing job.`);
        console.log(`📊 Today: ${limitCheck.dailyCount}/${limitCheck.dailyLimit}, This hour: ${limitCheck.hourlyCount}/${limitCheck.hourlyLimit}`);
        
        job.status = "paused";
        job.pauseReason = "daily_limit_reached";
        job.pausedAt = new Date().toISOString();
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        
        // Schedule resume for next day if daily limit reached
        if (limitCheck.dailyCount >= limitCheck.dailyLimit) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 0, 0, 0); // Resume at 9 AM next day
          
          const timeUntilResume = tomorrow.getTime() - Date.now();
          console.log(`⏰ Job will resume tomorrow at 9 AM (in ${Math.round(timeUntilResume / 1000 / 60 / 60)} hours)`);
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
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }

      console.log(
        `🔄 Processing batch ${batchIndex + 1} of ${contactBatches.length} for job ${jobId}`
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
          job.successCount++;
          processedInSession++;
          
          // Update daily stats
          await updateDailyStats(job.userId);
          
          console.log(`✅ Successfully updated contact ${contact.contactId} (${processedInSession} in session)`);
        } catch (error) {
          console.error(
            `❌ Error processing contact ${contact.contactId}:`,
            error.message
          );

          contact.status = "failed";
          contact.error = error.message;
          job.failureCount++;
          job.errors.push({
            contactId: contact.contactId,
            error: error.message,
            timestamp: new Date().toISOString(),
          });

          if (error.message.includes("TOKEN_REFRESH_FAILED")) {
            console.log(`⏸️ Pausing job ${jobId} - token refresh failed`);
            job.status = "paused";
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

        // Human-like behavior: Check for breaks
        const breakTime = shouldTakeBreak(processedInSession);
        if (breakTime > 0) {
          console.log(`😴 Taking a ${Math.round(breakTime / 1000 / 60)} minute break after ${processedInSession} profiles...`);
          await new Promise((resolve) => setTimeout(resolve, breakTime));
        }

        // Wait between batches with human-like timing
        if (batchIndex < contactBatches.length - 1) {
          const waitTime = getWorkingHoursDelay();
          console.log(`⏳ Waiting ${Math.round(waitTime / 1000 / 60)} minutes before next profile... (Human-like pattern)`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }

        console.log(
          `📈 Progress for job ${jobId}: ${job.processedCount}/${job.totalContacts} contacts processed (Session: ${processedInSession})`
        );
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
    }

    // Final save
    const finalJobs = await loadJobs();
    finalJobs[jobId] = job;
    await saveJobs(finalJobs);

    console.log(`✅ Job ${jobId} processing completed. Status: ${job.status}`);
  } catch (error) {
    console.error(`❌ Background processing error for job ${jobId}:`, error);
    job.status = "failed";
    job.error = error.message;

    const errorJobs = await loadJobs();
    errorJobs[jobId] = job;
    await saveJobs(errorJobs);
  }
};

// Get job status
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

    // Include daily limit info
    const limitCheck = await checkDailyLimit(job.userId);

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
        errors: job.errors,
        pauseReason: job.pauseReason,
        dailyLimitInfo: limitCheck
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

// Get user's current job
app.get("/user-job/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];

    if (!userSession || !userSession.currentJobId) {
      return res.status(200).json({
        success: false,
        message: "No active job found for user",
        canResume: false,
        job: null,
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
        pauseReason: job.pauseReason,
        dailyLimitInfo: limitCheck
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

// Check daily limits endpoint
app.get("/daily-limits/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const limitCheck = await checkDailyLimit(userId);
    
    res.status(200).json({
      success: true,
      limits: limitCheck
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

// New endpoint to handle manual token refresh from extension
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

// Test route
app.get("/simuratli", async (req, res) => {
  const profileId = "simuratli";
  const data = await fetchLinkedInProfile(profileId);
  console.log("🔍 Fetched Data:", data);
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});