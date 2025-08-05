const { getDataverse, createDataverse } = require("./dynamics");

function extractCompanyInfo(positionData, id) {
  if (!positionData) {
    return { name: "", location: "", id: "" };
  }

  return {
    name: positionData.companyName || "",
    address1_name:
      positionData.locationName || positionData.geoLocationName || "",
    uds_linkedincompanyid: id || "",
  };
}

function sanitizePhoneNumber(value) {
  if (!value) return "";
  
  const cleaned = value.replace(/\D/g, ""); // Remove non-digit characters
  
  // Check if the number is too large
  if (cleaned.length > 15) {
    console.warn(`⚠️ Phone number too long: ${cleaned}`);
    return "";
  }
  
  return cleaned;
}

// Enhanced validation for safe integers and large numbers
function validateSafeIntegers(obj) {
  for (const key in obj) {
    if (typeof obj[key] === "string") {
      // Check if the string represents a number
      if (/^-?\d+$/.test(obj[key])) {
        try {
          const num = BigInt(obj[key]);
          
          // If the number is too large, convert it to empty string
          if (num > BigInt(Number.MAX_SAFE_INTEGER) || num < BigInt(Number.MIN_SAFE_INTEGER)) {
            console.warn(`⚠️ Field "${key}" has unsafe integer: ${obj[key]}`);
            obj[key] = "";
          }
        } catch (e) {
          console.warn(`⚠️ Could not parse number in field "${key}": ${obj[key]}`);
          obj[key] = "";
        }
      }
    }
  }
  return obj;
}

async function transformToCreateUserRequest(profileData, endpoint, token) {
  try {
    // Check if profileData is valid
    if (
      !profileData ||
      !profileData.profileView ||
      !profileData.profileView.included
    ) {
      throw new Error(
        "Invalid LinkedIn data: profileView or included array is missing"
      );
    }

    const included = profileData.profileView.included;

    // Extract positions
    const positions = included.filter(
      (item) => item.$type === "com.linkedin.voyager.identity.profile.Position"
    );

    // Sort positions by start date (newest first)
    const sortedPositions = positions.sort((a, b) => {
      const getDate = (position) => {
        const start = position.timePeriod?.startDate;
        return new Date(`${start?.year || 0}-${start?.month || 1}-01`);
      };
      return getDate(b) - getDate(a);
    });

    const latestPosition = sortedPositions[0];
    const userRequest = {
      address1_name: "",
      jobtitle: latestPosition?.title || "",
      description: "",
      birthdate: null,
      emailaddress1: "",
      telephone1: "",
    };

    // Handle company association if position exists
    if (latestPosition?.companyUrn) {
      const idParts = latestPosition.companyUrn.split(":");
      const idOfCompany = idParts[idParts.length - 1];
      
      // Validate the ID isn't too large
      if (idOfCompany && idOfCompany.length <= 20) {
        const filter = `contains(uds_linkedincompanyid,'${idOfCompany}')`;
        const encodedFilter = encodeURIComponent(filter);
        const url = `${endpoint}/accounts?$filter=${encodedFilter}`;

        try {
          const companyResponse = await getDataverse(url, token);
          if (companyResponse?.value?.length > 0) {
            userRequest["parentcustomerid_account@odata.bind"] =
              `/accounts(${companyResponse.value[0].accountid})`;
          } else {
            console.log(latestPosition, "latestpso");
            const request = extractCompanyInfo(latestPosition, idOfCompany);
            const response = await createDataverse(
              `${endpoint}/accounts`,
              token,
              request,
              "POST"
            );
            if (response) {
              userRequest["parentcustomerid_account@odata.bind"] =
                `/accounts(${response.accountid})`;
            }
            console.log(response, "response of new company");
          }
        } catch (e) {
          console.error("Error checking company existence:", e.message);
        }
      } else {
        console.warn(`⚠️ LinkedIn company ID too long or invalid: ${idOfCompany}`);
      }
    }

    // Extract profile information
    const profile =
      included.find(
        (item) => item.$type === "com.linkedin.voyager.identity.profile.Profile"
      ) || {};

    // Handle birthdate
    const birth = profile.birthDate;
    if (birth?.month && birth?.day) {
      userRequest.birthdate = `1900-${String(birth.month).padStart(2, "0")}-${String(
        birth.day
      ).padStart(2, "0")}`;
    }

    // Extract contact info (prefer contactInfo section if available)
    const contactInfo = profileData.contactInfo?.data || {};

    // Use contactInfo email if available, otherwise try to extract from summary
    userRequest.emailaddress1 =
      contactInfo.emailAddress ||
      (profile.summary?.match(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
      ) || [])[0] ||
      "";

    // Use contactInfo phone if available, otherwise try to extract from summary
    const rawPhone = (
      contactInfo.phoneNumbers?.[0]?.number ||
      (profile.summary?.match(
        /(?:\+?\d{1,3})?\s?\(?\d{2,3}\)?[-.\s]?\d{3}[-.\s]?\d{4,6}/
      ) || [])[0] ||
      ""
    ).replace(/\s+/g, "");

    userRequest.telephone1 = sanitizePhoneNumber(rawPhone);

    // Set address and description
    userRequest.address1_name =
      profile.address || profile.locationName || contactInfo.address || "";
    userRequest.description = profile.summary || "";

    // 🔒 Safe integer and large number validation
    const cleaned = validateSafeIntegers(userRequest);

    // 📤 Log the final output
    console.log("📤 Sending to Dynamics:", JSON.stringify(cleaned, null, 2));

    return cleaned;
  } catch (error) {
    console.error("Error transforming LinkedIn profile data:", error);
    throw error;
  }
}

module.exports = {
  transformToCreateUserRequest,
};