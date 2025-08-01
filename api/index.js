const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// SIMPLIFIED CORS setup for Chrome Extensions
app.use((req, res, next) => {
  // Allow all origins for development (you can restrict this later)
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  } else {
    next();
  }
});

// CRITICAL: Add body parser middleware AFTER CORS
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const token =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL2V4cC0yMy0wOC0yNS5jcm0uZHluYW1pY3MuY29tLyIsImlzcyI6Imh0dHBzOi8vc3RzLndpbmRvd3MubmV0L2IzNjIyMGU3LTJhYjMtNGM3YS05YjZmLWY0ODI4MDdhYmI4ZC8iLCJpYXQiOjE3NTM5NTk3MDUsIm5iZiI6MTc1Mzk1OTcwNSwiZXhwIjoxNzUzOTY0NDU1LCJhY2N0IjowLCJhY3IiOiIxIiwiYWlvIjoiQVVRQXUvOFpBQUFBTmlSTGJUMU1rdGJCVldFdkNMM3pLQzZTelF0OU1JbTIrQTl4RG1EaFNwMHc3TTBGNEJqQzJPcHRIU1ZZdTJKUjkvODdXelhXY0tmMjQxYndHNXptdUE9PSIsImFtciI6WyJwd2QiXSwiYXBwaWQiOiIyZDg1YmQ4Zi0xOTA4LTQwODMtYmM1Zi1iYjVmZTU0MGY5YTYiLCJhcHBpZGFjciI6IjAiLCJmYW1pbHlfbmFtZSI6ImFkbWluZGVtbyIsImdpdmVuX25hbWUiOiJ0cmlhbCIsImlkdHlwIjoidXNlciIsImlwYWRkciI6IjE4OC4yNTMuMjA4Ljg4IiwibG9naW5faGludCI6Ik8uQ2lRMVlqWTNORFEyTUMwMk1qWTBMVFEzTjJVdFlUQTFPUzFrTnpkbVltVTVOVFF3WlRZU0pHSXpOakl5TUdVM0xUSmhZak10TkdNM1lTMDVZalptTFdZME9ESTRNRGRoWW1JNFpCb3ZkSEpwWVd4aFpHMXBibVJsYlc5QWRXUnpkSEpwWVd4elpHVnRiekk1TlM1dmJtMXBZM0p2YzI5bWRDNWpiMjBnZVE9PSIsIm5hbWUiOiJ0cmlhbCBhZG1pbmRlbW8iLCJvaWQiOiI1YjY3NDQ2MC02MjY0LTQ3N2UtYTA1OS1kNzdmYmU5NTQwZTYiLCJwdWlkIjoiMTAwMzIwMDRFQzY3NTRCQSIsInJoIjoiMS5BWEVCNXlCaXM3TXFla3liYl9TQ2dIcTdqUWNBQUFBQUFBQUF3QUFBQUFBQUFBRFlBWDl4QVEuIiwic2NwIjoidXNlcl9pbXBlcnNvbmF0aW9uIiwic2lkIjoiMDA2ZjQ0NzktMTNhYy05YTYxLTZiN2QtYjdkN2FmZGFjZjBhIiwic3ViIjoibVZxYmlMQnRNakg3V1ZuNGl1Tl9BOWlDR2ZSV3FpN0lFWDZTczJGVXVhSSIsInRlbmFudF9yZWdpb25fc2NvcGUiOiJOQSIsInRpZCI6ImIzNjIyMGU3LTJhYjMtNGM3YS05YjZmLWY0ODI4MDdhYmI4ZCIsInVuaXF1ZV9uYW1lIjoidHJpYWxhZG1pbmRlbW9AdWRzdHJpYWxzZGVtbzI5NS5vbm1pY3Jvc29mdC5jb20iLCJ1cG4iOiJ0cmlhbGFkbWluZGVtb0B1ZHN0cmlhbHNkZW1vMjk1Lm9ubWljcm9zb2Z0LmNvbSIsInV0aSI6IkxVd2EyaWhFOEVTM2g1XzJsRjFIQUEiLCJ2ZXIiOiIxLjAiLCJ3aWRzIjpbIjYyZTkwMzk0LTY5ZjUtNDIzNy05MTkwLTAxMjE3NzE0NWUxMCIsImI3OWZiZjRkLTNlZjktNDY4OS04MTQzLTc2YjE5NGU4NTUwOSJdLCJ4bXNfZnRkIjoiS1A0c2VycnlxUGEzYzhRU2tDcEM0VHRqVk5WV2gyTEpNaEZnZjZYa000a0JkWE51YjNKMGFDMWtjMjF6IiwieG1zX2lkcmVsIjoiOCAxIn0.jqXhFGm0v2PiMtwRuTzhxwxkinQ9Ihe0zWVQ6G_qtS12ILYEAbPzJ1eu4ufB2iHUVIrVhXfuBWki69smKRyQzHHPtQ7B0771RDbZYSlxgZiEBof8P618Z_Y_4F8qKkg43Szh0T3NimRvyxqt6_RGYsbyMxivVRHPZ1N0Hq9Mmlve3xqYnRO0tzkn2o6VRYcaKTnVW_MbVisbK7WFgRR8PPB9LWQJyrpaMb3dwfnj2Es4dXeoIWPJp6qNWgAqFS4WN66NaWaJZv5iWOjH8H63TSj1Qq-4UdSoZUUuNV4fH1LB9OvildBL7mmzcFDWjFFgzVkmor1awf7w0qW2Vqei3Q";

