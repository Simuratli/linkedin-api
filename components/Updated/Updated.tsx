import React, { useState } from "react";
import './Updated.css'
import UpdateIcon from "../../assets/update-icon";

interface HumanPattern {
  name: string;
  time: string;
  hourStart: number;
  hourEnd: number;
  pause?: boolean;
  maxProfiles?: number;
  minDelay?: number;
  maxDelay?: number;
  weekdayOnly?: boolean;
  weekendOnly?: boolean;
}

interface DailyLimitInfo {
  canProcess: boolean;
  dailyCount: number;
  hourlyCount: number;
  patternCount: number;
  dailyLimit: number;
  hourlyLimit: number;
  patternLimit: number;
  currentPattern: string;
  inPause: boolean;
  nextActivePattern?: {
    name: string;
    time: string;
    hourStart: number;
    hourEnd: number;
  };
  estimatedResumeTime?: string;
  cooldownActive?: boolean;
  cooldownDaysLeft?: number;
}

interface JobError {
  contactId: string;
  error: string;
  timestamp: string;
  humanPattern?: string;
}

interface LastError {
  type: string;
  message: string;
  timestamp: string;
}

interface AuthStatus {
  linkedinValid: boolean;
  dataverseValid: boolean;
  lastError: LastError | null;
  needsReauth: boolean;
}

interface JobStatus {
  jobId: string;
  status: "pending" | "processing" | "paused" | "completed" | "failed";
  totalContacts: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
  lastProcessedAt?: string;
  completedAt?: string;
  failedAt?: string;
  pauseReason?: string;
  estimatedResumeTime?: string;
  dailyLimitInfo?: DailyLimitInfo;
  errors?: JobError[];
  error?: string; // Job-level error
  lastError?: LastError; // Added this property
  authStatus?: AuthStatus;
  cooldownActive?: boolean;
  cooldownDaysLeft?: number;
  humanPatterns?: {
    startPattern: string;
    startTime: string;
    patternHistory?: Array<{
      pattern: string;
      endTime: string;
      profilesProcessed: number;
    }>;
  };
  dailyStats?: {
    startDate: string;
    processedToday: number;
    patternBreakdown?: Record<string, number>;
  };
  currentPattern?: string;
  currentPatternInfo?: HumanPattern;
}

interface JobStatusPopoverProps {
  jobStatus: JobStatus | null;
  dailyLimitInfo?: DailyLimitInfo | null;
  isCheckingJob?: boolean;
  currentHumanPattern?: HumanPattern | null;
  allHumanPatterns?: Record<string, HumanPattern>;
  simpleClientStats?: any;
  simpleClientInitialized?: boolean;
  apiStatus?: any;
  onInitializeSimpleClient?: () => void;
}

