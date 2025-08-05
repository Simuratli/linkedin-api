// Enhanced LinkedIn Client with Better Error Handling and Debugging
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Add detailed logging for debugging
const DEBUG_MODE = process.env.DEBUG_LINKEDIN === 'true';

const debugLog = (...args) => {
  if (DEBUG_MODE) {
    console.log('[DEBUG]', ...args);
  }
};

// Enhanced request function with better error handling
async function makeRequest(url, headers, requestType = 'profile_views') {
  // Rate limiting kontrolü
  const permission = await this.rateLimit.shouldAllowRequest(requestType);
  
  if (!permission.allowed) {
    throw new Error(`Rate limit exceeded`);
  }

  // Proxy rotation kontrolü
  if (!this.currentProxy || this.requestCount >= DAILY_LIMITS.proxy_rotation_after) {
    this.rotateProxy();
  }

  // Uzun gecikme (free proxy'ler için kritik)
  const delay = permission.recommendedDelay;
  console.log(`⏳ Waiting ${delay/1000}s before request (conservative approach)`);
  await new Promise(resolve => setTimeout(resolve, delay));

  const proxyAgent = new HttpsProxyAgent(this.currentProxy.url);

  try {
    console.log(`🔍 Making ${requestType} request via free proxy`);
    debugLog('Request URL:', url);
    debugLog('Request Headers:', JSON.stringify(headers, null, 2));
    
    const response = await fetch(url, {
      method: 'GET',
      headers,
      agent: proxyAgent,
      timeout: DAILY_LIMITS.request_timeout,
    });

    this.requestCount++;
    this.rateLimit.incrementCounter(requestType);

    debugLog('Response Status:', response.status);
    debugLog('Response Headers:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

    if (!response.ok) {
      // Get response body for better error debugging
      let errorBody = '';
      try {
        errorBody = await response.text();
        debugLog('Error Response Body:', errorBody);
      } catch (e) {
        debugLog('Could not read error response body');
      }

      this.proxyManager.recordProxyResult(this.currentProxy, false, response.status.toString());
      
      // Enhanced error handling based on status codes
      if (response.status === 400) {
        throw new Error(`Bad Request (400): ${errorBody || 'Invalid request format or parameters'}`);
      } else if (response.status === 401) {
        throw new Error(`Unauthorized (401): ${errorBody || 'Invalid or expired authentication'}`);
      } else if (response.status === 403) {
        throw new Error(`Forbidden (403): ${errorBody || 'Access denied or rate limited'}`);
      } else if (response.status === 404) {
        throw new Error(`Not Found (404): ${errorBody || 'Profile not found or URL invalid'}`);
      } else if (response.status === 429) {
        throw new Error(`Rate Limited (429): ${errorBody || 'Too many requests'}`);
      } else {
        throw new Error(`Request failed (${response.status}): ${errorBody || 'Unknown error'}`);
      }
    }

    // Başarılı istek
    this.proxyManager.recordProxyResult(this.currentProxy, true);
    
    const contentType = response.headers.get('content-type');
    debugLog('Response Content-Type:', contentType);
    
    let data;
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
      debugLog('Response Data Keys:', Object.keys(data));
    } else {
      const textData = await response.text();
      debugLog('Response Text Length:', textData.length);
      debugLog('Response Text Preview:', textData.substring(0, 200));
      throw new Error(`Unexpected content type: ${contentType}. Expected JSON response.`);
    }
    
    console.log(`✅ Successful ${requestType} request`);
    return data;

  } catch (error) {
    console.error(`❌ Request failed:`, error.message);
    this.proxyManager.recordProxyResult(this.currentProxy, false, 'network_error');
    throw error;
  }
}

