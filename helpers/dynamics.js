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

module.exports = {
  createDataverse,
  getDataverse,
};
