/**
 * Utility to synchronize job data with daily statistics to ensure consistency
 */
const fs = require('fs').promises;
const path = require('path');

// Path to daily stats file
const DATA_DIR = path.join(process.cwd(), 'data');
const DAILY_STATS_FILE = path.join(DATA_DIR, 'daily_rate_limits.json');

/**
 * Load the daily stats file
 */
const loadDailyStats = async () => {
  try {
    const data = await fs.readFile(DAILY_STATS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist, create directory and empty file
    if (error.code === 'ENOENT') {
      console.log(`⚠️ Daily stats file not found, creating empty one at ${DAILY_STATS_FILE}`);
      await fs.mkdir(path.dirname(DAILY_STATS_FILE), { recursive: true });
      await fs.writeFile(DAILY_STATS_FILE, '{}', { mode: 0o666 });
    } else {
      console.error("Error loading daily stats:", error);
    }
    return {};
  }
};

/**
 * Save the daily stats file
 */
const saveDailyStats = async (stats) => {
  try {
    // Make sure the directory exists before writing
    await fs.mkdir(path.dirname(DAILY_STATS_FILE), { recursive: true });
    await fs.writeFile(DAILY_STATS_FILE, JSON.stringify(stats, null, 2));
    console.log(`✅ Daily stats saved to ${DAILY_STATS_FILE}`);
  } catch (error) {
    console.error("Error saving daily stats:", error);
  }
};

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
 * Synchronize job data with daily stats to ensure consistency
 * 
 * @param {string} userId - The user ID
 * @param {Object} job - The job object to synchronize
 * @param {Object} dailyStats - Daily statistics object (optional, will be loaded if not provided)
 * @returns {Object} - Updated daily stats
 */
const synchronizeJobWithDailyStats = async (userId, job, dailyStats = null) => {
  try {
    console.log(`🔄 Senkronizasyon başlatılıyor: Kullanıcı ${userId}`);
    
    // Null check for job object
    if (!job) {
      console.error(`❌ Senkronizasyon hatası: job objesi undefined veya null`);
      return null;
    }
    
    // Load daily stats if not provided
    if (!dailyStats) {
      try {
        console.log(`📊 Günlük istatistikler yükleniyor...`);
        dailyStats = await loadDailyStats();
        console.log(`✅ Günlük istatistikler yüklendi`);
      } catch (loadError) {
        console.error(`❌ Günlük istatistikleri yükleme hatası: ${loadError.message}`);
        // Boş bir obje oluştur ve devam et
        dailyStats = {};
      }
    }

    // Initialize user stats if not exist
    if (!dailyStats[userId]) {
      console.log(`📊 ${userId} için yeni günlük istatistik kaydı oluşturuluyor`);
      dailyStats[userId] = {};
    }
    
    // Get today's key
    const today = getTodayKey();
    const hourKey = getHourKey();
    
    console.log(`📅 Bugün: ${today}, Saat: ${hourKey}`);
    
    // Calculate the number of processed contacts in this job
    const processedCount = job.successCount || 0;
    console.log(`📊 İşlenen profil sayısı: ${processedCount}`);
    
    // Ensure job's dailyStats object is properly initialized
    if (!job.dailyStats) {
      console.log(`📊 İş istatistikleri başlatılıyor`);
      job.dailyStats = {
        startDate: today,
        processedToday: 0,
        patternBreakdown: {}
      };
    }
    
    // Update daily stats based on job processed count
    dailyStats[userId][today] = processedCount;
    dailyStats[userId][hourKey] = processedCount;
    
    // Also update the job's dailyStats object for consistency
    job.dailyStats.processedToday = processedCount;
    job.dailyStats.startDate = job.dailyStats.startDate || today;
    
    console.log(`📊 Güncellenmiş istatistikler: Bugün=${processedCount}`);
    
    // Save the updated daily stats
    try {
      console.log(`💾 Günlük istatistikler kaydediliyor...`);
      await saveDailyStats(dailyStats);
      console.log(`✅ Günlük istatistikler kaydedildi`);
    } catch (saveError) {
      console.error(`❌ Günlük istatistikleri kaydetme hatası: ${saveError.message}`);
      // Hatayı yut ve devam et
    }
    
    console.log(`✅ Senkronizasyon tamamlandı: ${userId} için ${processedCount} profil işlendi`);
    
    return dailyStats;
  } catch (error) {
    console.error(`❌ Senkronizasyon ana hatası: ${error.message}`, error);
    // Hatayı yukarı fırlatma - arka plan işlemi devam etsin
    return null;
  }
};

module.exports = {
  synchronizeJobWithDailyStats,
  loadDailyStats,
  saveDailyStats,
  getTodayKey,
  getHourKey
};
