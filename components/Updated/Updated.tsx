import React, { useState, useEffect } from "react";
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

interface JobStatus {
  jobId: string;
  status: "pending" | "processing" | "paused" | "completed" | "failed" | "cancelled";
  totalContacts: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
  lastProcessedAt?: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  pauseReason?: string;
  estimatedResumeTime?: string;
  dailyLimitInfo?: DailyLimitInfo;
  errors?: JobError[];
  error?: string; // Job-level error
  lastError?: LastError; // Added this property
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
  cooldownOverridden?: boolean;
  overriddenAt?: string;
}

interface JobStatusPopoverProps {
  jobStatus: JobStatus | null;
  dailyLimitInfo?: DailyLimitInfo | null;
  isCheckingJob?: boolean;
  currentHumanPattern?: HumanPattern | null;
  allHumanPatterns?: Record<string, HumanPattern>;
  cooldownInfo?: {
    active: boolean;
    daysLeft?: number;
    lastCompleted?: string;
  } | null;
  authError?: string | null;
  onOverrideCooldown?: () => Promise<boolean>;
  onCleanOverride?: () => Promise<boolean>;
  onStopProcessing?: () => Promise<boolean>;
  onRestartAfterCancel?: (resetContacts?: boolean) => Promise<boolean>;
}

