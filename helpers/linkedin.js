const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, '../data');
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'daily_rate_limits.json');
const SESSION_FILE = path.join(DATA_DIR, 'session_data.json');

// Daily limits for LinkedIn requests
const DAILY_LIMITS = {
  profile_views: 100,
  contact_info: 50,
  request_timeout: 15000,
  min_delay_between: 2000,  // 2 seconds minimum
  max_delay_between: 8000,  // 8 seconds maximum
  max_retries: 3
};

// LinkedIn headers for better stealth
const LINKEDIN_HEADERS = {
  'Accept': 'application/vnd.linkedin.normalized+json+2.1',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'DNT': '1',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'X-Requested-With': 'XMLHttpRequest',
  'x-li-lang': 'en_US',
  'x-li-track': JSON.stringify({
    "clientVersion": "1.13.9631",
    "mpVersion": "1.13.9631",
    "osName": "web",
    "timezoneOffset": -480,
    "timezone": "America/Los_Angeles",
    "deviceFormFactor": "DESKTOP",
    "mpName": "voyager-web"
  })
};

// User-Agent rotation for better stealth
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0'
];

// Ensure data directory exists
const ensureDataDir = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
};

// Simple timeout wrapper for fetch
const fetchWithTimeout = async (url, options = {}, timeoutMs = DAILY_LIMITS.request_timeout) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { 
      ...options, 
      signal: controller.signal
    });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
};

// Rate limiter with persistent storage
class RateLimiter {
  constructor() {
    this.limits = {};
    this.requestHistory = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    
    try {
      const data = await fs.readFile(RATE_LIMIT_FILE, 'utf8');
      const parsed = JSON.parse(data);
      this.limits = parsed.limits || {};
      this.requestHistory = parsed.requestHistory || [];
      
      // Clean old history (keep only last 24 hours)
      const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
      this.requestHistory = this.requestHistory.filter(req => req.timestamp > oneDayAgo);
      
      console.log('📊 Rate limiter loaded from disk');
    } catch (error) {
      console.log('📊 Starting with fresh rate limits');
    }
    
    this.loaded = true;
  }

  async save() {
    try {
      const data = {
        limits: this.limits,
        requestHistory: this.requestHistory,
        lastSaved: Date.now()
      };
      await fs.writeFile(RATE_LIMIT_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('❌ Failed to save rate limits:', error.message);
    }
  }
// Check if request is allowed
  async checkLimit(type, increment = true) {
    await this.load();
    
    const now = Date.now();
    const today = new Date().toDateString();
    
    if (!this.limits[today]) {
      this.limits[today] = {};
    }
    
    const currentCount = this.limits[today][type] || 0;
    const limit = DAILY_LIMITS[type];
    
    if (currentCount >= limit) {
      return { allowed: false, current: currentCount, limit, remaining: 0 };
    }
    
    if (increment) {
      this.limits[today][type] = currentCount + 1;
      this.requestHistory.push({
        type,
        timestamp: now,
        date: today
      });
      
      // Save periodically
      if (this.requestHistory.length % 10 === 0) {
        await this.save();
      }
    }
    
    return {
      allowed: true,
      current: this.limits[today][type] || 0,
      limit,
      remaining: limit - (this.limits[today][type] || 0)
    };
  }

  // Get current stats
  async getStats() {
    await this.load();
    
    const today = new Date().toDateString();
    const todayLimits = this.limits[today] || {};
    
    return {
      today: todayLimits,
      requestHistory: this.requestHistory.length,
      dailyLimits: DAILY_LIMITS
    };
  }

  // Reset daily limits (for testing)
  async resetDaily() {
    const today = new Date().toDateString();
    this.limits[today] = {};
    await this.save();
  }
}

// Main LinkedIn Client
class LinkedInClient {
  constructor() {
    this.rateLimiter = new RateLimiter();
    this.sessionData = {};
    this.initialized = false;
  }

  // Initialize the client
  async initialize() {
    if (this.initialized) {
      console.log('✅ LinkedIn client already initialized');
      return;
    }

    try {
      console.log('🚀 Initializing simple LinkedIn client...');
      
      await ensureDataDir();
      await this.loadSessionData();
      
      this.initialized = true;
      console.log('✅ LinkedIn client initialized successfully');
      
    } catch (error) {
      console.error('❌ LinkedIn client initialization failed:', error.message);
      throw error;
    }
  }