const crmUrl = `https://exp-23-08-25.crm.dynamics.com/`;
const endpoint = `${crmUrl}/api/data/v9.2`;

async function createDataverse(url, token, request, method) {
  const headers = {
    Authorization: `Bearer ${token.includes('"') ? JSON.parse(token) : token}`,
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
      console.error("Error Text:", text);
      throw new Error(`Error Text: ${text}`);
    }

    try {
      const data = JSON.parse(text);
      return data;
    } catch {
      return text;
    }
  } catch (error) {
    console.error("Error creating Dataverse data:", error);
    return { error: error.stack || error.message };
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
    const data = await response.json();
    return data;
  } catch (error) {
    return { error: error };
  }
}

// Default cookies for testing (your existing ones)
const defaultCookies = {
  JSESSIONID: '"ajax:8767151925238686570"',
  li_at: "AQEDASyb8_4Dn7z0AAABl2LysiAAAAGYT9ZH-k4AhMjoJtNwVZtohs347zdb8N7EZ6nzNRfELAbl8nkqmlpfLMFAFiLuiMM1jQt_1i-GIHoUj90uxi4Udqa-MwUfB2hJ5YNDd49oWNUwJNdL9x0bxCnk",
};

// FIXED: Updated function to accept cookies parameter
function getHeaders(csrf, cookieObj) {
  const cookieHeader = Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  return {
    "csrf-token": csrf,
    cookie: cookieHeader,
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-li-lang": "en_US",
    "x-restli-protocol-version": "2.0.0",
  };
}

function transformToCreateUserRequest(profileData) {
  const currentPosition = profileData.included.find(
    (item) =>
      item.$type === "com.linkedin.voyager.identity.profile.Position" &&
      !item.timePeriod?.endDate
  );

  const currentCompany = currentPosition
    ? profileData.included.find((item) => item.entityUrn)
    : null;

  const positions = profileData.included.filter(
    (item) => item.$type === "com.linkedin.voyager.identity.profile.Position"
  );

  const sortedPositions = positions.sort((a, b) => {
    const dateA = new Date(
      `${a.timePeriod.startDate.year}-${a.timePeriod.startDate.month}-01`
    );
    const dateB = new Date(
      `${b.timePeriod.startDate.year}-${b.timePeriod.startDate.month}-01`
    );
    return dateB - dateA;
  });

  const latestPosition = sortedPositions[0];
  const latestCompanyUrn = latestPosition?.companyUrn;
  console.log(latestCompanyUrn, "latestCompanyUrn");

  const profile = profileData.included.find(
    (item) => item.$type === "com.linkedin.voyager.identity.profile.Profile"
  );

  const birthdate = profile?.birthDate
    ? `${profile.birthDate.year || "1900"}-${String(
        profile.birthDate.month
      ).padStart(2, "0")}-${String(profile.birthDate.day).padStart(2, "0")}`
    : null;

  return {
    address1_name: profile?.address || "",
    jobtitle: currentPosition?.title || profile?.headline || "",
    description: profile?.summary || "",
    birthdate: birthdate,
  };
}

