// Enhanced LinkedIn Bot Protection System
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

// Günlük rate limiting için dosya yolu
const RATE_LIMIT_FILE = path.join(__dirname, '../data/daily_rate_limits.json');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0'
];

const RESIDENTIAL_IPS = [
  // Bu kısmı gerçek residential proxy'lerle doldur
  '192.168.1.100',
  '10.0.0.50',
  // Veya proxy servisinden al
];

// Günlük rate limitleri
const DAILY_LIMITS = {
  profile_views: 500,      // Günlük profil görüntüleme limiti
  contact_info: 100,       // Günlük contact info limiti
  search_queries: 200,     // Günlük arama limiti
  max_requests_per_hour: 80, // Saatlik genel limit
  max_burst_requests: 3,   // Ard arda yapılabilecek maksimum istek
};

// Advanced rate limiting class
class AdvancedRateLimit {
  constructor() {
    this.dailyCounters = {};
    this.hourlyCounters = {};
    this.lastRequestTimes = [];
    this.suspiciousActivity = false;
    this.backoffMultiplier = 1;
    this.lastResetTime = this.getTodayKey();
    
    // Startup'ta günlük verileri yükle
    this.loadDailyData();
  }

  getTodayKey() {
    return new Date().toISOString().split('T')[0];
  }

  getHourKey() {
    const now = new Date();
    return `${this.getTodayKey()}-${now.getHours()}`;
  }

  async loadDailyData() {
    try {
      const data = await fs.readFile(RATE_LIMIT_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      // Bugünkü verileri yükle, eski verileri temizle
      const today = this.getTodayKey();
      if (parsed[today]) {
        this.dailyCounters = parsed[today];
      }
    } catch (error) {
      // Dosya yoksa veya hata varsa boş başla
      this.dailyCounters = {};
    }
  }

  async saveDailyData() {
    try {
      let allData = {};
      try {
        const existingData = await fs.readFile(RATE_LIMIT_FILE, 'utf8');
        allData = JSON.parse(existingData);
      } catch (e) {
        // Dosya yoksa boş obje ile başla
      }

      const today = this.getTodayKey();
      allData[today] = this.dailyCounters;

      // 7 günden eski verileri temizle
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      const weekAgoKey = weekAgo.toISOString().split('T')[0];

      Object.keys(allData).forEach(key => {
        if (key < weekAgoKey) {
          delete allData[key];
        }
      });

      await fs.writeFile(RATE_LIMIT_FILE, JSON.stringify(allData, null, 2));
    } catch (error) {
      console.error('Daily data save error:', error);
    }
  }

  resetCountersIfNewDay() {
    const today = this.getTodayKey();
    if (this.lastResetTime !== today) {
      this.dailyCounters = {};
      this.lastResetTime = today;
      this.backoffMultiplier = 1; // Reset backoff on new day
      this.suspiciousActivity = false;
    }
  }

  resetCountersIfNewHour() {
    const currentHour = this.getHourKey();
    if (!this.hourlyCounters[currentHour]) {
      // Yeni saat, eski saatleri temizle
      this.hourlyCounters = {};
      this.hourlyCounters[currentHour] = 0;
    }
  }

  incrementCounter(type) {
    this.resetCountersIfNewDay();
    this.resetCountersIfNewHour();

    const today = this.getTodayKey();
    const currentHour = this.getHourKey();

    if (!this.dailyCounters[type]) {
      this.dailyCounters[type] = 0;
    }
    
    this.dailyCounters[type]++;
    this.hourlyCounters[currentHour]++;
    
    // Günlük verileri kaydet
    this.saveDailyData();
  }

  checkDailyLimit(type) {
    this.resetCountersIfNewDay();
    const count = this.dailyCounters[type] || 0;
    const limit = DAILY_LIMITS[type] || 1000;
    
    return {
      allowed: count < limit,
      current: count,
      limit: limit,
      remaining: Math.max(0, limit - count)
    };
  }

  checkHourlyLimit() {
    this.resetCountersIfNewHour();
    const currentHour = this.getHourKey();
    const count = this.hourlyCounters[currentHour] || 0;
    
    return {
      allowed: count < DAILY_LIMITS.max_requests_per_hour,
      current: count,
      limit: DAILY_LIMITS.max_requests_per_hour,
      remaining: Math.max(0, DAILY_LIMITS.max_requests_per_hour - count)
    };
  }

  checkBurstLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Son 1 dakikadaki istekleri filtrele
    this.lastRequestTimes = this.lastRequestTimes.filter(time => time > oneMinuteAgo);
    
    return {
      allowed: this.lastRequestTimes.length < DAILY_LIMITS.max_burst_requests,
      current: this.lastRequestTimes.length,
      limit: DAILY_LIMITS.max_burst_requests
    };
  }

