const express = require("express");
const { transformToCreateUserRequest } = require("./helpers/transform");
const { fetchLinkedInProfile, initializeFreeProxyClient } = require("./helpers/linkedin");
const app = express();
const PORT = 3000;

const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL2V4cC0yMy0wOC0yNS5jcm0uZHluYW1pY3MuY29tLyIsImlzcyI6Imh0dHBzOi8vc3RzLndpbmRvd3MubmV0L2IzNjIyMGU3LTJhYjMtNGM3YS05YjZmLWY0ODI4MDdhYmI4ZC8iLCJpYXQiOjE3NTQwNDMyMjIsIm5iZiI6MTc1NDA0MzIyMiwiZXhwIjoxNzU0MDQ4NTgzLCJhY2N0IjowLCJhY3IiOiIxIiwiYWlvIjoiQVVRQXUvOFpBQUFBRDNnenlDMkg3a1Rod2tXTGp0N1BFMGM0VkJYY3ByRTRxaWlOd2V6WEFnMCtPNU5KWU1NVXduaUg4VmZ4MUxVOWVnbllqL2ZSNk1hOHFmUkp1eXZQL1E9PSIsImFtciI6WyJwd2QiXSwiYXBwaWQiOiIyZDg1YmQ4Zi0xOTA4LTQwODMtYmM1Zi1iYjVmZTU0MGY5YTYiLCJhcHBpZGFjciI6IjAiLCJmYW1pbHlfbmFtZSI6ImFkbWluZGVtbyIsImdpdmVuX25hbWUiOiJ0cmlhbCIsImlkdHlwIjoidXNlciIsImlwYWRkciI6IjM3LjYxLjExMy4yMTgiLCJsb2dpbl9oaW50IjoiTy5DaVExWWpZM05EUTJNQzAyTWpZMExUUTNOMlV0WVRBMU9TMWtOemRtWW1VNU5UUXdaVFlTSkdJek5qSXlNR1UzTFRKaFlqTXROR00zWVMwNVlqWm1MV1kwT0RJNE1EZGhZbUk0WkJvdmRISnBZV3hoWkcxcGJtUmxiVzlBZFdSemRISnBZV3h6WkdWdGJ6STVOUzV2Ym0xcFkzSnZjMjltZEM1amIyMGdlUT09IiwibmFtZSI6InRyaWFsIGFkbWluZGVtbyIsIm9pZCI6IjViNjc0NDYwLTYyNjQtNDc3ZS1hMDU5LWQ3N2ZiZTk1NDBlNiIsInB1aWQiOiIxMDAzMjAwNEVDNjc1NEJBIiwicmgiOiIxLkFYRUI1eUJpczdNcWVreWJiX1NDZ0hxN2pRY0FBQUFBQUFBQXdBQUFBQUFBQUFEWUFYOXhBUS4iLCJzY3AiOiJ1c2VyX2ltcGVyc29uYXRpb24iLCJzaWQiOiIwMDZmNDQ3OS0xM2FjLTlhNjEtNmI3ZC1iN2Q3YWZkYWNmMGEiLCJzdWIiOiJtVnFiaUxCdE1qSDdXVm40aXVOX0E5aUNHZlJXcWk3SUVYNlNzMkZVdWFJIiwidGVuYW50X3JlZ2lvbl9zY29wZSI6Ik5BIiwidGlkIjoiYjM2MjIwZTctMmFiMy00YzdhLTliNmYtZjQ4MjgwN2FiYjhkIiwidW5pcXVlX25hbWUiOiJ0cmlhbGFkbWluZGVtb0B1ZHN0cmlhbHNkZW1vMjk1Lm9ubWljcm9zb2Z0LmNvbSIsInVwbiI6InRyaWFsYWRtaW5kZW1vQHVkc3RyaWFsc2RlbW8yOTUub25taWNyb3NvZnQuY29tIiwidXRpIjoiNElLanNvY1kta09fVGptSkl5U2JBQSIsInZlciI6IjEuMCIsIndpZHMiOlsiNjJlOTAzOTQtNjlmNS00MjM3LTkxOTAtMDEyMTc3MTQ1ZTEwIiwiYjc5ZmJmNGQtM2VmOS00Njg5LTgxNDMtNzZiMTk0ZTg1NTA5Il0sInhtc19mdGQiOiJZRkJNbXg5MXR2SUdSYlJyX3AzbWxmU3lGaDBPM2diU1ZGX0tPNWxaNEVBQmRYTmxZWE4wTFdSemJYTSIsInhtc19pZHJlbCI6IjEgMTYifQ.mLwxoj9DvwI0SUigUjxLrcH2PYS5zCf7dW4gRjfKBu-t9htH0bLxwtDoNLxnuIfKs-v8oEYAobC8xgMfS89lr96UpWYvXrCFy0p_7AeuMa3eKaXmsRvd2jxtCxJrfm4VpV9qBIZI4cNH_IONlodOmmK-fizp29ISy8OXsjXLRw4qC7YCfjLTlAzFs5oNo-eNsvClHKhlTgYe_j_t7T0VMp2FYwTGeUNBhJbg4x5sIWC01vZ6gUs5dgWuL1ZgNhrCnkF7vMH50aCh_PpzDYUeJQ6RaKSUDQP1e1G6OMOg1CzKFD7taAi703jOI-a7-u3VW3g6anPK1ntvWBEHewyvQw"
// const clientId = `c46c1cad-f01e-43f2-b070-786a4a96bed5`
// const tenantId =  `3afde653-4d50-499a-bf5d-7a4b99b814f9`
const crmUrl = `https://exp-23-08-25.crm.dynamics.com`;
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

    const text = await response.text(); // Read the body once here

    if (!response.ok) {
      console.error("Error Text:", text);
      throw new Error(`Error Text: ${text}`);
    }

    try {
      const data = JSON.parse(text);
      return data;
    } catch {
      // If not JSON, just return raw text or empty object
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
      console.log(response.status, "response status of dataverse");
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Unauthorized access - please log in again.");
        }
        if (response.status === 404) {
          throw new Error("Resource not found - please check the URL.");
        }
      
        throw new Error(`Error fetching data: ${response.statusText}`);
      }
      const data = await response.json();
      return data;
    } catch (error) {
      console.log(error, "error of datverse");
      return { error: error };
    }
  }