export function JobStatusPopover({ 
  jobStatus, 
  dailyLimitInfo, 
  isCheckingJob, 
  currentHumanPattern,
  allHumanPatterns,
  simpleClientStats,
  simpleClientInitialized,
  apiStatus,
  onInitializeSimpleClient 
}: JobStatusPopoverProps) {
  const [visible, setVisible] = useState(false);

  const getStatusColor = (status?: string) => {
    switch (status) {
      case "completed": return "#10B981"; // green
      case "processing": return "#3B82F6"; // blue
      case "paused": return "#F59E0B"; // yellow
      case "failed": return "#EF4444"; // red
      case "cooldown": return "#9333EA"; // Purple for cooldown
      default: return "#6B7280"; // gray
    }
  };

  const getProgressPercentage = () => {
    if (!jobStatus || jobStatus.totalContacts === 0) return 0;
    return Math.round((jobStatus.processedCount / jobStatus.totalContacts) * 100);
  };

  const getSuccessRate = () => {
    if (!jobStatus || jobStatus.processedCount === 0) return 0;
    return Math.round((jobStatus.successCount / jobStatus.processedCount) * 100);
  };

  const isValidDate = (dateString?: string) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    return !isNaN(date.getTime());
  };

  const formatTime = (dateString?: string) => {
    if (!dateString || !isValidDate(dateString)) return "N/A";
    try {
      return new Date(dateString).toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    } catch (error) {
      console.error("Error formatting time:", error, dateString);
      return "N/A";
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString || !isValidDate(dateString)) return "N/A";
    try {
      return new Date(dateString).toLocaleDateString();
    } catch (error) {
      console.error("Error formatting date:", error, dateString);
      return "N/A";
    }
  };

  const getCurrentPatternStatus = () => {
    const pattern = currentHumanPattern || jobStatus?.currentPatternInfo;
    if (!pattern) return null;

    const limits = dailyLimitInfo || jobStatus?.dailyLimitInfo;
    const patternCount = limits?.patternCount || 0;
    const patternLimit = limits?.patternLimit || pattern.maxProfiles || 0;
    
    return {
      name: pattern.name,
      time: pattern.time,
      isActive: !pattern.pause,
      processed: patternCount,
      limit: patternLimit,
      percentage: patternLimit > 0 ? Math.round((patternCount / patternLimit) * 100) : 0
    };
  };

  const renderStatusBadge = () => {
    if (isCheckingJob) {
      return <span className="status-badge checking">Checking...</span>;
    }
    
    if (!jobStatus) {
      return <span className="status-badge ready">Ready</span>;
    }

    // Handle cooldown period
    if (jobStatus.cooldownActive) {
      return <span className="status-badge cooldown">Cooldown Active</span>;
    }

    // Show auth error badges based on authStatus
    if (jobStatus.authStatus?.needsReauth) {
      if (!jobStatus.authStatus.linkedinValid) {
        return <span className="status-badge auth-error">LinkedIn Auth Required</span>;
      }
      if (!jobStatus.authStatus.dataverseValid) {
        return <span className="status-badge auth-error">Dynamics Auth Required</span>;
      }
    }

    return (
      <span 
        className={`status-badge ${jobStatus.status}`}
        style={{ backgroundColor: getStatusColor(jobStatus.status) }}
      >
        {jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)}
      </span>
    );
  };

  const renderPatternInfo = () => {
    const patternStatus = getCurrentPatternStatus();
    if (!patternStatus) return null;

    return (
      <div className="pattern-section">
        <div className="section-header">
          <strong>Current Pattern:</strong>
        </div>
        <div className="pattern-info">
          <div className="pattern-name">
            {patternStatus.name} 
            <span className={`pattern-status ${patternStatus.isActive ? 'active' : 'paused'}`}>
              {patternStatus.isActive ? '●' : '⏸️'}
            </span>
          </div>
          <div className="pattern-time">{patternStatus.time}</div>
          {patternStatus.limit > 0 && (
            <div className="pattern-progress">
              <div className="progress-text">
                {patternStatus.processed}/{patternStatus.limit} profiles ({patternStatus.percentage}%)
              </div>
              <div className="progress-bar">
                <div 
                  className="progress-fill"
                  style={{ width: `${Math.min(patternStatus.percentage, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderLimitsInfo = () => {
    const limits = dailyLimitInfo || jobStatus?.dailyLimitInfo;
    if (!limits) return null;

    return (
      <div className="limits-section">
        <div className="section-header">
          <strong>Today's Limits:</strong>
        </div>
        <div className="limits-grid">
          <div className="limit-item">
            <span className="limit-label">Daily:</span>
            <span className="limit-value">
              {limits.dailyCount}/{limits.dailyLimit}
            </span>
          </div>
          <div className="limit-item">
            <span className="limit-label">Hourly:</span>
            <span className="limit-value">
              {limits.hourlyCount}/{limits.hourlyLimit}
            </span>
          </div>
        </div>
        {limits.estimatedResumeTime && (
          <div className="resume-info">
            <strong>Next Resume:</strong> {formatTime(limits.estimatedResumeTime)}
            {limits.nextActivePattern && (
              <span className="next-pattern"> ({limits.nextActivePattern.name})</span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderJobProgress = () => {
    if (!jobStatus) return null;

    const progressPercentage = getProgressPercentage();
    const successRate = getSuccessRate();

    return (
      <div className="progress-section">
        <div className="section-header">
          <strong>Job Progress:</strong>
        </div>
        <div className="progress-stats">
          <div className="stat-item">
            <span className="stat-label">Overall:</span>
            <span className="stat-value">
              {jobStatus.processedCount}/{jobStatus.totalContacts} ({progressPercentage}%)
            </span>
          </div>
          <div className="progress-bar">
            <div 
              className="progress-fill"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          <div className="success-failure">
            <div className="stat-item success">
              <span className="stat-label">✅ Success:</span>
              <span className="stat-value">{jobStatus.successCount}</span>
            </div>
            <div className="stat-item failure">
              <span className="stat-label">❌ Failed:</span>
              <span className="stat-value">{jobStatus.failureCount}</span>
            </div>
            <div className="stat-item success-rate">
              <span className="stat-label">Success Rate:</span>
              <span className="stat-value">{successRate}%</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderPatternBreakdown = () => {
    if (!jobStatus?.dailyStats?.patternBreakdown) return null;

    const breakdown = jobStatus.dailyStats.patternBreakdown;
    const total = Object.values(breakdown).reduce((sum, count) => sum + count, 0);

    if (total === 0) return null;

    return (
      <div className="breakdown-section">
        <div className="section-header">
          <strong>Pattern Breakdown:</strong>
        </div>
        <div className="breakdown-list">
          {Object.entries(breakdown).map(([pattern, count]) => (
            <div key={pattern} className="breakdown-item">
              <span className="pattern-name">{pattern}:</span>
              <span className="pattern-count">
                {count} ({Math.round((count / total) * 100)}%)
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderTimestamps = () => {
    if (!jobStatus) return null;
    
    // Debug timestamp values
    console.log("Timestamps received:", {
      createdAt: jobStatus.createdAt,
      lastProcessedAt: jobStatus.lastProcessedAt,
      completedAt: jobStatus.completedAt
    });

    return (
      <div className="timestamps-section">
        <div className="section-header">
          <strong>Timestamps:</strong>
        </div>
        <div className="timestamps-list">
          <div className="timestamp-item">
            <span className="timestamp-label">Created:</span>
            <span className="timestamp-value">
              {formatDate(jobStatus.createdAt)} {formatTime(jobStatus.createdAt)}
            </span>
          </div>
          {jobStatus.lastProcessedAt && (
            <div className="timestamp-item">
              <span className="timestamp-label">Last Processed:</span>
              <span className="timestamp-value">{formatDate(jobStatus.lastProcessedAt)} {formatTime(jobStatus.lastProcessedAt)}</span>
            </div>
          )}
          {jobStatus.completedAt && (
            <div className="timestamp-item">
              <span className="timestamp-label">Completed:</span>
              <span className="timestamp-value">{formatDate(jobStatus.completedAt)} {formatTime(jobStatus.completedAt)}</span>
            </div>
          )}
          {jobStatus.estimatedResumeTime && jobStatus.status === "paused" && (
            <div className="timestamp-item">
              <span className="timestamp-label">Resume Time:</span>
              <span className="timestamp-value">{formatDate(jobStatus.estimatedResumeTime)} {formatTime(jobStatus.estimatedResumeTime)}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderPauseReason = () => {
    const limits = dailyLimitInfo || jobStatus?.dailyLimitInfo;

    // Handle cooldown period first
    if (limits?.cooldownActive) {
      return (
        <div className="pause-reason-section">
          <div className="section-header">
            <strong>Processing Blocked:</strong>
          </div>
          <div className="pause-reason cooldown">
            🕒 Monthly cooldown active - Please wait {limits.cooldownDaysLeft} day(s) before running again
          </div>
        </div>
      );
    }

    if (!jobStatus || jobStatus.status !== "paused" || !jobStatus.pauseReason) return null;

    const reasonMessages: Record<string, string> = {
      daily_limit_reached: "Daily processing limit has been reached",
      pattern_limit_reached: `${jobStatus.currentPattern} pattern limit reached`,
      pause_period: `Currently in ${jobStatus.currentPattern} pause period`,
      hourly_limit_reached: "Hourly processing limit reached",
      session_invalid: "Session has expired - please re-authenticate",
      token_refresh_failed: "Authentication refresh failed - please re-authenticate",
      linkedin_session_invalid: "LinkedIn session expired - please re-authenticate LinkedIn",
      dataverse_session_invalid: "Dataverse session expired - please re-authenticate Dynamics",
      limit_reached: "Processing limits reached"
    };

    return (
      <div className="pause-reason-section">
        <div className="section-header">
          <strong>Pause Reason:</strong>
        </div>
        <div className={`pause-reason ${jobStatus.pauseReason.includes('_session_invalid') ? 'auth-error' : ''}`}>
          {reasonMessages[jobStatus.pauseReason] || jobStatus.pauseReason}
          {jobStatus.lastError?.message && (
            <div className="error-details">
              {jobStatus.lastError.message}
            </div>
          )}
        </div>
      </div>
    );
  };

const renderErrors = () => {
  type ErrorItem = {
    type: "system" | "auth" | "contact";
    error: string;
    timestamp?: string;
    icon: string;
    contactId?: string;
    humanPattern?: string;
    service?: "linkedin" | "dataverse";
  };
  const allErrors: ErrorItem[] = [];

  // Add authentication status errors
  if (jobStatus?.authStatus) {
    if (!jobStatus.authStatus.linkedinValid) {
      allErrors.push({
        type: "auth",
        error: "LinkedIn session expired - Please re-authenticate LinkedIn",
        timestamp: jobStatus.lastProcessedAt,
        icon: "🔗",
        service: "linkedin"
      });
    }
    if (!jobStatus.authStatus.dataverseValid) {
      allErrors.push({
        type: "auth",
        error: "Dataverse session expired - Please re-authenticate Dynamics",
        timestamp: jobStatus.lastProcessedAt,
        icon: "📊",
        service: "dataverse"
      });
    }
  }

  // Add system-level errors
  if (jobStatus?.status === "failed" && jobStatus.error) {
    allErrors.push({
      type: "system",
      error: jobStatus.error,
      timestamp: jobStatus.failedAt || jobStatus.lastProcessedAt,
      icon: "🚨"
    });
  }

  // Add detailed error if available
  if (jobStatus?.lastError) {
    allErrors.push({
      type: "system",
      error: `${jobStatus.lastError.type}: ${jobStatus.lastError.message}`,
      timestamp: jobStatus.lastError.timestamp,
      icon: "⚠️"
    });
  }

  // Add individual contact errors (last 5 instead of 3)
  if (jobStatus?.errors && jobStatus.errors.length > 0) {
    const recentContactErrors = jobStatus.errors.slice(-5);
    recentContactErrors.forEach((error) => {
      allErrors.push({
        type: "contact",
        error: error.error,
        timestamp: error.timestamp,
        contactId: error.contactId,
        humanPattern: error.humanPattern,
        icon: "⚠️",
      });
    });
  }

  if (allErrors.length === 0) return null;

  return (
    <div className="errors-section">
      <div className="section-header">
        <strong>
          Recent Errors ({allErrors.length}
          {jobStatus?.errors && jobStatus.errors.length > 5 
            ? ` of ${jobStatus.errors.length} total` 
            : ''}):
        </strong>
      </div>
      <div className="errors-list">
        {allErrors.map((error, index) => (
          <div
            key={index}
            className={`error-item ${error.type === "auth" || error.type === "system" ? "critical" : ""}`}
          >
            <div className="error-time">
              {error.icon} {formatTime(error.timestamp)}
            </div>
            <div className="error-message">{error.error}</div>
            {error.contactId && (
              <div className="error-pattern">Contact: {error.contactId}</div>
            )}
            {error.humanPattern && (
              <div className="error-pattern">
                Pattern: {error.humanPattern}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

  if (isCheckingJob && !jobStatus) {
    return (
      <div className="job-status-wrapper checking">
        <span className="update-icon" style={{ cursor: "pointer" }}>
          <UpdateIcon status="pending" />
        </span>
      </div>
    );
  }

  return (
    <div
      className="job-status-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      style={{ position: "relative", display: "inline-block" }}
    >
      <span className="update-icon" style={{ cursor: "pointer" }}>
        <UpdateIcon status={jobStatus?.status || "pending"} />
        {renderStatusBadge()}
      </span>

      {visible && (
        <div className="popup-box enhanced-popup" style={{ 
          position: 'absolute',
          top: '-3px',
          zIndex: 9999 
        }}>
          <div className="popup-header">
            <h3>LinkedIn Processing Status</h3>
          </div>
          

          <div className="popup-content">
            {renderPatternInfo()}
            {renderLimitsInfo()}
            {renderJobProgress()}
            {renderPatternBreakdown()}
            {renderPauseReason()}
            {renderTimestamps()}
            {renderErrors()}
          </div>

          {jobStatus && (
            <div className="popup-footer">
              <small>Job ID: {jobStatus.jobId}</small>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