  recordRequest() {
    this.lastRequestTimes.push(Date.now());
  }

  detectSuspiciousActivity() {
    const hourlyCheck = this.checkHourlyLimit();
    const burstCheck = this.checkBurstLimit();
    
    // Şüpheli aktivite tespiti
    if (hourlyCheck.current > hourlyCheck.limit * 0.8 || !burstCheck.allowed) {
      this.suspiciousActivity = true;
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 1.5, 5);
      console.warn('⚠️ Suspicious activity detected, increasing delays');
    }
    
    return this.suspiciousActivity;
  }

  getAdaptiveDelay(baseMin = 8000, baseMax = 15000) {
    const multiplier = this.backoffMultiplier;
    const min = baseMin * multiplier;
    const max = baseMax * multiplier;
    
    // Şüpheli aktivite varsa daha uzun bekle
    if (this.suspiciousActivity) {
      return this.getRandomDelay(min * 2, max * 3);
    }
    
    return this.getRandomDelay(min, max);
  }

  getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async shouldAllowRequest(type = 'profile_views') {
    const dailyCheck = this.checkDailyLimit(type);
    const hourlyCheck = this.checkHourlyLimit();
    const burstCheck = this.checkBurstLimit();

    if (!dailyCheck.allowed) {
      throw new Error(`Daily limit exceeded for ${type}. Limit: ${dailyCheck.limit}, Current: ${dailyCheck.current}`);
    }

    if (!hourlyCheck.allowed) {
      const waitTime = 3600000; // 1 hour
      throw new Error(`Hourly limit exceeded. Wait ${waitTime/60000} minutes`);
    }

    if (!burstCheck.allowed) {
      const waitTime = 60000; // 1 minute
      throw new Error(`Burst limit exceeded. Wait ${waitTime/1000} seconds`);
    }

    return {
      allowed: true,
      dailyRemaining: dailyCheck.remaining,
      hourlyRemaining: hourlyCheck.remaining,
      recommendedDelay: this.getAdaptiveDelay()
    };
  }
}

// Human behavior simulation
class HumanBehaviorSimulator {
  constructor() {
    this.sessionStartTime = Date.now();
    this.activityPattern = this.generateDailyPattern();
    this.mouseMovements = [];
    this.scrollEvents = [];
  }

  generateDailyPattern() {
    // Gerçekçi günlük aktivite paterni oluştur
    const patterns = [
      { start: 9, end: 12, intensity: 0.7 },   // Sabah yoğunluğu
      { start: 13, end: 17, intensity: 0.9 },  // Öğleden sonra yoğunluğu
      { start: 19, end: 22, intensity: 0.4 },  // Akşam düşük aktivite
    ];
    return patterns;
  }

  getCurrentIntensity() {
    const hour = new Date().getHours();
    const pattern = this.activityPattern.find(p => hour >= p.start && hour <= p.end);
    return pattern ? pattern.intensity : 0.2;
  }

  simulateReadingTime(contentLength = 1000) {
    // İçerik uzunluğuna göre okuma süresi simüle et
    const wordsPerMinute = 200;
    const words = contentLength / 5; // Ortalama kelime uzunluğu
    const readingTimeMs = (words / wordsPerMinute) * 60 * 1000;
    
    // %20-80 arası rastgele varyasyon ekle
    const variance = 0.6 * Math.random() + 0.2;
    return Math.floor(readingTimeMs * variance);
  }

