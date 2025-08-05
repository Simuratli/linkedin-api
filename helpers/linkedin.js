// LinkedIn Client with Free Proxy Support - Güvenli ve Dikkatli Yaklaşım
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Dosya yolları
const RATE_LIMIT_FILE = path.join(__dirname, '../data/daily_rate_limits.json');
const PROXY_STATS_FILE = path.join(__dirname, '../data/free_proxy_stats.json');
const WORKING_PROXIES_FILE = path.join(__dirname, '../data/working_proxies.json');

// Free proxy'ler için çok konservatif limitler
const DAILY_LIMITS = {
  profile_views: 300,          // Günde maksimum 300 (güvenli)
  contact_info: 50,            // Contact info çok sınırlı
  search_queries: 100,         // Arama limiti
  max_requests_per_hour: 50,   // Saatte max 50 (çok konservatif)
  max_burst_requests: 2,       // Ard arda max 2 istek
  proxy_rotation_after: 15,    // Her 15 request'te proxy değiş
  proxy_test_timeout: 10000,   // 10 saniye proxy test timeout
  request_timeout: 20000,      // 20 saniye request timeout
  min_delay_between: 15000,    // En az 15 saniye ara
  max_delay_between: 45000,    // En fazla 45 saniye ara
};

// Popüler Free Proxy API'leri
const FREE_PROXY_APIS = [
  'https://api.proxyscrape.com/v2/?request=get&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt'
];

// User Agent'lar (daha geniş çeşitlilik)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0'
];

// Free Proxy Manager
class FreeProxyManager {
  constructor() {
    this.allProxies = [];
    this.workingProxies = [];
    this.failedProxies = new Set();
    this.proxyStats = {};
    this.lastProxyFetch = 0;
    this.currentProxyIndex = 0;
    
    this.loadStoredData();
  }

  async loadStoredData() {
    try {
      // Çalışan proxy'leri yükle
      const workingData = await fs.readFile(WORKING_PROXIES_FILE, 'utf8');
      const workingParsed = JSON.parse(workingData);
      this.workingProxies = workingParsed.proxies || [];
      this.lastProxyFetch = workingParsed.lastFetch || 0;
      
      // Proxy istatistiklerini yükle
      const statsData = await fs.readFile(PROXY_STATS_FILE, 'utf8');
      const statsParsed = JSON.parse(statsData);
      this.proxyStats = statsParsed.stats || {};
      this.failedProxies = new Set(statsParsed.failed || []);
      
      console.log(`📊 Loaded ${this.workingProxies.length} working proxies from cache`);
    } catch (error) {
      console.log('📋 No cached proxy data found, will fetch fresh proxies');
    }
  }

  async saveStoredData() {
    try {
      const dataDir = path.dirname(WORKING_PROXIES_FILE);
      await fs.mkdir(dataDir, { recursive: true });
      
      // Çalışan proxy'leri kaydet
      await fs.writeFile(WORKING_PROXIES_FILE, JSON.stringify({
        proxies: this.workingProxies,
        lastFetch: this.lastProxyFetch,
        lastUpdate: new Date().toISOString()
      }, null, 2));
      
      // İstatistikleri kaydet
      await fs.writeFile(PROXY_STATS_FILE, JSON.stringify({
        stats: this.proxyStats,
        failed: Array.from(this.failedProxies),
        lastUpdate: new Date().toISOString()
      }, null, 2));
      
    } catch (error) {
      console.error('❌ Failed to save proxy data:', error);
    }
  }

  // Free proxy'leri API'lerden çek
  async fetchFreeProxies() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    // Eğer son 1 saat içinde çektiyse ve çalışan proxy'ler varsa skip et
    if (this.workingProxies.length > 10 && (now - this.lastProxyFetch) < oneHour) {
      console.log('📋 Using cached proxies (fetched recently)');
      return;
    }

