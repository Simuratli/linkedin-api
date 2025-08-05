// Direct LinkedIn Client - No Proxies, Real Browser Simulation
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Realistic browser simulation settings
const BROWSER_CONFIG = {
  // Real Chrome/Firefox user agents
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0'
  ],
  
  // Realistic accept headers
  acceptLanguages: [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9',
    'en-CA,en;q=0.9',
    'en-AU,en;q=0.9'
  ],
  
  // Realistic delays (human-like)
  delays: {
    min: 30000,   // 30 seconds minimum
    max: 90000,   // 1.5 minutes maximum
    betweenProfiles: [60000, 180000], // 1-3 minutes between profiles
    afterError: [120000, 300000] // 2-5 minutes after error
  },
  
  // Session management
  sessionLimits: {
    maxRequests: 15,     // Max requests per session
    maxTime: 1800000,    // 30 minutes max per session
    cooldown: 900000     // 15 minutes cooldown between sessions
  }
};

class DirectLinkedInSession {
  constructor() {
    this.id = crypto.randomUUID();
    this.sessionId = crypto.randomInt(1e12, 1e13 - 1);
    this.userAgent = BROWSER_CONFIG.userAgents[Math.floor(Math.random() * BROWSER_CONFIG.userAgents.length)];
    this.acceptLanguage = BROWSER_CONFIG.acceptLanguages[Math.floor(Math.random() * BROWSER_CONFIG.acceptLanguages.length)];
    this.createdAt = Date.now();
    this.requestCount = 0;
    this.lastRequest = null;
    this.isActive = true;
    this.fingerprint = this.generateFingerprint();
  }

  generateFingerprint() {
    return {
      sessionId: `"ajax:${this.sessionId}"`,
      userAgent: this.userAgent,
      acceptLanguage: this.acceptLanguage,
      bcookie: `"v=2&${crypto.randomUUID()}"`,
      bscookie: `"v=1&${Date.now()}${crypto.randomUUID().substring(0, 8)}"`,
      li_at: this.generateLiAtToken(),
      li_gc: 'MTs%3D',
      li_mc: 'MTs%3D',
      lang: 'v=2&lang=en-us',
      timezone: 'Etc/GMT',
      csrfToken: this.sessionId.toString()
    };
  }

  generateLiAtToken() {
    const timestamp = Date.now();
    const randomPart = crypto.randomBytes(32).toString('base64');
    return `AQEDARq${timestamp}_${randomPart}`;
  }

  isExpired() {
    const now = Date.now();
    const timeSinceCreation = now - this.createdAt;
    const timeSinceLastRequest = this.lastRequest ? now - this.lastRequest : 0;
    
    return (
      this.requestCount >= BROWSER_CONFIG.sessionLimits.maxRequests ||
      timeSinceCreation >= BROWSER_CONFIG.sessionLimits.maxTime ||
      (this.lastRequest && timeSinceLastRequest >= BROWSER_CONFIG.sessionLimits.cooldown)
    );
  }

  incrementRequest() {
    this.requestCount++;
    this.lastRequest = Date.now();
  }
}

class DirectLinkedInClient {
  constructor() {
    this.sessions = [];
    this.currentSession = null;
    this.sessionFile = path.join(__dirname, '../data/direct_sessions.json');
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      sessionsCreated: 0,
      sessionsExpired: 0,
      lastError: null
    };
    