  // Load session data
  async loadSessionData() {
    try {
      const data = await fs.readFile(SESSION_FILE, 'utf8');
      this.sessionData = JSON.parse(data);
      console.log('📊 Session data loaded');
    } catch (error) {
      console.log('📊 Starting with fresh session data');
      this.sessionData = {};
    }
  }

  // Save session data
  async saveSessionData() {
    try {
      await fs.writeFile(SESSION_FILE, JSON.stringify(this.sessionData, null, 2));
    } catch (error) {
      console.error('❌ Failed to save session data:', error.message);
    }
  }

  // Generate session ID for tracking
  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Get random user agent
  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  // Get random delay between min and max
  getRandomDelay() {
    return Math.floor(Math.random() * (DAILY_LIMITS.max_delay_between - DAILY_LIMITS.min_delay_between + 1)) + DAILY_LIMITS.min_delay_between;
  }

  // Make LinkedIn request with retries and delays
  async makeLinkedInRequest(url, options = {}, retries = DAILY_LIMITS.max_retries) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check rate limits
    const rateLimitCheck = await this.rateLimiter.checkLimit('profile_views');
    if (!rateLimitCheck.allowed) {
      throw new Error(`Daily rate limit exceeded: ${rateLimitCheck.current}/${rateLimitCheck.limit}`);
    }

    let lastError;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Add random delay before request (except first attempt)
        if (attempt > 1) {
          const delay = this.getRandomDelay();
          console.log(`⏳ Waiting ${delay}ms before retry attempt ${attempt}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Enhanced headers with rotation
        const headers = {
          ...LINKEDIN_HEADERS,
          'User-Agent': this.getRandomUserAgent(),
          ...options.headers
        };

        // Add authentication headers if available
        if (options.cookies) {
          headers['Cookie'] = Object.entries(options.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
        }

        console.log(`🔄 Attempt ${attempt}/${retries} - Making request to LinkedIn`);

        const response = await fetchWithTimeout(url, {
          ...options,
          headers,
          method: options.method || 'GET'
        });

        if (response.ok) {
          console.log(`✅ Request successful on attempt ${attempt}`);
          return response;
        } else if (response.status === 429) {
          // Rate limited
          const retryAfter = response.headers.get('retry-after') || '60';
          console.log(`⏳ Rate limited, waiting ${retryAfter}s before retry`);
          await new Promise(resolve => setTimeout(resolve, parseInt(retryAfter) * 1000));
          continue;
        } else if (response.status === 403 || response.status === 401) {
          // Blocked or unauthorized
          throw new Error(`Access denied (${response.status}). May be blocked or need re-authentication.`);
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Attempt ${attempt}/${retries} failed: ${error.message}`);
        
        // Wait before retry with exponential backoff
        if (attempt < retries) {
          const delay = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Request failed after ${retries} attempts. Last error: ${lastError?.message}`);
  }

  // Fetch LinkedIn profile
  async fetchLinkedInProfile(profileId, cookies = {}) {
    try {
      console.log(`🔍 Fetching LinkedIn profile: ${profileId}`);
      
      // Generate session ID for tracking
      const sessionId = this.generateSessionId();
      
      // LinkedIn Voyager API endpoints
      const endpoints = {
        profile: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`,
        contact: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`
      };

      const results = {};
      
      // Fetch main profile data first (most important)
      try {
        const profileResponse = await this.makeLinkedInRequest(endpoints.profile, {
          headers: {
            'Accept': 'application/vnd.linkedin.normalized+json+2.1',
            'x-restli-protocol-version': '2.0.0'
          },
          cookies
        });

        if (profileResponse.ok) {
          results.profileView = await profileResponse.json();
          console.log(`✅ Profile data fetched for ${profileId}`);
        }
      } catch (error) {
        console.error(`❌ Failed to fetch profile data: ${error.message}`);
        results.profileView = { error: error.message };
      }

      // Add delay between requests
      const delay = this.getRandomDelay();
      console.log(`⏳ Waiting ${delay}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, delay));

