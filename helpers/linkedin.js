const crypto = require("crypto");
const fetch = require("node-fetch");
const { getBakuTime, getBakuDateTime, getBakuHour, getBakuDay } = require('./timeZone');

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedIn/9.1.1",
  "LinkedIn/9.1.1 (iPhone; iOS 15.6; Scale/3.00)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

// Human behavior patterns based on time of day - ULTRA FAST TIMING
const HUMAN_PATTERNS = {
  morningBurst: {
    time: "9-11 AM (Weekdays)",
    profiles: 25,
    delay: "8-15 sec", // Ultra fast morning burst
    hourStart: 9,
    hourEnd: 11,
    minDelay: 8000, // 8 sec
    maxDelay: 15000, // 15 sec
    maxProfiles: 25,
    weekdayOnly: true,
  },
  lunchBreak: {
    time: "12-1 PM (Weekdays)",
    pause: true,
    hourStart: 12,
    hourEnd: 12,
    weekdayOnly: true,
  },
  afternoonWork: {
    time: "2-5 PM (Weekdays)",
    profiles: 35,
    delay: "10-20 sec", // Fast work pace
    hourStart: 14,
    hourEnd: 17,
    minDelay: 10000, // 10 sec
    maxDelay: 20000, // 20 sec
    maxProfiles: 35,
    weekdayOnly: true,
  },
  eveningLight: {
    time: "6-8 PM (Weekdays)",
    profiles: 30,
    delay: "12-25 sec", // Quick evening check
    hourStart: 18,
    hourEnd: 20,
    minDelay: 12000, // 12 sec
    maxDelay: 25000, // 25 sec
    maxProfiles: 30,
    weekdayOnly: true,
  },
  nightRest: {
    time: "9 PM-8 AM (All days)",
    pause: true,
    hourStart: 22,
    hourEnd: 22,
  },
  weekendBurst: {
    time: "9 AM-12 PM (Weekends)",
    profiles: 50,
    delay: "15-30 sec", // Fast weekend burst
    hourStart: 9,
    hourEnd: 12,
    minDelay: 15000, // 15 sec
    maxDelay: 30000, // 30 sec
    maxProfiles: 50,
    weekendOnly: true,
  },
  weekendEvening: {
    time: "5-9 PM (Weekends)",
    profiles: 25,
    delay: "20-40 sec", // Quick weekend evening
    hourStart: 17,
    hourEnd: 21,
    minDelay: 20000, // 20 sec
    maxDelay: 40000, // 40 sec
    maxProfiles: 25,
    weekendOnly: true,
  },
  weekendAfternoon: {
    time: "1-4 PM (Weekends)",
    profiles: 30,
    delay: "18-35 sec", // Efficient weekend afternoon
    hourStart: 13,
    hourEnd: 16,
    minDelay: 18000, // 18 sec
    maxDelay: 35000, // 35 sec
    maxProfiles: 30,
    weekendOnly: true,
  },
};

// Get current human pattern based on time
function getCurrentHumanPattern() {
  const bakuHour = getBakuHour();
  const isWeekend = [0, 6].includes(getBakuDay()); // 0=Sunday, 6=Saturday


  // Check each pattern with weekday/weekend awareness
  for (const [patternName, pattern] of Object.entries(HUMAN_PATTERNS)) {
    // Skip if pattern doesn't match current day type
    if (pattern.weekendOnly && !isWeekend) continue;
    if (pattern.weekdayOnly && isWeekend) continue;

    if (pattern.hourStart <= pattern.hourEnd) {
      // Normal range (e.g., 9-11, 14-17)
      if (bakuHour >= pattern.hourStart && bakuHour < pattern.hourEnd) {
        return { name: patternName, ...pattern };
      }
    } else {
      // Overnight range (e.g., 21-8 means 9PM to 8AM)
      if (bakuHour >= pattern.hourStart || bakuHour < pattern.hourEnd) {
        return { name: patternName, ...pattern };
      }
    }
  }

  // Default to afternoon work if no pattern matches
  return { name: "afternoonWork", ...HUMAN_PATTERNS.afternoonWork };
}

