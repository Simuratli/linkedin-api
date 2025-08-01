const express = require("express");
const cors = require("cors");
const { transformToCreateUserRequest } = require("../helpers/transform");
const { fetchLinkedInProfile } = require("../helpers/linkedin");
const { createDataverse, getDataverse } = require("../helpers/dynamics");
const { sleep , chunkArray} = require("../helpers/delay");
const app = express();
const PORT = process.env.PORT || 3000;

// SIMPLIFIED CORS setup for Chrome Extensions
app.use(cors());
app.use((req, res, next) => {
  // Allow all origins for development (you can restrict this later)
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With, Accept, Origin",
  );
  res.header("Access-Control-Max-Age", "86400"); // Cache preflight for 24 hours

  // Handle preflight requests
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
    const { li_at, accessToken, crmUrl, jsessionid } = req.body;

    if (!jsessionid || !accessToken || !crmUrl || !li_at) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: li_at, accessToken, and endpoint are required",
      });
    }

    const clientEndpoint = `${crmUrl}/api/data/v9.2`;
    const dataverseToken = accessToken;

    const response = await getDataverse(
      `${clientEndpoint}/contacts`,
      dataverseToken
    );

    if (!response || !response.value) {
      return res.status(400).json({
        success: false,
        message: "No contacts found or invalid response from Dataverse",
      });
    }

    const updateResults = [];
    const errors = [];

    const contacts = response.value.filter((c) => !!c.uds_linkedin);
    const BATCH_SIZE = 60;
    const WAIT_BETWEEN_BATCHES_MS = 60000; // 60 seconds
    const contactBatches = chunkArray(contacts, BATCH_SIZE);

    for (let batchIndex = 0; batchIndex < contactBatches.length; batchIndex++) {
      const batch = contactBatches[batchIndex];

      console.log(`Processing batch ${batchIndex + 1} of ${contactBatches.length}`);

      const promises = batch.map(async (contact) => {
        try {
          const match = contact.uds_linkedin.match(/\/in\/([^\/]+)/);
          const profileId = match ? match[1] : null;

          if (!profileId) {
            throw new Error(
              `Invalid LinkedIn URL format for contact ${contact.contactid}`
            );
          }

          const customCookies = {
            li_at: li_at,
            jsession: jsessionid || '"ajax:8767151925238686570"',
          };

          const profileData = await fetchLinkedInProfile(profileId, customCookies);

          if (profileData.error) {
            throw new Error(`LinkedIn API error: ${profileData.error}`);
          }

          const convertedProfile = transformToCreateUserRequest(profileData, clientEndpoint, accessToken);
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
      });

      await Promise.allSettled(promises);

      if (batchIndex < contactBatches.length - 1) {
        console.log(`Waiting ${WAIT_BETWEEN_BATCHES_MS / 1000}s before next batch...`);
        await sleep(WAIT_BETWEEN_BATCHES_MS);
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