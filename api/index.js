const express = require("express");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");
const { transformToCreateUserRequest } = require("../helpers/transform");
const { 
  fetchLinkedInProfile, 
  generateSessionId, 
  getRateLimitStatus, 
  initializeLinkedInClient,
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

// Initialize LinkedIn Client
const initializeLinkedInClientAPI = async () => {
  if (linkedInClientInitialized) {
    console.log('✅ LinkedIn client already initialized');
    return;
  }

  try {
    console.log('🚀 Initializing Simple LinkedIn Client...');
    await initializeLinkedInClient();
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

// Simple batch configuration
const getBatchConfig = () => {
  return {
    batchSize: 1, // Process one at a time to be safe
    waitBetweenBatches: 30000, // 30 seconds between batches
    waitBetweenRequests: 5000, // 5 seconds between requests
    maxDailyProcessing: 100
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
    const config = getBatchConfig();
    
    res.status(200).json({
      success: true,
      stats: stats,
      config: config,
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

// Initialize LinkedIn client endpoint
app.post("/initialize-client", async (req, res) => {
  try {
    await initializeLinkedInClientAPI();
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

// Start processing endpoint
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
        await initializeLinkedInClientAPI();
      } catch (initError) {
        return res.status(500).json({
          success: false,
          message: "Failed to initialize LinkedIn client. Please try again.",
          error: initError.message
        });
      }
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

// Background processing function
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

    const config = getBatchConfig();
    console.log(`📊 Processing job ${jobId} with config:`, {
      batchSize: config.batchSize,
      waitBetweenBatches: config.waitBetweenBatches / 1000 + 's',
      waitBetweenRequests: config.waitBetweenRequests / 1000 + 's',
      maxDaily: config.maxDailyProcessing
    });

    // Get pending contacts
    const pendingContacts = job.contacts.filter((c) => c.status === "pending");
    const contactsToProcess = pendingContacts.slice(0, config.maxDailyProcessing);
    const contactBatches = chunkArray(contactsToProcess, config.batchSize);

    console.log(`📊 Processing ${contactsToProcess.length} contacts in ${contactBatches.length} batches for job ${jobId}`);

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
      const batch = contactBatches[batchIndex];

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
            jsessionid: currentUserSession.jsessionid,
          };

          console.log(`🔍 Fetching LinkedIn profile: ${profileId}`);
          const profileData = await fetchLinkedInProfile(profileId, customCookies);
          console.log(`✅ Successfully fetched profile data`);

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

          // Wait between requests
          console.log(`⏳ Waiting ${config.waitBetweenRequests/1000}s before next request`);
          await sleep(config.waitBetweenRequests);

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

      // Wait between batches
      if (batchIndex < contactBatches.length - 1) {
        console.log(`⏳ Waiting ${config.waitBetweenBatches / 1000}s before next batch`);
        await sleep(config.waitBetweenBatches);
      }

      console.log(`📈 Progress for job ${jobId}: ${job.processedCount}/${job.totalContacts} contacts processed`);
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

// Job status endpoint
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

// User job endpoint
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
      clientInitialized: linkedInClientInitialized
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

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const config = getBatchConfig();
    res.status(200).json({
      success: true,
      status: "healthy",
      config: config,
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

// Start server
app.listen(PORT, async () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`📊 Daily LinkedIn limits configured:`);
  console.log(`   - Profile requests: ${DAILY_LIMITS.profile_views}`);
  console.log(`   - Contact info: ${DAILY_LIMITS.contact_info}`);
  
  // Initialize LinkedIn client on startup
  try {
    console.log('🚀 Initializing LinkedIn Client on startup...');
    await initializeLinkedInClientAPI();
  } catch (error) {
    console.warn('⚠️ LinkedIn client initialization failed on startup. Will initialize on first request.');
    console.warn('Error:', error.message);
  }
});