// Enhanced LinkedIn Client with Advanced Proxy Management and Anti-Detection
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const AbortController = require('abort-controller');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// File paths for persistent storage
const DATA_DIR = path.join(__dirname, '../data');
const RATE_LIMIT_FILE = path.join(DATA_DIR, 'daily_rate_limits.json');
const PROXY_STATS_FILE = path.join(DATA_DIR, 'proxy_stats.json');
const WORKING_PROXIES_FILE = path.join(DATA_DIR, 'working_proxies.json');
const SESSION_FILE = path.join(DATA_DIR, 'session_data.json');

// Enhanced limits for high-volume requests (10k+ support)
const DAILY_LIMITS = {
  profile_views: 15000,
  contact_info: 3000,
  search_queries: 8000,
  max_requests_per_hour: 800,
  max_burst_requests: 15,
  proxy_rotation_after: 20,
  proxy_test_timeout: 6000,
  request_timeout: 20000,
  min_delay_between: 500,
  max_delay_between: 2000,
  max_retries: 7,
  proxy_health_threshold: 0.6,
  concurrent_requests: 8,
  proxy_refresh_interval: 300000 // 5 minutes
};

// Your working proxy list (simple text format)
const PROXY_LIST_URL = 'https://raw.githubusercontent.com/Simuratli/linkedin-api/refs/heads/master/proxies.txt';

// Enhanced User-Agent rotation with mobile and desktop variants
const USER_AGENTS = [
  // Chrome Desktop
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  
  // Firefox Desktop
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
  
  // Safari Desktop
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
  
  // Mobile variants for better stealth
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPad; CPU OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
];

// LinkedIn-specific headers for better stealth
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

// Ensure data directory exists
const ensureDataDir = async () => {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (error) {
    // Directory already exists
  }
};

// Enhanced timeout fetch with better error handling
class TimeoutFetch {
  static async fetchWithTimeout(url, options = {}, timeoutMs = DAILY_LIMITS.request_timeout) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, { 
        ...options, 
        signal: controller.signal,
        timeout: timeoutMs
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
  }
}

// Advanced Proxy Manager with health monitoring
class AdvancedProxyManager {
  constructor() {
    this.proxies = [];
    this.workingProxies = [];
    this.deadProxies = new Set();
    this.proxyStats = new Map();
    this.currentProxyIndex = 0;
    this.lastProxyFetch = 0;
    this.isRefreshing = false;
    this.proxyPool = {
      http: [],
      https: [],
      socks4: [],
      socks5: []
    };
  }

  // Get random user agent for stealth
  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  // Generate random headers for better stealth
  generateRandomHeaders(customHeaders = {}) {
    const baseHeaders = {
      'User-Agent': this.getRandomUserAgent(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'DNT': '1',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      ...customHeaders
    };

    return baseHeaders;
  }

  // Fetch proxies from your simple text-based proxy list
  async fetchProxiesFromAPI() {
    try {
      console.log('🔄 Fetching proxies from text list...');
      const response = await TimeoutFetch.fetchWithTimeout(PROXY_LIST_URL, {
        headers: this.generateRandomHeaders(),
        method: 'GET'
      }, 15000);

      if (!response.ok) {
        throw new Error(`Proxy list responded with status: ${response.status}`);
      }

      const textData = await response.text();
      const lines = textData.split('\n').filter(line => line.trim());
      
      console.log(`📊 Found ${lines.length} proxy entries in text file`);

      const newProxies = [];
      lines.forEach((line, index) => {
        try {
          const trimmedLine = line.trim();
          if (!trimmedLine) return;
          
          // Parse IP:PORT format
          const match = trimmedLine.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})$/);
          if (match) {
            const [, ip, port] = match;
            const proxyUrl = `http://${ip}:${port}`;
            
            newProxies.push({
              url: proxyUrl,
              protocol: 'http',
              ip: ip,
              port: parseInt(port),
              country: 'unknown',
              countryCode: 'unknown',
              city: 'unknown',
              anonymity: 'unknown',
              uptime: 95, // Assume good uptime since it's in your curated list
              averageTimeout: 1000, // Assume reasonable timeout
              isAlive: true,
              lastTested: null,
              successCount: 0,
              failureCount: 0,
              responseTime: null,
              isWorking: null,
              // Give higher priority to your curated list
              priority: Math.max(100 - index, 1), // Higher priority for proxies listed first
              source: 'curated_list'
            });
          } else {
            console.warn(`⚠️ Invalid proxy format: ${trimmedLine}`);
          }
        } catch (e) {
          console.warn(`⚠️ Error parsing proxy line: ${line} - ${e.message}`);
        }
      });

