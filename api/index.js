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
const COMPLETION_HISTORY_FILE = path.join(DATA_DIR, "completion_history.json");

// ENHANCED DAILY LIMIT CONFIGURATION WITH HUMAN PATTERNS
const DAILY_PROFILE_LIMIT = 180; // Conservative daily limit
const BURST_LIMIT = 15; // Max profiles in one hour (fallback)
const COMPLETION_COOLDOWN_DAYS = 30; // 1 ay cooldown
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

// Completion history management
const loadCompletionHistory = async () => {
  try {
    const data = await fs.readFile(COMPLETION_HISTORY_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const saveCompletionHistory = async (history) => {
  try {
    await safeWrite(COMPLETION_HISTORY_FILE, history);
  } catch (error) {
    console.error("Error saving completion history:", error);
  }
};

const checkCompletionCooldown = async (userId) => {
  const history = await loadCompletionHistory();
  const userHistory = history[userId];

  if (!userHistory || !userHistory.lastCompletedAt) {
    return {
      canStart: true,
      reason: "no_previous_completion"
    };
  }

  const lastCompleted = new Date(userHistory.lastCompletedAt);
  const now = new Date();
  const daysSinceCompletion = Math.floor((now - lastCompleted) / (1000 * 60 * 60 * 24));

  if (daysSinceCompletion < COMPLETION_COOLDOWN_DAYS) {
    const remainingDays = COMPLETION_COOLDOWN_DAYS - daysSinceCompletion;
    const nextAllowedDate = new Date(lastCompleted);
    nextAllowedDate.setDate(nextAllowedDate.getDate() + COMPLETION_COOLDOWN_DAYS);

    return {
      canStart: false,
      reason: "completion_cooldown",
      lastCompletedAt: userHistory.lastCompletedAt,
      daysSinceCompletion,
      remainingDays,
      nextAllowedDate: nextAllowedDate.toISOString(),
      totalProcessed: userHistory.totalProcessed,
      completionDate: lastCompleted.toLocaleDateString('tr-TR')
    };
  }

  return {
    canStart: true,
    reason: "cooldown_expired",
    daysSinceCompletion
  };
};

const recordCompletion = async (userId, totalProcessed) => {
  const history = await loadCompletionHistory();
  
  if (!history[userId]) {
    history[userId] = {};
  }

  history[userId] = {
    lastCompletedAt: new Date().toISOString(),
    totalProcessed: totalProcessed,
    completionCount: (history[userId].completionCount || 0) + 1,
  };

  await saveCompletionHistory(history);
  console.log(`📝 Completion recorded for user ${userId}: ${totalProcessed} profiles processed`);
};

// ... [rest of your existing helper functions remain the same] ...

// Enhanced background processing with completion recording
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
      // [existing batch processing logic remains the same...]
      // ... [your existing batch processing code] ...
    }

    // Mark job as completed if all contacts processed
    const remainingPending = job.contacts.filter(
      (c) => c.status === "pending"
    ).length;
    if (remainingPending === 0) {
      job.status = "completed";
      job.completedAt = new Date().toISOString();

      // Record completion in history
      await recordCompletion(job.userId, job.successCount);

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
    
    job.status = "failed";
    job.error = error.message;
    job.failedAt = new Date().toISOString();
    
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

// Enhanced endpoint with 30-day completion cooldown
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
      forceStart = false // Admin override
    } = req.body;

    if (!userId || !jsessionid || !accessToken || !crmUrl || !li_at) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: userId, li_at, accessToken, crmUrl, and jsessionid are required",
      });
    }

    // Check 30-day cooldown
    if (!forceStart) {
      const cooldownCheck = await checkCompletionCooldown(userId);
      if (!cooldownCheck.canStart) {
        return res.status(429).json({
          success: false,
          message: `Tüm profiller ${cooldownCheck.completionDate} tarihinde işlendi. ${cooldownCheck.remainingDays} gün sonra tekrar başlatabilirsiniz.`,
          cooldownInfo: cooldownCheck,
          nextAllowedDate: new Date(cooldownCheck.nextAllowedDate).toLocaleDateString('tr-TR')
        });
      }
    }

    // [rest of your existing /start-processing endpoint logic remains the same...]
    // ... [your existing endpoint code] ...

  } catch (error) {
    console.error("❌ Error in /start-processing:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// New endpoint to check cooldown status
app.get("/cooldown-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const cooldownCheck = await checkCompletionCooldown(userId);
    
    res.status(200).json({
      success: true,
      cooldownInfo: cooldownCheck,
      nextAllowedDate: cooldownCheck.nextAllowedDate 
        ? new Date(cooldownCheck.nextAllowedDate).toLocaleDateString('tr-TR')
        : null
    });
  } catch (error) {
    console.error("❌ Error checking cooldown status:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// [rest of your existing endpoints remain the same...]

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
  console.log(`🕒 Starting with ${getCurrentHumanPattern().name} pattern`);
  console.log(`📊 Human patterns enabled:`, Object.keys(HUMAN_PATTERNS));
  console.log(`⏳ Completion cooldown: ${COMPLETION_COOLDOWN_DAYS} days`);
});1