# LinkedIn Profile Processor API

## Overview

A sophisticated Node.js/Express API designed to automatically process LinkedIn profiles and update Microsoft Dataverse (CRM) contacts with intelligent human-like behavior patterns, CRM-based job sharing, and comprehensive rate limiting.

## 🚀 Key Features

### 🤖 **Human-Like Processing Patterns**
- **8 Time-Based Patterns**: Morning burst, afternoon work, evening light, weekends, lunch breaks, night rest
- **Intelligent Delays**: 1-5 minute delays between profiles based on time patterns
- **Automatic Breaks**: Pattern-aware break scheduling mimicking human behavior
- **Dynamic Scheduling**: Automatic pausing during lunch and night hours

### 🏢 **CRM-Based Job Sharing**
- **Multi-User Collaboration**: Multiple users from the same CRM share job progress
- **Unified Rate Limits**: Limits applied per CRM organization, not per individual user
- **Real-Time Synchronization**: All users see identical progress and status updates
- **Participant Management**: System tracks all users participating in shared jobs

### 🔐 **Advanced Authentication & Token Management**
- **Automatic Token Refresh**: Seamless renewal of expired access tokens
- **Graceful Fallback**: Jobs pause gracefully when authentication fails
- **Session Persistence**: User sessions survive server restarts via MongoDB
- **Multi-Platform Auth**: Supports both LinkedIn and Microsoft Dataverse authentication

### 📊 **Comprehensive Analytics & Monitoring**
- **Real-Time Progress Tracking**: Live job status with detailed statistics
- **Pattern Analytics**: Processing breakdown by time patterns
- **Success/Failure Metrics**: Detailed error reporting and success tracking
- **Job Age Monitoring**: Automatic detection and restart of stalled jobs

## 🏗️ System Architecture

### **Core Components**

```
├── api/
│   └── index.js              # Main API server with all endpoints
├── helpers/
│   ├── db.js                 # MongoDB data layer and schemas
│   ├── linkedin.js           # LinkedIn profile fetching and patterns
│   ├── dynamics.js           # Microsoft Dataverse integration
│   ├── transform.js          # Data transformation utilities
│   ├── delay.js              # Human-like delay calculations
│   ├── syncJobStats.js       # Job statistics synchronization
│   └── timeZone.js           # Time zone handling utilities
└── data/                     # Legacy file storage (migrated to MongoDB)
```

### **Database Schema (MongoDB)**

#### **Jobs Collection**
```javascript
{
  jobId: "job_1234567890_abc123",
  userId: "user123",                    // Original creator
  participants: ["user123", "user456"], // All CRM users sharing this job
  crmUrl: "normalized_crm_hostname",    // Normalized CRM identifier
  totalContacts: 75,
  contacts: [
    {
      contactId: "contact123",
      linkedinUrl: "https://linkedin.com/in/profile",
      status: "completed" // pending, processing, completed, failed
    }
  ],
  processedCount: 12,
  successCount: 11,
  failureCount: 1,
  status: "processing", // pending, processing, paused, completed, failed
  createdAt: "2025-01-13T09:30:00.000Z",
  humanPatterns: {
    startPattern: "morningBurst",
    patternHistory: []
  },
  dailyStats: {
    processedToday: 12,
    patternBreakdown: { "morningBurst": 12 },
    crmBased: true
  }
}
```

#### **User Sessions Collection**
```javascript
{
  userId: "user123",
  currentJobId: "job_1234567890_abc123",
  li_at: "linkedin_auth_token",
  jsessionid: "linkedin_session_id",
  accessToken: "dataverse_access_token",
  refreshToken: "dataverse_refresh_token",
  clientId: "azure_app_client_id",
  tenantId: "azure_tenant_id",
  verifier: "code_verifier",
  crmUrl: "https://org.crm.dynamics.com",
  lastActivity: "2025-01-13T10:15:00.000Z"
}
```

## 🕐 Human Processing Patterns

### **Pattern Schedule**

