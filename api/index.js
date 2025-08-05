const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
const PORT = 5678;

app.use(cors());
app.use(bodyParser.json());

let accessToken = "";
let codeVerifier = "";
let tokenEndpoint = "";
let clientId = "";
let tenantId = "";

app.post("/save-auth", (req, res) => {
  accessToken = req.body.accessToken;
  codeVerifier = req.body.codeVerifier;
  tokenEndpoint = req.body.tokenEndpoint;
  clientId = req.body.clientId;
  tenantId = req.body.tenantId;
  res.status(200).json({ message: "Saved successfully" });
});

app.post("/update-contacts-post", async (req, res) => {
  const { contacts, linkedInData, dataverseBaseUrl } = req.body;
  const results = [];
  const errors = [];

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const updateContact = async (contact) => {
    const linkedInContact = linkedInData.find(
      (data) =>
        data.fullName.toLowerCase() ===
        `${contact.firstname} ${contact.lastname}`.toLowerCase()
    );

    if (!linkedInContact || !linkedInContact.linkedinUrl) {
      return {
        success: false,
        contactId: contact.contactid,
        message: "LinkedIn URL not found",
      };
    }

    const updateUrl = `${dataverseBaseUrl}/contacts(${contact.contactid})`;

    try {
      await axios.patch(
        updateUrl,
        { new_linkedinurl: linkedInContact.linkedinUrl },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
        }
      );

      return {
        success: true,
        contactId: contact.contactid,
        linkedinUrl: linkedInContact.linkedinUrl,
      };
    } catch (error) {
      return {
        success: false,
        contactId: contact.contactid,
        message: error.response?.data || error.message,
      };
    }
  };

  const BATCH_SIZE = 10;
  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(updateContact));
    results.push(...batchResults.filter((r) => r.success));
    errors.push(...batchResults.filter((r) => !r.success));
    await delay(3000); // Delay between batches
  }

  res.status(200).json({ results, errors });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