      // Fetch contact info (if rate limits allow)
      const contactLimit = await this.rateLimiter.checkLimit('contact_info', false);
      if (contactLimit.allowed) {
        try {
          await this.rateLimiter.checkLimit('contact_info', true); // Increment counter
          const contactResponse = await this.makeLinkedInRequest(endpoints.contact, {
            headers: {
              'Accept': 'application/vnd.linkedin.normalized+json+2.1',
              'x-restli-protocol-version': '2.0.0'
            },
            cookies
          });

          if (contactResponse.ok) {
            results.contactInfo = await contactResponse.json();
            console.log(`✅ Contact info fetched for ${profileId}`);
          }
        } catch (error) {
          console.warn(`⚠️ Failed to fetch contact info: ${error.message}`);
          results.contactInfo = { error: error.message };
        }
      } else {
        console.log(`⏸️ Contact info rate limit reached (${contactLimit.current}/${contactLimit.limit})`);
        results.contactInfo = { error: 'Rate limit exceeded' };
      }

      // Return combined results
      const combinedData = {
        profileId,
        sessionId,
        timestamp: Date.now(),
        success: !!results.profileView && !results.profileView.error,
        ...results, // This spreads profileView and contactInfo at the top level for compatibility
        data: results,
        // Simplified combined data for easier processing
        combined: this.combineProfileData(results)
      };

      // Save session data
      this.sessionData[sessionId] = combinedData;
      await this.saveSessionData();

      console.log(`🎯 Successfully fetched LinkedIn profile: ${profileId}`);
      return combinedData;

    } catch (error) {
      console.error(`❌ Error fetching LinkedIn profile ${profileId}:`, error.message);
      return {
        profileId,
        timestamp: Date.now(),
        success: false,
        error: error.message,
        data: null
      };
    }
  }

  // Combine profile data into a simplified format
  combineProfileData(results) {
    const combined = {};
    
    try {
      // Extract profile basics
      if (results.profileView && results.profileView.profile) {
        const profile = results.profileView.profile;
        combined.firstName = profile.firstName;
        combined.lastName = profile.lastName;
        combined.headline = profile.headline;
        combined.summary = profile.summary;
        combined.location = profile.geoLocationName;
        combined.industry = profile.industryName;
        combined.profilePicture = profile.displayPictureUrl;
        combined.publicIdentifier = profile.publicIdentifier;
      }

      // Extract contact info
      if (results.contactInfo && results.contactInfo.data) {
        const contact = results.contactInfo.data;
        combined.email = contact.emailAddress;
        combined.phone = contact.phoneNumbers?.[0]?.number;
        combined.websites = contact.websites?.map(w => w.url);
        combined.twitter = contact.twitterHandles?.[0]?.name;
      }

      return combined;
    } catch (error) {
      console.warn(`⚠️ Error combining profile data: ${error.message}`);
      return { error: 'Failed to combine profile data' };
    }
  }

  // Get rate limit status
  async getRateLimitStatus() {
    const stats = await this.rateLimiter.getStats();
    
    return {
      rateLimitStats: stats,
      clientInitialized: this.initialized,
      dailyLimits: DAILY_LIMITS
    };
  }
}

// Global client instance
let globalLinkedInClient = null;

// Initialize LinkedIn client
const initializeLinkedInClient = async () => {
  if (!globalLinkedInClient) {
    globalLinkedInClient = new LinkedInClient();
  }
  await globalLinkedInClient.initialize();
  return globalLinkedInClient;
};

// Fetch LinkedIn profile (main export function)
const fetchLinkedInProfile = async (profileId, cookies = {}) => {
  if (!globalLinkedInClient) {
    await initializeLinkedInClient();
  }
  return await globalLinkedInClient.fetchLinkedInProfile(profileId, cookies);
};

// Generate session ID
const generateSessionId = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Get rate limit status
const getRateLimitStatus = () => {
  if (!globalLinkedInClient) {
    return {
      rateLimitStats: { today: {}, requestHistory: 0, dailyLimits: DAILY_LIMITS },
      clientInitialized: false,
      dailyLimits: DAILY_LIMITS
    };
  }
  return globalLinkedInClient.getRateLimitStatus();
};

// Export all functions
module.exports = {
  // Main functions
  fetchLinkedInProfile,
  initializeLinkedInClient,
  getRateLimitStatus,
  generateSessionId,
  
  // Classes for advanced usage
  LinkedInClient,
  RateLimiter,
  
  // Constants
  DAILY_LIMITS,
  LINKEDIN_HEADERS,
  
  // File paths
  RATE_LIMIT_FILE,
  SESSION_FILE
};