export function JobStatusPopover({ 
  jobStatus, 
  dailyLimitInfo, 
  isCheckingJob, 
  currentHumanPattern,
  allHumanPatterns,
  cooldownInfo,
  authError,
  onOverrideCooldown,
  onCleanOverride,
  onStopProcessing,
  onRestartAfterCancel
}: JobStatusPopoverProps) {
  const [visible, setVisible] = useState(false);
  const [showRestartOptions, setShowRestartOptions] = useState(false);

  // Handle timing for showing restart options after cancellation
  useEffect(() => {
    if (jobStatus?.status === "cancelled" && jobStatus.cancelledAt) {
      setShowRestartOptions(false);
      const timer = setTimeout(() => {
        setShowRestartOptions(true);
      }, 3000); // 3 second delay

      return () => clearTimeout(timer);
    } else {
      setShowRestartOptions(false);
    }
  }, [jobStatus?.status, jobStatus?.cancelledAt]);

  const handleStopProcessing = async () => {
    if (!onStopProcessing) return;
    
    const confirmed = window.confirm(
      `Are you sure you want to complete the current processing job?\n\n` +
      `This will:\n` +
      `• Mark ALL remaining contacts as successfully processed\n` +
      `• Complete the job immediately\n` +
      `• Count all contacts toward your daily processed total\n\n` +
      `Note: This action cannot be undone. All pending contacts will be marked as successful.`
    );
    
    if (confirmed) {
      const success = await onStopProcessing();
      if (success) {
        console.log("✅ Processing completed successfully with all remaining contacts marked as successful");
      }
    }
  };

  const handleRestartAfterCancel = async (resetContacts = false) => {
    if (!onRestartAfterCancel) return;
    
    const resetMessage = resetContacts 
      ? `• Reset contact counts to 0\n• Start completely fresh\n`
      : `• Continue from where you left off\n• Keep existing progress\n`;
    
    const confirmed = window.confirm(
      `Are you sure you want to restart processing after cancellation?\n\n` +
      `This will:\n` +
      resetMessage +
      `• Create a new processing job\n` +
      `• Resume LinkedIn profile processing\n\n` +
      `Choose your restart option in the next dialog.`
    );
    
    if (confirmed) {
      const success = await onRestartAfterCancel(resetContacts);
      if (success) {
        console.log("✅ Processing restarted successfully after cancellation");
      }
    }
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case "completed": return "#10B981"; // green
      case "processing": return "#3B82F6"; // blue
      case "paused": return "#F59E0B"; // yellow
      case "failed": return "#EF4444"; // red
      case "cancelled": return "#6B7280"; // gray
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

  const formatTime = (dateString?: string) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return "N/A";
    return new Date(dateString).toLocaleDateString();
  };

  const getCurrentPatternStatus = () => {
    const pattern = currentHumanPattern || jobStatus?.currentPatternInfo;
    if (!pattern) return null;

    const limits = dailyLimitInfo || jobStatus?.dailyLimitInfo;
    
    // Get the actual count for this specific pattern from pattern breakdown
    const patternBreakdown = jobStatus?.dailyStats?.patternBreakdown;
    const currentPatternName = pattern.name;
    const actualPatternCount = patternBreakdown?.[currentPatternName] || 0;
    
    const patternLimit = limits?.patternLimit || pattern.maxProfiles || 0;
    
    return {
      name: pattern.name,
      time: pattern.time,
      isActive: !pattern.pause,
      processed: actualPatternCount,
      limit: patternLimit,
      percentage: patternLimit > 0 ? Math.round((actualPatternCount / patternLimit) * 100) : 0
    };
  };

  const renderStatusBadge = () => {
    // Priority 1: Cooldown state
    if (cooldownInfo?.active) {
      return <span className="status-badge cooldown">Cooldown Active</span>;
    }
    
    if (isCheckingJob) {
      return <span className="status-badge checking">Checking...</span>;
    }
    
    // Priority 2: Check for authentication errors
    if (authError && (
      authError.includes("Missing required parameters") || 
      authError.includes("userId") || 
      authError.includes("li_at") || 
      authError.includes("accessToken") || 
      authError.includes("crmUrl") || 
      authError.includes("jsessionid")
    )) {
      return <span className="status-badge auth-error">Login Required</span>;
    }
    
    if (!jobStatus) {
      return <span className="status-badge ready">Ready</span>;
    }

    // Show special auth error badges for different services
    if (jobStatus.pauseReason === 'linkedin_session_invalid') {
      return <span className="status-badge auth-error">LinkedIn Auth Error</span>;
    }
    if (jobStatus.pauseReason === 'dataverse_session_invalid') {
      return <span className="status-badge auth-error">Dataverse Auth Error</span>;
    }
    if (jobStatus.pauseReason === 'token_refresh_failed') {
      return <span className="status-badge auth-error">Auth Refresh Failed</span>;
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

  const renderCooldownInfo = () => {
    if (!cooldownInfo?.active) return null;

    const formatLastCompleted = (dateString?: string) => {
      if (!dateString) return "N/A";
      const date = new Date(dateString);
      return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
    };

    const handleOverride = async () => {
      if (!onOverrideCooldown) return;
      
      const confirmed = window.confirm(
        `Are you sure you want to override the cooldown period?\n\n` +
        `This will allow you to start processing contacts again immediately, ` +
        `bypassing the ${cooldownInfo.daysLeft} day(s) remaining cooldown period.\n\n` +
        `Note: This action cannot be undone.`
      );
      
      if (confirmed) {
        const success = await onOverrideCooldown();
        if (success) {
          // Success message is handled by the parent component
          console.log("✅ Cooldown override successful");
        }
      }
    };

    const handleCleanOverride = async () => {
      if (!onCleanOverride) return;
      
      const confirmed = window.confirm(
        `Are you sure you want to perform a COMPLETE RESET?\n\n` +
        `This will:\n` +
        `• Remove ALL job history\n` +
        `• Clear all session data\n` +
        `• Reset contact counts to 0\n` +
        `• Allow immediate fresh start\n\n` +
        `This gives you a completely clean slate as if you never used the system.\n\n` +
        `Note: This action cannot be undone and removes all historical data.`
      );
      
      if (confirmed) {
        const doubleConfirm = window.confirm(
          `FINAL CONFIRMATION\n\n` +
          `This will permanently delete ALL your job history and data.\n` +
          `Are you absolutely sure you want to proceed with the complete reset?`
        );
        
        if (doubleConfirm) {
          const success = await onCleanOverride();
          if (success) {
            console.log("✅ Clean override successful");
          }
        }
      }
    };

    return (
      <div className="cooldown-section">
        <div className="section-header">
          <strong>🚫 Cooldown Period Active</strong>
        </div>
        <div className="cooldown-info">
          <div className="cooldown-row">
            <span className="cooldown-label">Days Remaining:</span>
            <span className="cooldown-value" style={{ color: '#3B82F6', fontWeight: 'bold' }}>
              {cooldownInfo.daysLeft} days
            </span>
          </div>
          {cooldownInfo.lastCompleted && (
            <div className="cooldown-row">
              <span className="cooldown-label">Last Completed:</span>
              <span className="cooldown-value">
                {formatLastCompleted(cooldownInfo.lastCompleted)}
              </span>
            </div>
          )}
          <div className="cooldown-message">
            <small style={{ color: '#6B7280', fontStyle: 'italic' }}>
              All contacts have been processed. Please wait for the cooldown period to end before starting a new processing job.
            </small>
          </div>
          {(onOverrideCooldown || onCleanOverride) && (
            <div className="cooldown-override">
              {onOverrideCooldown && (
                <div className="override-option">
                  <button 
                    className="override-button"
                    onClick={handleOverride}
                    title="Override cooldown and continue with existing contacts"
                  >
                    🔓 Override Cooldown
                  </button>
                  <small style={{ color: '#6B7280', fontSize: '10px', marginTop: '4px', display: 'block' }}>
                    Bypass cooldown and continue processing existing contacts
                  </small>
                </div>
              )}
              {onCleanOverride && (
                <div className="override-option" style={{ marginTop: '8px' }}>
                  <button 
                    className="override-button clean-override"
                    onClick={handleCleanOverride}
                    title="Complete reset - start fresh from 0"
                    style={{ 
                      background: 'linear-gradient(45deg, #EF4444, #DC2626)',
                      borderColor: '#DC2626'
                    }}
                  >
                    🧹 Fresh Start (Reset All)
                  </button>
                  <small style={{ color: '#6B7280', fontSize: '10px', marginTop: '4px', display: 'block' }}>
                    Complete reset - removes all data and starts from 0 contacts
                  </small>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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

    return (
      <div className="timestamps-section">
        <div className="section-header">
          <strong>Timestamps:</strong>
        </div>
        <div className="timestamps-list">
          <div className="timestamp-item">
            <span className="timestamp-label">Created:</span>
            <span className="timestamp-value">{formatDate(jobStatus.createdAt)} {formatTime(jobStatus.createdAt)}</span>
          </div>
          {jobStatus.lastProcessedAt && (
            <div className="timestamp-item">
              <span className="timestamp-label">Last Processed:</span>
              <span className="timestamp-value">{formatTime(jobStatus.lastProcessedAt)}</span>
            </div>
          )}
          {jobStatus.completedAt && (
            <div className="timestamp-item">
              <span className="timestamp-label">Completed:</span>
              <span className="timestamp-value">{formatTime(jobStatus.completedAt)}</span>
            </div>
          )}
          {jobStatus.estimatedResumeTime && jobStatus.status === "paused" && (
            <div className="timestamp-item">
              <span className="timestamp-label">Resume Time:</span>
              <span className="timestamp-value">{formatTime(jobStatus.estimatedResumeTime)}</span>
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

    const reasonMessages = {
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
          {reasonMessages[jobStatus.pauseReason as keyof typeof reasonMessages] || jobStatus.pauseReason}
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
  };
  const allErrors: ErrorItem[] = [];

  // Add job-level error if exists
  if (jobStatus?.error && jobStatus?.status === "failed") {
    allErrors.push({
      type: "system",
      error: jobStatus.error,
      timestamp: jobStatus.failedAt || jobStatus.lastProcessedAt,
      icon: "🚨",
    });
  }

  // Add authentication errors
  if (jobStatus?.pauseReason === "session_invalid") {
    allErrors.push({
      type: "auth",
      error: "User session expired - Authentication required",
      timestamp: jobStatus.lastProcessedAt,
      icon: "🔐",
    });
  }

  if (jobStatus?.pauseReason === "token_refresh_failed") {
    allErrors.push({
      type: "auth",
      error: "Token refresh failed - Re-authentication required",
      timestamp: jobStatus.lastProcessedAt,
      icon: "🔐",
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

  const renderJobControls = () => {
    // Show different controls based on job status
    if (!jobStatus) return null;
    
    // Show stop button for processing or paused jobs
    if ((jobStatus.status === "processing" || jobStatus.status === "paused") && onStopProcessing) {
      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Job Controls:</strong>
          </div>
          <div className="controls-buttons">
            <button 
              className="control-button stop-button"
              onClick={handleStopProcessing}
              title="Complete current processing job"
              style={{ 
                background: 'linear-gradient(45deg, #EF4444, #DC2626)',
                color: 'white',
                border: '1px solid #DC2626',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              ✅ Complete Processing
            </button>
            <small style={{ color: '#6B7280', fontSize: '10px', marginTop: '4px', display: 'block' }}>
              Complete the job by marking all remaining contacts as successful
            </small>
          </div>
        </div>
      );
    }

    // Show cooldown override info for completed jobs with cooldownOverridden
    if (jobStatus.status === "completed" && jobStatus.cooldownOverridden === true) {
      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Cooldown Active (Override):</strong>
          </div>
          <div className="processing-stopped-message" style={{ color: '#d35400', marginBottom: 8 }}>
            ⏳ Cooldown aktif ve override edilmiş. 1 ay beklemeniz gerekiyor veya admin ile iletişime geçin.<br />
            <small>Job tamamlandı, yeni iş başlatamazsınız.</small>
          </div>
          {onOverrideCooldown && (
            <button
              className="control-button override-button"
              onClick={onOverrideCooldown}
              style={{
                background: 'linear-gradient(45deg, #f59e42, #e67e22)',
                color: 'white',
                border: '1px solid #e67e22',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                marginTop: 8
              }}
            >
              Cooldown Override Talebi Gönder
            </button>
          )}
        </div>
      );
    }
    // Show completion message for completed jobs (normal)
    if (jobStatus.status === "completed") {
      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Job Completed:</strong>
          </div>
          <div className="processing-stopped-message">
            🎉 Processing completed successfully! All {jobStatus.totalContacts} contacts processed.
            <small>You can start a new job when ready.</small>
          </div>
        </div>
      );
    }

    // Legacy: Show restart buttons for cancelled jobs (only after delay) - kept for backward compatibility
    if (jobStatus.status === "cancelled" && showRestartOptions && onRestartAfterCancel) {
      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Restart Options:</strong>
          </div>
          <div className="controls-buttons">
            <button 
              className="control-button restart-button"
              onClick={() => handleRestartAfterCancel(false)}
              title="Continue from where you left off"
              style={{ 
                background: 'linear-gradient(45deg, #10B981, #059669)',
                color: 'white',
                border: '1px solid #059669',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                marginBottom: '6px'
              }}
            >
              🔄 Continue Processing
            </button>
            <small style={{ color: '#6B7280', fontSize: '10px', marginBottom: '8px', display: 'block' }}>
              Resume from {jobStatus.processedCount}/{jobStatus.totalContacts} contacts
            </small>
            
            <button 
              className="control-button restart-fresh-button"
              onClick={() => handleRestartAfterCancel(true)}
              title="Start completely fresh from 0"
              style={{ 
                background: 'linear-gradient(45deg, #3B82F6, #2563EB)',
                color: 'white',
                border: '1px solid #2563EB',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '12px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
            >
              🆕 Start Fresh
            </button>
            <small style={{ color: '#6B7280', fontSize: '10px', marginTop: '4px', display: 'block' }}>
              Reset all contacts and start from 0
            </small>
          </div>
        </div>
      );
    }

    return null;
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
        <UpdateIcon status={jobStatus?.status === "cancelled" ? "paused" : (jobStatus?.status || "pending")} />
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
            {renderCooldownInfo()}
            {renderPatternInfo()}
            {renderLimitsInfo()}
            {renderJobProgress()}
            {renderJobControls()}
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