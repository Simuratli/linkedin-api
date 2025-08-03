const express = require("express");
const cors = require("cors");
const { transformToCreateUserRequest } = require("../helpers/transform");
const { fetchLinkedInProfile } = require("../helpers/linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep , chunkArray, getRandomDelay} = require("../helpers/delay");

const app = express();
const PORT = process.env.PORT || 3000;

// Token refresh helper using your existing getAccessTokenRequest pattern
const refreshAccessToken = async (refreshToken, clientId, tenantId, crmUrl, verifier) => {
  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: {
          "Content-type": "application/x-www-form-urlencoded",
        },
        credentials: "omit",
        body: `client_id=${clientId}&scope=${crmUrl}/.default&grant_type=refresh_token&refresh_token=${refreshToken}&redirect_uri=http://localhost:5678&code_verifier=${verifier}`,
      },
    );
    
    const data = await response.json();
    
    if (response.ok && data.access_token) {
      console.log('✅ Token refreshed successfully');
      return data;
    } else {
      throw new Error(data.error_description || 'Token refresh failed');
    }
  } catch (error) {
    console.error('❌ Token refresh error:', error.message);
    throw error;
  }
};

// Enhanced API call helper with token refresh
const callDataverseWithRefresh = async (url, token, method = 'GET', body = null, refreshData = null) => {
  try {
    // First attempt with current token
    if (method === 'GET') {
      return await getDataverse(url, token);
    } else {
      return await createDataverse(url, token, body, method);
    }
  } catch (error) {
    console.log('🔍 API call failed, checking if token refresh needed...');
    
    // Check if it's a 401 error and we have refresh data
    if (error.message.includes('401') && refreshData) {
      try {
        console.log('🔄 Attempting token refresh...');
        const newTokenData = await refreshAccessToken(
          refreshData.refreshToken,
          refreshData.clientId,
          refreshData.tenantId,
          refreshData.crmUrl,
          refreshData.verifier
        );
        
        // Retry the API call with new token
        console.log('🔄 Retrying API call with refreshed token...');
        if (method === 'GET') {
          return await getDataverse(url, newTokenData.access_token);
        } else {
          return await createDataverse(url, newTokenData.access_token, body, method);
        }
      } catch (refreshError) {
        console.error('❌ Token refresh failed:', refreshError.message);
        throw new Error('TOKEN_REFRESH_FAILED: ' + refreshError.message);
      }
    }
    
    throw error;
  }
};

