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

// NEW: Pause/Resume/Break Event Interfaces
interface PauseResumeEvent {
  type: "pause" | "resume" | "break";
  timestamp: string;
  reason: string;
  icon: string;
  message: string;
  details: {
    limits?: {
      daily: string;
      hourly: string;
      pattern: string;
    };
    pattern?: string;
    estimatedResumeTime?: string;
    batchProgress?: string;
    processedInSession?: number;
    previousPauseReason?: string;
    pauseDuration?: number;
    processedCount?: number;
    limitStatus?: {
      daily: string;
      hourly: string;
      pattern: string;
    };
    durationMinutes?: number;
    currentPattern?: string;
  };
  displayMessage: string;
}

interface ActivitySummary {
  totalPauses: number;
  totalResumes: number;
  totalBreaks: number;
  lastActivity?: number;
  events?: PauseResumeEvent[];
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
  pausedAt?: string;
  pauseDisplayInfo?: {
    code: string;
    message: string;
    isAutoResumable: boolean;
    needsUserAction: boolean;
  };
  estimatedResumeTime?: string;
  dailyLimitInfo?: DailyLimitInfo;
  hourlyLimitInfo?: {
    hourlyCount: number;
    hourlyLimit: number;
    hourlyLimitReached: boolean;
    waitInfo: {
      needsWait: boolean;
      waitMinutes: number;
      waitUntil?: string;
      waitMessage?: string;
    };
  };
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
  canRestart?: boolean;
  // NEW: Pause/Resume/Break History
  pauseResumeHistory?: PauseResumeEvent[];
  totalPauses?: number;
  totalResumes?: number;
  totalBreaks?: number;
  activitySummary?: ActivitySummary;
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
    needsOverride?: boolean;
    overrideReason?: string;
  } | null;
  authError?: string | null;
  needsTokenRefresh?: boolean;
  onOverrideCooldown?: () => Promise<boolean>;
  onCleanOverride?: () => Promise<boolean>;
  onStopProcessing?: () => Promise<boolean>;
  onRestartAfterCancel?: (resetContacts?: boolean) => Promise<boolean>;
  onShowOverrideButton?: () => void;
  onForceRun?: () => Promise<boolean>;
}

