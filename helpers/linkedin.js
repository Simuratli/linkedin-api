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


async function fetchLinkedInProfile(profileId, customCookies = null) {
  const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
  const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;
  
  
  // Build cookies object properly
  const cookies = {
    JSESSIONID: customCookies?.jsession || "ajax:8767151925238686570",
    li_at: customCookies?.li_at || "AQEDASyb8_4Dn7z0AAABl2LysiAAAAGYT9ZH-k4AhMjoJtNwVZtohs347zdb8N7EZ6nzNRfELAbl8nkqmlpfLMFAFiLuiMM1jQt_1i-GIHoUj90uxi4Udqa-MwUfB2hJ5YNDd49oWNUwJNdL9x0bxCnk",
  };
  
  const csrfToken = cookies.JSESSIONID.replace(/"/g, "");
  const headers = getHeaders(csrfToken, cookies);
  
  
  try {
    // Fetch both endpoints simultaneously
    const [profileViewResponse, contactInfoResponse] = await Promise.all([
      fetch(profileViewUrl, {
        headers,
        credentials: "include",
      }),
      fetch(contactInfoUrl, {
        headers,
        credentials: "include",
      })
    ]);
    console.log(contactInfoResponse,'contactInfoResponse')
    // Check if both requests were successful
    if (!profileViewResponse.ok) {
      throw new Error(`LinkedIn profile view fetch error: ${profileViewResponse.status}`);
    }
    
    if (!contactInfoResponse.ok) {
      throw new Error(`LinkedIn contact info fetch error: ${contactInfoResponse.status}`);
    }
    
    // Parse both responses
    const [profileViewData, contactInfoData] = await Promise.all([
      profileViewResponse.json(),
      contactInfoResponse.json()
    ]);
    
    // Combine the responses
    const combinedResponse = {
      profileView: profileViewData,
      contactInfo: contactInfoData,
      // You can also merge specific fields if needed
      combined: {
        ...profileViewData,
        contactInfo: contactInfoData
      }
    };
    
    console.log("✅ Successfully fetched both profile view and contact info");
    return combinedResponse;
    
  } catch (err) {
    console.error("❌ Error:", err.message);
    return { error: err.message };
  }
}
module.exports = {
  fetchLinkedInProfile,
};