// CORS setup
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, Origin",
  );
  res.header("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  } else {
    next();
  }
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.post("/update-contacts-post", async (req, res) => {
  try {
    const { 
      li_at, 
      accessToken, 
      refreshToken, 
      clientId, 
      tenantId, 
      verifier, 
      crmUrl, 
      jsessionid 
    } = req.body;

    if (!jsessionid || !accessToken || !crmUrl || !li_at) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: li_at, accessToken, crmUrl, and jsessionid are required",
      });
    }

    const clientEndpoint = `${crmUrl}/api/data/v9.2`;
    
    // Prepare refresh data for token refresh if needed
    const refreshData = refreshToken && clientId && tenantId && verifier ? {
      refreshToken,
      clientId,
      tenantId,
      crmUrl,
      verifier
    } : null;

    let currentAccessToken = accessToken;
    let tokenWasRefreshed = false;

    // Get contacts with automatic token refresh
    let response;
    try {
      response = await callDataverseWithRefresh(
        `${clientEndpoint}/contacts`, 
        currentAccessToken, 
        'GET', 
        null, 
        refreshData
      );
    } catch (error) {
      if (error.message.includes('TOKEN_REFRESH_FAILED')) {
        return res.status(401).json({
          success: false,
          message: "Token refresh failed. Please re-authenticate in extension.",
          needsReauth: true,
          error: error.message,
        });
      }
      throw error;
    }

    if (!response || !response.value) {
      return res.status(400).json({
        success: false,
        message: "No contacts found or invalid response from Dataverse",
      });
    }

    const updateResults = [];
    const errors = [];
    const contacts = response.value.filter((c) => !!c.uds_linkedin);
    
    const BATCH_SIZE = 5;
    const WAIT_BETWEEN_BATCHES_MS = 45000;
    const contactBatches = chunkArray(contacts, BATCH_SIZE);

    console.log(`📊 Processing ${contacts.length} contacts in ${contactBatches.length} batches`);

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
      const batch = contactBatches[batchIndex];
      
      console.log(`🔄 Processing batch ${batchIndex + 1} of ${contactBatches.length}`);

      const batchPromises = batch.map(async (contact) => {
        try {
          const match = contact.uds_linkedin.match(/\/in\/([^\/]+)/);
          const profileId = match ? match[1] : null;

          if (!profileId) {
            throw new Error(`Invalid LinkedIn URL format for contact ${contact.contactid}`);
          }

          const customCookies = {
            li_at: li_at,
            jsession: jsessionid || generateSessionId(),
          };

          const profileData = await fetchLinkedInProfile(profileId, customCookies);

          if (profileData.error) {
            throw new Error(`LinkedIn API error: ${profileData.error}`);
          }

          const convertedProfile = transformToCreateUserRequest(profileData, clientEndpoint, currentAccessToken);
          const updateUrl = `${clientEndpoint}/contacts(${contact.contactid})`;

          // Update contact with automatic token refresh
          const updateResponse = await callDataverseWithRefresh(
            updateUrl,
            currentAccessToken,
            "PATCH",
            convertedProfile,
            refreshData
          );

          updateResults.push({
            contactId: contact.contactid,
            success: true,
            profileId: profileId,
            response: updateResponse,
          });

        } catch (error) {
          console.error(`❌ Error processing contact ${contact.contactid}:`, error.message);
          
          // If token refresh failed, stop the entire process
          if (error.message.includes('TOKEN_REFRESH_FAILED')) {
            throw error;
          }
          
          errors.push({
            contactId: contact.contactid,
            success: false,
            error: error.message,
          });
        }
      });

      await Promise.allSettled(batchPromises);

      if (batchIndex < contactBatches.length - 1) {
        const waitTime = WAIT_BETWEEN_BATCHES_MS + getRandomDelay(-10000, 20000);
        console.log(`⏳ Waiting ${waitTime / 1000}s before next batch...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      const processed = (batchIndex + 1) * BATCH_SIZE;
      const total = contacts.length;
      console.log(`📈 Progress: ${Math.min(processed, total)}/${total} contacts processed`);
    }

    res.status(200).json({
      success: true,
      message: "LinkedIn profile update process completed",
      stats: {
        totalContacts: response.value.length,
        updated: updateResults.length,
        failed: errors.length,
        successRate: `${((updateResults.length / contacts.length) * 100).toFixed(1)}%`
      },
      updates: updateResults,
      errors: errors.length > 0 ? errors : undefined,
      tokenRefreshed: tokenWasRefreshed,
    });

  } catch (error) {
    console.error("❌ Error in /update-contacts-post:", error);
    
    // Handle token refresh failures specifically
    if (error.message.includes('TOKEN_REFRESH_FAILED')) {
      return res.status(401).json({
        success: false,
        message: "Token refresh failed. Please re-authenticate in extension.",
        needsReauth: true,
        error: error.message,
      });
    }
    
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// New endpoint to handle manual token refresh from extension
app.post("/refresh-token", async (req, res) => {
  try {
    const { refreshToken, clientId, tenantId, crmUrl, verifier } = req.body;

    if (!refreshToken || !clientId || !tenantId || !crmUrl || !verifier) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters for token refresh",
      });
    }

    const newTokenData = await refreshAccessToken(refreshToken, clientId, tenantId, crmUrl, verifier);

    res.status(200).json({
      success: true,
      message: "Token refreshed successfully",
      tokenData: newTokenData,
    });

  } catch (error) {
    console.error("❌ Token refresh failed:", error);
    res.status(401).json({
      success: false,
      message: "Token refresh failed",
      error: error.message,
      needsReauth: true,
    });
  }
});

// Test route
app.get("/simuratli", async (req, res) => {
  const profileId = "simuratli";
  const data = await fetchLinkedInProfile(profileId);
  console.log("🔍 Fetched Data:", data);
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});