| Pattern | Time | Weekdays | Max Profiles | Delay Range | Description |
|---------|------|----------|--------------|-------------|-------------|
| **Morning Burst** | 9-11 AM | Mon-Fri | 25 | 1-2 min | High activity period |
| **Lunch Break** | 12-1 PM | Mon-Fri | 0 | N/A | Complete pause |
| **Afternoon Work** | 2-5 PM | Mon-Fri | 35 | 2-3 min | Main working period |
| **Evening Light** | 6-8 PM | Mon-Fri | 15 | 3-5 min | Reduced activity |
| **Night Rest** | 9 PM-8 AM | Daily | 0 | N/A | Complete pause |
| **Weekend Burst** | 9 AM-12 PM | Sat-Sun | 50 | 1-3 min | Weekend activity |
| **Weekend Afternoon** | 1-4 PM | Sat-Sun | 30 | 2-4 min | Relaxed weekend work |
| **Weekend Evening** | 5-9 PM | Sat-Sun | 25 | 3-6 min | Light weekend activity |

### **Rate Limiting System**

- **Daily Limit**: 180 profiles per CRM organization
- **Hourly Limit**: 15 profiles per hour per CRM
- **Pattern Limits**: Varies by time pattern (15-50 profiles)
- **CRM-Based**: All limits shared across users of the same CRM

## 🔗 API Endpoints

### **Job Management**

#### `POST /start-processing`
Starts a new LinkedIn profile processing job or resumes an existing one.

**Request Body:**
```json
{
  "userId": "user123",
  "li_at": "linkedin_auth_token",
  "jsessionid": "linkedin_session_id",
  "accessToken": "dataverse_access_token",
  "refreshToken": "dataverse_refresh_token",
  "clientId": "azure_app_client_id",
  "tenantId": "azure_tenant_id",
  "verifier": "code_verifier",
  "crmUrl": "https://org.crm.dynamics.com",
  "resume": false
}
```

**Response:**
```json
{
  "success": true,
  "message": "Processing started",
  "jobId": "job_1234567890_abc123",
  "totalContacts": 75,
  "processedCount": 0,
  "status": "processing",
  "currentPattern": "morningBurst",
  "limitInfo": {
    "canProcess": true,
    "dailyCount": 0,
    "hourlyCount": 0,
    "patternCount": 0,
    "dailyLimit": 180,
    "hourlyLimit": 15,
    "patternLimit": 25,
    "currentPattern": "morningBurst",
    "sharedLimits": "Shared with all users of org_crm_dynamics_com"
  }
}
```

#### `GET /job-status/:jobId`
Retrieves detailed status information for a specific job.

**Response:**
```json
{
  "success": true,
  "job": {
    "jobId": "job_1234567890_abc123",
    "status": "processing",
    "totalContacts": 75,
    "processedCount": 12,
    "successCount": 11,
    "failureCount": 1,
    "createdAt": "2025-01-13T09:30:00.000Z",
    "lastProcessedAt": "2025-01-13T10:15:00.000Z",
    "currentPattern": "morningBurst",
    "currentPatternInfo": {
      "name": "morningBurst",
      "time": "9-11 AM (Weekdays)",
      "profiles": 25,
      "delay": "1-2 min"
    },
    "dailyLimitInfo": {
      "canProcess": true,
      "dailyCount": 12,
      "patternCount": 12,
      "currentPattern": "morningBurst"
    },
    "humanPatterns": {
      "startPattern": "morningBurst",
      "startTime": "2025-01-13T09:30:00.000Z",
      "patternHistory": []
    },
    "isStalled": false,
    "restartCount": 0,
    "timeSinceLastProcess": 45
  }
}
```

#### `GET /user-job/:userId`
Gets the current active job for a specific user, including CRM-shared jobs.

**Response:**
```json
{
  "success": true,
  "canResume": true,
  "job": {
    "jobId": "job_1234567890_abc123",
    "status": "processing",
    "processedCount": 12,
    "totalContacts": 75,
    "jobAge": {
      "days": 0,
      "hours": 2,
      "isOld": false,
      "isVeryOld": false
    }
  },
  "authStatus": {
    "linkedinValid": true,
    "dataverseValid": true,
    "needsReauth": false,
    "lastError": null
  }
}
```

### **Monitoring & Polling**