  simulateTypingPattern() {
    // İnsan typing pattern'i simüle et
    return {
      keystrokeDynamics: Math.random() * 100 + 50, // 50-150ms arası
      pauseBetweenWords: Math.random() * 200 + 100, // 100-300ms arası
    };
  }

  getHumanizedDelay(baseDelay) {
    const intensity = this.getCurrentIntensity();
    const sessionDuration = Date.now() - this.sessionStartTime;
    
    // Uzun session'larda yorgunluk faktörü
    const fatigueMultiplier = Math.min(1 + (sessionDuration / 3600000) * 0.2, 2);
    
    // Günlük yoğunluğa göre ayarlama
    const adjustedDelay = baseDelay * (2 - intensity) * fatigueMultiplier;
    
    return Math.floor(adjustedDelay);
  }
}

// Enhanced LinkedIn client
class EnhancedLinkedInClient {
  constructor() {
    this.rateLimit = new AdvancedRateLimit();
    this.behaviorSimulator = new HumanBehaviorSimulator();
    this.sessionId = this.generateSessionId();
    this.fingerprint = this.generateFingerprint();
    this.requestHistory = [];
    this.consecutiveErrors = 0;
    this.lastSuccessfulRequest = null;
  }

  generateSessionId() {
    return `"ajax:${crypto.randomInt(1e18, 1e19 - 1)}`;
  }

  generateFingerprint() {
    // Browser fingerprint simüle et
    return {
      screen: { width: 1920, height: 1080, colorDepth: 24 },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: 'en-US',
      platform: 'Win32',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      webgl: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    };
  }

  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  generateAdvancedHeaders(csrf, cookieObj, profileId, requestType = 'profile') {
    const cookieHeader = Object.entries(cookieObj)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const baseHeaders = {
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'accept-language': 'en-US,en;q=0.9,tr;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'csrf-token': csrf,
      'cookie': cookieHeader,
      'dnt': '1',
      'pragma': 'no-cache',
      'referer': `https://www.linkedin.com/in/${profileId}/`,
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': this.getRandomUserAgent(),
      'x-li-lang': 'en_US',
      'x-li-page-instance': `urn:li:page:d_flagship3_profile_view_base;${crypto.randomUUID()}`,
      'x-restli-protocol-version': '2.0.0',
      'x-requested-with': 'XMLHttpRequest',
      'x-li-track': JSON.stringify({
        'clientApplicationInstance': crypto.randomUUID(),
        'pageInstance': crypto.randomUUID(),
      }),
    };

    // Request type'a göre özel headerlar ekle
    if (requestType === 'contact') {
      baseHeaders['x-li-page-instance'] = `urn:li:page:d_flagship3_profile_view_base_contact_details;${crypto.randomUUID()}`;
    }

    return baseHeaders;
  }

