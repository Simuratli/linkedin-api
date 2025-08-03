// Auth helper to save authentication data when tokens are received
export const saveAuthData = async (authParams) => {
  try {
    await chrome.storage.local.set({
      authData: {
        clientId: authParams.clientId,
        tenantId: authParams.tenantId,
        verifier: authParams.verifier,
        crmUrl: authParams.crmUrl,
        savedAt: Date.now()
      }
    });
    console.log('✅ Auth data saved successfully');
  } catch (error) {
    console.error('❌ Failed to save auth data:', error);
  }
};

// Save token data when received from Microsoft
export const saveTokenData = async (tokenData) => {
  try {
    await chrome.storage.local.set({
      tokenData: {
        ...tokenData,
        savedAt: Date.now(),
        expiresAt: Date.now() + (tokenData.expires_in * 1000)
      }
    });
    console.log('✅ Token data saved successfully');
  } catch (error) {
    console.error('❌ Failed to save token data:', error);
  }
};

// Check if tokens are expired or will expire soon
export const isTokenExpired = async () => {
  try {
    const { tokenData } = await chrome.storage.local.get(['tokenData']);
    
    if (!tokenData || !tokenData.expiresAt) {
      return true;
    }
    
    // Consider expired if expires in next 5 minutes
    return Date.now() > (tokenData.expiresAt - 5 * 60 * 1000);
  } catch (error) {
    console.error('❌ Failed to check token expiry:', error);
    return true;
  }
};

// Get stored auth and token data
export const getStoredAuthData = async () => {
  try {
    const data = await chrome.storage.local.get(['authData', 'tokenData']);
    return {
      authData: data.authData || null,
      tokenData: data.tokenData || null
    };
  } catch (error) {
    console.error('❌ Failed to get stored auth data:', error);
    return { authData: null, tokenData: null };
  }
};

// Clear all authentication data
export const clearAuthData = async () => {
  try {
    await chrome.storage.local.remove(['authData', 'tokenData', 'lastProcessState']);
    console.log('✅ Auth data cleared successfully');
  } catch (error) {
    console.error('❌ Failed to clear auth data:', error);
  }
};

// Validate that we have all required auth data
export const validateAuthData = async () => {
  try {
    const { authData, tokenData } = await getStoredAuthData();
    
    const hasAuthData = authData && 
                       authData.clientId && 
                       authData.tenantId && 
                       authData.verifier;
    
    const hasTokenData = tokenData && 
                        tokenData.access_token && 
                        tokenData.refresh_token;
    
    return !!(hasAuthData && hasTokenData);
  } catch (error) {
    console.error('❌ Failed to validate auth data:', error);
    return false;
  }
};