// Check if current time is during a pause period
function isDuringPause() {
  const currentPattern = getCurrentHumanPattern();
  return currentPattern.pause === true;
}

// Get human-like delay based on current time pattern
function getHumanPatternDelay() {
  const currentPattern = getCurrentHumanPattern();

  if (currentPattern.pause) {
    // During pause periods, return longer delay (30-60 minutes)
    const pauseDelay = Math.floor(Math.random() * 1800000) + 1800000; // 30-60 min
    console.log(
      `⏸️ Currently in ${currentPattern.name} (${currentPattern.time}) - pausing for ${Math.round(pauseDelay / 60000)} minutes`
    );
    return pauseDelay;
  }

  // During active periods, use pattern-specific delays
  const delay =
    Math.floor(
      Math.random() * (currentPattern.maxDelay - currentPattern.minDelay + 1)
    ) + currentPattern.minDelay;
  console.log(
    `⏱️ ${currentPattern.name} pattern (${currentPattern.time}) - waiting ${Math.round(delay / 1000)} seconds`
  );
  return delay;
}

// Enhanced human-like delay patterns
function getRandomDelay(min = 3000, max = 8000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getHumanReadingDelay() {
  const currentPattern = getCurrentHumanPattern();

  if (currentPattern.pause) {
    return Math.floor(Math.random() * 45000) + 30000; // 30-75s during pause
  }

  // Adjust reading time based on time of day
  const baseMin = currentPattern.name === "morningBurst" ? 10000 : 15000;
  const baseMax = currentPattern.name === "eveningLight" ? 60000 : 45000;

  return Math.floor(Math.random() * (baseMax - baseMin)) + baseMin;
}

function getPageNavigationDelay() {
  const currentPattern = getCurrentHumanPattern();

  if (currentPattern.pause) {
    return Math.floor(Math.random() * 8000) + 5000; // 5-13s during pause
  }

  // Faster navigation in morning, slower in evening
  const baseDelay = currentPattern.name === "morningBurst" ? 1500 : 2000;
  const maxDelay = currentPattern.name === "eveningLight" ? 8000 : 5000;

  return Math.floor(Math.random() * (maxDelay - baseDelay)) + baseDelay;
}

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function generateSessionId() {
  return `"ajax:${crypto.randomInt(1e18, 1e19 - 1)}"`; // tırnak kapandı
}

function getHeaders(csrf, cookieObj, profileId) {
  const cookieHeader = Object.entries(cookieObj)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  return {
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "cache-control": "no-cache",
    "csrf-token": csrf,
    cookie: cookieHeader,
    dnt: "1",
    pragma: "no-cache",
    referer: `https://www.linkedin.com/in/${profileId}/`,
    "sec-ch-ua":
      '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": getRandomUserAgent(),
    "x-li-lang": "en_US",
    "x-li-page-instance": `urn:li:page:d_flagship3_profile_view_base;${crypto.randomUUID()}`,
    "x-restli-protocol-version": "2.0.0",
  };
}

class SimpleQueue {
  constructor() {
    this.lastRequest = 0;
    this.requestCount = 0;
    this.hourStart = Date.now();
    this.dailyCount = 0;
    this.dailyStart = this.getTodayStart();
    this.currentPatternCount = 0;
  }

  getTodayStart() {
    const today = getBakuDateTime();
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }

  resetDailyCountIfNeeded() {
    const now = Date.now();
    const todayStart = this.getTodayStart();

    if (todayStart > this.dailyStart) {
      this.dailyCount = 0;
      this.dailyStart = todayStart;
      console.log("🆕 New day started - daily count reset");
    }
  }

  checkHumanPatternLimits() {
    const currentPattern = getCurrentHumanPattern();

    if (currentPattern.pause) {
      return {
        shouldWait: true,
        reason: "pause_period",
        pattern: currentPattern.name,
      };
    }

    if (
      currentPattern.maxProfiles &&
      this.currentPatternCount >= currentPattern.maxProfiles
    ) {
      console.log(
        `📊 Pattern limit reached for ${currentPattern.name}: ${this.currentPatternCount}/${currentPattern.maxProfiles}`
      );
      return {
        shouldWait: true,
        reason: "pattern_limit",
        pattern: currentPattern.name,
      };
    }

    return { shouldWait: false };
  }

  async add(requestFn) {
    const now = Date.now();
    this.resetDailyCountIfNeeded();

    if (now - this.hourStart > 3600000) {
      this.requestCount = 0;
      this.hourStart = now;
      this.currentPatternCount = 0;
    }

    const patternCheck = this.checkHumanPatternLimits();
    if (patternCheck.shouldWait) {
      if (patternCheck.reason === "pause_period") {
        const pauseDelay = getHumanPatternDelay();
        console.log(
          `⏸️ In ${patternCheck.pattern} - pausing for ${Math.round(pauseDelay / 60000)} minutes`
        );
        await new Promise((resolve) => setTimeout(resolve, pauseDelay));
        return this.add(requestFn);
      } else if (patternCheck.reason === "pattern_limit") {
        const nextHour = new Date();
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        const waitTime = nextHour.getTime() - now;
        console.log(
          `⏳ Pattern limit reached. Waiting ${Math.round(waitTime / 60000)} minutes for next period...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        this.currentPatternCount = 0;
        return this.add(requestFn);
      }
    }

    if (this.requestCount >= 15) {
      const waitUntilNextHour = 3600000 - (now - this.hourStart);
      if (waitUntilNextHour > 0) {
        console.log(
          `⏳ Hourly rate limit reached. Waiting ${Math.round(waitUntilNextHour / 1000 / 60)} minutes...`
        );
        await new Promise((resolve) => setTimeout(resolve, waitUntilNextHour));
        this.requestCount = 0;
        this.currentPatternCount = 0;
        this.hourStart = Date.now();
      }
    }

    const patternDelay = getHumanPatternDelay();
    const timeSinceLastRequest = now - this.lastRequest;

    if (timeSinceLastRequest < patternDelay) {
      const waitTime = patternDelay - timeSinceLastRequest;
      console.log(
        `⏳ Human pattern delay: waiting ${Math.round(waitTime / 1000)} seconds...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    const jitter = getRandomDelay(2000, 8000); // Ultra fast: 2-8 seconds
    console.log(
      `😴 Human behavior jitter: additional ${Math.round(jitter / 1000)} second pause...`
    );
    await new Promise((resolve) => setTimeout(resolve, jitter));

    this.lastRequest = Date.now();
    this.requestCount++;
    this.currentPatternCount++;
    this.dailyCount++;

    const currentPattern = getCurrentHumanPattern();
    console.log(
      `📊 Request ${this.requestCount}/15 this hour | Pattern: ${currentPattern.name} (${this.currentPatternCount}/${currentPattern.maxProfiles || "∞"}) | Daily: ${this.dailyCount}`
    );

    return await requestFn();
  }
}

const requestQueue = new SimpleQueue();

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      if (error.message.includes("429") || error.message.includes("403")) {
        const currentPattern = getCurrentHumanPattern();
        const baseDelay = currentPattern.pause ? 30000 : 15000;
        const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
        const jitter = Math.random() * exponentialDelay * 0.5;
        const backoffDelay = exponentialDelay + jitter;

        console.log(
          `⚠️ Rate limited (attempt ${attempt}) during ${currentPattern.name}, waiting ${Math.round(backoffDelay / 1000)} seconds...`
        );
        await new Promise((resolve) => setTimeout(resolve, backoffDelay));
      } else {
        const errorDelay = isDuringPause()
          ? getRandomDelay(10000, 30000)
          : getRandomDelay(5000, 15000);
        console.log(
          `❌ Error on attempt ${attempt}, retrying in ${Math.round(errorDelay / 1000)} seconds...`
        );
        await new Promise((resolve) => setTimeout(resolve, errorDelay));
      }
    }
  }
}

async function simulateHumanBrowsing() {
  const currentPattern = getCurrentHumanPattern();

  const actions = [
    {
      name: "scroll",
      delay: currentPattern.pause
        ? getRandomDelay(1000, 4000)
        : getRandomDelay(500, 2000),
    },
    {
      name: "pause",
      delay: currentPattern.pause
        ? getRandomDelay(3000, 8000)
        : getRandomDelay(1000, 4000),
    },
    { name: "read", delay: getHumanReadingDelay() },
  ];

  let actionWeights;
  switch (currentPattern.name) {
    case "morningBurst":
      actionWeights = [0.4, 0.4, 0.2];
      break;
    case "eveningLight":
      actionWeights = [0.2, 0.3, 0.5];
      break;
    default:
      actionWeights = [0.33, 0.33, 0.34];
  }

  const random = Math.random();
  let selectedAction;
  if (random < actionWeights[0]) selectedAction = actions[0];
  else if (random < actionWeights[0] + actionWeights[1])
    selectedAction = actions[1];
  else selectedAction = actions[2];

  console.log(
    `🤖 ${currentPattern.name}: Simulating human ${selectedAction.name} for ${Math.round(selectedAction.delay / 1000)}s...`
  );
  await new Promise((resolve) => setTimeout(resolve, selectedAction.delay));
}

async function fetchLinkedInProfile(profileId, customCookies = null) {
  return requestQueue.add(async () => {
    const profileViewUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileView`;
    const contactInfoUrl = `https://www.linkedin.com/voyager/api/identity/profiles/${profileId}/profileContactInfo`;

    const cookies = {
      JSESSIONID: customCookies?.jsession || generateSessionId(),
      li_at: customCookies?.li_at || "YOUR_LI_AT_TOKEN_HERE",
      liap: "true",
      timezone: "Asia/Baku", // Update timezone to Baku
      lang: "v=2&lang=en-us",
    };

    const csrfToken = cookies.JSESSIONID.replace(/"/g, "");
    const headers = getHeaders(csrfToken, cookies, profileId);

    return withRetry(async () => {
      try {
        const currentPattern = getCurrentHumanPattern();
        console.log(
          `🔍 Fetching LinkedIn profile: ${profileId} (${currentPattern.name} pattern)`
        );

        await simulateHumanBrowsing();

        const profileViewResponse = await fetch(profileViewUrl, {
          headers,
          credentials: "include",
        });

        if (!profileViewResponse.ok) {
          if (profileViewResponse.status === 429)
            throw new Error(`Rate limited: ${profileViewResponse.status}`);
          if (profileViewResponse.status === 403)
            throw new Error(`Access forbidden: ${profileViewResponse.status}`);
          throw new Error(`Profile fetch error: ${profileViewResponse.status}`);
        }

        const navigationDelay = getPageNavigationDelay();
        console.log(
          `🧑‍💻 Human navigation pause (${currentPattern.name}): ${Math.round(navigationDelay / 1000)}s before contact info...`
        );
        await new Promise((resolve) => setTimeout(resolve, navigationDelay));

        let contactInfoData = null;
        const contactInfoResponse = await fetch(contactInfoUrl, {
          headers: {
            ...headers,
            referer: `https://www.linkedin.com/in/${profileId}/overlay/contact-info/`,
          },
          credentials: "include",
        });

        if (contactInfoResponse.ok)
          contactInfoData = await contactInfoResponse.json();
        else
          console.warn(
            `⚠️ Contact info failed for ${profileId}: ${contactInfoResponse.status}`
          );

        const profileViewData = await profileViewResponse.json();
        await simulateHumanBrowsing();

        return {
          profileView: profileViewData,
          contactInfo: contactInfoData,
          combined: { ...profileViewData, contactInfo: contactInfoData },
          humanPattern: currentPattern.name,
        };
      } catch (error) {
        console.error(`❌ Error fetching ${profileId}:`, error.message);
        throw error;
      }
    });
  });
}

module.exports = {
  fetchLinkedInProfile,
  generateSessionId,
  getCurrentHumanPattern,
  isDuringPause,
  HUMAN_PATTERNS,
};
