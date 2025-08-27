async function createDataverse(url, token, request, method) {

  function cleanToken(token) {
  try {
    return token.includes('"') ? JSON.parse(token) : token;
  } catch (e) {
    console.warn('Token parse error, using as-is:', e);
    return token;
  }
}

  const headers = {
    Authorization: `Bearer ${cleanToken(token)}`,
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  const options = {
    method: method,
    headers: headers,
    body: JSON.stringify(request),
  };

  try {
    const response = await fetch(url, options);
    const text = await response.text();

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      
      // Try to parse error response for more details
      if (text) {
        try {
          const errorData = JSON.parse(text);
          errorMessage = errorData.error?.message || errorData.message || text;
        } catch {
          // If not JSON, use the text as is (but limit length)
          errorMessage = text.length > 500 ? text.substring(0, 500) + '...' : text;
        }
      }
      
      console.error("Dataverse API Error:", errorMessage);
      
      // Return error object instead of throwing
      return { 
        error: errorMessage,
        success: false,
        statusCode: response.status,
        timestamp: new Date().toISOString()
      };
    }

    // Try to parse successful response
    try {
      const data = JSON.parse(text);
      return {
        ...data,
        success: true,
        timestamp: new Date().toISOString()
      };
    } catch {
      // If response is not JSON, return as text
      return {
        data: text,
        success: true,
        timestamp: new Date().toISOString()
      };
    }
  } catch (error) {
    console.error("Error creating Dataverse data:", error);
    
    // Return consistent error format
    return { 
      error: error.message || 'Network error occurred',
      success: false,
      details: error.stack,
      timestamp: new Date().toISOString()
    };
  }
}

async function getDataverse(url, token) {
  const headers = {
    Authorization: `Bearer ${token.includes('"') ? JSON.parse(token) : token}`,
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
  };


  const options = {
    method: "GET",
    headers: headers,
  };
    console.log(`urloepte`,url,options);
  

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      
      // Try to get more detailed error info
      try {
        const errorText = await response.text();
        if (errorText) {
          try {
            const errorData = JSON.parse(errorText);
            errorMessage = errorData.error?.message || errorData.message || errorText;
          } catch {
            errorMessage = errorText.length > 500 ? errorText.substring(0, 500) + '...' : errorText;
          }
        }
      } catch {
        // Use default error message if can't read response
      }
      
      console.error("Dataverse GET Error:", errorMessage);
      
      // Specific error handling for common status codes
      if (response.status === 401) {
        return {
          error: "Unauthorized - Authentication required",
          success: false,
          statusCode: 401,
          requiresAuth: true,
          timestamp: new Date().toISOString()
        };
      }
      
      if (response.status === 404) {
        return {
          error: "Resource not found",
          success: false,
          statusCode: 404,
          timestamp: new Date().toISOString()
        };
      }
      
      return {
        error: errorMessage,
        success: false,
        statusCode: response.status,
        timestamp: new Date().toISOString()
      };
    }
    
    const data = await response.json();
    return {
      ...data,
      success: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error fetching Dataverse data:", error);
    
    return { 
      error: error.message || 'Network error occurred',
      success: false,
      details: error.stack,
      timestamp: new Date().toISOString()
    };
  }
}


async function getAccessTokenRequest(clientId, tenantId, crmUrl, verifier, type, token) {
  try {
    const grantType = type === "refresh" ? "refresh_token" : "authorization_code";
    const tokenParam = type === "refresh" ? "refresh_token" : "code";
    const cleanToken = token.includes('"') ? JSON.parse(token) : token;
    
    const body = `client_id=${clientId}&scope=${crmUrl}/.default&grant_type=${grantType}&${tokenParam}=${cleanToken}&redirect_uri=http://localhost:5678&code_verifier=${verifier}`;
    
    const response = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: {
          "Content-type": "application/x-www-form-urlencoded",
        },
        credentials: "omit",
        body: body,
      }
    );
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error("OAuth Error:", data.error_description || data.error);
      return {
        error: data.error_description || data.error || `HTTP ${response.status}`,
        error_description: data.error_description,
        success: false,
        statusCode: response.status,
        timestamp: new Date().toISOString()
      };
    }
    
    if (data.error) {
      console.error("OAuth Response Error:", data.error_description || data.error);
      return {
        error: data.error,
        error_description: data.error_description,
        success: false,
        timestamp: new Date().toISOString()
      };
    }
    
    return {
      ...data,
      success: true,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error in getAccessTokenRequest:", error);
    
    return {
      error: error.message || "Network error occurred",
      error_description: "Failed to get access token",
      success: false,
      timestamp: new Date().toISOString(),
      details: error.stack
    };
  }
}

// Fetch contacts from Dataverse CRM
async function fetchContactsFromDataverse(token, crmUrl, tenantId) {
  try {
    console.log(`📋 Fetching contacts from Dataverse CRM: ${crmUrl}`);
    
    // Define the fields we want to retrieve, including all possible LinkedIn URL fields
    const selectFields = [
      'contactid',
      'fullname',
      'firstname', 
      'lastname',
      'uds_linkedin',
    ].join(',');
    
    // Construct the endpoint for contacts with field selection and active contacts filter
    const endpoint = `${crmUrl}/api/data/v9.2/contacts?$select=${selectFields}&$filter=statecode eq 0`;
    
    console.log(`🔗 Fetching from endpoint: ${endpoint}`);
    console.log(`🔗 Fetching from token: ${token}`);
    
    // Use getDataverse function to fetch contacts
    const response = await getDataverse(endpoint, token);
    
    if (!response || response.error) {
      console.error(`❌ Error fetching contacts from Dataverse:`, response?.error || 'Unknown error');
      return [];
    }
    
    if (!response.value || !Array.isArray(response.value)) {
      console.error(`❌ Invalid response format from Dataverse contacts API:`, response);
      return [];
    }
    
    console.log(`✅ Successfully fetched ${response.value.length} contacts from Dataverse`);
    
    // Log the fields available in the first contact for debugging
    if (response.value.length > 0) {
      const firstContact = response.value[0];
      console.log(`📝 Available fields in first contact:`, Object.keys(firstContact));
      
      // Log all LinkedIn-related field values for debugging
      const linkedinFields = Object.keys(firstContact).filter(key => 
        key.toLowerCase().includes('linkedin') || 
        key.toLowerCase().includes('website') ||
        key.includes('uds_')
      );
      
      console.log(`🔗 LinkedIn-related fields in first contact:`, linkedinFields.reduce((obj, field) => {
        obj[field] = firstContact[field];
        return obj;
      }, {}));
    }
    
    // Return the contacts array
    return response.value;
    
  } catch (error) {
    console.error(`❌ Exception in fetchContactsFromDataverse:`, error.message);
    return [];
  }
}

module.exports = {
  createDataverse,
  getDataverse,
  getAccessTokenRequest,
  fetchContactsFromDataverse
};