    console.log('🔄 Fetching fresh free proxies...');
    this.allProxies = [];

    // Fallback proxy listesi (eğer API'ler çalışmazsa)
    const fallbackProxies = [
      'http://103.149.162.194:80',
      'http://103.149.162.195:80',
      'http://103.149.162.196:80',
      'http://103.149.162.197:80',
      'http://103.149.162.198:80',
      'http://103.149.162.199:80',
      'http://103.149.162.200:80',
      'http://103.149.162.201:80',
      'http://103.149.162.202:80',
      'http://103.149.162.203:80'
    ];

    let apiSuccess = false;
    for (const apiUrl of FREE_PROXY_APIS) {
      try {
        console.log(`📡 Fetching from: ${apiUrl.substring(0, 50)}...`);
        
        const response = await fetch(apiUrl, {
          timeout: 15000,
          headers: {
            'User-Agent': this.getRandomUserAgent()
          }
        });

        if (response.ok) {
          const data = await response.text();
          const proxies = this.parseProxyList(data);
          this.allProxies.push(...proxies);
          console.log(`✅ Found ${proxies.length} proxies from this source`);
          apiSuccess = true;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to fetch from API: ${error.message}`);
      }
      
      // API'ler arası kısa bekleme
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Eğer hiçbir API çalışmazsa fallback proxy'leri kullan
    if (!apiSuccess || this.allProxies.length === 0) {
      console.log('⚠️ No proxies found from APIs, using fallback proxies...');
      this.allProxies = [...fallbackProxies];
    }

    // Duplicate'leri temizle
    this.allProxies = [...new Set(this.allProxies)];
    console.log(`📊 Total unique proxies found: ${this.allProxies.length}`);
    
    this.lastProxyFetch = now;
    await this.testAndFilterProxies();
  }

  parseProxyList(data) {
    const proxies = [];
    const lines = data.split('\n');
    
    for (const line of lines) {
      const cleanLine = line.trim();
      
      // IP:PORT formatını kontrol et
      const match = cleanLine.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/);
      if (match) {
        const [, ip, port] = match;
        
        // Temel IP validasyonu
        const ipParts = ip.split('.').map(Number);
        if (ipParts.every(part => part >= 0 && part <= 255)) {
          proxies.push(`http://${ip}:${port}`);
        }
      }
    }
    
