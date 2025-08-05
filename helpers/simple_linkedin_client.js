// Simple LinkedIn Client - No Proxies, Direct Requests
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Simple browser simulation
const BROWSER_CONFIG = {
  userAgents: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
  ],
  
  delays: {
    min: 30000,   // 30 seconds
    max: 90000,   // 1.5 minutes
    betweenRequests: [60000, 120000] // 1-2 minutes between requests
  }
};

class SimpleLinkedInClient {
  constructor() {
    this.requestCount = 0;
    this.lastRequest = 0;
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastError: null
    };
    
    console.log('🚀 Simple LinkedIn Client initialized (no proxies)');
  }

  getRandomUserAgent() {
    return BROWSER_CONFIG.userAgents[Math.floor(Math.random() * BROWSER_CONFIG.userAgents.length)];
  }

  generateSessionId() {
    return crypto.randomInt(1e12, 1e13 - 1);
  }

  generateHeaders(profileId) {
    const sessionId = this.generateSessionId();
    
    return {
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'accept-language': 'en-US,en;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'csrf-token': sessionId.toString(),
      'cookie': `JSESSIONID="ajax:${sessionId}"; li_at="AQEDARq${Date.now()}_${crypto.randomBytes(32).toString('base64')}"; liap=true; bcookie="v=2&${crypto.randomUUID()}"; bscookie="v=1&${Date.now()}${crypto.randomUUID().substring(0, 8)}"`,
      'referer': `https://www.linkedin.com/in/${profileId}/`,
      'user-agent': this.getRandomUserAgent(),
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
    
    // Realistic delay
    const delay = Math.floor(Math.random() * 
      (BROWSER_CONFIG.delays.max - BROWSER_CONFIG.delays.min + 1)) + 
      BROWSER_CONFIG.delays.min;
    
    console.log(`⏳ Waiting ${delay/1000}s before request (realistic delay)`);
    await new Promise(resolve => setTimeout(resolve, delay));

    const headers = this.generateHeaders(profileId);
    
    try {
      console.log(`🔍 Making ${requestType} request (attempt ${retryCount + 1}/${maxRetries + 1})`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
        timeout: 30000,
      });

      this.requestCount++;
      this.lastRequest = Date.now();
      this.stats.totalRequests++;

      if (!response.ok) {
        if (response.status === 429 || response.status === 403) {
          // Rate limited or blocked
          this.stats.failedRequests++;
          this.stats.lastError = `HTTP ${response.status}`;
          
          if (retryCount < maxRetries) {
            console.log(`⚠️ Rate limited, waiting longer before retry...`);
            await new Promise(resolve => setTimeout(resolve, 120000)); // 2 minutes
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
      
      return data;

    } catch (error) {
      console.error(`❌ Request failed:`, error.message);
      this.stats.failedRequests++;
      this.stats.lastError = error.message;
      
      if (retryCount < maxRetries) {
        console.log(`🔄 Retrying...`);
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute
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
      
      // Wait between requests
      const interRequestDelay = Math.floor(Math.random() * 
        (BROWSER_CONFIG.delays.betweenRequests[1] - BROWSER_CONFIG.delays.betweenRequests[0] + 1)) + 
        BROWSER_CONFIG.delays.betweenRequests[0];
      
      console.log(`⏳ Waiting ${interRequestDelay/1000}s between requests`);
      await new Promise(resolve => setTimeout(resolve, interRequestDelay));

      // Get contact info (optional, more risky)
      let contactInfoData = null;
      try {
        // Only try contact info 10% of the time to reduce risk
        if (Math.random() < 0.1) {
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
      requestCount: this.requestCount,
      successRate: this.stats.totalRequests > 0 ? 
        Math.round((this.stats.successfulRequests / this.stats.totalRequests) * 100) : 0
    };
  }
}

// Global instance
let simpleLinkedInClient = null;

// Initialize function
async function initializeSimpleLinkedInClient() {
  simpleLinkedInClient = new SimpleLinkedInClient();
  return simpleLinkedInClient;
}

// Export functions
async function fetchLinkedInProfile(profileId) {
  if (!simpleLinkedInClient) {
    throw new Error('Simple LinkedIn client not initialized. Call initializeSimpleLinkedInClient() first.');
  }
  return simpleLinkedInClient.fetchLinkedInProfile(profileId);
}

function getStats() {
  if (!simpleLinkedInClient) {
    return { error: 'Client not initialized' };
  }
  return simpleLinkedInClient.getStats();
}

module.exports = {
  SimpleLinkedInClient,
  initializeSimpleLinkedInClient,
  fetchLinkedInProfile,
  getStats
}; 