const crypto = require('crypto');

// User agent rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

// Random delay
function getRandomDelay(min = 3000, max = 8000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Get random user agent
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Generate session ID
function generateSessionId() {
  return `"ajax:${crypto.randomInt(1000000000000000000, 9999999999999999999)}"`;
}

// Enhanced headers
function getHeaders(csrf, cookieObj, profileId) {
  const cookieHeader = Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  return {
    "accept": "application/vnd.linkedin.normalized+json+2.1",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "cache-control": "no-cache",
    "csrf-token": csrf,
    "cookie": cookieHeader,
    "dnt": "1",
    "pragma": "no-cache",
    "referer": `https://www.linkedin.com/in/${profileId}/`,
    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": getRandomUserAgent(),
    "x-li-lang": "en_US",
    "x-li-page-instance": `urn:li:page:d_flagship3_profile_view_base;${crypto.randomUUID()}`,
    "x-restli-protocol-version": "2.0.0"
  };
}

// Simple request queue to control timing
class SimpleQueue {
  constructor() {
    this.lastRequest = 0;
    this.minDelay = 8000; // 8 second minimum between requests
  }

  async add(requestFn) {
    // Ensure minimum delay between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    
    if (timeSinceLastRequest < this.minDelay) {
      const waitTime = this.minDelay - timeSinceLastRequest;
      console.log(`⏳ Waiting ${waitTime/1000}s before next LinkedIn request...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Add random jitter (1-3 seconds)
    const jitter = getRandomDelay(1000, 3000);
    await new Promise(resolve => setTimeout(resolve, jitter));
    
    this.lastRequest = Date.now();
    return await requestFn();
  }
}

// Global queue instance
const requestQueue = new SimpleQueue();

// Retry with backoff
async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Check for rate limiting
      if (error.message.includes('429') || error.message.includes('403')) {
        const backoffDelay = 5000 * Math.pow(2, attempt - 1) + Math.random() * 5000;
        console.log(`⚠️ Rate limited, waiting ${backoffDelay/1000}s before retry ${attempt + 1}...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      } else {
        throw error;
      }
    }
  }
}

// Main fetch function
async function fetchLinkedInProfile(profileId, customCookies = null) {
  return requestQueue.add(async () => {
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;
    
    // Setup cookies
    const cookies = {
      JSESSIONID: customCookies?.jsession || generateSessionId(),
      li_at: customCookies?.li_at || "YOUR_LI_AT_TOKEN_HERE",
      "liap": "true",
      "timezone": "America/Los_Angeles",
      "lang": "v=2&lang=en-us"
    };
    
    const csrfToken = cookies.JSESSIONID.replace(/"/g, "");
    const headers = getHeaders(csrfToken, cookies, profileId);
    
    return withRetry(async () => {
      try {
        console.log(`🔍 Fetching LinkedIn profile: ${profileId}`);
        
        // Fetch profile view
        const profileViewResponse = await fetch(profileViewUrl, {
          headers,
          credentials: "include"
        });

        if (!profileViewResponse.ok) {
          if (profileViewResponse.status === 429) {
            throw new Error(`Rate limited: ${profileViewResponse.status}`);
          }
          if (profileViewResponse.status === 403) {
            throw new Error(`Access forbidden - possible bot detection: ${profileViewResponse.status}`);
          }
          throw new Error(`Profile fetch error: ${profileViewResponse.status}`);
        }

        // Random delay between requests to same profile
        await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 4000)));

        // Fetch contact info
        const contactInfoResponse = await fetch(contactInfoUrl, {
          headers: {
            ...headers,
            "referer": `https://www.linkedin.com/in/${profileId}/overlay/contact-info/`
          },
          credentials: "include"
        });

        let contactInfoData = null;
        if (contactInfoResponse.ok) {
          contactInfoData = await contactInfoResponse.json();
        } else {
          console.warn(`⚠️ Contact info failed for ${profileId}: ${contactInfoResponse.status}`);
        }

        const profileViewData = await profileViewResponse.json();
        
        const result = {
          profileView: profileViewData,
          contactInfo: contactInfoData,
          combined: {
            ...profileViewData,
            contactInfo: contactInfoData
          }
        };
        
        console.log(`✅ Successfully fetched: ${profileId}`);
        return result;
        
      } catch (error) {
        console.error(`❌ Error fetching ${profileId}:`, error.message);
        throw error;
      }
    });
  });
}

module.exports = {
  fetchLinkedInProfile,
  generateSessionId
};