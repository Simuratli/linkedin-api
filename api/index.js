const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { transformToCreateUserRequest } = require("../helpers/transform");
const { 
  fetchLinkedInProfile, 
  generateSessionId, 
  getRateLimitStatus, 
  initializeFreeProxyClient,
  refreshProxies,
  DAILY_LIMITS 
} = require("../helpers/linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep, chunkArray, getRandomDelay } = require("../helpers/delay");

const app = express();
const PORT = process.env.PORT || 3000;

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, "data");
const JOBS_FILE = path.join(DATA_DIR, "processing_jobs.json");
const USER_SESSIONS_FILE = path.join(DATA_DIR, "user_sessions.json");

// Global LinkedIn client state
let linkedInClientInitialized = false;

// Ensure data directory exists
const ensureDataDir = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    console.error("Error creating data directory:", error);
  }
};

// Initialize LinkedIn Client with Free Proxy
const initializeLinkedInClient = async () => {
  if (linkedInClientInitialized) {
    console.log('✅ LinkedIn client already initialized');
    return;
  }

  try {
    console.log('🚀 Initializing Free Proxy LinkedIn Client...');
    await initializeFreeProxyClient();
    linkedInClientInitialized = true;
    console.log('✅ LinkedIn client initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize LinkedIn client:', error);
    throw error;
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

// Enhanced dynamic batch configuration for free proxies
const getDynamicBatchConfig = () => {
  const stats = getRateLimitStatus();
  
  if (stats.error) {
    // Fallback config if client not initialized
    return {
      batchSize: 1,
      waitBetweenBatches: 60000,
      shouldPause: false,
      shouldSlowDown: true,
      maxDailyProcessing: 50
    };
  }

  const rateLimitStats = stats.rateLimitStats;
  const proxyStats = stats.proxyStats;
  
  // Very conservative configuration for free proxies
  return {
    batchSize: rateLimitStats.suspiciousActivity ? 1 : 2, // Much smaller batches
    waitBetweenBatches: rateLimitStats.suspiciousActivity ? 300000 : 120000, // 2-5 minutes
    shouldPause: rateLimitStats.profileViews > (DAILY_LIMITS.profile_views * 0.85), // Pause at 85%
    shouldSlowDown: rateLimitStats.profileViews > (DAILY_LIMITS.profile_views * 0.7), // Slow at 70%
    maxDailyProcessing: Math.max(10, DAILY_LIMITS.profile_views - rateLimitStats.profileViews), // Conservative daily limit
    proxyHealthy: proxyStats.workingProxies > 5, // Need at least 5 working proxies
    needsProxyRefresh: proxyStats.workingProxies < 3 // Refresh if less than 3 proxies
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

// Initialize data directory and LinkedIn client on startup
ensureDataDir();

// Rate limit status endpoint with enhanced proxy information
app.get("/rate-limit-status/:userId", async (req, res) => {
  try {
    const stats = getRateLimitStatus();
    const config = getDynamicBatchConfig();
    
    res.status(200).json({
      success: true,
      stats: stats,
      config: config,
      recommendations: {
        shouldSlowDown: config.shouldSlowDown,
        shouldPause: config.shouldPause,
        recommendedBatchSize: config.batchSize,
        recommendedDelay: config.waitBetweenBatches,
        needsProxyRefresh: config.needsProxyRefresh,
        proxyHealthy: config.proxyHealthy
      },
      clientInitialized: linkedInClientInitialized
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error getting rate limit status",
      error: error.message,
      clientInitialized: linkedInClientInitialized
    });
  }
});

// Proxy management endpoints
app.post("/refresh-proxies", async (req, res) => {
  try {
    if (!linkedInClientInitialized) {
      await initializeLinkedInClient();
    }
    
    console.log('🔄 Manual proxy refresh requested');
    await refreshProxies();
    
    const stats = getRateLimitStatus();
    res.status(200).json({
      success: true,
      message: "Proxies refreshed successfully",
      stats: stats
    });
  } catch (error) {
    console.error('❌ Proxy refresh failed:', error);
    res.status(500).json({
      success: false,
      message: "Proxy refresh failed",
      error: error.message
    });
  }
});

// Initialize LinkedIn client endpoint
app.post("/initialize-client", async (req, res) => {
  try {
    await initializeLinkedInClient();
    const stats = getRateLimitStatus();
    
    res.status(200).json({
      success: true,
      message: "LinkedIn client initialized successfully",
      stats: stats
    });
  } catch (error) {
    console.error('❌ Client initialization failed:', error);
    res.status(500).json({
      success: false,
      message: "Client initialization failed",
      error: error.message
    });
  }
});

// Enhanced start processing endpoint
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

    // Initialize LinkedIn client if not done yet
    if (!linkedInClientInitialized) {
      try {
        await initializeLinkedInClient();
      } catch (initError) {
        return res.status(500).json({
          success: false,
          message: "Failed to initialize LinkedIn client. Please try again or refresh proxies.",
          error: initError.message,
          needsProxyRefresh: true
        });
      }
    }

    // Check proxy health before starting
    const config = getDynamicBatchConfig();
    if (!config.proxyHealthy) {
      return res.status(503).json({
        success: false,
        message: "Insufficient working proxies. Please refresh proxies first.",
        needsProxyRefresh: true,
        workingProxies: getRateLimitStatus().proxyStats?.workingProxies || 0
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
          status: "pending",
        })),
        processedCount: 0,
        successCount: 0,
        failureCount: 0,
        status: "pending",
        createdAt: new Date().toISOString(),
        lastProcessedAt: null,
        errors: [],
        proxyStats: getRateLimitStatus().proxyStats, // Track proxy health at start
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
      proxyStats: getRateLimitStatus().proxyStats,
      dailyLimits: DAILY_LIMITS
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

    // Get dynamic configuration for free proxies
    let config = getDynamicBatchConfig();
    
    console.log(`📊 Free Proxy Dynamic config for job ${jobId}:`, {
      batchSize: config.batchSize,
      waitTime: config.waitBetweenBatches / 1000 + 's',
      shouldPause: config.shouldPause,
      maxDaily: config.maxDailyProcessing,
      proxyHealthy: config.proxyHealthy,
      needsProxyRefresh: config.needsProxyRefresh
    });

    // Check proxy health
    if (config.needsProxyRefresh) {
      console.log(`🔄 Refreshing proxies before processing job ${jobId}`);
      try {
        await refreshProxies();
        config = getDynamicBatchConfig(); // Update config after refresh
      } catch (proxyError) {
        console.error(`❌ Proxy refresh failed for job ${jobId}:`, proxyError);
        job.status = "paused";
        job.pauseReason = "proxy_refresh_failed";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }
    }

    // Daily limit check
    if (config.shouldPause) {
      const stats = getRateLimitStatus();
      console.log(`⏸️ Daily limit approaching, pausing job ${jobId}`);
      job.status = "paused";
      job.pauseReason = "daily_limit_approaching";
      await saveJobs({ ...(await loadJobs()), [jobId]: job });
      return;
    }

    // Get pending contacts
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    
    // Limit contacts based on daily quota (very conservative for free proxies)
    const contactsToProcess = pendingContacts.slice(0, Math.min(config.maxDailyProcessing, 20)); // Max 20 per day
    const contactBatches = chunkArray(contactsToProcess, config.batchSize);

    console.log(`📊 Processing ${contactsToProcess.length} contacts (free proxy limited) in ${contactBatches.length} batches for job ${jobId}`);

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
      const batch = contactBatches[batchIndex];

      // Update configuration before each batch
      config = getDynamicBatchConfig();
      
      // Check limits again
      if (config.shouldPause) {
        console.log(`⏸️ Daily limit reached during processing, pausing job ${jobId}`);
        job.status = "paused";
        job.pauseReason = "daily_limit_reached";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }

      // Check proxy health
      if (!config.proxyHealthy) {
        console.log(`⏸️ Proxy health degraded, pausing job ${jobId}`);
        job.status = "paused";
        job.pauseReason = "proxy_health_degraded";
        await saveJobs({ ...(await loadJobs()), [jobId]: job });
        return;
      }

      // Check if user session is still valid
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
      const stats = getRateLimitStatus();
      console.log(`📈 Rate limit status: ${stats.rateLimitStats?.profileViews || 0}/${DAILY_LIMITS.profile_views} daily profile views`);
      console.log(`🔗 Proxy status: ${stats.proxyStats?.workingProxies || 0} working proxies`);

      // Process batch sequentially for free proxies (safer)
      for (const contact of batch) {
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
 console.log(profileData,'profileData')
          console.log(profileId,'profiprofileIdleData')
          // Enhanced LinkedIn profile fetching with free proxy support
          console.log(`🔍 Fetching LinkedIn profile: ${profileId} (Free Proxy Mode)`);
          const profileData = await fetchLinkedInProfile(
            profileId,
            customCookies
          );
         
          if (profileData.error) {
            throw new Error(`LinkedIn API error: ${profileData.error}`);
          }

          const convertedProfile = await transformToCreateUserRequest(
            profileData.combined || profileData,
            `${currentUserSession.crmUrl}/api/data/v9.2`,
            currentUserSession.accessToken
          );

          console.log(convertedProfile,'convertedProfile')
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

          // Extra delay between contacts in same batch (for free proxies)
          if (batch.indexOf(contact) < batch.length - 1) {
            const intraContactDelay = Math.floor(Math.random() * 10000) + 5000; // 5-15 seconds
            console.log(`⏳ Waiting ${intraContactDelay/1000}s before next contact in batch`);
            await new Promise((resolve) => setTimeout(resolve, intraContactDelay));
          }

        } catch (error) {
          console.error(
            `❌ Error processing contact ${contact.contactId}:`,
            error.message,
          );

          contact.status = "failed";
          contact.error = error.message;
          job.failureCount++;
          job.errors.push({
            contactId: contact.contactId,
            error: error.message,
            timestamp: new Date().toISOString(),
          });

          // Handle LinkedIn protection for free proxies
          if (error.message.includes("Rate limited") || 
              error.message.includes("Bot detected") ||
              error.message.includes("LinkedIn blocked proxy")) {
            console.log(`⚠️ LinkedIn protection triggered for job ${jobId}, extending delays`);
            // Force longer delays but continue processing
            const protectionDelay = Math.floor(Math.random() * 60000) + 120000; // 2-3 minutes
            console.log(`⏳ Protection delay: ${protectionDelay/1000}s`);
            await new Promise((resolve) => setTimeout(resolve, protectionDelay));
          }

          if (error.message.includes("TOKEN_REFRESH_FAILED")) {
            console.log(`⏸️ Pausing job ${jobId} - token refresh failed`);
            job.status = "paused";
            job.pauseReason = "token_refresh_failed";
            throw error;
          }

          if (error.message.includes("Daily limit exceeded")) {
            console.log(`⏸️ Pausing job ${jobId} - daily limit exceeded`);
            job.status = "paused";
            job.pauseReason = "daily_limit_exceeded";
            throw error;
          }
        }
      }

      // Update progress after each batch
      job.processedCount = job.successCount + job.failureCount;

      // Save progress
      const currentJobs = await loadJobs();
      currentJobs[jobId] = job;
      await saveJobs(currentJobs);

      // Long wait between batches (critical for free proxies)
      if (batchIndex < contactBatches.length - 1) {
        const adaptiveWaitTime = config.waitBetweenBatches + getRandomDelay(-30000, 60000); // Add extra randomness
        console.log(`⏳ Free proxy adaptive wait ${adaptiveWaitTime / 1000}s before next batch`);
        await new Promise((resolve) => setTimeout(resolve, adaptiveWaitTime));
      }

      console.log(`📈 Progress for job ${jobId}: ${job.processedCount}/${job.totalContacts} contacts processed`);
      const currentStats = getRateLimitStatus();
      console.log(`📊 Today's usage: ${currentStats.rateLimitStats?.profileViews || 0}/${DAILY_LIMITS.profile_views} profile views`);
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
    console.log(`📊 Final daily stats: Profile views: ${finalStats.rateLimitStats?.profileViews || 0}/${DAILY_LIMITS.profile_views}`);
    console.log(`🔗 Working proxies: ${finalStats.proxyStats?.workingProxies || 0}`);
    
  } catch (error) {
    console.error(`❌ Background processing error for job ${jobId}:`, error);
    job.status = "failed";
    job.error = error.message;

    const errorJobs = await loadJobs();
    errorJobs[jobId] = job;
    await saveJobs(errorJobs);
  }
};

// Enhanced job status endpoint
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
      rateLimitStatus: rateLimitStats,
      clientInitialized: linkedInClientInitialized,
      dailyLimits: DAILY_LIMITS
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

// Enhanced user job endpoint
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
        rateLimitStatus: getRateLimitStatus(),
        clientInitialized: linkedInClientInitialized
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
      rateLimitStatus: getRateLimitStatus(),
      clientInitialized: linkedInClientInitialized,
      dailyLimits: DAILY_LIMITS
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
  const userId = req.body.userId || `legacy_${Date.now()}`;
  req.body.userId = userId;
  req.body.resume = false;

  // Forward to new endpoint
  return app._router.handle(
    { ...req, url: "/start-processing", method: "POST" },
    res
  );
});