    return proxies;
  }

  // Proxy'leri test et ve çalışanları filtrele
  async testAndFilterProxies() {
    if (this.allProxies.length === 0) {
      console.log('❌ No proxies to test');
      return;
    }

    console.log('🧪 Testing proxies for functionality...');
    const batchSize = 10; // Daha küçük batch size
    const workingProxies = [];
    
    // Proxy'leri batch'lere ayır
    for (let i = 0; i < Math.min(this.allProxies.length, 100); i += batchSize) {
      const batch = this.allProxies.slice(i, i + batchSize);
      
      const testPromises = batch.map(proxy => this.testProxy(proxy));
      const results = await Promise.allSettled(testPromises);
      
      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.working) {
          workingProxies.push({
            url: batch[index],
            responseTime: result.value.responseTime,
            country: result.value.country || 'Unknown'
          });
        }
      });
      
      console.log(`📊 Tested batch ${Math.floor(i/batchSize) + 1}, found ${workingProxies.length} working proxies so far`);
      
      // Batch'ler arası kısa bekleme
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Eğer hiç çalışan proxy bulunamazsa, tüm proxy'leri çalışan olarak kabul et
    if (workingProxies.length === 0) {
      console.log('⚠️ No working proxies found, accepting all proxies as working...');
      this.workingProxies = this.allProxies.slice(0, 20).map(proxy => ({
        url: proxy,
        responseTime: 5000,
        country: 'Unknown'
      }));
    } else {
      // Response time'a göre sırala (hızlı olanlar önce)
      this.workingProxies = workingProxies
        .sort((a, b) => a.responseTime - b.responseTime)
        .slice(0, 20); // En iyi 20 tanesini al
    }

    console.log(`✅ Found ${this.workingProxies.length} working proxies`);
    await this.saveStoredData();
  }

  // Tek proxy test et
  async testProxy(proxyUrl) {
    const startTime = Date.now();
    
    try {
      const proxyAgent = new HttpsProxyAgent(proxyUrl);
      
      // Basit HTTP test - daha kısa timeout
      const response = await fetch('http://httpbin.org/ip', {
        method: 'GET',
        agent: proxyAgent,
        timeout: 8000, // Daha kısa timeout
        headers: {
          'User-Agent': this.getRandomUserAgent()
        }
      });

      if (response.ok) {
        const data = await response.json();
        const responseTime = Date.now() - startTime;
        
        return {
          working: true,
          responseTime: responseTime,
          ip: data.origin
        };
      }
    } catch (error) {
      // Test başarısız - daha detaylı log
      console.log(`❌ Proxy test failed for ${proxyUrl}: ${error.message}`);
    }

    return { working: false };
  }

  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  // En iyi proxy'yi seç
  getBestProxy() {
    if (this.workingProxies.length === 0) {
      throw new Error('No working proxies available. Please fetch new proxies.');
    }

    // Failed proxy'leri filtrele
    const availableProxies = this.workingProxies.filter(proxy => 
      !this.failedProxies.has(proxy.url)
    );

    if (availableProxies.length === 0) {
      // Tüm proxy'ler failed ise, failed list'i temizle ve tekrar dene
      console.log('⚠️ All proxies marked as failed, clearing failed list...');
      this.failedProxies.clear();
      return this.getBestProxy();
    }

    // Round-robin seçim
    const selectedProxy = availableProxies[this.currentProxyIndex % availableProxies.length];
    this.currentProxyIndex++;

    return selectedProxy;
  }

  // Proxy sonucunu kaydet
  recordProxyResult(proxy, success, errorType = null) {
    const proxyUrl = proxy.url || proxy;
    
    if (!this.proxyStats[proxyUrl]) {
      this.proxyStats[proxyUrl] = { success: 0, failed: 0, errors: {} };
    }

    if (success) {
      this.proxyStats[proxyUrl].success++;
      // Başarılı ise failed list'ten çıkar
      this.failedProxies.delete(proxyUrl);
    } else {
      this.proxyStats[proxyUrl].failed++;
      
      if (errorType) {
        if (!this.proxyStats[proxyUrl].errors[errorType]) {
          this.proxyStats[proxyUrl].errors[errorType] = 0;
        }
        this.proxyStats[proxyUrl].errors[errorType]++;
      }

      // 3 kez başarısız ise failed list'e ekle
      if (this.proxyStats[proxyUrl].failed >= 3) {
        this.failedProxies.add(proxyUrl);
        console.log(`🚫 Proxy marked as failed: ${proxyUrl.substring(0, 30)}...`);
      }
    }

    this.saveStoredData();
  }

  getStats() {
    return {
      totalProxies: this.allProxies.length,
      workingProxies: this.workingProxies.length,
      failedProxies: this.failedProxies.size,
      proxyStats: Object.keys(this.proxyStats).length,
      lastFetch: new Date(this.lastProxyFetch).toLocaleString()
    };
  }

  // Proxy'leri manuel olarak refresh et
  async refreshProxies() {
    console.log('🔄 Manual proxy refresh initiated...');
    this.lastProxyFetch = 0; // Force refresh
    await this.fetchFreeProxies();
  }
}

// Rate Limiting (Free proxy'ler için çok konservatif)
class ConservativeRateLimit {
  constructor() {
    this.dailyCounters = {};
    this.hourlyCounters = {};
    this.requestTimestamps = [];
    this.suspiciousActivity = false;
    this.backoffMultiplier = 1;
    this.lastResetTime = this.getTodayKey();
    
    this.loadDailyData();
  }

