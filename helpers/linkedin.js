// Enhanced LinkedIn scraping with bot detection avoidance
const https = require('https');
const crypto = require('crypto');

// User agent rotation pool
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// Random delay generator
function getRandomDelay(min = 3000, max = 8000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Get random user agent
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Generate realistic session ID
function generateSessionId() {
  return `"ajax:${crypto.randomInt(1000000000000000000, 9999999999999999999)}"`;
}

// Enhanced headers with more realistic browser fingerprinting
function getEnhancedHeaders(csrf, cookieObj, profileId) {
  const cookieHeader = Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const userAgent = getRandomUserAgent();
  
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
    "user-agent": userAgent,
    "x-li-lang": "en_US",
    "x-li-page-instance": `urn:li:page:d_flagship3_profile_view_base;${crypto.randomUUID()}`,
    "x-li-track": JSON.stringify({
      "clientVersion": "1.13.1043",
      "mpVersion": "1.13.1043",
      "osName": "web",
      "timezoneOffset": -480,
      "timezone": "America/Los_Angeles"
    }),
    "x-restli-protocol-version": "2.0.0"
  };
}

// Request queue manager to control concurrency
class RequestQueue {
  constructor(maxConcurrent = 2, minDelay = 5000, maxDelay = 12000) {
    this.queue = [];
    this.running = [];
    this.maxConcurrent = maxConcurrent;
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.lastRequest = 0;
  }

  async add(requestFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ requestFn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running.length >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const { requestFn, resolve, reject } = this.queue.shift();
    
    // Ensure minimum delay between requests
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequest;
    const minWait = this.minDelay;
    
    if (timeSinceLastRequest < minWait) {
      await new Promise(resolve => setTimeout(resolve, minWait - timeSinceLastRequest));
    }

    const requestPromise = this.executeRequest(requestFn)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        const index = this.running.indexOf(requestPromise);
        if (index > -1) {
          this.running.splice(index, 1);
        }
        this.process(); // Process next item in queue
      });

    this.running.push(requestPromise);
    this.lastRequest = Date.now();
  }

  async executeRequest(requestFn) {
    // Add random jitter
    const jitter = getRandomDelay(1000, 3000);
    await new Promise(resolve => setTimeout(resolve, jitter));
    
    return await requestFn();
  }
}

// Create global queue instance
const requestQueue = new RequestQueue(2, 8000, 15000); // Max 2 concurrent, 8-15s delays

// Retry mechanism with exponential backoff
async function withRetry(fn, maxRetries = 3, baseDelay = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Check if it's a rate limit or bot detection error
      if (error.message.includes('429') || error.message.includes('403')) {
        const backoffDelay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 5000;
        console.log(`Rate limited, waiting ${backoffDelay/1000}s before retry ${attempt + 1}...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      } else {
        throw error; // Don't retry non-rate-limit errors
      }
    }
  }
}

// Enhanced fetch function with better error handling
async function fetchLinkedInProfile(profileId, customCookies = null) {
  return requestQueue.add(async () => {
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;
    
    // Rotate session IDs periodically to look more natural
    const cookies = {
      JSESSIONID: customCookies?.jsession || generateSessionId(),
      li_at: customCookies?.li_at || "YOUR_LI_AT_TOKEN_HERE",
      // Add more realistic cookies
      "liap": "true",
      "timezone": "America/Los_Angeles",
      "lang": "v=2&lang=en-us"
    };
    
    const csrfToken = cookies.JSESSIONID.replace(/"/g, "");
    const headers = getEnhancedHeaders(csrfToken, cookies, profileId);
    
    return withRetry(async () => {
      try {
        console.log(`🔍 Fetching profile: ${profileId}`);
        
        // Fetch profile view first, then contact info with delay
        const profileViewResponse = await fetch(profileViewUrl, {
          headers,
          credentials: "include",
          // Add connection options to avoid timeouts
          timeout: 30000
        });

        if (!profileViewResponse.ok) {
          if (profileViewResponse.status === 429) {
            throw new Error(`Rate limited: ${profileViewResponse.status}`);
          }
          if (profileViewResponse.status === 403) {
            throw new Error(`Access forbidden - possible bot detection: ${profileViewResponse.status}`);
          }
          throw new Error(`Profile view fetch error: ${profileViewResponse.status}`);
        }

        // Add delay between requests to same profile
        await new Promise(resolve => setTimeout(resolve, getRandomDelay(2000, 4000)));

        const contactInfoResponse = await fetch(contactInfoUrl, {
          headers: {
            ...headers,
            // Slightly different referer for contact info
            "referer": `https://www.linkedin.com/in/${profileId}/overlay/contact-info/`
          },
          credentials: "include",
          timeout: 30000
        });

        let contactInfoData = null;
        if (contactInfoResponse.ok) {
          contactInfoData = await contactInfoResponse.json();
        } else {
          console.warn(`⚠️ Contact info fetch failed for ${profileId}: ${contactInfoResponse.status}`);
        }

        const profileViewData = await profileViewResponse.json();
        
        const combinedResponse = {
          profileView: profileViewData,
          contactInfo: contactInfoData,
          combined: {
            ...profileViewData,
            contactInfo: contactInfoData
          }
        };
        
        console.log(`✅ Successfully fetched profile: ${profileId}`);
        return combinedResponse;
        
      } catch (err) {
        console.error(`❌ Error fetching ${profileId}:`, err.message);
        throw err;
      }
    }, 3, 10000); // 3 retries with 10s base delay
  });
}

module.exports = {
  fetchLinkedInProfile,
};