// Enhanced token refresh endpoint
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

// Enhanced test route with free proxy LinkedIn client
app.get("/simuratli", async (req, res) => {
  const profileId = "simuratli";
  try {
    // Initialize client if not done yet
    if (!linkedInClientInitialized) {
      await initializeLinkedInClient();
    }

    console.log(`🔍 Testing free proxy LinkedIn fetch for: ${profileId}`);
    const data = await fetchLinkedInProfile(profileId);
    const stats = getRateLimitStatus();
    
    console.log("🔍 Fetched Data:", data);
    console.log("📊 Rate limit stats:", stats);
    
    res.json({
      success: true,
      data: data,
      rateLimitStatus: stats,
      clientInitialized: linkedInClientInitialized,
      dailyLimits: DAILY_LIMITS
    });
  } catch (error) {
    console.error("❌ Test endpoint error:", error);
    const stats = getRateLimitStatus();
    
    res.status(500).json({
      success: false,
      error: error.message,
      rateLimitStatus: stats,
      clientInitialized: linkedInClientInitialized,
      suggestion: error.message.includes('not initialized') ? 'Try calling /initialize-client first' : 'Check proxy health or refresh proxies'
    });
  }
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const stats = getRateLimitStatus();
    const config = getDynamicBatchConfig();
    
    res.status(200).json({
      success: true,
      status: "healthy",
      clientInitialized: linkedInClientInitialized,
      rateLimitStatus: stats,
      config: config,
      dailyLimits: DAILY_LIMITS,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: "unhealthy",
      error: error.message,
      clientInitialized: linkedInClientInitialized,
      timestamp: new Date().toISOString()
    });
  }
});

// Start server with client initialization
app.listen(PORT, async () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`📊 Daily LinkedIn limits configured:`);
  console.log(`   - Profile views: ${DAILY_LIMITS.profile_views}`);
  console.log(`   - Contact info: ${DAILY_LIMITS.contact_info}`);
  console.log(`   - Max requests per hour: ${DAILY_LIMITS.max_requests_per_hour}`);
  console.log(`   - Proxy rotation after: ${DAILY_LIMITS.proxy_rotation_after} requests`);
  
  // Initialize LinkedIn client on startup (optional, can be done on first request)
  try {
    console.log('🚀 Initializing Free Proxy LinkedIn Client on startup...');
    await initializeLinkedInClient();
    const stats = getRateLimitStatus();
    console.log(`📊 Client initialized with ${stats.proxyStats?.workingProxies || 0} working proxies`);
  } catch (error) {
    console.warn('⚠️ LinkedIn client initialization failed on startup. Will initialize on first request.');
    console.warn('Error:', error.message);
  }
});