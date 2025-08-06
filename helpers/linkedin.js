const crypto = require('crypto');
const fetch = require('node-fetch');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedIn/9.1.1',
  'LinkedIn/9.1.1 (iPhone; iOS 15.6; Scale/3.00)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// Enhanced human-like delay patterns
function getRandomDelay(min = 3000, max = 8000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getHumanReadingDelay() {
  // Simulate human reading time - 15-45 seconds
  return Math.floor(Math.random() * 30000) + 15000;
}

function getPageNavigationDelay() {
  // Time between clicking profile and loading contact info
  return Math.floor(Math.random() * 5000) + 2000;
}

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function generateSessionId() {
  return `"ajax:${crypto.randomInt(1e18, 1e19 - 1)}`;
}

function getHeaders(csrf, cookieObj, profileId) {
  const cookieHeader = Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
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
    'user-agent': getRandomUserAgent(),
    'x-li-lang': 'en_US',
    'x-li-page-instance': `urn:li:page:d_flagship3_profile_view_base;${crypto.randomUUID()}`,
    'x-restli-protocol-version': '2.0.0'
  };
}

class SimpleQueue {
  constructor() {
    this.lastRequest = 0;
    this.minDelay = 120000; // 2 minutes minimum (was 8 seconds)
    this.requestCount = 0;
    this.hourStart = Date.now();
  }

  async add(requestFn) {
    const now = Date.now();
    
    // Reset hourly counter
    if (now - this.hourStart > 3600000) { // 1 hour
      this.requestCount = 0;
      this.hourStart = now;
    }

    // Check hourly rate limit
    if (this.requestCount >= 15) {
      const waitUntilNextHour = 3600000 - (now - this.hourStart);
      if (waitUntilNextHour > 0) {
        console.log(`⏳ Hourly rate limit reached. Waiting ${Math.round(waitUntilNextHour / 1000 / 60)} minutes...`);
        await new Promise(resolve => setTimeout(resolve, waitUntilNextHour));
        this.requestCount = 0;
        this.hourStart = Date.now();
      }
    }

    const timeSinceLastRequest = now - this.lastRequest;

    if (timeSinceLastRequest < this.minDelay) {
      const waitTime = this.minDelay - timeSinceLastRequest;
      console.log(`⏳ Rate limiting: waiting ${Math.round(waitTime / 1000)} seconds before LinkedIn request...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    // Add human-like jitter (30s - 3min additional delay)
    const jitter = getRandomDelay(30000, 180000);
    console.log(`😴 Human behavior: additional ${Math.round(jitter / 1000)} second pause...`);
    await new Promise(resolve => setTimeout(resolve, jitter));

    this.lastRequest = Date.now();
    this.requestCount++;
    
    console.log(`📊 Request ${this.requestCount}/15 this hour`);
    
    return await requestFn();
  }
}

const requestQueue = new SimpleQueue();

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      if (error.message.includes('429') || error.message.includes('403')) {
        // Exponential backoff with human-like randomness
        const baseDelay = 15000 * Math.pow(2, attempt - 1); // Start with 15 seconds
        const jitter = Math.random() * baseDelay * 0.5; // Add up to 50% jitter
        const backoffDelay = baseDelay + jitter;
        
        console.log(`⚠️ Rate limited (attempt ${attempt}), waiting ${Math.round(backoffDelay / 1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      } else {
        // For other errors, shorter delay
        const errorDelay = getRandomDelay(5000, 15000);
        console.log(`❌ Error on attempt ${attempt}, retrying in ${Math.round(errorDelay / 1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, errorDelay));
      }
    }
  }
}

// Simulate human browsing patterns
async function simulateHumanBrowsing() {
  const actions = [
    { name: 'scroll', delay: getRandomDelay(500, 2000) },
    { name: 'pause', delay: getRandomDelay(1000, 4000) },
    { name: 'read', delay: getHumanReadingDelay() }
  ];
  
  const randomAction = actions[Math.floor(Math.random() * actions.length)];
  console.log(`🤖 Simulating human ${randomAction.name} for ${Math.round(randomAction.delay / 1000)}s...`);
  await new Promise(resolve => setTimeout(resolve, randomAction.delay));
}

async function fetchLinkedInProfile(profileId, customCookies = null) {
  return requestQueue.add(async () => {
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;

    const cookies = {
      JSESSIONID: customCookies?.jsession || generateSessionId(),
      li_at: customCookies?.li_at || 'YOUR_LI_AT_TOKEN_HERE',
      liap: 'true',
      timezone: 'America/Los_Angeles',
      lang: 'v=2&lang=en-us'
    };

    const csrfToken = cookies.JSESSIONID.replace(/"/g, '');
    const headers = getHeaders(csrfToken, cookies, profileId);

    return withRetry(async () => {
      try {
        console.log(`🔍 Fetching LinkedIn profile: ${profileId}`);

        // Simulate human behavior - browsing to profile first
        await simulateHumanBrowsing();

        const profileViewResponse = await fetch(profileViewUrl, {
          headers,
          credentials: 'include'
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

        // Human-like pause before requesting contact info
        const navigationDelay = getPageNavigationDelay();
        console.log(`🧑‍💻 Human navigation pause: ${Math.round(navigationDelay / 1000)}s before contact info...`);
        await new Promise(resolve => setTimeout(resolve, navigationDelay));

        const contactInfoResponse = await fetch(contactInfoUrl, {
          headers: {
            ...headers,
            referer: `https://www.linkedin.com/in/${profileId}/overlay/contact-info/`
          },
          credentials: 'include'
        });

        let contactInfoData = null;
        if (contactInfoResponse.ok) {
          contactInfoData = await contactInfoResponse.json();
        } else {
          console.warn(`⚠️ Contact info failed for ${profileId}: ${contactInfoResponse.status}`);
        }

        const profileViewData = await profileViewResponse.json();

        // Final human pause - simulate reading the data
        await simulateHumanBrowsing();

        return {
          profileView: profileViewData,
          contactInfo: contactInfoData,
          combined: {
            ...profileViewData,
            contactInfo: contactInfoData
          }
        };

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