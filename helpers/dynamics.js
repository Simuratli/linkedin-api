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

module.exports = {
  createDataverse,
  getDataverse,
  getAccessTokenRequest
};