app.get("/get-accounts", async (req, res) => {
  try {
    const response = await getDataverse(`${endpoint}/accounts`, token);
    console.log("Response:", response);
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
    console.log("Response:", response);
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
    console.log("Response:", response);
    const data = response;
    res.json(data);
  } catch (error) {
    console.error("Fetch error:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// Fake kullanıcı: simuratli
const profileId = "simuratli";

// Gerekli LinkedIn çerezleri
const cookies = {
  JSESSIONID: '"ajax:8767151925238686570"', // LinkedIn'den alınan
  li_at:
    "AQEDASyb8_4Dn7z0AAABl2LysiAAAAGYT9ZH-k4AhMjoJtNwVZtohs347zdb8N7EZ6nzNRfELAbl8nkqmlpfLMFAFiLuiMM1jQt_1i-GIHoUj90uxi4Udqa-MwUfB2hJ5YNDd49oWNUwJNdL9x0bxCnk", // LinkedIn'den alınan
};

const csrfToken = cookies["JSESSIONID"].replace(/"/g, "");

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


app.get("/update-contacts", async (req, res) => {
  try {
    // Fetch contacts from Dataverse
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

        // Extract LinkedIn profile ID
        const match = contact.uds_linkedin.match(/\/in\/([^\/]+)/);
        const profileId = match ? match[1] : null;

        if (!profileId) {
          console.log(
            `Invalid LinkedIn URL format for contact ${contact.contactid}`
          );
          continue;
        }

        // Fetch LinkedIn profile data
        const profileData = await fetchLinkedInProfile(profileId);
        const convertedProfile = transformToCreateUserRequest(profileData);

        // Update contact in Dataverse
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

    // Return consolidated results
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

app.get("/simuratli", async (req, res) => {
  initializeFreeProxyClient()
  const data = await fetchLinkedInProfile("simuratli");
  const newdata = await transformToCreateUserRequest(data, endpoint, token);
  res.json(newdata);
});

app.get("/uds-lin", async (req, res) => {
  // URL encode the entire filter parameter
  const filter = `contains(uds_linkedincompanyid,'10889116')`;
  const encodedFilter = encodeURIComponent(filter);
  const url = `${endpoint}/accounts?$filter=${encodedFilter}`;
  
  
  console.log(url, "URL for checking company existence");
  let isCompanyExist = await getDataverse(url, token);
  res.json(isCompanyExist);
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