// Enhanced profile fetch with better URL validation and error handling
async function fetchLinkedInProfile(profileId, customCookies = null) {
  if (!this.currentProxy) {
    this.rotateProxy();
  }

  // Validate profileId
  if (!profileId || typeof profileId !== 'string') {
    throw new Error(`Invalid profileId: ${profileId}`);
  }

  // Clean profileId (remove any trailing slashes or query params)
  const cleanProfileId = profileId.replace(/[\/\?#].*$/, '').trim();
  
  if (!cleanProfileId) {
    throw new Error(`Empty profileId after cleaning: ${profileId}`);
  }

  debugLog('Original profileId:', profileId);
  debugLog('Cleaned profileId:', cleanProfileId);

  const fingerprint = this.generateFingerprint();
  
  // Use more standard LinkedIn API endpoints
  const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${cleanProfileId}/profileView`;
  const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${cleanProfileId}/profileContactInfo`;

  debugLog('Profile View URL:', profileViewUrl);
  debugLog('Contact Info URL:', contactInfoUrl);

  // Enhanced cookie handling
  const defaultCookies = {
    JSESSIONID: fingerprint.sessionId,
    li_at: 'DEFAULT_LI_AT_TOKEN', // This should be replaced with actual token
    liap: 'true',
    bcookie: fingerprint.bcookie,
    bscookie: fingerprint.bscookie,
  };

  // Merge with custom cookies, giving priority to custom ones
  const cookies = {
    ...defaultCookies,
    ...(customCookies || {})
  };

  debugLog('Using cookies:', Object.keys(cookies));

  // Validate required cookies
  if (!cookies.li_at || cookies.li_at === 'DEFAULT_LI_AT_TOKEN') {
    throw new Error('Missing or invalid li_at cookie. Please provide valid LinkedIn authentication token.');
  }

  const csrfToken = fingerprint.sessionId.replace(/"/g, '');

  try {
    // Ana profil verisini al
    const profileHeaders = this.generateHeaders(csrfToken, cookies, cleanProfileId, fingerprint);
    debugLog('Profile request headers:', JSON.stringify(profileHeaders, null, 2));
    
    const profileData = await this.makeRequest(profileViewUrl, profileHeaders, 'profile_views');

    // Validate profile data structure
    if (!profileData) {
      throw new Error('No profile data returned from LinkedIn API');
    }

    debugLog('Profile data structure:', {
      hasData: !!profileData,
      keys: Object.keys(profileData),
      dataType: typeof profileData
    });

    // İki istek arası uzun gecikme
    const interRequestDelay = Math.floor(Math.random() * 20000) + 15000; // 15-35 saniye
    console.log(`⏳ Waiting ${interRequestDelay/1000}s between profile and contact requests`);
    await new Promise(resolve => setTimeout(resolve, interRequestDelay));

    // Contact info'yu al (çok sınırlı)
    let contactInfoData = null;
    try {
      // Contact info'yu sadece %30 olasılıkla dene (çok riskli)
      if (Math.random() < 0.3) {
        const contactHeaders = this.generateHeaders(csrfToken, cookies, cleanProfileId, fingerprint);
        contactInfoData = await this.makeRequest(contactInfoUrl, contactHeaders, 'contact_info');
        debugLog('Contact info data:', contactInfoData ? 'received' : 'null');
      } else {
        console.log('📊 Skipping contact info to reduce risk');
      }
    } catch (contactError) {
      console.warn(`⚠️ Contact info failed for ${cleanProfileId}:`, contactError.message);
      // Don't throw error for contact info failure, just log it
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
    console.error(`❌ Profile fetch failed for ${cleanProfileId}:`, error.message);
    
    // Enhanced error context
    if (error.message.includes('400')) {
      console.error('💡 400 Error Debugging:');
      console.error('   - Check if profileId is valid:', cleanProfileId);
      console.error('   - Verify li_at cookie is not expired');
      console.error('   - Check if LinkedIn API endpoint is correct');
      console.error('   - Verify request headers format');
    }
    
    throw error;
  }
}

// Enhanced header generation with better validation
function generateHeaders(csrf, cookies, profileId, fingerprint) {
  // Validate required parameters
  if (!csrf) {
    throw new Error('CSRF token is required for LinkedIn API requests');
  }
  
  if (!cookies || !cookies.li_at) {
    throw new Error('li_at cookie is required for LinkedIn API requests');
  }

  const cookieHeader = Object.entries(cookies)
    .filter(([k, v]) => v && v !== 'undefined') // Filter out undefined values
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  debugLog('Generated cookie header length:', cookieHeader.length);

  const headers = {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': fingerprint.acceptLanguage || 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    'csrf-token': csrf,
    'cookie': cookieHeader,
    'referer': `https://www.linkedin.com/in/${profileId}/`,
    'user-agent': fingerprint.userAgent,
    'x-li-lang': 'en_US',
    'x-restli-protocol-version': '2.0.0',
    'x-requested-with': 'XMLHttpRequest', // This might be important for some requests
  };

  // Validate essential headers
  if (!headers.cookie.includes('li_at=')) {
    throw new Error('li_at cookie not found in generated headers');
  }

  return headers;
}

// Enhanced fingerprint generation
function generateFingerprint() {
  const sessionId = generateSessionId();
  
  return {
    sessionId: sessionId,
    userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    acceptLanguage: 'en-US,en;q=0.9,tr;q=0.8', // Add more language variety
    bcookie: `"v=2&${crypto.randomUUID()}"`,
    bscookie: `"v=1&${Date.now()}${crypto.randomUUID().substring(0, 8)}"`,
    timestamp: Date.now()
  };
}

// Enhanced session ID generation
function generateSessionId() {
  const timestamp = Date.now();
  const random = Math.floor(Math.random() * 1000000);
  return `"ajax:${timestamp}${random.toString().padStart(6, '0')}"`;
}

// Test function for debugging
async function testLinkedInConnection(profileId = 'simuratli', customCookies = null) {
  console.log('🧪 Testing LinkedIn connection...');
  
  if (!linkedInClient) {
    throw new Error('LinkedIn client not initialized');
  }

  try {
    // Test basic proxy connectivity first
    const proxyStats = linkedInClient.proxyManager.getStats();
    console.log('📊 Proxy stats:', proxyStats);

    if (proxyStats.workingProxies === 0) {
      throw new Error('No working proxies available');
    }

    // Test LinkedIn profile fetch
    const result = await linkedInClient.fetchLinkedInProfile(profileId, customCookies);
    
    console.log('✅ LinkedIn connection test successful');
    console.log('📊 Response structure:', {
      hasProfileView: !!result.profileView,
      hasContactInfo: !!result.contactInfo,
      hasCombined: !!result.combined,
      profileViewKeys: result.profileView ? Object.keys(result.profileView).length : 0
    });

    return result;
    
  } catch (error) {
    console.error('❌ LinkedIn connection test failed:', error.message);
    
    // Provide debugging suggestions
    console.error('💡 Debugging suggestions:');
    console.error('   1. Check if li_at cookie is valid and not expired');
    console.error('   2. Verify proxy connectivity');
    console.error('   3. Check if profile ID is correct and accessible');
    console.error('   4. Review LinkedIn API rate limits');
    
    throw error;
  }
}

// Export the enhanced functions
module.exports = {
  // ... existing exports
  testLinkedInConnection,
  debugLog,
  
  // Enhanced functions (these would replace the existing ones in your linkedin.js)
  makeRequest: makeRequest.bind(FreeProxyLinkedInClient.prototype),
  fetchLinkedInProfile: fetchLinkedInProfile.bind(FreeProxyLinkedInClient.prototype),
  generateHeaders: generateHeaders,
  generateFingerprint: generateFingerprint,
  generateSessionId: generateSessionId
};