  getTodayKey() {
    return new Date().toISOString().split('T')[0];
  }

  async loadDailyData() {
    try {
      const data = await fs.readFile(RATE_LIMIT_FILE, 'utf8');
      const parsed = JSON.parse(data);
      
      const today = this.getTodayKey();
      if (parsed[today]) {
        this.dailyCounters = parsed[today].counters || {};
        this.suspiciousActivity = parsed[today].suspicious || false;
        this.backoffMultiplier = parsed[today].backoff || 1;
      }
    } catch (error) {
      this.dailyCounters = {};
    }
  }

  async saveDailyData() {
    try {
      let allData = {};
      try {
        const existingData = await fs.readFile(RATE_LIMIT_FILE, 'utf8');
        allData = JSON.parse(existingData);
      } catch (e) {}

      const today = this.getTodayKey();
      allData[today] = {
        counters: this.dailyCounters,
        suspicious: this.suspiciousActivity,
        backoff: this.backoffMultiplier,
        lastUpdate: new Date().toISOString()
      };

      const dataDir = path.dirname(RATE_LIMIT_FILE);
      await fs.mkdir(dataDir, { recursive: true });
      
      await fs.writeFile(RATE_LIMIT_FILE, JSON.stringify(allData, null, 2));
    } catch (error) {
      console.error('❌ Rate limit save error:', error);
    }
  }

  resetCountersIfNewDay() {
    const today = this.getTodayKey();
    if (this.lastResetTime !== today) {
      this.dailyCounters = {};
      this.hourlyCounters = {};
      this.lastResetTime = today;
      this.backoffMultiplier = 1;
      this.suspiciousActivity = false;
      console.log('🔄 Daily counters reset');
    }
  }

