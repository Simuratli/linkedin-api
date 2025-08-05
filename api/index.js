const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { transformToCreateUserRequest } = require("../helpers/transform");
const { fetchLinkedInProfile, generateSessionId, getRateLimitStatus } = require("../helpers/enhanced_linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep, chunkArray, getRandomDelay } = require("../helpers/delay");

const app = express();
const PORT = process.env.PORT || 3000;

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "processing_jobs.json");
const USER_SESSIONS_FILE = path.join(DATA_DIR, "user_sessions.json");

// Ensure data directory exists
const ensureDataDir = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error("Error creating data directory:", error);
  }
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

// Dinamik batch konfigürasyonu
const getDynamicBatchConfig = () => {
  const stats = getRateLimitStatus();
  
  return {
    batchSize: stats.suspiciousActivity ? 2 : (stats.backoffMultiplier > 2 ? 3 : 5),
    waitBetweenBatches: stats.suspiciousActivity ? 180000 : (60000 + (stats.backoffMultiplier - 1) * 30000),
    shouldPause: stats.profileViews > (stats.limits.profile_views * 0.85), // %85'e ulaştığında duraklat
    shouldSlowDown: stats.profileViews > (stats.limits.profile_views * 0.7), // %70'te yavaşlat
    maxDailyProcessing: Math.max(50, stats.limits.profile_views - stats.profileViews) // Günlük kalan limit
  };
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

// Rate limit status endpoint
app.get("/rate-limit-status/:userId", async (req, res) => {
  try {
    const stats = getRateLimitStatus();
    res.status(200).json({
      success: true,
      stats: stats,
      recommendations: {
        shouldSlowDown: stats.suspiciousActivity,
        recommendedBatchSize: stats.suspiciousActivity ? 2 : 5,
        recommendedDelay: stats.backoffMultiplier > 1 ? 60000 : 45000
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error getting rate limit status",
      error: error.message
    });
  }
});

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
      userId, // Unique identifier for the user (could be email, userID, etc.)
      resume = false, // Whether to resume existing job
    } = req.body;

    if (!userId || !jsessionid || !accessToken || !crmUrl || !li_at) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: userId, li_at, accessToken, crmUrl, and jsessionid are required",
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

// Enhanced background processing function
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

    // Dinamik konfigürasyon al
    let config = getDynamicBatchConfig();
    
    console.log(`📊 Dynamic config for job ${jobId}:`, {
      batchSize: config.batchSize,
      waitTime: config.waitBetweenBatches / 1000 + 's',
      shouldPause: config.shouldPause,
      maxDaily: config.maxDailyProcessing,
      rateLimitStats: getRateLimitStatus()
    });

    // Günlük limit kontrolü
    if (config.shouldPause) {
      const stats = getRateLimitStatus();
      console.log(`⏸️ Daily limit approaching (${stats.profileViews}/${stats.limits.profile_views}), pausing job ${jobId}`);
      job.status = "paused";
      job.pauseReason = "daily_limit_approaching";
      await saveJobs({ ...(await loadJobs()), [jobId]: job });
      return;
    }

    // Get pending contacts
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    
    // Günlük limit kontrolüne göre process edilecek contact sayısını sınırla
    const contactsToProcess = pendingContacts.slice(0, config.maxDailyProcessing);
    const contactBatches = chunkArray(contactsToProcess, config.batchSize);

    console.log(`📊 Processing ${contactsToProcess.length} contacts (limited by daily quota) in ${contactBatches.length} batches for job ${jobId}`);

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
      const batch = contactBatches[batchIndex];

      // Her batch öncesi konfigürasyonu güncelle
      config = getDynamicBatchConfig();
      
      // Eğer günlük limit yaklaşıyorsa dur
      if (config.shouldPause) {
        console.log(`⏸️ Daily limit reached during processing, pausing job ${jobId}`);
        job.status = "paused";
        job.pauseReason = "daily_limit_reached";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }

      // Check if user session is still valid (user might have disconnected)
      const currentUserSessions = await loadUserSessions();
      const currentUserSession = currentUserSessions[job.userId];

      if (!currentUserSession || !currentUserSession.accessToken) {
        console.log(`⏸️ Pausing job ${jobId} - user session invalid`);
        job.status = "paused";
        job.pauseReason = "user_session_invalid";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }

      console.log(`🔄 Processing batch ${batchIndex + 1} of ${contactBatches.length} for job ${jobId}`);
      console.log(`📈 Rate limit status: ${getRateLimitStatus().profileViews}/${getRateLimitStatus().limits.profile_views} daily requests used`);

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

          // Enhanced LinkedIn profile fetching with rate limiting
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
          console.log(`✅ Successfully updated contact ${contact.contactId}`);
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

          // LinkedIn rate limit ve bot detection handling
          if (error.message.includes("Rate limited") || error.message.includes("Bot detected")) {
            console.log(`⚠️ LinkedIn protection triggered, extending delays for job ${jobId}`);
            // Bu durumda batch processing'i yavaşlat ama devam et
          }

          if (error.message.includes("TOKEN_REFRESH_FAILED")) {
            console.log(`⏸️ Pausing job ${jobId} - token refresh failed`);
            job.status = "paused";
            job.pauseReason = "token_refresh_failed";
            throw error; // Stop processing this batch
          }

          if (error.message.includes("Daily limit exceeded")) {
            console.log(`⏸️ Pausing job ${jobId} - daily limit exceeded`);
            job.status = "paused";
            job.pauseReason = "daily_limit_exceeded";
            throw error; // Stop processing this batch
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

        // Wait between batches with adaptive delay
        if (batchIndex < contactBatches.length - 1) {
          const adaptiveWaitTime = config.waitBetweenBatches + getRandomDelay(-15000, 30000);
          console.log(`⏳ Adaptive wait ${adaptiveWaitTime / 1000}s before next batch (suspicious: ${getRateLimitStatus().suspiciousActivity})`);
          await new Promise((resolve) => setTimeout(resolve, adaptiveWaitTime));
        }

        console.log(`📈 Progress for job ${jobId}: ${job.processedCount}/${job.totalContacts} contacts processed`);
        console.log(`📊 Today's LinkedIn usage: ${getRateLimitStatus().profileViews}/${getRateLimitStatus().limits.profile_views}`);
        
      } catch (error) {
        if (error.message.includes("TOKEN_REFRESH_FAILED") || 
            error.message.includes("daily_limit_exceeded")) {
          break; // Stop processing
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
    } else if (config.shouldPause) {
      job.status = "paused";
      job.pauseReason = "daily_limit_reached";
    }

    // Final save
    const finalJobs = await loadJobs();
    finalJobs[jobId] = job;
    await saveJobs(finalJobs);

    console.log(`✅ Job ${jobId} processing completed. Status: ${job.status}`);
    
    // Final stats
    const finalStats = getRateLimitStatus();
    console.log(`📊 Final daily stats: Profile views: ${finalStats.profileViews}/${finalStats.limits.profile_views}, Contact info: ${finalStats.contactInfo}/${finalStats.limits.contact_info}`);
    
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

    // Rate limit bilgilerini de ekle
    const rateLimitStats = getRateLimitStatus();

    res.status(200).json({
      success: true,
      job: {
        jobId: job.jobId,
        status: job.status,
        totalContacts: job.totalContacts,
        processedCount: job.processedCount,
        successCount: job.successCount,
        failureCount: job.failureCount,
        pauseReason: job.pauseReason,
        createdAt: job.createdAt,
        lastProcessedAt: job.lastProcessedAt,
        completedAt: job.completedAt,
        errors: job.errors,
      },
      rateLimitStatus: rateLimitStats
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
        rateLimitStatus: getRateLimitStatus()
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
        pauseReason: job.pauseReason,
        createdAt: job.createdAt,
        lastProcessedAt: job.lastProcessedAt,
        completedAt: job.completedAt,
      },
      rateLimitStatus: getRateLimitStatus()
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

// Test route with enhanced LinkedIn client
app.get("/simuratli", async (req, res) => {
  const profileId = "simuratli";
  try {
    const data = await fetchLinkedInProfile(profileId);
    console.log("🔍 Fetched Data:", data);
    console.log("📊 Rate limit stats:", getRateLimitStatus());
    res.json({
      data: data,
      rateLimitStatus: getRateLimitStatus()
    });
  } catch (error) {
    console.error("❌ Test endpoint error:", error);
    res.status(500).json({
      error: error.message,
      rateLimitStatus: getRateLimitStatus()
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`📊 Daily LinkedIn limits: Profile views: ${getRateLimitStatus().limits.profile_views}, Contact info: ${getRateLimitStatus().limits.contact_info}`);
});