// FIXED: Updated fetchLinkedInProfile to accept cookies parameter
async function fetchLinkedInProfile(profileId, customCookies = null) {
  const url = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
  
  // Use provided cookies or fall back to default ones
  const cookiesToUse = customCookies || defaultCookies;
  
  // Build cookies object properly
  const cookies = {
    JSESSIONID: customCookies?.jsession || defaultCookies.JSESSIONID,
    li_at: customCookies?.li_at || defaultCookies.li_at,
  };

  const csrfToken = cookies.JSESSIONID.replace(/"/g, "");
  const headers = getHeaders(csrfToken, cookies);

  console.log("Using cookies:", cookies);
  console.log("Headers:", headers);

  try {
    const res = await fetch(url, {
      headers,
      credentials: "include",
    });

    if (!res.ok) {
      throw new Error(`LinkedIn fetch error: ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    console.error("❌ Error:", err.message);
    return { error: err.message };
  }
}

// Your existing routes
app.get("/get-accounts", async (req, res) => {
  try {
    const response = await getDataverse(`${endpoint}/accounts`, token);
    const data = response;
    res.json(data);
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/get-contacts", async (req, res) => {
  try {
    const response = await getDataverse(`${endpoint}/contacts`, token);
    const data = response;
    res.json(data);
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

app.get("/get-linkedinId", async (req, res) => {
  try {
    const response = await getDataverse(`${endpoint}/contacts`, token);
    const data = response;
    res.json(data);
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// Original GET route (for testing)
app.get("/update-contacts", async (req, res) => {
  try {
    const response = await getDataverse(`${endpoint}/contacts`, token);

    if (!response || !response.value) {
      return res.status(400).json({
        success: false,
        message: "No contacts found or invalid response from Dataverse",
      });
    }

    const updateResults = [];
    const errors = [];

    for (const contact of response.value) {
      try {
        if (!contact.uds_linkedin) {
          console.log(`No LinkedIn URL for contact ${contact.contactid}`);
          continue;
        }

        const match = contact.uds_linkedin.match(/\/in\/([^\/]+)/);
        const profileId = match ? match[1] : null;

        if (!profileId) {
          console.log(
            `Invalid LinkedIn URL format for contact ${contact.contactid}`
          );
          continue;
        }

        const profileData = await fetchLinkedInProfile(profileId);
        const convertedProfile = transformToCreateUserRequest(profileData);

        const updateUrl = `${endpoint}/contacts(${contact.contactid})`;
        const updateResponse = await createDataverse(
          updateUrl,
          token,
          convertedProfile,
          "PATCH"
        );

        updateResults.push({
          contactId: contact.contactid,
          success: true,
          profileId: profileId,
          response: updateResponse,
        });
      } catch (error) {
        console.error(`Error processing contact ${contact.contactid}:`, error);
        errors.push({
          contactId: contact.contactid,
          success: false,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      message: "LinkedIn profile update process completed",
      stats: {
        totalContacts: response.value.length,
        updated: updateResults.length,
        failed: errors.length,
      },
      updates: updateResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error in /update-contacts:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// FIXED: Updated POST route with proper cookie handling
app.post("/update-contacts-post", async (req, res) => {
  try {
    console.log("Request Body:", req.body);

    const { li_at, accessToken, crmUrl,jsessionid  } = req.body;

    if (!jsessionid || !accessToken || !crmUrl || !li_at) {
      return res.status(400).json({
        success: false,
        message: "Missing required parameters: li_at, accessToken, and endpoint are required",
      });
    }

    const clientEndpoint =  `${crmUrl}/api/data/v9.2`

    const dataverseToken = accessToken;
    const response = await getDataverse(`${clientEndpoint}/contacts`, dataverseToken);

    if (!response || !response.value) {
      return res.status(400).json({
        success: false,
        message: "No contacts found or invalid response from Dataverse",
      });
    }

    const updateResults = [];
    const errors = [];

    for (const contact of response.value) {
      try {
        if (!contact.uds_linkedin) {
          console.log(`No LinkedIn URL for contact ${contact.contactid}`);
          continue;
        }

        const match = contact.uds_linkedin.match(/\/in\/([^\/]+)/);
        const profileId = match ? match[1] : null;

        if (!profileId) {
          console.log(
            `Invalid LinkedIn URL format for contact ${contact.contactid}`
          );
          continue;
        }

        // Use the cookies from the request
        const customCookies = {
          li_at: li_at,
          jsession: jsessionid || '"ajax:8767151925238686570"' // fallback to default if not provided
        };

        console.log(`Fetching profile for ${profileId} with cookies:`, customCookies);

        const profileData = await fetchLinkedInProfile(profileId, customCookies);
        
        if (profileData.error) {
          throw new Error(`LinkedIn API error: ${profileData.error}`);
        }

        const convertedProfile = transformToCreateUserRequest(profileData);

        const updateUrl = `${clientEndpoint}/contacts(${contact.contactid})`;
        const updateResponse = await createDataverse(
          updateUrl,
          dataverseToken,
          convertedProfile,
          "PATCH"
        );

        updateResults.push({
          contactId: contact.contactid,
          success: true,
          profileId: profileId,
          response: updateResponse,
        });
      } catch (error) {
        console.error(`Error processing contact ${contact.contactid}:`, error);
        errors.push({
          contactId: contact.contactid,
          success: false,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      message: "LinkedIn profile update process completed",
      stats: {
        totalContacts: response.value.length,
        updated: updateResults.length,
        failed: errors.length,
      },
      updates: updateResults,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error in /update-contacts-post:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
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