    this.loadSessions();
    console.log('🚀 Direct LinkedIn Client initialized (no proxies, real browser simulation)');
  }

  async loadSessions() {
    try {
      const data = await fs.readFile(this.sessionFile, 'utf8');
      const parsed = JSON.parse(data);
      this.sessions = parsed.sessions || [];
      this.stats = parsed.stats || this.stats;
      console.log(`📋 Loaded ${this.sessions.length} existing sessions`);
    } catch (error) {
      console.log('📋 No existing sessions found, will create new ones');
      this.sessions = [];
    }
  }

  async saveSessions() {
    try {
      const dataDir = path.dirname(this.sessionFile);
      await fs.mkdir(dataDir, { recursive: true });
      
      await fs.writeFile(this.sessionFile, JSON.stringify({
        sessions: this.sessions,
        stats: this.stats,
        lastUpdate: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error('❌ Failed to save sessions:', error);
    }
  }

  createNewSession() {
    const session = new DirectLinkedInSession();
    this.sessions.push(session);
    this.stats.sessionsCreated++;
    console.log(`🆕 Created new session: ${session.id}`);
    return session;
  }

  getActiveSession() {
    // Clean up expired sessions
    this.sessions = this.sessions.filter(session => {
      if (session.isExpired()) {
        this.stats.sessionsExpired++;
        return false;
      }
      return true;
    });

    // Find active session with least requests
    const activeSessions = this.sessions.filter(s => s.isActive && !s.isExpired());
    
    if (activeSessions.length === 0) {
      console.log('⚠️ No active sessions, creating new one...');
      return this.createNewSession();
    }

    // Sort by request count and last used time
    const sortedSessions = activeSessions.sort((a, b) => {
      if (a.requestCount !== b.requestCount) {
        return a.requestCount - b.requestCount;
      }
      return (a.lastRequest || 0) - (b.lastRequest || 0);
    });

    return sortedSessions[0];
  }

  generateHeaders(profileId, session) {
    const cookieHeader = Object.entries(session.fingerprint)
      .filter(([key]) => ['JSESSIONID', 'li_at', 'bcookie', 'bscookie', 'li_gc', 'li_mc', 'lang', 'timezone'].includes(key))
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return {
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'accept-language': session.acceptLanguage,
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'csrf-token': session.fingerprint.csrfToken,
      'cookie': cookieHeader,
      'referer': `https://www.linkedin.com/in/${profileId}/`,
      'user-agent': session.userAgent,
      'x-li-lang': 'en_US',
      'x-restli-protocol-version': '2.0.0',
      'x-li-page-instance': `urn:li:page:d_flagship3_profile_view_base;${crypto.randomUUID()}`,
      'x-requested-with': 'XMLHttpRequest',
      'x-li-track': '{"clientVersion":"1.10.*"}',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'origin': 'https://www.linkedin.com'
    };
  }

  async makeRequest(url, profileId, requestType = 'profile_views', retryCount = 0) {
    const maxRetries = 2;
    
    // Get or create session
    if (!this.currentSession || this.currentSession.isExpired()) {
      this.currentSession = this.getActiveSession();
      console.log(`🔄 Using session: ${this.currentSession.id} (requests: ${this.currentSession.requestCount})`);
    }

    // Realistic delay
    const delay = Math.floor(Math.random() * 
      (BROWSER_CONFIG.delays.max - BROWSER_CONFIG.delays.min + 1)) + 
      BROWSER_CONFIG.delays.min;
    
    console.log(`⏳ Waiting ${delay/1000}s before request (realistic browser behavior)`);
    await new Promise(resolve => setTimeout(resolve, delay));

    const headers = this.generateHeaders(profileId, this.currentSession);
    
    try {
      console.log(`🔍 Making ${requestType} request (attempt ${retryCount + 1}/${maxRetries + 1})`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
        timeout: 30000,
      });

      this.currentSession.incrementRequest();
      this.stats.totalRequests++;

      if (!response.ok) {
        if (response.status === 429 || response.status === 403) {
          // Session blocked, mark as inactive
          this.currentSession.isActive = false;
          this.stats.failedRequests++;
          this.stats.lastError = `HTTP ${response.status}`;
          
          if (retryCount < maxRetries) {
            console.log(`⚠️ Session blocked, trying new session...`);
            this.currentSession = null;
            await new Promise(resolve => setTimeout(resolve, 10000));
            return this.makeRequest(url, profileId, requestType, retryCount + 1);
          }
        }
        
        this.stats.failedRequests++;
        this.stats.lastError = `HTTP ${response.status}`;
        throw new Error(`Request failed: ${response.status}`);
      }

      this.stats.successfulRequests++;
      const data = await response.json();
      console.log(`✅ Successful ${requestType} request`);
      
      await this.saveSessions();
      return data;

    } catch (error) {
      console.error(`❌ Request failed:`, error.message);
      this.stats.failedRequests++;
      this.stats.lastError = error.message;
      
      if (retryCount < maxRetries) {
        console.log(`🔄 Retrying with new session...`);
        this.currentSession = null;
        await new Promise(resolve => setTimeout(resolve, 5000));
        return this.makeRequest(url, profileId, requestType, retryCount + 1);
      }
      
      throw error;
    }
  }

  async fetchLinkedInProfile(profileId) {
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;

    try {
      // Get profile data
      const profileData = await this.makeRequest(profileViewUrl, profileId, 'profile_views');
      
      // Realistic delay between requests
      const interRequestDelay = Math.floor(Math.random() * 
        (BROWSER_CONFIG.delays.betweenProfiles[1] - BROWSER_CONFIG.delays.betweenProfiles[0] + 1)) + 
        BROWSER_CONFIG.delays.betweenProfiles[0];
      
      console.log(`⏳ Waiting ${interRequestDelay/1000}s between requests`);
      await new Promise(resolve => setTimeout(resolve, interRequestDelay));

      // Get contact info (optional, more risky)
      let contactInfoData = null;
      try {
        // Only try contact info 20% of the time to reduce risk
        if (Math.random() < 0.2) {
          contactInfoData = await this.makeRequest(contactInfoUrl, profileId, 'contact_info');
        } else {
          console.log('📊 Skipping contact info to reduce detection risk');
        }
      } catch (contactError) {
        console.warn(`⚠️ Contact info failed: ${contactError.message}`);
      }

      return {
        profileView: profileData,
        contactInfo: contactInfoData,
        sessionId: this.currentSession?.id,
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

  getStats() {
    return {
      ...this.stats,
      activeSessions: this.sessions.filter(s => s.isActive && !s.isExpired()).length,
      totalSessions: this.sessions.length,
      currentSession: this.currentSession?.id,
      successRate: this.stats.totalRequests > 0 ? 
        Math.round((this.stats.successfulRequests / this.stats.totalRequests) * 100) : 0
    };
  }

  async refreshSessions(count = 5) {
    console.log(`🔄 Creating ${count} new sessions...`);
    for (let i = 0; i < count; i++) {
      this.createNewSession();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await this.saveSessions();
    console.log(`✅ Created ${count} new sessions`);
  }
}

// Global instance
let directLinkedInClient = null;

// Initialize function
async function initializeDirectLinkedInClient() {
  directLinkedInClient = new DirectLinkedInClient();
  await directLinkedInClient.refreshSessions(10); // Create 10 initial sessions
  return directLinkedInClient;
}

// Export functions
async function fetchLinkedInProfile(profileId) {
  if (!directLinkedInClient) {
    throw new Error('Direct LinkedIn client not initialized. Call initializeDirectLinkedInClient() first.');
  }
  return directLinkedInClient.fetchLinkedInProfile(profileId);
}

function getStats() {
  if (!directLinkedInClient) {
    return { error: 'Client not initialized' };
  }
  return directLinkedInClient.getStats();
}

async function refreshSessions() {
  if (!directLinkedInClient) {
    throw new Error('Direct LinkedIn client not initialized');
  }
  return directLinkedInClient.refreshSessions();
}

module.exports = {
  DirectLinkedInClient,
  initializeDirectLinkedInClient,
  fetchLinkedInProfile,
  getStats,
  refreshSessions
}; 