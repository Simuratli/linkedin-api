const { getAccessTokenRequest } = require('./dynamics');
const fs = require('fs').promises;
const path = require('path');

class AuthService {
  constructor() {
    this.configPath = path.join(__dirname, 'auth-config.json');
    this.config = null;
  }

  // Load authentication configuration
  async loadConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(configData);
      return this.config;
    } catch (error) {
      console.error('No auth config found, please set up authentication first');
      return null;
    }
  }

  // Save authentication configuration
  async saveConfig(config) {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
      this.config = config;
      console.log('✅ Auth config saved successfully');
    } catch (error) {
      console.error('Failed to save auth config:', error);
      throw error;
    }
  }

  // Generate PKCE code verifier and challenge
  generatePKCE() {
    const codeVerifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), 
      byte => String.fromCharCode(97 + (byte % 26))).join('');
    
    return {
      codeVerifier,
      codeChallenge: codeVerifier // Simplified for demo
    };
  }

  // Get authorization URL for initial login
  getAuthUrl(clientId, tenantId, crmUrl) {
    const pkce = this.generatePKCE();
    
    // Save PKCE for later use
    this.pendingAuth = { 
      clientId, 
      tenantId, 
      crmUrl, 
      codeVerifier: pkce.codeVerifier 
    };

    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize` +
      `?client_id=${clientId}` +
      `&response_type=code` +
      `&redirect_uri=http://localhost:5678` +
      `&scope=${crmUrl}/.default` +
      `&state=${Math.random().toString(36).substring(2)}` +
      `&code_challenge=${pkce.codeChallenge}` +
      `&code_challenge_method=plain`;

    return authUrl;
  }

  // Exchange authorization code for tokens (first time login)
  async exchangeCodeForTokens(authCode) {
    if (!this.pendingAuth) {
      throw new Error('No pending authentication found');
    }

    const { clientId, tenantId, crmUrl, codeVerifier } = this.pendingAuth;

    const result = await getAccessTokenRequest(
      clientId,
      tenantId, 
      crmUrl,
      codeVerifier,
      "authorization_code",
      authCode
    );

    if (result.success) {
      const config = {
        clientId,
        tenantId,
        crmUrl,
        codeVerifier,
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        tokenExpiry: new Date(Date.now() + (result.expires_in * 1000)),
        lastRefresh: new Date()
      };

      await this.saveConfig(config);
      this.pendingAuth = null;
      return config;
    } else {
      throw new Error(`Authentication failed: ${result.error}`);
    }
  }

  // Refresh access token using refresh token
  async refreshAccessToken() {
    if (!this.config) {
      await this.loadConfig();
    }

    if (!this.config || !this.config.refreshToken) {
      throw new Error('No refresh token available, please login again');
    }

    const result = await getAccessTokenRequest(
      this.config.clientId,
      this.config.tenantId,
      this.config.crmUrl,
      this.config.codeVerifier,
      "refresh",
      this.config.refreshToken
    );

    if (result.success) {
      this.config.accessToken = result.access_token;
      if (result.refresh_token) {
        this.config.refreshToken = result.refresh_token;
      }
      this.config.tokenExpiry = new Date(Date.now() + (result.expires_in * 1000));
      this.config.lastRefresh = new Date();

      await this.saveConfig(this.config);
      console.log('✅ Token refreshed successfully');
      return this.config.accessToken;
    } else {
      console.error('❌ Token refresh failed:', result.error);
      throw new Error(`Token refresh failed: ${result.error}`);
    }
  }

  // Get valid access token (refresh if needed)
  async getValidAccessToken() {
    if (!this.config) {
      await this.loadConfig();
    }

    if (!this.config) {
      throw new Error('Not authenticated, please login first');
    }

    // Check if token is still valid (with 5 minute buffer)
    const now = new Date();
    const tokenExpiry = new Date(this.config.tokenExpiry);
    const bufferTime = 5 * 60 * 1000; // 5 minutes

    if (now.getTime() + bufferTime >= tokenExpiry.getTime()) {
      console.log('🔄 Token expiring soon, refreshing...');
      return await this.refreshAccessToken();
    }

    return this.config.accessToken;
  }

  // Check if user is authenticated
  async isAuthenticated() {
    try {
      await this.getValidAccessToken();
      return true;
    } catch (error) {
      return false;
    }
  }

  // Clear all authentication data
  async logout() {
    try {
      await fs.unlink(this.configPath);
      this.config = null;
      this.pendingAuth = null;
      console.log('✅ Logged out successfully');
    } catch (error) {
      console.log('Already logged out');
    }
  }

  // Get current auth status
  async getAuthStatus() {
    if (!this.config) {
      await this.loadConfig();
    }

    if (!this.config) {
      return {
        authenticated: false,
        message: 'Not authenticated'
      };
    }

    const tokenExpiry = new Date(this.config.tokenExpiry);
    const now = new Date();
    const timeUntilExpiry = tokenExpiry.getTime() - now.getTime();

    return {
      authenticated: true,
      tokenExpiry: tokenExpiry,
      timeUntilExpiry: Math.max(0, Math.floor(timeUntilExpiry / 1000 / 60)), // minutes
      lastRefresh: new Date(this.config.lastRefresh),
      crmUrl: this.config.crmUrl
    };
  }
}

module.exports = AuthService;