#### `GET /job-poll/:userId`
Real-time job polling endpoint for frontend applications. Automatically resumes stalled jobs.

#### `GET /debug-job-memory/:userId`
Debug endpoint for troubleshooting job memory and session persistence.

**Response:**
```json
{
  "success": true,
  "debug": {
    "userId": "user123",
    "timestamp": "2025-01-13T10:15:00.000Z",
    "userSession": {
      "exists": true,
      "currentJobId": "job_1234567890_abc123",
      "lastActivity": "2025-01-13T10:15:00.000Z",
      "sessionKeys": ["currentJobId", "li_at", "accessToken", "crmUrl"]
    },
    "jobs": {
      "totalJobs": 1,
      "userJobs": [
        {
          "jobId": "job_1234567890_abc123",
          "status": "processing",
          "processedCount": 12,
          "totalContacts": 75
        }
      ]
    },
    "jobForCurrentSession": {
      "jobId": "job_1234567890_abc123",
      "status": "processing",
      "ageInDays": 0,
      "canResume": true
    }
  }
}
```

### **Human Patterns & Analytics**

#### `GET /human-patterns`
Retrieves information about all available human processing patterns.

**Response:**
```json
{
  "success": true,
  "currentPattern": {
    "name": "morningBurst",
    "info": {
      "time": "9-11 AM (Weekdays)",
      "profiles": 25,
      "delay": "1-2 min",
      "hourStart": 9,
      "hourEnd": 11,
      "minDelay": 60000,
      "maxDelay": 120000,
      "maxProfiles": 25,
      "weekdayOnly": true
    },
    "isActive": true
  },
  "allPatterns": {
    "morningBurst": { "..." },
    "afternoonWork": { "..." },
    "eveningLight": { "..." }
  },
  "nextActivePattern": {
    "name": "afternoonWork",
    "hourStart": 14
  },
  "estimatedResumeTime": null
}
```

#### `GET /daily-limits/:userId`
Checks current rate limits for a user.

#### `GET /pattern-stats/:userId`
Retrieves processing statistics broken down by pattern.

**Response:**
```json
{
  "success": true,
  "patternStats": {
    "morningBurst": {
      "processed": 12,
      "limit": 25,
      "isActive": true
    },
    "afternoonWork": {
      "processed": 0,
      "limit": 35,
      "isActive": false
    }
  },
  "dailyTotal": 12,
  "dailyLimit": 180
}
```

### **System Management**

#### `POST /refresh-token`
Manually refreshes authentication tokens.

**Request Body:**
```json
{
  "refreshToken": "refresh_token_here",
  "clientId": "azure_client_id",
  "tenantId": "azure_tenant_id",
  "crmUrl": "https://org.crm.dynamics.com",
  "verifier": "code_verifier"
}
```

#### `GET /health`
System health check with optional user status.

**Query Parameters:**
- `userId` (optional): Include user-specific health status

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-13T10:15:00.000Z",
  "currentPattern": {
    "name": "morningBurst",
    "isActive": true
  },
  "server": "LinkedIn Profile Processor with Human Patterns"
}
```

#### `POST /debug-restart-job/:jobId`
Manually restarts a stuck or failed job.

#### `GET /user-cooldown/:userId`
Checks if user is in cooldown period (30-day limit after completing all contacts).

#### `GET /user-jobs-history/:userId`
Retrieves complete job history for a user.

#### `POST /synchronize-job-stats/:userId`
Manually synchronizes job statistics with daily stats.

## 🔧 Configuration

### **Environment Variables**

```bash
# Server Configuration
PORT=3000

# MongoDB Configuration
MONGODB_URI=mongodb://localhost:27017/linkedin-processor

# Rate Limiting
DAILY_PROFILE_LIMIT=180
BURST_LIMIT=15

# Human Patterns (configured in code)
# See helpers/linkedin.js for pattern definitions
```

### **Rate Limits**

```javascript
const DAILY_PROFILE_LIMIT = 180;  // Conservative daily limit
const BURST_LIMIT = 15;           // Max profiles in one hour
```

## 🚀 Getting Started

### **Prerequisites**

- Node.js 16+
- MongoDB 4.4+
- Microsoft Azure App Registration
- LinkedIn Developer Account (for profile access)

### **Installation**

1. **Clone the repository:**
```bash
git clone <repository-url>
cd simplenode
```

2. **Install dependencies:**
```bash
npm install
```

3. **Set up environment variables:**
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. **Start MongoDB:**
```bash
# Local MongoDB
mongod

