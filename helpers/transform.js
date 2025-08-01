function transformToCreateUserRequest(profileData) {
  const currentPosition = profileData.included.find(
    (item) =>
      item.$type === "com.linkedin.voyager.identity.profile.Position" &&
      !item.timePeriod?.endDate,
  );

  const currentCompany = currentPosition
    ? profileData.included.find((item) => item.entityUrn)
    : null;

  const positions = profileData.included.filter(
    (item) => item.$type === "com.linkedin.voyager.identity.profile.Position",
  );

  const sortedPositions = positions.sort((a, b) => {
    const dateA = new Date(
      `${a.timePeriod.startDate.year}-${a.timePeriod.startDate.month}-01`,
    );
    const dateB = new Date(
      `${b.timePeriod.startDate.year}-${b.timePeriod.startDate.month}-01`,
    );
    return dateB - dateA;
  });

  const latestPosition = sortedPositions[0];
  const latestCompanyUrn = latestPosition?.companyUrn;
  console.log(latestCompanyUrn, "latestCompanyUrn");

  const profile = profileData.included.find(
    (item) => item.$type === "com.linkedin.voyager.identity.profile.Profile",
  );

  const birthdate = profile?.birthDate
    ? `${profile.birthDate.year || "1900"}-${String(
        profile.birthDate.month,
      ).padStart(2, "0")}-${String(profile.birthDate.day).padStart(2, "0")}`
    : null;

  return {
    address1_name: profile?.address || "",
    jobtitle: currentPosition?.title || profile?.headline || "",
    description: profile?.summary || "",
    birthdate: birthdate,
  };
}

module.exports = {
  transformToCreateUserRequest,
};
