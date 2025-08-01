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

module.exports = {
  fetchLinkedInProfile,
};