  incrementCounter(type) {
    this.resetCountersIfNewDay();

    if (!this.dailyCounters[type]) {
      this.dailyCounters[type] = 0;
    }
    this.dailyCounters[type]++;

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

  getRandomDelay() {
    // Free proxy'ler için çok uzun gecikmeler
    const baseMin = DAILY_LIMITS.min_delay_between;
    const baseMax = DAILY_LIMITS.max_delay_between;
    
    const multiplier = this.suspiciousActivity ? 2 : 1;
    const min = baseMin * multiplier;
    const max = baseMax * multiplier;
    
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async shouldAllowRequest(type = 'profile_views') {
    const dailyCheck = this.checkDailyLimit(type);

    if (!dailyCheck.allowed) {
      throw new Error(`Daily limit exceeded for ${type}. Limit: ${dailyCheck.limit}, Current: ${dailyCheck.current}`);
    }

    return {
      allowed: true,
      dailyRemaining: dailyCheck.remaining,
      recommendedDelay: this.getRandomDelay()
    };
  }

  getStats() {
    this.resetCountersIfNewDay();
    return {
      profileViews: this.dailyCounters.profile_views || 0,
      contactInfo: this.dailyCounters.contact_info || 0,
      limits: DAILY_LIMITS,
      suspiciousActivity: this.suspiciousActivity,
      backoffMultiplier: this.backoffMultiplier
    };
  }
}

// Ana LinkedIn Client
class FreeProxyLinkedInClient {
  constructor() {
    this.proxyManager = new FreeProxyManager();
    this.rateLimit = new ConservativeRateLimit();
    this.currentProxy = null;
    this.requestCount = 0;
    this.sessionFingerprints = new Map();
    
    console.log('🚀 Free Proxy LinkedIn Client initialized');
  }

  // Proxy'leri initialize et
  async initializeProxies() {
    await this.proxyManager.fetchFreeProxies();
    
    // Eğer hiç proxy bulunamazsa, manuel olarak bazı proxy'ler ekle
    if (this.proxyManager.workingProxies.length === 0) {
      console.log('⚠️ No working proxies found, adding manual fallback proxies...');
      this.proxyManager.workingProxies = [
        { url: 'http://103.149.162.194:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.195:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.196:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.197:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.198:80', responseTime: 5000, country: 'Unknown' }
      ];
      await this.proxyManager.saveStoredData();
    }
    
    console.log(`✅ Initialized with ${this.proxyManager.workingProxies.length} working proxies`);
  }

  rotateProxy() {
    try {
      this.currentProxy = this.proxyManager.getBestProxy();
      this.requestCount = 0;
      console.log(`🔄 Rotated to proxy: ${this.currentProxy.url.substring(0, 30)}...`);
      return this.currentProxy;
    } catch (error) {
      console.error('❌ Proxy rotation failed:', error.message);
      
      // Eğer proxy rotation başarısız olursa, manuel proxy'ler ekle
      console.log('⚠️ Adding manual fallback proxies...');
      this.proxyManager.workingProxies = [
        { url: 'http://103.149.162.194:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.195:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.196:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.197:80', responseTime: 5000, country: 'Unknown' },
        { url: 'http://103.149.162.198:80', responseTime: 5000, country: 'Unknown' }
      ];
      
      this.currentProxy = this.proxyManager.workingProxies[0];
      this.requestCount = 0;
      console.log(`🔄 Using fallback proxy: ${this.currentProxy.url}`);
      return this.currentProxy;
    }
  }

  generateFingerprint() {
    return {
      sessionId: `"ajax:${crypto.randomInt(1e12, 1e13 - 1)}"`,
      userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
      acceptLanguage: 'en-US,en;q=0.9',
      bcookie: `"v=2&${crypto.randomUUID()}"`,
      bscookie: `"v=1&${Date.now()}${crypto.randomUUID().substring(0, 8)}"`,
    };
  }

  generateHeaders(csrf, cookies, profileId, fingerprint) {
    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    return {
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'accept-language': fingerprint.acceptLanguage,
      'accept-encoding': 'gzip, deflate, br',
      'cache-control': 'no-cache',
      'csrf-token': csrf,
      'cookie': cookieHeader,
      'referer': `https://www.linkedin.com/in/${profileId}/`,
      'user-agent': fingerprint.userAgent,
      'x-li-lang': 'en_US',
      'x-restli-protocol-version': '2.0.0',
    };
  }

  async makeRequest(url, headers, requestType = 'profile_views', retryCount = 0) {
    const maxRetries = 3;
    
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
      console.log(`🔍 Making ${requestType} request via free proxy (attempt ${retryCount + 1}/${maxRetries + 1})`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers,
        agent: proxyAgent,
        timeout: DAILY_LIMITS.request_timeout,
      });

      this.requestCount++;
      this.rateLimit.incrementCounter(requestType);

      if (!response.ok) {
        this.proxyManager.recordProxyResult(this.currentProxy, false, response.status.toString());
        
        if (response.status === 429 || response.status === 403) {
          // Bu proxy'yi failed olarak işaretle ve yeni proxy dene
          throw new Error(`LinkedIn blocked proxy: ${response.status}`);
        }
        
        // 400 hatası için özel işlem - proxy'yi değiştir ve tekrar dene
        if (response.status === 400 && retryCount < maxRetries) {
          console.log(`⚠️ HTTP 400 error, rotating proxy and retrying...`);
          this.rotateProxy();
          // Kısa bekleme sonra tekrar dene
          await new Promise(resolve => setTimeout(resolve, 5000));
          return this.makeRequest(url, headers, requestType, retryCount + 1);
        }
        
        throw new Error(`Request failed: ${response.status}`);
      }

      // Başarılı istek
      this.proxyManager.recordProxyResult(this.currentProxy, true);
      
      const data = await response.json();
      console.log(`✅ Successful ${requestType} request`);
      
      return data;

    } catch (error) {
      console.error(`❌ Request failed:`, error.message);
      this.proxyManager.recordProxyResult(this.currentProxy, false, 'network_error');
      
      // Network error durumunda proxy'yi değiştir ve tekrar dene
      if ((error.message.includes('network_error') || error.message.includes('timeout')) && retryCount < maxRetries) {
        console.log(`⚠️ Network error, rotating proxy and retrying...`);
        this.rotateProxy();
        await new Promise(resolve => setTimeout(resolve, 3000));
        return this.makeRequest(url, headers, requestType, retryCount + 1);
      }
      
      throw error;
    }
  }

