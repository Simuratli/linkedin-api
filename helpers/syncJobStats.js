/**
 * Utility to synchronize job data with daily statistics to ensure consistency
 */
const { loadDailyStats, saveDailyStats, loadUserSessions } = require('./db');

/**
 * Get today's date key in YYYY-MM-DD format
 */
const getTodayKey = () => {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
};

/**
 * Get current hour key in YYYY-MM-DD-HH format
 */
const getHourKey = () => {
  const now = new Date();
  return `${now.toISOString().split("T")[0]}-${now.getHours()}`; // YYYY-MM-DD-HH
};

/**
 * Get pattern key in YYYY-MM-DD-patternName format
 */
const getPatternKey = (patternName) => {
  return `${getTodayKey()}-${patternName}`;
};

/**
 * Normalize CRM URL for use as stats key
 */
const normalizeCrmUrl = (crmUrl) => {
  if (!crmUrl) return 'unknown_crm';
  try {
    const url = new URL(crmUrl);
    return url.hostname.toLowerCase().replace(/\./g, '_');
  } catch (error) {
    return crmUrl.toLowerCase().replace(/[^a-z0-9]/g, '_');
  }
};

/**
 * Synchronize job data with daily stats to ensure consistency
 * 
 * @param {string} userId - The user ID
 * @param {Object} job - The job object to synchronize
 * @returns {Object} - Updated daily stats
 */
const synchronizeJobWithDailyStats = async (userId, job) => {
  try {
    console.log(`🔄 Starting synchronization for user ${userId}, job ${job?.jobId}`);
    
    // Null check for job object
    if (!job) {
      console.error(`❌ Sync error: job object is undefined or null`);
      return null;
    }
    
    // Load user sessions to get CRM URL
    const userSessions = await loadUserSessions();
    const userSession = userSessions[userId];
    
    // Determine the stats key (CRM-based or user-based)
    let statsKey = userId;
    if (userSession?.crmUrl) {
      statsKey = normalizeCrmUrl(userSession.crmUrl);
      console.log(`📊 Using CRM-based stats key: ${statsKey} for CRM: ${userSession.crmUrl}`);
    } else {
      console.log(`📊 Using user-based stats key: ${statsKey}`);
    }
    
    // Get time-based keys
    const today = getTodayKey();
    const hourKey = getHourKey();
    
    console.log(`📅 Today: ${today}, Hour: ${hourKey}`);
    
    // Get the actual processed count from job
    const processedCount = job.processedCount || 0;
    const successCount = job.successCount || 0;
    
    console.log(`📊 Job stats - Processed: ${processedCount}, Success: ${successCount}`);
    
    // Clear existing stats for this key to avoid duplication
    const { DailyStats } = require('./db');
    
    // Delete existing records for today and current hour to reset counts
    await DailyStats.deleteMany({
      userId: statsKey,
      $or: [
        { dateKey: today },
        { hourKey: hourKey }
      ]
    });
    
    // Update stats based on actual job counts
    const actualProfilesProcessed = successCount;
    
    // Update daily and hourly stats with the correct count
    const { updateDailyStats } = require('./db');
    
    // Update stats for each successfully processed contact
    for (let i = 0; i < actualProfilesProcessed; i++) {
      await updateDailyStats(statsKey, today, hourKey, null);
    }
    
    // Update pattern-specific counts
    if (job.dailyStats && job.dailyStats.patternBreakdown) {
      for (const [patternName, count] of Object.entries(job.dailyStats.patternBreakdown)) {
        const patternKey = getPatternKey(patternName);
        
        // Delete existing pattern records to reset
        await DailyStats.deleteMany({
          userId: statsKey,
          patternKey: patternKey
        });
        
        // Update pattern count
        for (let i = 0; i < count; i++) {
          await updateDailyStats(statsKey, null, null, patternKey);
        }
      }
    }
    
    console.log(`✅ Synchronization completed for ${statsKey}:`, {
      today: actualProfilesProcessed,
      hour: actualProfilesProcessed,
      patterns: job.dailyStats?.patternBreakdown || {}
    });
    
    return true;
  } catch (error) {
    console.error(`❌ Sync error for user ${userId}:`, error.message);
    return null;
  }
};

module.exports = {
  synchronizeJobWithDailyStats,
  getTodayKey,
  getHourKey,
  getPatternKey,
  normalizeCrmUrl
};