# Or MongoDB Atlas connection string in .env
```

5. **Initialize the database:**
```bash
# Database will be automatically initialized on first run
```

6. **Start the server:**
```bash
# Development
npm run dev

# Production
npm start
```

### **API Base URL**
```
http://localhost:3000
```

## 📋 Usage Examples

### **Starting a Processing Job**

```javascript
const response = await fetch('/start-processing', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user123',
    li_at: 'linkedin_auth_token',
    jsessionid: 'linkedin_session_id',
    accessToken: 'dataverse_access_token',
    refreshToken: 'dataverse_refresh_token',
    clientId: 'azure_client_id',
    tenantId: 'azure_tenant_id',
    verifier: 'code_verifier',
    crmUrl: 'https://org.crm.dynamics.com'
  })
});

const data = await response.json();
console.log('Job started:', data.jobId);
```

### **Monitoring Job Progress**

```javascript
// Poll job status every 15 seconds
const pollJobStatus = async (jobId) => {
  const response = await fetch(`/job-status/${jobId}`);
  const data = await response.json();
  
  console.log(`Progress: ${data.job.processedCount}/${data.job.totalContacts}`);
  console.log(`Status: ${data.job.status}`);
  console.log(`Current Pattern: ${data.job.currentPattern}`);
  
  return data.job;
};

setInterval(() => pollJobStatus('job_1234567890_abc123'), 15000);
```

### **Checking Current Limits**

```javascript
const checkLimits = async (userId) => {
  const response = await fetch(`/daily-limits/${userId}`);
  const data = await response.json();
  
  console.log('Daily processed:', data.limits.dailyCount);
  console.log('Can process:', data.limits.canProcess);
  console.log('Current pattern:', data.currentPattern.name);
};
```

## 🔍 Troubleshooting

### **Common Issues**

#### **Job Stuck in Processing**
```javascript
// Use debug restart endpoint
await fetch(`/debug-restart-job/${jobId}`, { method: 'POST' });
```

#### **Authentication Failures**
```javascript
// Check auth status
const response = await fetch(`/user-job/${userId}`);
const data = await response.json();

if (data.authStatus.needsReauth) {
  // Redirect user to re-authenticate
  window.location.href = '/auth';
}
```

#### **Rate Limit Issues**
```javascript
// Check current limits
const limits = await fetch(`/daily-limits/${userId}`);
console.log('Limit info:', limits.limitInfo);
```

### **Debug Endpoints**

- `/debug-job-memory/:userId` - Check job memory and sessions
- `/debug-restart-job/:jobId` - Manually restart stuck jobs
- `/health?userId=:userId` - System health with user status

## 🔐 Security Considerations

### **Authentication**
- All API calls require proper authentication tokens
- Tokens are automatically refreshed when possible
- Sessions are encrypted and stored securely in MongoDB

### **Rate Limiting**
- Built-in rate limiting prevents abuse
- CRM-based limits ensure fair usage across organizations
- Human-like patterns prevent detection

### **Data Protection**
- No sensitive data stored in logs
- Authentication tokens encrypted in database
- CORS properly configured for cross-origin requests

## 📊 Monitoring & Analytics

### **Available Metrics**
- Job completion rates
- Processing times by pattern
- Authentication failure rates
- System health indicators

### **Logging**
- Comprehensive logging for all operations
- Error tracking with context
- Performance monitoring

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Commit your changes: `git commit -am 'Add new feature'`
4. Push to the branch: `git push origin feature/new-feature`
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:
- Create an issue in the repository
- Check the troubleshooting section
- Use debug endpoints for diagnostics

---

*This API is designed to be robust, scalable, and human-like in its operation. It provides enterprise-grade LinkedIn profile processing with intelligent rate limiting and comprehensive monitoring capabilities.*