  async makeLinkedInRequest(url, headers, requestType = 'profile_views') {
    // Rate limiting kontrolü
    const permission = await this.rateLimit.shouldAllowRequest(requestType);
    
    if (!permission.allowed) {
      throw new Error(`Rate limit exceeded: ${permission.message}`);
    }

    // Adaptif gecikme
    const delay = permission.recommendedDelay;
    console.log(`⏳ Adaptive delay: ${delay/1000}s (${requestType})`);
    await new Promise(resolve => setTimeout(resolve, delay));

    // İstek öncesi human behavior simülasyonu
    const readingTime = this.behaviorSimulator.simulateReadingTime();
    if (this.lastSuccessfulRequest) {
      console.log(`📖 Simulating reading time: ${readingTime/1000}s`);
      await new Promise(resolve => setTimeout(resolve, readingTime));
    }

    try {
      console.log(`🔍 Making LinkedIn request: ${requestType}`);
      
      const response = await fetch(url, {
        headers,
        credentials: 'include',
        timeout: 30000, // 30 saniye timeout
      });

      // Request'i kaydet
      this.rateLimit.recordRequest();
      this.rateLimit.incrementCounter(requestType);
      
      // Error handling
      if (!response.ok) {
        this.consecutiveErrors++;
        
        if (response.status === 429) {
          this.rateLimit.detectSuspiciousActivity();
          throw new Error(`Rate limited: ${response.status} - Backing off`);
        }
        
        if (response.status === 403) {
          this.rateLimit.detectSuspiciousActivity();
          throw new Error(`Access forbidden - Bot detected: ${response.status}`);
        }
        
        if (response.status === 999) {
          throw new Error(`LinkedIn challenge required: ${response.status}`);
        }
        
        throw new Error(`Request failed: ${response.status}`);
      }

      // Başarılı istek
      this.consecutiveErrors = 0;
      this.lastSuccessfulRequest = Date.now();
      
      const data = await response.json();
      
      console.log(`✅ Successful ${requestType} request`);
      console.log(`📊 Daily remaining: ${permission.dailyRemaining}, Hourly remaining: ${permission.hourlyRemaining}`);
      
      return data;

    } catch (error) {
      console.error(`❌ LinkedIn request failed:`, error.message);
      
      // Consecutive error handling
      if (this.consecutiveErrors >= 3) {
        const backoffTime = Math.pow(2, this.consecutiveErrors) * 5000;
        console.log(`🛑 ${this.consecutiveErrors} consecutive errors, backing off for ${backoffTime/1000}s`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
      
      throw error;
    }
  }

  async fetchLinkedInProfile(profileId, customCookies = null) {
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;

    const cookies = {
      JSESSIONID: customCookies?.jsession || this.generateSessionId(),
      li_at: customCookies?.li_at || 'YOUR_LI_AT_TOKEN_HERE',
      liap: 'true',
      timezone: 'America/Los_Angeles',
      lang: 'v=2&lang=en-us',
      bcookie: `"v=2&${crypto.randomUUID()}"`,
      bscookie: `"v=1&${Date.now()}${crypto.randomUUID()}"`,
    };

    const csrfToken = cookies.JSESSIONID.replace(/"/g, '');

    try {
      // Ana profil verisini al
      const profileHeaders = this.generateAdvancedHeaders(csrfToken, cookies, profileId, 'profile');
      const profileData = await this.makeLinkedInRequest(profileViewUrl, profileHeaders, 'profile_views');

      // İki istek arası human-like delay
      const interRequestDelay = this.behaviorSimulator.getHumanizedDelay(
        this.rateLimit.getRandomDelay(3000, 7000)
      );
      await new Promise(resolve => setTimeout(resolve, interRequestDelay));

      // Contact info'yu al (daha sınırlı)
      let contactInfoData = null;
      try {
        const contactHeaders = this.generateAdvancedHeaders(csrfToken, cookies, profileId, 'contact');
        contactInfoData = await this.makeLinkedInRequest(contactInfoUrl, contactHeaders, 'contact_info');
      } catch (contactError) {
        console.warn(`⚠️ Contact info failed for ${profileId}:`, contactError.message);
      }

      return {
        profileView: profileData,
        contactInfo: contactInfoData,
        combined: {
          ...profileData,
          contactInfo: contactInfoData
        }
      };

    } catch (error) {
      console.error(`❌ Profile fetch failed for ${profileId}:`, error.message);
      throw error;
    }
  }

  // Günlük istatistikleri al
  getDailyStats() {
    return {
      profileViews: this.rateLimit.dailyCounters.profile_views || 0,
      contactInfo: this.rateLimit.dailyCounters.contact_info || 0,
      limits: DAILY_LIMITS,
      suspiciousActivity: this.rateLimit.suspiciousActivity,
      backoffMultiplier: this.rateLimit.backoffMultiplier,
    };
  }
}

// Global instance
const linkedInClient = new EnhancedLinkedInClient();

// Export functions for backward compatibility
async function fetchLinkedInProfile(profileId, customCookies = null) {
  return linkedInClient.fetchLinkedInProfile(profileId, customCookies);
}

function generateSessionId() {
  return linkedInClient.generateSessionId();
}

// Rate limit status endpoint helper
function getRateLimitStatus() {
  return linkedInClient.getDailyStats();
}

module.exports = {
  fetchLinkedInProfile,
  generateSessionId,
  getRateLimitStatus,
  EnhancedLinkedInClient,
  DAILY_LIMITS
};