export function JobStatusPopover({ 
  jobStatus, 
  dailyLimitInfo, 
  isCheckingJob, 
  currentHumanPattern,
  allHumanPatterns,
  cooldownInfo,
  authError,
  needsTokenRefresh,
  onOverrideCooldown,
  onCleanOverride,
  onStopProcessing,
  onRestartAfterCancel,
  onShowOverrideButton,
  onForceRun
}: JobStatusPopoverProps) {
  const [visible, setVisible] = useState(false);
  const [showRestartOptions, setShowRestartOptions] = useState(false);
  // Fix: Move restartLoading state to top-level to avoid hook order issues
  const [restartLoading, setRestartLoading] = useState(false);
  const [refreshingToken, setRefreshingToken] = useState(false);

  // Defensive: If jobStatus is not fully populated, try to map/fill missing fields for failed jobs
  let normalizedJobStatus = jobStatus;
  if (jobStatus && jobStatus.status === 'failed') {
    // If backend sends 'processed' and 'total' instead of processedCount/totalContacts
    if (
      typeof jobStatus.processedCount === 'undefined' &&
      typeof (jobStatus as any).processed !== 'undefined'
    ) {
      normalizedJobStatus = {
        ...jobStatus,
        processedCount: (jobStatus as any).processed,
      };
    }
    if (
      typeof jobStatus.totalContacts === 'undefined' &&
      typeof (jobStatus as any).total !== 'undefined'
    ) {
      normalizedJobStatus = {
        ...normalizedJobStatus!,
        totalContacts: (jobStatus as any).total,
      };
    }
    // If error field is missing, show a generic error
    if (typeof jobStatus.error === 'undefined') {
      normalizedJobStatus = {
        ...normalizedJobStatus!,
        error: 'Job failed. No error message from backend.'
      };
    }
  }

    // FAILED/CANCELLED JOB YENİDEN BAŞLATMA
    const API_BASE_URL = "https://linkedin-api-basl.onrender.com";
    const handleRestartJob = async () => {
      if (!jobStatus) return;
      const confirmed = window.confirm(
        "Bu job başarısız oldu veya iptal edildi. Yeniden başlatmak istiyor musunuz?"
      );
      if (!confirmed) return;
      try {
        const res = await fetch(`${API_BASE_URL}/debug-restart-job/${jobStatus.jobId}`, { method: "POST" });
        const data = await res.json();
        if (data.success) {
          alert("Job yeniden başlatıldı!");
          // Optionally, reload or update job progress here
        } else {
          alert("Başlatılamadı: " + data.message);
        }
      } catch (err) {
        alert("Bir hata oluştu: " + err);
      }
    };

  // Remove alwaysVisibleRestartAndOverride: restart button will only show in popup now
  const alwaysVisibleRestartAndOverride = () => null;
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
        if (typeof onShowOverrideButton === 'function') {
          onShowOverrideButton();
        }
      }
    }
  };

  const handleForceRun = async () => {
    if (!onForceRun) return;
    const confirmed = window.confirm(
      `Are you sure you want to force run?\n\n` +
      `This will:\n` +
      `• Reset ALL daily/hourly/pattern limits to 0\n` +
      `• Immediately start processing\n` +
      `• Override any pause conditions\n\n` +
      `Note: This action will reset your usage statistics and start fresh processing.`
    );
    if (confirmed) {
      const success = await onForceRun();
      if (success) {
        console.log("🚀 Force run completed successfully - all limits reset and processing started");
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

  const handleRefreshToken = async () => {
    if (!needsTokenRefresh || normalizedJobStatus?.pauseReason !== 'token_refresh_failed') return;
    
    setRefreshingToken(true);
    try {
      // Show user message
      const proceed = window.confirm(
        "🔄 Token Refresh Required\n\n" +
        "Your authentication token has expired. Click OK to refresh it automatically.\n\n" +
        "• Job processing will resume after successful refresh\n" +
        "• This may take a few seconds\n" +
        "• Make sure you're connected to the internet"
      );

      if (!proceed) {
        setRefreshingToken(false);
        return;
      }

      // Call refresh endpoint (backend handles the token refresh logic)
      const refreshResponse = await fetch('http://localhost:5678/refresh-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: normalizedJobStatus?.jobId || '',
          userId: 'default' // Backend will find the correct user from job
        })
      });
      
      const result = await refreshResponse.json();
      
      if (result.success) {
        alert('✅ Token refreshed successfully!\n\nJob processing will resume automatically.');
        // Trigger page refresh to update job status
        window.location.reload();
      } else {
        if (result.needsReauth) {
          alert('❌ Token refresh failed - manual reconnection required.\n\nPlease reconnect through LinkedIn extension.');
        } else {
          alert('❌ Token refresh failed: ' + (result.message || 'Unknown error'));
        }
      }
    } catch (error) {
      console.error('❌ Token refresh error:', error);
      alert('❌ Token refresh failed due to network error.\n\nPlease check your connection and try again.');
    } finally {
      setRefreshingToken(false);
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
    
    if (!normalizedJobStatus) {
      return <span className="status-badge ready">Ready</span>;
    }

    // Show special auth error badges for different services
    if (normalizedJobStatus.pauseReason === 'linkedin_session_invalid') {
      return <span className="status-badge auth-error">LinkedIn Auth Error</span>;
    }
    if (normalizedJobStatus.pauseReason === 'dataverse_session_invalid') {
      return <span className="status-badge auth-error">Dataverse Auth Error</span>;
    }
    if (normalizedJobStatus.pauseReason === 'token_refresh_failed') {
      return (
        <div className="auth-error-container">
          <span className="status-badge auth-error">Auth Refresh Failed</span>
          <button 
            className="control-button refresh-token-button"
            onClick={handleRefreshToken}
            disabled={refreshingToken}
            title="Refresh authentication token to continue processing"
            style={{ 
              backgroundColor: refreshingToken ? '#DC2626' : '#EF4444', 
              color: 'white',
              border: 'none',
              opacity: refreshingToken ? 0.7 : 1,
              cursor: refreshingToken ? 'not-allowed' : 'pointer'
            }}
          >
            {refreshingToken ? '🔄 Refreshing...' : '🔄 Refresh Token'}
          </button>
          <small style={{ color: '#DC2626', fontSize: '10px', marginTop: '4px', display: 'block' }}>
            Token expired - click to refresh and resume processing
          </small>
        </div>
      );
    }

    return (
      <span 
        className={`status-badge ${normalizedJobStatus.status}`}
        style={{ backgroundColor: getStatusColor(normalizedJobStatus.status) }}
      >
        {normalizedJobStatus.status.charAt(0).toUpperCase() + normalizedJobStatus.status.slice(1)}
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

    // Get the actual pattern count from job status (this should match processedCount 1:1)
    const actualPatternCount = jobStatus?.processedCount || 0;
    const patternLimit = patternStatus.limit || 0;
    const patternPercentage = patternLimit > 0 ? Math.round((actualPatternCount / patternLimit) * 100) : 0;

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
          {patternLimit > 0 && (
            <div className="pattern-progress">
              <div className="progress-text">
                Pattern Count: {actualPatternCount}/{patternLimit} contacts ({patternPercentage}%)
              </div>
              <div className="progress-bar">
                <div 
                  className="progress-fill"
                  style={{ width: `${Math.min(patternPercentage, 100)}%` }}
                />
              </div>
              <div className="pattern-breakdown-detail" style={{ 
                fontSize: '11px', 
                color: '#6B7280', 
                marginTop: '4px' 
              }}>
                <div>✅ Processed: {jobStatus?.processedCount || 0}</div>
                <div>📊 Pattern Limit: {patternLimit}</div>
                <div>🎯 Pattern Count: {actualPatternCount} (should match processed)</div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderLimitsInfo = () => {
    const limits = dailyLimitInfo || jobStatus?.dailyLimitInfo;
    const hourlyInfo = jobStatus?.hourlyLimitInfo;
    if (!limits || !hourlyInfo) return null;

    // Only show if hourly limit is reached and wait time is needed
    if (!hourlyInfo.hourlyLimitReached && !hourlyInfo.waitInfo?.needsWait) {
      return null;
    }

    return (
      <div className="limits-section">
        {/* Only show hourly limit reached indicator */}
        {hourlyInfo.hourlyLimitReached && (
          <div className="limit-reached-alert" style={{
            padding: '8px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginBottom: '8px'
          }}>
            <span style={{ color: '#ef4444', fontSize: '14px' }}>🚫</span>
            <span style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold' }}>
              HOURLY LIMIT REACHED
            </span>
          </div>
        )}

        {/* Only show wait time if needed */}
        {hourlyInfo.waitInfo?.needsWait && (
          <div className="wait-time-alert" style={{
            padding: '8px',
            backgroundColor: '#fffbeb',
            border: '1px solid #fed7aa',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span style={{ fontSize: '16px' }}>⏳</span>
            <div>
              <div style={{ 
                color: '#f59e0b', 
                fontSize: '12px', 
                fontWeight: 'bold' 
              }}>
                Wait {hourlyInfo.waitInfo.waitMinutes} minutes
              </div>
              <div style={{ 
                color: '#92400e', 
                fontSize: '10px' 
              }}>
                Until next hour begins
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderJobProgress = () => {
    if (!normalizedJobStatus) return null;

    const progressPercentage = normalizedJobStatus.totalContacts
      ? Math.round((normalizedJobStatus.processedCount / normalizedJobStatus.totalContacts) * 100)
      : 0;
    const successRate = normalizedJobStatus.processedCount
      ? Math.round((normalizedJobStatus.successCount / normalizedJobStatus.processedCount) * 100)
      : 0;

    return (
      <div className="progress-section">
        <div className="section-header">
          <strong>Job Progress:</strong>
        </div>
        <div className="progress-stats">
          <div className="stat-item">
            <span className="stat-label">Overall:</span>
            <span className="stat-value">
              {normalizedJobStatus.processedCount}/{normalizedJobStatus.totalContacts} ({progressPercentage}%)
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
              <span className="stat-value">{normalizedJobStatus.successCount ?? 0}</span>
            </div>
            <div className="stat-item failure">
              <span className="stat-label">❌ Failed:</span>
              <span className="stat-value">{normalizedJobStatus.failureCount ?? 0}</span>
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

    if (!jobStatus || jobStatus.status !== "paused") return null;

    // Use new pauseDisplayInfo if available, otherwise fall back to old logic
    let displayMessage = "";
    let needsUserAction = false;
    let isAutoResumable = true;

    if (jobStatus.pauseDisplayInfo) {
      displayMessage = jobStatus.pauseDisplayInfo.message;
      needsUserAction = jobStatus.pauseDisplayInfo.needsUserAction;
      isAutoResumable = jobStatus.pauseDisplayInfo.isAutoResumable;
    } else if (jobStatus.pauseReason) {
      // Fallback to old logic
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
      displayMessage = reasonMessages[jobStatus.pauseReason] || `Paused: ${jobStatus.pauseReason}`;
      needsUserAction = ['session_invalid', 'token_refresh_failed', 'linkedin_session_invalid', 'dataverse_session_invalid'].includes(jobStatus.pauseReason);
    } else {
      return null; // No pause reason available
    }

    const pausedTime = jobStatus.pausedAt 
      ? new Date(jobStatus.pausedAt).toLocaleString() 
      : '';

    return (
      <div className="pause-reason-section">
        <div className="section-header">
          <span className="section-title">
            {needsUserAction ? "⚠️ Action Required" : "⏸️ Pause Information"}
          </span>
        </div>
        <div className="pause-details">
          <div className="pause-message" style={{ 
            color: needsUserAction ? '#DC2626' : '#F59E0B',
            fontWeight: needsUserAction ? 'bold' : 'normal'
          }}>
            {displayMessage}
          </div>
          {pausedTime && (
            <div className="pause-timestamp">
              Paused at: {pausedTime}
            </div>
          )}
          {isAutoResumable && !needsUserAction && (
            <div className="auto-resume-note" style={{ color: '#10B981', fontSize: '0.85em', marginTop: '4px' }}>
              ✓ Will resume automatically when conditions are met
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

  const renderPauseResumeHistory = () => {
    if (!jobStatus?.activitySummary?.events || jobStatus.activitySummary.events.length === 0) {
      return null;
    }

    const events = jobStatus.activitySummary.events;
    
    return (
      <div className="pause-resume-section" style={{ 
        marginTop: '12px', 
        padding: '10px', 
        backgroundColor: '#f8f9fa', 
        borderRadius: '6px', 
        border: '1px solid #e9ecef' 
      }}>
        <div className="section-header">
          <strong>🕒 Activity Timeline:</strong>
        </div>
        <div className="activity-timeline" style={{ marginTop: '8px' }}>
          {events.map((event, index) => (
            <div key={index} className="activity-event" style={{ 
              marginBottom: '8px', 
              padding: '8px', 
              backgroundColor: 'white', 
              borderRadius: '4px', 
              borderLeft: `3px solid ${event.type === 'pause' ? '#ff6b6b' : event.type === 'resume' ? '#51cf66' : '#339af0'}` 
            }}>
              <div className="event-time" style={{ 
                fontSize: '12px', 
                fontWeight: 'bold', 
                color: '#495057', 
                marginBottom: '4px' 
              }}>
                {event.icon} {formatTime(event.timestamp)}
              </div>
              <div className="event-message" style={{ 
                fontSize: '13px', 
                color: '#212529', 
                marginBottom: '2px' 
              }}>
                {event.message}
              </div>
              {event.reason && (
                <div className="event-reason" style={{ 
                  fontSize: '11px', 
                  color: '#6c757d', 
                  fontStyle: 'italic' 
                }}>
                  <small>Reason: {event.reason}</small>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="activity-stats" style={{ 
          marginTop: '10px', 
          display: 'flex', 
          gap: '12px', 
          flexWrap: 'wrap' 
        }}>
          <div className="stat-item" style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '4px', 
            fontSize: '12px' 
          }}>
            <span className="stat-label" style={{ color: '#6c757d' }}>Total Pauses:</span>
            <span className="stat-value" style={{ 
              fontWeight: 'bold', 
              color: '#ff6b6b',
              backgroundColor: '#ffe3e3',
              padding: '2px 6px',
              borderRadius: '3px'
            }}>
              {jobStatus.activitySummary.totalPauses}
            </span>
          </div>
          <div className="stat-item" style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '4px', 
            fontSize: '12px' 
          }}>
            <span className="stat-label" style={{ color: '#6c757d' }}>Total Resumes:</span>
            <span className="stat-value" style={{ 
              fontWeight: 'bold', 
              color: '#51cf66',
              backgroundColor: '#e3ffe3',
              padding: '2px 6px',
              borderRadius: '3px'
            }}>
              {jobStatus.activitySummary.totalResumes}
            </span>
          </div>
          <div className="stat-item" style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '4px', 
            fontSize: '12px' 
          }}>
            <span className="stat-label" style={{ color: '#6c757d' }}>Total Breaks:</span>
            <span className="stat-value" style={{ 
              fontWeight: 'bold', 
              color: '#339af0',
              backgroundColor: '#e3f2ff',
              padding: '2px 6px',
              borderRadius: '3px'
            }}>
              {jobStatus.activitySummary.totalBreaks}
            </span>
          </div>
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
                background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                color: "white",
                border: "1px solid #2563EB",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "all 0.2s ease",
                marginRight: 8
              }}
            >
              ✅ Complete Processing
            </button>
            {/* Show Force Run button for paused jobs */}
            {jobStatus.status === "paused" && onForceRun && (
              <button 
                className="control-button force-run-button"
                onClick={handleForceRun}
                title="Reset all limits and start processing immediately"
                style={{
                  background: "linear-gradient(45deg, #EF4444, #DC2626)",
                  color: "white",
                  border: "1px solid #DC2626",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  fontSize: "12px",
                  fontWeight: "bold",
                  cursor: "pointer",
                  transition: "all 0.2s ease"
                }}
              >
                🚀 Force to Run
              </button>
            )}
            <small style={{ color: '#6B7280', fontSize: '10px', marginTop: '4px', display: 'block' }}>
              {jobStatus.status === "paused" 
                ? "Complete the job or force restart with reset limits" 
                : "Complete the job by marking all remaining contacts as successful"
              }
            </small>
          </div>
        </div>
      );
    }

    // Show restart and override buttons for failed/cancelled jobs (in popup only)
    if ((jobStatus.status === "failed" || jobStatus.status === "cancelled") && jobStatus.jobId && jobStatus.canRestart) {
      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Job Controls:</strong>
          </div>
          <div className="controls-buttons">
            <button
              className="control-button override-button"
              onClick={handleRestartJob}
              style={{
                background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                color: "white",
                border: "1px solid #2563EB",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "all 0.2s ease"
              }}
            >
              🔄 Job'u Yeniden Başlat
            </button>
            {onOverrideCooldown && (
              <button
                className="control-button override-button"
                onClick={onOverrideCooldown}
                style={{
                  background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                  color: "white",
                  border: "1px solid #2563EB",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  fontSize: "12px",
                  fontWeight: "bold",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  marginLeft: 8
                }}
              >
                🔓 Override Cooldown
              </button>
            )}
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
                background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                color: "white",
                border: "1px solid #2563EB",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "all 0.2s ease",
                marginTop: 8
              }}
            >
              Cooldown Override Talebi Gönder
            </button>
          )}
        </div>
      );
    }
    // Show completion message for completed jobs (normal) with immediate override button if in cooldown
    if (jobStatus.status === "completed") {
      // Check if cooldown is active and job was NOT manually overridden
      const isInCooldown = jobStatus.completedAt && !jobStatus.cooldownOverridden;
      const completedAt = jobStatus.completedAt ? new Date(jobStatus.completedAt) : null;
      const daysSinceCompletion = isInCooldown && completedAt ? (Date.now() - completedAt.getTime()) / (1000 * 60 * 60 * 24) : 0;
      const cooldownActive = isInCooldown && daysSinceCompletion < 30;

      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Job Completed:</strong>
          </div>
          <div className="processing-stopped-message">
            🎉 Processing completed successfully! All {jobStatus.totalContacts} contacts processed.
            <small>You can start a new job when ready.</small>
          </div>
          {cooldownActive && onOverrideCooldown && (
            <div style={{ marginTop: 8 }}>
              <div className="processing-stopped-message" style={{ color: '#d35400', marginBottom: 8 }}>
                ⏳ Cooldown period active ({Math.ceil(30 - daysSinceCompletion)} days remaining).
              </div>
              <button
                className="control-button override-button"
                onClick={onOverrideCooldown}
                style={{
                  background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                  color: "white",
                  border: "1px solid #2563EB",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  fontSize: "12px",
                  fontWeight: "bold",
                  cursor: "pointer",
                  transition: "all 0.2s ease"
                }}
              >
                🔓 Override Cooldown
              </button>
            </div>
          )}
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
                background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                color: "white",
                border: "1px solid #2563EB",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "all 0.2s ease",
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
                background: "linear-gradient(45deg, #3B82F6, #2563EB)",
                color: "white",
                border: "1px solid #2563EB",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "all 0.2s ease"
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

    // Show Force Run button ONLY for ready state (no job)
    if (onForceRun && !normalizedJobStatus) {
      return (
        <div className="job-controls-section">
          <div className="section-header">
            <strong>Force Run:</strong>
          </div>
          <div className="controls-buttons">
            <button 
              className="control-button force-run-button"
              onClick={handleForceRun}
              title="Reset all limits and start processing immediately"
              style={{
                background: "linear-gradient(45deg, #EF4444, #DC2626)",
                color: "white",
                border: "1px solid #DC2626",
                borderRadius: "6px",
                padding: "8px 12px",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                transition: "all 0.2s ease"
              }}
            >
              🚀 Force to Run
            </button>
            <small style={{ color: '#6B7280', fontSize: '10px', marginTop: '4px', display: 'block' }}>
              Resets all daily/hourly/pattern limits and starts processing immediately
            </small>
          </div>
        </div>
      );
    }

    return null;
  };

  if (isCheckingJob && !normalizedJobStatus) {
    return (
      <div className="job-status-wrapper checking">
        <span className="update-icon" style={{ cursor: "pointer" }}>
          <UpdateIcon status="pending" />
        </span>
      </div>
    );
  }

  // Show debug info if jobStatus is not fully populated
  if (normalizedJobStatus && (!normalizedJobStatus.status || !normalizedJobStatus.jobId)) {
    return (
      <div className="job-status-wrapper error">
        <span style={{ color: 'red', fontWeight: 'bold' }}>JobStatus verisi eksik veya hatalı!</span>
        <pre style={{ fontSize: 10, color: '#333', background: '#f8d7da', padding: 8, borderRadius: 4, marginTop: 8 }}>{JSON.stringify(normalizedJobStatus, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div>
      <div
        className="job-status-wrapper"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        style={{ position: "relative", display: "inline-block" }}
      >
        <span className="update-icon" style={{ cursor: "pointer" }}>
          <UpdateIcon status={normalizedJobStatus?.status === "cancelled" ? "paused" : (normalizedJobStatus?.status || "pending")} />
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
              {renderPauseResumeHistory()}
            </div>
            {normalizedJobStatus && (
              <div className="popup-footer">
                <small>Job ID: {normalizedJobStatus.jobId}</small>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}