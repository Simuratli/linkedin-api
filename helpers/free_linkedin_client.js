// Free LinkedIn Client - No Proxies, Smart Session Rotation
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Smart request patterns to avoid detection
const REQUEST_PATTERNS = {
  // Different user agents for variety
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0'
  ],
  
  // Different accept languages
  acceptLanguages: [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9',
    'en-CA,en;q=0.9',
    'en-AU,en;q=0.9'
  ],
  
  // Realistic delays between requests (in milliseconds)
  delays: {
    min: 45000,  // 45 seconds minimum
    max: 120000, // 2 minutes maximum
    betweenProfiles: [60000, 180000] // 1-3 minutes between profiles
  },
  
  // Session limits
  sessionLimits: {
    maxRequests: 25,  // Max requests per session
    maxTime: 3600000, // 1 hour max per session
    cooldown: 1800000 // 30 minutes cooldown between sessions
  }
};

class FreeLinkedInSession {
  constructor() {
    this.id = crypto.randomUUID();
    this.sessionId = crypto.randomInt(1e12, 1e13 - 1);
    this.userAgent = REQUEST_PATTERNS.userAgents[Math.floor(Math.random() * REQUEST_PATTERNS.userAgents.length)];
    this.acceptLanguage = REQUEST_PATTERNS.acceptLanguages[Math.floor(Math.random() * REQUEST_PATTERNS.acceptLanguages.length)];
    this.createdAt = Date.now();
    this.requestCount = 0;
    this.lastRequest = null;
    this.isActive = true;
    
    // Generate realistic cookies
    this.cookies = {
      JSESSIONID: `"ajax:${this.sessionId}"`,
      li_at: this.generateLiAtToken(),
      liap: 'true',
      bcookie: `"v=2&${crypto.randomUUID()}"`,
      bscookie: `"v=1&${Date.now()}${crypto.randomUUID().substring(0, 8)}"`,
      li_gc: 'MTs%3D',
      li_mc: 'MTs%3D',
      lang: 'v=2&lang=en-us',
      timezone: 'Etc/GMT',
      'li_at': this.generateLiAtToken()
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
      this.requestCount >= REQUEST_PATTERNS.sessionLimits.maxRequests ||
      timeSinceCreation >= REQUEST_PATTERNS.sessionLimits.maxTime ||
      (this.lastRequest && timeSinceLastRequest >= REQUEST_PATTERNS.sessionLimits.cooldown)
    );
  }

  incrementRequest() {
    this.requestCount++;
    this.lastRequest = Date.now();
  }
}

class FreeLinkedInClient {
  constructor() {
    this.sessions = [];
    this.currentSession = null;
    this.sessionFile = path.join(__dirname, '../data/free_sessions.json');
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      sessionsCreated: 0,
      sessionsExpired: 0
    };
    
    this.loadSessions();
    console.log('🚀 Free LinkedIn Client initialized (no proxies needed)');
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
    const session = new FreeLinkedInSession();
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
    const cookieHeader = Object.entries(session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return {
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'accept-language': session.acceptLanguage,
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'csrf-token': session.sessionId.toString(),
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
      'sec-fetch-site': 'same-origin'
    };
  }

  async makeRequest(url, profileId, requestType = 'profile_views', retryCount = 0) {
    const maxRetries = 2;
    
    // Get or create session
    if (!this.currentSession || this.currentSession.isExpired()) {
      this.currentSession = this.getActiveSession();
      console.log(`🔄 Using session: ${this.currentSession.id} (requests: ${this.currentSession.requestCount})`);
    }

    // Smart delay
    const delay = Math.floor(Math.random() * 
      (REQUEST_PATTERNS.delays.max - REQUEST_PATTERNS.delays.min + 1)) + 
      REQUEST_PATTERNS.delays.min;
    
    console.log(`⏳ Waiting ${delay/1000}s before request (smart pattern)`);
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
          
          if (retryCount < maxRetries) {
            console.log(`⚠️ Session blocked, trying new session...`);
            this.currentSession = null;
            await new Promise(resolve => setTimeout(resolve, 10000));
            return this.makeRequest(url, profileId, requestType, retryCount + 1);
          }
        }
        
        this.stats.failedRequests++;
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
      
      // Smart delay between requests
      const interRequestDelay = Math.floor(Math.random() * 
        (REQUEST_PATTERNS.delays.betweenProfiles[1] - REQUEST_PATTERNS.delays.betweenProfiles[0] + 1)) + 
        REQUEST_PATTERNS.delays.betweenProfiles[0];
      
      console.log(`⏳ Waiting ${interRequestDelay/1000}s between requests`);
      await new Promise(resolve => setTimeout(resolve, interRequestDelay));

      // Get contact info (optional, more risky)
      let contactInfoData = null;
      try {
        // Only try contact info 30% of the time to reduce risk
        if (Math.random() < 0.3) {
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
let freeLinkedInClient = null;

// Initialize function
async function initializeFreeLinkedInClient() {
  freeLinkedInClient = new FreeLinkedInClient();
  await freeLinkedInClient.refreshSessions(10); // Create 10 initial sessions
  return freeLinkedInClient;
}

// Export functions
async function fetchLinkedInProfile(profileId) {
  if (!freeLinkedInClient) {
    throw new Error('LinkedIn client not initialized. Call initializeFreeLinkedInClient() first.');
  }
  return freeLinkedInClient.fetchLinkedInProfile(profileId);
}

function getStats() {
  if (!freeLinkedInClient) {
    return { error: 'Client not initialized' };
  }
  return freeLinkedInClient.getStats();
}

async function refreshSessions() {
  if (!freeLinkedInClient) {
    throw new Error('LinkedIn client not initialized');
  }
  return freeLinkedInClient.refreshSessions();
}

module.exports = {
  FreeLinkedInClient,
  initializeFreeLinkedInClient,
  fetchLinkedInProfile,
  getStats,
  refreshSessions
}; 