  async fetchLinkedInProfile(profileId, customCookies = null) {
    if (!this.currentProxy) {
      this.rotateProxy();
    }

    const fingerprint = this.generateFingerprint();
    
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;

    const cookies = {
      JSESSIONID: fingerprint.sessionId,
      li_at: customCookies?.li_at || 'YOUR_LI_AT_TOKEN_HERE',
      liap: 'true',
      bcookie: fingerprint.bcookie,
      bscookie: fingerprint.bscookie,
    };

    const csrfToken = fingerprint.sessionId.replace(/"/g, '');

    try {
      // Ana profil verisini al
      const profileHeaders = this.generateHeaders(csrfToken, cookies, profileId, fingerprint);
      const profileData = await this.makeRequest(profileViewUrl, profileHeaders, 'profile_views');

      // İki istek arası uzun gecikme
      const interRequestDelay = Math.floor(Math.random() * 20000) + 15000; // 15-35 saniye
      console.log(`⏳ Waiting ${interRequestDelay/1000}s between profile and contact requests`);
      await new Promise(resolve => setTimeout(resolve, interRequestDelay));

      // Contact info'yu al (çok sınırlı)
      let contactInfoData = null;
      try {
        // Contact info'yu sadece %30 olasılıkla dene (çok riskli)
        if (Math.random() < 0.3) {
          const contactHeaders = this.generateHeaders(csrfToken, cookies, profileId, fingerprint);
          contactInfoData = await this.makeRequest(contactInfoUrl, contactHeaders, 'contact_info');
        } else {
          console.log('📊 Skipping contact info to reduce risk');
        }
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

  // Manual proxy refresh
  async refreshProxies() {
    await this.proxyManager.refreshProxies();
  }

  getStats() {
    return {
      rateLimitStats: this.rateLimit.getStats(),
      proxyStats: this.proxyManager.getStats(),
      currentProxy: this.currentProxy ? this.currentProxy.url.substring(0, 30) + '...' : null,
      requestCount: this.requestCount
    };
  }
}

// Global instance
let linkedInClient = null;

// Initialize function
async function initializeFreeProxyClient() {
  linkedInClient = new FreeProxyLinkedInClient();
  await linkedInClient.initializeProxies();
  return linkedInClient;
}

// Export functions
async function fetchLinkedInProfile(profileId, customCookies = null) {
  if (!linkedInClient) {
    throw new Error('LinkedIn client not initialized. Call initializeFreeProxyClient() first.');
  }
  return linkedInClient.fetchLinkedInProfile(profileId, customCookies);
}

function generateSessionId() {
  return `"ajax:${crypto.randomInt(1e12, 1e13 - 1)}"`;
}

function getRateLimitStatus() {
  if (!linkedInClient) {
    return { error: 'Client not initialized' };
  }
  return linkedInClient.getStats();
}

// Proxy yenileme fonksiyonu
async function refreshProxies() {
  if (!linkedInClient) {
    throw new Error('LinkedIn client not initialized');
  }
  return linkedInClient.refreshProxies();
}

module.exports = {
  fetchLinkedInProfile,
  generateSessionId,
  getRateLimitStatus,
  initializeFreeProxyClient,
  refreshProxies,
  FreeProxyLinkedInClient,
  DAILY_LIMITS
};