      // Sort by priority (first proxies in your list get higher priority)
      const sortedProxies = newProxies.sort((a, b) => b.priority - a.priority);

      console.log(`✅ Successfully parsed ${sortedProxies.length} proxies from curated list`);
      return sortedProxies;

    } catch (error) {
      console.error('❌ Failed to fetch proxies from text list:', error.message);
      return [];
    }
  }

  // Test individual proxy with enhanced validation
  async testProxy(proxy, testUrl = 'http://httpbin.org/ip') {
    const startTime = Date.now();
    
    try {
      let agent;
      if (proxy.protocol === 'http' || proxy.protocol === 'https') {
        agent = new HttpsProxyAgent(proxy.url);
      } else if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
        agent = new SocksProxyAgent(proxy.url);
      } else {
        throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
      }

      const response = await TimeoutFetch.fetchWithTimeout(testUrl, {
        agent,
        headers: this.generateRandomHeaders(),
        method: 'GET'
      }, DAILY_LIMITS.proxy_test_timeout);

      const responseTime = Date.now() - startTime;

      if (response.ok) {
        const result = await response.json();
        proxy.responseTime = responseTime;
        proxy.lastTested = Date.now();
        proxy.successCount++;
        proxy.isWorking = true;
        
        // Update proxy stats
        const stats = this.proxyStats.get(proxy.url) || { success: 0, failure: 0, avgResponseTime: 0 };
        stats.success++;
        stats.avgResponseTime = (stats.avgResponseTime + responseTime) / 2;
        this.proxyStats.set(proxy.url, stats);
        
        return true;
      } else {
        throw new Error(`Test failed with status: ${response.status}`);
      }

    } catch (error) {
      proxy.failureCount++;
      proxy.isWorking = false;
      proxy.lastTested = Date.now();
      
      // Update failure stats
      const stats = this.proxyStats.get(proxy.url) || { success: 0, failure: 0, avgResponseTime: 0 };
      stats.failure++;
      this.proxyStats.set(proxy.url, stats);
      
      return false;
    }
  }

  // Test proxies in batches for better performance
  async testProxiesBatch(proxies, batchSize = 20) {
    const workingProxies = [];
    
    for (let i = 0; i < proxies.length; i += batchSize) {
      const batch = proxies.slice(i, i + batchSize);
      console.log(`🧪 Testing proxy batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(proxies.length/batchSize)} (${batch.length} proxies)`);
      
      const testPromises = batch.map(proxy => this.testProxy(proxy));
      const results = await Promise.allSettled(testPromises);
      
      results.forEach((result, index) => {
        const proxy = batch[index];
        if (result.status === 'fulfilled' && result.value === true) {
          workingProxies.push(proxy);
        }
      });
      
      // Small delay between batches to avoid overwhelming the test endpoints
      if (i + batchSize < proxies.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    return workingProxies;
  }

  // Refresh proxy pool with health monitoring
  async refreshProxyPool(forceRefresh = false) {
    const now = Date.now();
    
    if (this.isRefreshing) {
      console.log('⏳ Proxy refresh already in progress...');
      return;
    }

    if (!forceRefresh && 
        this.workingProxies.length > 50 && 
        (now - this.lastProxyFetch) < DAILY_LIMITS.proxy_refresh_interval) {
      console.log(`✅ Using cached proxies (${this.workingProxies.length} available)`);
      return;
    }

    this.isRefreshing = true;
    
    try {
      console.log('🔄 Starting proxy pool refresh...');
      
      // Fetch new proxies from API
      const newProxies = await this.fetchProxiesFromAPI();
      
      if (newProxies.length === 0) {
        console.warn('⚠️ No proxies fetched from API');
        this.isRefreshing = false;
        return;
      }

      // Test proxies in batches
      console.log(`🧪 Testing ${newProxies.length} proxies...`);
      const workingProxies = await this.testProxiesBatch(newProxies);
      
      // Organize proxies by protocol
      this.proxyPool = { http: [], https: [], socks4: [], socks5: [] };
      workingProxies.forEach(proxy => {
        if (this.proxyPool[proxy.protocol]) {
          this.proxyPool[proxy.protocol].push(proxy);
        }
      });

      // Update working proxies list
      this.proxies = newProxies;
      this.workingProxies = workingProxies;
      this.lastProxyFetch = now;
      
      // Save working proxies to file
      await this.saveProxyStats();
      
      console.log(`✅ Proxy refresh completed:`);
      console.log(`   - Total tested: ${this.proxies.length}`);
      console.log(`   - Working proxies: ${this.workingProxies.length}`);
      console.log(`   - Success rate: ${((this.workingProxies.length/this.proxies.length) * 100).toFixed(1)}%`);
      console.log(`   - HTTP: ${this.proxyPool.http.length}`);
      console.log(`   - HTTPS: ${this.proxyPool.https.length}`);
      console.log(`   - SOCKS4: ${this.proxyPool.socks4.length}`);
      console.log(`   - SOCKS5: ${this.proxyPool.socks5.length}`);

    } catch (error) {
      console.error('❌ Proxy refresh failed:', error.message);
    } finally {
      this.isRefreshing = false;
    }
  }

  // Get best proxy based on performance metrics and list priority
  getBestProxy(protocol = 'http') {
    let availableProxies = this.workingProxies;
    
    // Filter by protocol if specified
    if (protocol && this.proxyPool[protocol]) {
      availableProxies = this.proxyPool[protocol];
    }
    
    if (availableProxies.length === 0) {
      throw new Error(`No working proxies available for protocol: ${protocol}`);
    }

    // Enhanced sorting based on curated list priority + performance data
    const sortedProxies = availableProxies.sort((a, b) => {
      const aStats = this.proxyStats.get(a.url) || { success: 0, failure: 1, avgResponseTime: 5000 };
      const bStats = this.proxyStats.get(b.url) || { success: 0, failure: 1, avgResponseTime: 5000 };
      
      // Calculate performance score
      const aSuccessRate = aStats.success / (aStats.success + aStats.failure);
      const bSuccessRate = bStats.success / (bStats.success + bStats.failure);
      
      // Combine list priority with our performance data
      const aScore = (
        (a.priority || 50) * 0.4 +              // List priority (40% weight)
        (aSuccessRate * 100) * 0.4 +            // Our success rate (40% weight)  
        ((3000 - (aStats.avgResponseTime || 3000)) / 30) * 0.2  // Response time (20% weight)
      );
      
      const bScore = (
        (b.priority || 50) * 0.4 +
        (bSuccessRate * 100) * 0.4 +
        ((3000 - (bStats.avgResponseTime || 3000)) / 30) * 0.2
      );
      
      return bScore - aScore;
    });

    // Use weighted round-robin selection from top performers
    const topProxies = sortedProxies.slice(0, Math.min(20, sortedProxies.length));
    
    // Prefer proxies from curated list that are working well
    const curatedProxies = topProxies.filter(p => p.source === 'curated_list');
    const selectionPool = curatedProxies.length > 0 ? curatedProxies : topProxies;
    
    const selectedProxy = selectionPool[this.currentProxyIndex % selectionPool.length];
    this.currentProxyIndex++;
    
    return selectedProxy;
  }

  // Mark proxy as dead and remove from working pool
  markProxyAsDead(proxyUrl) {
    this.deadProxies.add(proxyUrl);
    this.workingProxies = this.workingProxies.filter(p => p.url !== proxyUrl);
    
    // Remove from protocol pools
    Object.keys(this.proxyPool).forEach(protocol => {
      this.proxyPool[protocol] = this.proxyPool[protocol].filter(p => p.url !== proxyUrl);
    });
    
    console.log(`💀 Marked proxy as dead: ${proxyUrl} (${this.workingProxies.length} remaining)`);
  }

  // Save proxy statistics to file
  async saveProxyStats() {
    try {
      const statsData = {
        workingProxies: this.workingProxies,
        proxyStats: Object.fromEntries(this.proxyStats),
        deadProxies: Array.from(this.deadProxies),
        lastUpdated: Date.now(),
        proxyPool: {
          http: this.proxyPool.http.length,
          https: this.proxyPool.https.length,
          socks4: this.proxyPool.socks4.length,
          socks5: this.proxyPool.socks5.length
        }
      };
      
      await fs.writeFile(PROXY_STATS_FILE, JSON.stringify(statsData, null, 2));
      await fs.writeFile(WORKING_PROXIES_FILE, JSON.stringify(this.workingProxies, null, 2));
    } catch (error) {
      console.error('❌ Failed to save proxy stats:', error.message);
    }
  }

  // Load proxy statistics from file
  async loadProxyStats() {
    try {
      const data = await fs.readFile(PROXY_STATS_FILE, 'utf8');
      const statsData = JSON.parse(data);
      
      this.workingProxies = statsData.workingProxies || [];
      this.proxyStats = new Map(Object.entries(statsData.proxyStats || {}));
      this.deadProxies = new Set(statsData.deadProxies || []);
      
      // Rebuild proxy pools
      this.proxyPool = { http: [], https: [], socks4: [], socks5: [] };
      this.workingProxies.forEach(proxy => {
        if (this.proxyPool[proxy.protocol]) {
          this.proxyPool[proxy.protocol].push(proxy);
        }
      });
      
      console.log(`📊 Loaded proxy stats: ${this.workingProxies.length} working proxies`);
    } catch (error) {
      console.log('📊 No existing proxy stats found, starting fresh');
    }
  }

  // Get proxy statistics
  getStats() {
    return {
      totalProxies: this.proxies.length,
      workingProxies: this.workingProxies.length,
      deadProxies: this.deadProxies.size,
      successRate: this.proxies.length > 0 ? (this.workingProxies.length / this.proxies.length * 100).toFixed(1) : 0,
      proxyPool: {
        http: this.proxyPool.http.length,
        https: this.proxyPool.https.length,
        socks4: this.proxyPool.socks4.length,
        socks5: this.proxyPool.socks5.length
      },
      avgResponseTime: this.getAverageResponseTime(),
      lastRefresh: this.lastProxyFetch
    };
  }

  // Calculate average response time
  getAverageResponseTime() {
    const stats = Array.from(this.proxyStats.values());
    if (stats.length === 0) return 0;
    
    const totalTime = stats.reduce((sum, stat) => sum + (stat.avgResponseTime || 0), 0);
    return Math.round(totalTime / stats.length);
  }
}

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
    this.proxyManager = new AdvancedProxyManager();
    this.rateLimiter = new RateLimiter();
    this.sessionData = {};
    this.initialized = false;
    this.requestQueue = [];
    this.processing = false;
  }

  // Initialize the client
  async initialize() {
    if (this.initialized) {
      console.log('✅ LinkedIn client already initialized');
      return;
    }

    try {
      console.log('🚀 Initializing LinkedIn client...');
      
      await ensureDataDir();
      await this.proxyManager.loadProxyStats();
      await this.loadSessionData();
      
      // Initial proxy refresh
      await this.proxyManager.refreshProxyPool(true);
      
      if (this.proxyManager.workingProxies.length === 0) {
        throw new Error('No working proxies available after initialization');
      }
      
      this.initialized = true;
      console.log(`✅ LinkedIn client initialized with ${this.proxyManager.workingProxies.length} working proxies`);
      
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

  // Enhanced LinkedIn request with anti-detection
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
        // Get best proxy
        const proxy = this.proxyManager.getBestProxy('http');
        
        // Create proxy agent
        let agent;
        if (proxy.protocol === 'http' || proxy.protocol === 'https') {
          agent = new HttpsProxyAgent(proxy.url);
        } else if (proxy.protocol === 'socks4' || proxy.protocol === 'socks5') {
          agent = new SocksProxyAgent(proxy.url);
        }

        // Enhanced headers with rotation
        const headers = {
          ...LINKEDIN_HEADERS,
          ...this.proxyManager.generateRandomHeaders(),
          ...options.headers
        };

        // Add authentication headers if available
        if (options.cookies) {
          headers['Cookie'] = Object.entries(options.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
        }

        console.log(`🔄 Attempt ${attempt}/${retries} - Using proxy: ${proxy.url}`);

        const response = await TimeoutFetch.fetchWithTimeout(url, {
          ...options,
          agent,
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
          this.proxyManager.markProxyAsDead(proxy.url);
          throw new Error(`Access denied (${response.status}). Proxy may be blocked.`);
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Attempt ${attempt}/${retries} failed: ${error.message}`);
        
        // If proxy-related error, mark as dead and try again
        if (error.message.includes('timeout') || 
            error.message.includes('ECONNREFUSED') ||
            error.message.includes('ENOTFOUND')) {
          try {
            const proxy = this.proxyManager.getBestProxy('http');
            this.proxyManager.markProxyAsDead(proxy.url);
          } catch (e) {
            // Ignore if no proxy available
          }
        }
        
        // Wait before retry with exponential backoff
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Request failed after ${retries} attempts. Last error: ${lastError?.message}`);
  }
   // Fetch LinkedIn profile with enhanced voyager API
  async fetchLinkedInProfile(profileId, cookies = {}) {
    try {
      console.log(`🔍 Fetching LinkedIn profile: ${profileId}`);
      
      // Generate session ID for tracking
      const sessionId = this.generateSessionId();
      
      // LinkedIn Voyager API endpoints for comprehensive profile data
      const endpoints = {
        profile: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`,
        contact: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`,
        experience: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profilePositionGroups`,
        skills: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/skillCategory`,
        education: `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileSchools`
      };

      const results = {};
      
      // Fetch main profile data first (most important)
      try {
        const profileResponse = await this.makeLinkedInRequest(endpoints.profile, {
          headers: {
            'Accept': 'application/vnd.linkedin.normalized+json+2.1',
            'x-restli-protocol-version': '2.0.0',
            'x-li-track': JSON.stringify({
              "clientVersion": "1.13.9631",
              "mpVersion": "1.13.9631", 
              "osName": "web",
              "timezoneOffset": -480,
              "timezone": "America/Los_Angeles",
              "deviceFormFactor": "DESKTOP",
              "mpName": "voyager-web"
            })
          },
          cookies
        });

        if (profileResponse.ok) {
          results.profile = await profileResponse.json();
          console.log(`✅ Profile data fetched for ${profileId}`);
        }
      } catch (error) {
        console.error(`❌ Failed to fetch profile data: ${error.message}`);
        results.profile = { error: error.message };
      }

      // Add small delay between requests
      await new Promise(resolve => setTimeout(resolve, 
        Math.random() * (DAILY_LIMITS.max_delay_between - DAILY_LIMITS.min_delay_between) + DAILY_LIMITS.min_delay_between
      ));

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
            results.contact = await contactResponse.json();
            console.log(`✅ Contact info fetched for ${profileId}`);
          }
        } catch (error) {
          console.warn(`⚠️ Failed to fetch contact info: ${error.message}`);
          results.contact = { error: error.message };
        }
      } else {
        console.log(`⏸️ Contact info rate limit reached (${contactLimit.current}/${contactLimit.limit})`);
        results.contact = { error: 'Rate limit exceeded' };
      }

      // Fetch experience data
      try {
        await new Promise(resolve => setTimeout(resolve, 
          Math.random() * (DAILY_LIMITS.max_delay_between - DAILY_LIMITS.min_delay_between) + DAILY_LIMITS.min_delay_between
        ));

        const experienceResponse = await this.makeLinkedInRequest(endpoints.experience, {
          headers: {
            'Accept': 'application/vnd.linkedin.normalized+json+2.1',
            'x-restli-protocol-version': '2.0.0'
          },
          cookies
        });

        if (experienceResponse.ok) {
          results.experience = await experienceResponse.json();
          console.log(`✅ Experience data fetched for ${profileId}`);
        }
      } catch (error) {
        console.warn(`⚠️ Failed to fetch experience data: ${error.message}`);
        results.experience = { error: error.message };
      }

      // Return combined results
      const combinedData = {
        profileId,
        sessionId,
        timestamp: Date.now(),
        success: !!results.profile && !results.profile.error,
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
      if (results.profile && results.profile.profile) {
        const profile = results.profile.profile;
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
      if (results.contact && results.contact.contactInfo) {
        const contact = results.contact.contactInfo;
        combined.email = contact.emailAddress;
        combined.phone = contact.phoneNumbers?.[0]?.number;
        combined.websites = contact.websites?.map(w => w.url);
        combined.twitter = contact.twitterHandles?.[0]?.name;
      }

      // Extract experience
      if (results.experience && results.experience.positionGroups) {
        combined.experience = results.experience.positionGroups.map(group => ({
          company: group.companyName,
          positions: group.profilePositions?.map(pos => ({
            title: pos.title,
            description: pos.description,
            startDate: pos.dateRange?.start,
            endDate: pos.dateRange?.end,
            current: !pos.dateRange?.end
          }))
        }));
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
    const proxyStats = this.proxyManager.getStats();
    
    return {
      rateLimitStats: stats,
      proxyStats: proxyStats,
      clientInitialized: this.initialized,
      dailyLimits: DAILY_LIMITS
    };
  }

  // Refresh proxies manually
  async refreshProxies() {
    console.log('🔄 Manual proxy refresh requested');
    await this.proxyManager.refreshProxyPool(true);
    return this.proxyManager.getStats();
  }
}

// Global client instance
let globalLinkedInClient = null;

// Initialize LinkedIn client
const initializeFreeProxyClient = async () => {
  if (!globalLinkedInClient) {
    globalLinkedInClient = new LinkedInClient();
  }
  await globalLinkedInClient.initialize();
  return globalLinkedInClient;
};

// Fetch LinkedIn profile (main export function)
const fetchLinkedInProfile = async (profileId, cookies = {}) => {
  if (!globalLinkedInClient) {
    await initializeFreeProxyClient();
  }
  return await globalLinkedInClient.fetchLinkedInProfile(profileId, cookies);
};

// Generate session ID
const generateSessionId = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Get rate limit status
const getRateLimitStatus = async () => {
  if (!globalLinkedInClient) {
    return {
      rateLimitStats: { today: {}, requestHistory: 0, dailyLimits: DAILY_LIMITS },
      proxyStats: { totalProxies: 0, workingProxies: 0, successRate: 0 },
      clientInitialized: false,
      dailyLimits: DAILY_LIMITS
    };
  }
  return await globalLinkedInClient.getRateLimitStatus();
};

// Refresh proxies
const refreshProxies = async () => {
  if (!globalLinkedInClient) {
    await initializeFreeProxyClient();
  }
  return await globalLinkedInClient.refreshProxies();
};

// Export all functions
module.exports = {
  // Main functions
  fetchLinkedInProfile,
  initializeFreeProxyClient, 
  refreshProxies,
  getRateLimitStatus,
  generateSessionId,
  
  // Classes for advanced usage
  LinkedInClient,
  AdvancedProxyManager,
  RateLimiter,
  TimeoutFetch,
  
  // Constants
  DAILY_LIMITS,
  USER_AGENTS,
  LINKEDIN_HEADERS,
  
  // File paths
  RATE_LIMIT_FILE,
  PROXY_STATS_FILE,
  WORKING_PROXIES_FILE
};
      