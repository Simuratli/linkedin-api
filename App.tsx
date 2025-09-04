//@ts-nocheck
/// <reference types="chrome" />

import React, { useEffect, useRef, useState } from "react";
import { DoubleNextIcon, CloseIconBigger, LogoIcon } from "./assets";
import { useStore } from "./store";
import { usePaging } from "./hooks/usePaging";
import { Loader } from "./components";
import { LINKEDIN_PAGE_ENUM } from "./types/global.types";
import posthog from "posthog-js";
import UpdateIcon from "./assets/update-icon";
import { JobStatusPopover } from "./components/Updated/Updated";

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
}

// Activity Summary Interfaces
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
  jobAge?: {
    days: number;
    hours: number;
    createdTimestamp: number;
    isOld: boolean;
    isVeryOld: boolean;
  };
  errors?: Array<{
    contactId: string;
    error: string;
    timestamp: string;
    humanPattern?: string;
  }>;
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
  activitySummary?: ActivitySummary;
}

interface HumanPattern {
  name: string;
  time: string;
  hourStart: number;
  hourEnd: number;
  pause?: boolean;
  maxProfiles?: number;
}

function App() {
  const {
    setSidebarOpen,
    sidebarOpen,
    loading,
    setCurrentUserFullName,
    currentUserFullname,
    accessToken,
    crmUrl,
    refreshToken,
    clientId,
    tenantId,
    code_verifier,
  } = useStore();
  const { CurrentPage, updated } = usePaging();

  const startTimeRef = useRef<number | null>(null);
  const jobMonitorInterval = useRef<number | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [isCheckingJob, setIsCheckingJob] = useState(false);
  const [dailyLimitInfo, setDailyLimitInfo] = useState<DailyLimitInfo | null>(null);
  const [lastJobRunTimestamp, setLastJobRunTimestamp] = useState<string | null>(null);
  const [currentHumanPattern, setCurrentHumanPattern] = useState<HumanPattern | null>(null);
  const [allHumanPatterns, setAllHumanPatterns] = useState<Record<string, HumanPattern>>({});
  const [cooldownInfo, setCooldownInfo] = useState<{
    active: boolean;
    daysLeft?: number;
    lastCompleted?: string;
    needsOverride?: boolean;
    overrideReason?: string;
  } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const API_BASE_URL = "https://linkedin-api-basl.onrender.com";

  const hasOneMonthPassed = (lastRun: string | null) => {
    if (!lastRun) return true;
    const lastRunTime = new Date(lastRun).getTime();
    return Date.now() - lastRunTime > ONE_MONTH_MS;
  };

  const setJobRunTimestamp = () => {
    const timestamp = new Date().toISOString();
    localStorage.setItem("lastJobRun", timestamp);
    setLastJobRunTimestamp(timestamp);
  };

  // Enhanced debug function for job memory
  const debugJobMemory = async () => {
    const userId = getUserId();
    console.log("🔍 === JOB MEMORY DEBUG START ===");
    console.log("User ID:", userId);
    console.log("Stored linkedin_public_id:", localStorage.getItem("linkedin_public_id"));
    console.log("Last job run:", localStorage.getItem("lastJobRun"));
    console.log("Current job status state:", jobStatus);
    
    try {
      // Check debug endpoint
      console.log("📊 Fetching server debug info...");
      const debugResponse = await fetch(`${API_BASE_URL}/debug-job-memory/${encodeURIComponent(userId)}`);
      if (debugResponse.ok) {
        const debugResult = await debugResponse.json();
        console.log("🏠 Server debug info:", debugResult.debug);
        
        if (debugResult.debug.jobForCurrentSession) {
          console.log("✅ Job found in server memory:", debugResult.debug.jobForCurrentSession);
        } else {
          console.log("❌ No job found in server memory");
        }
      }
      
      // Check user-job endpoint
      console.log("📋 Fetching user job info...");
      const crmParam = crmUrl ? `?crmUrl=${encodeURIComponent(crmUrl)}` : '';
      const response = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}${crmParam}`);
      const result = await response.json();
      console.log("📋 User job response:", result);
      
      if (result.success && result.job) {
        console.log("✅ Job details:", {
          jobId: result.job.jobId,
          status: result.job.status,
          processed: result.job.processedCount,
          total: result.job.totalContacts,
          createdAt: result.job.createdAt,
          jobAge: result.job.jobAge
        });
        
        if (result.job.jobAge?.days > 0) {
          console.log(`⏰ Job is ${result.job.jobAge.days} days old!`);
        }
        
        // **🚀 SIMPLE FIX: Set job status directly from debugJobMemory!**
        console.log("🚀 SETTING JOB STATUS from debugJobMemory!");
        const jobObj = result.job;
        setJobStatus(jobObj);
        setDailyLimitInfo(jobObj.dailyLimitInfo);
        
        // Create status message for paused job
        let statusMessage = "";
        const ageInfo = jobObj.jobAge?.days > 0 ? ` (${jobObj.jobAge.days}d old)` : '';
        
        if (jobObj.status === "paused") {
          if (jobObj.hourlyLimitInfo?.hourlyLimitReached) {
            const waitTime = jobObj.hourlyLimitInfo.waitInfo?.waitMinutes || 0;
            statusMessage = `⏸️ Job paused${ageInfo} - Hourly limit reached. Wait ${waitTime} minutes.`;
          } else {
            statusMessage = `⏸️ Job paused${ageInfo}. Processed: ${jobObj.processedCount}/${jobObj.totalContacts}`;
          }
        } else if (jobObj.status === "processing") {
          statusMessage = `🔄 Continuing job${ageInfo}... (${jobObj.processedCount}/${jobObj.totalContacts})`;
        } else {
          statusMessage = `Found ${jobObj.status} job${ageInfo}. Progress: ${jobObj.processedCount}/${jobObj.totalContacts}`;
        }
        
        // Send message to background script
        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: jobObj.status,
            message: statusMessage,
            canResume: jobObj.status === "paused",
            jobData: jobObj,
            dailyLimitInfo: jobObj.dailyLimitInfo,
            humanPattern: result.currentPatternInfo,
            jobAge: jobObj.jobAge,
          },
        });
        
        console.log("✅ Job status set and message sent!");
      } else {
        console.log("❌ No job found or job completed");
      }
    } catch (error) {
      console.error("🚨 Debug error:", error);
    }
    
    console.log("🔍 === JOB MEMORY DEBUG END ===");
  };

  // Monitor job cleanup on unmount
  useEffect(() => {
    return () => {
      if (jobMonitorInterval.current) {
        clearInterval(jobMonitorInterval.current);
        jobMonitorInterval.current = null;
      }
    };
  }, []);

  const getUserId = () => {
    const storedProfileId = window.localStorage.getItem("linkedin_public_id");
    if (storedProfileId) return storedProfileId;

    const fallbackId = posthog.get_distinct_id();
    if (fallbackId) {
      window.localStorage.setItem("linkedin_public_id", fallbackId);
      return fallbackId;
    }

    return "unknown_user";
  };

  // Fetch current human pattern information
  const fetchHumanPatterns = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/human-patterns`);
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setCurrentHumanPattern(result.currentPattern.info);
          setAllHumanPatterns(result.allPatterns);
          return result;
        }
      }
    } catch (error) {
      console.error("Error fetching human patterns:", error);
    }
    return null;
  };

  // Check daily limits with human pattern awareness
  const checkDailyLimits = async (userId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/daily-limits/${encodeURIComponent(userId)}`);
      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setDailyLimitInfo(result.limits);
          return result.limits;
        }
      }
    } catch (error) {
      console.error("Error checking daily limits:", error);
    }
    return null;
  };

  // **ENHANCED** Force immediate job status refresh
  const forceJobStatusRefresh = async () => {
    if (jobStatus?.jobId) {
      console.log("🔄 Force refreshing job status for:", jobStatus.jobId);
      await checkJobStatus(jobStatus.jobId);
    }
  };

  // **FIXED** Enhanced job monitoring with pattern awareness and proper job ID handling
  const checkJobStatus = async (jobId: string) => {
    if (!jobId) return;
    
    // **DEFENSIVE CHECK** - Don't check if this isn't the current job
    if (jobStatus?.jobId && jobStatus.jobId !== jobId) {
      console.log("🛑 Skipping status check - not current job:", {
        currentJobId: jobStatus.jobId,
        checkingJobId: jobId
      });
      return;
    }
    
    console.log("🔍 Checking job status for:", jobId);
    
    try {
      // Fetch both job status and latest human patterns concurrently
      const [statusResponse, patternsResult] = await Promise.all([
        fetch(`${API_BASE_URL}/job-status/${jobId}`),
        fetchHumanPatterns()
      ]);

      if (!statusResponse.ok) {
        if (statusResponse.status === 404) {
          console.log("❌ Job not found (404), clearing job status:", jobId);
          setJobStatus(null);
          if (jobMonitorInterval.current) {
            window.clearInterval(jobMonitorInterval.current);
            jobMonitorInterval.current = null;
            console.log("🧹 Cleared monitoring - job not found");
          }
          return;
        }
        throw new Error(`HTTP error! status: ${statusResponse.status}`);
      }
      
      const result = await statusResponse.json();
      
      if (!result.success) {
        console.warn("Job status check returned unsuccessful result");
        return;
      }

      // **DEFENSIVE CHECK** - Make sure this is still the right job
      if (result.job.jobId !== jobId) {
        console.log("⚠️ Job ID mismatch in response - ignoring:", {
          requestedJobId: jobId,
          responseJobId: result.job.jobId
        });
        return;
      }

      console.log("📊 Job status update:", {
        status: result.job.status,
        processed: result.job.processedCount,
        total: result.job.totalContacts,
        jobAge: result.job.jobAge
      });

      setJobStatus(result.job);
      setDailyLimitInfo(result.job.dailyLimitInfo);
      
      // Update pattern info from the patterns API (most up-to-date) or fallback to job status
      if (patternsResult?.currentPattern?.info) {
        setCurrentHumanPattern(patternsResult.currentPattern.info);
        setAllHumanPatterns(patternsResult.allPatterns);
        console.log("🔄 Updated patterns from patterns API:", patternsResult.currentPattern.info);
      } else if (result.job.currentPatternInfo) {
        setCurrentHumanPattern(result.job.currentPatternInfo);
        console.log("🔄 Updated patterns from job status:", result.job.currentPatternInfo);
      }

      // Enhanced status messages with age and pattern info
      let statusMessage = "";
      let processStatus = result.job.status;

      if (result.job.status === "processing") {
        const progress = `${result.job.processedCount}/${result.job.totalContacts}`;
        const successRate = result.job.processedCount > 0 
          ? Math.round((result.job.successCount / result.job.processedCount) * 100) 
          : 0;
        
        const ageInfo = result.job.jobAge?.days > 0 ? ` (${result.job.jobAge.days}d old)` : '';
        statusMessage = `🔄 Processing${ageInfo} (${progress}) | ✅ ${result.job.successCount} ❌ ${result.job.failureCount} (${successRate}% success)`;
        
        if (result.job.dailyLimitInfo) {
          const { currentPattern, patternCount, patternLimit } = result.job.dailyLimitInfo;
          if (patternLimit) {
            statusMessage += ` | ${currentPattern}: ${patternCount}/${patternLimit}`;
          }
        }
      } 
      else if (result.job.status === "paused") {
        const ageInfo = result.job.jobAge?.days > 0 ? ` (${result.job.jobAge.days}d old)` : '';
        
        // Use new pauseDisplayInfo if available
        if (result.job.pauseDisplayInfo) {
          const pauseInfo = result.job.pauseDisplayInfo;
          const pausedTime = result.job.pausedAt 
            ? ` (${new Date(result.job.pausedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` 
            : '';
          
          if (pauseInfo.needsUserAction) {
            statusMessage = `⚠️ Paused${ageInfo}${pausedTime} - ${pauseInfo.message}`;
          } else {
            statusMessage = `⏸️ Paused${ageInfo}${pausedTime} - ${pauseInfo.message}`;
          }
        }
        // Fallback to old logic if pauseDisplayInfo not available
        else if (result.job.pauseReason === "daily_limit_reached") {
          statusMessage = `⏸️ Paused${ageInfo} - Daily limit reached`;
        } 
        else if (result.job.pauseReason === "pattern_limit_reached") {
          statusMessage = `⏸️ Paused${ageInfo} - ${result.job.dailyLimitInfo?.currentPattern} pattern limit reached`;
        }
        else if (result.job.pauseReason === "pause_period") {
          const resumeTime = result.job.estimatedResumeTime 
            ? new Date(result.job.estimatedResumeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : 'soon';
          statusMessage = `⏸️ Paused${ageInfo} - Currently in ${result.job.dailyLimitInfo?.currentPattern} period. Resuming ${resumeTime}`;
        }
        else {
          statusMessage = `⏸️ Job paused${ageInfo}. Processed: ${result.job.processedCount}/${result.job.totalContacts}`;
        }
      } 
      else if (result.job.status === "completed") {
        const successRate = result.job.totalContacts > 0 
          ? Math.round((result.job.successCount / result.job.totalContacts) * 100) 
          : 0;
        const ageInfo = result.job.jobAge?.days > 0 ? ` (completed ${result.job.jobAge.days}d ago)` : '';
        statusMessage = `✅ Completed${ageInfo}! ${result.job.successCount}/${result.job.totalContacts} (${successRate}% success)`;
        processStatus = "completed";
      }
      else if (result.job.status === "cancelled") {
        const ageInfo = result.job.jobAge?.days > 0 ? ` (cancelled ${result.job.jobAge.days}d ago)` : '';
        statusMessage = `🛑 Cancelled${ageInfo}. Progress saved: ${result.job.processedCount}/${result.job.totalContacts}`;
        processStatus = "cancelled";
      }

      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        data: {
          status: processStatus,
          message: statusMessage,
          progress: {
            total: result.job.totalContacts,
            processed: result.job.processedCount,
            success: result.job.successCount,
            failed: result.job.failureCount,
          },
          dailyLimitInfo: result.job.dailyLimitInfo,
          pauseReason: result.job.pauseReason,
          humanPattern: patternsResult?.currentPattern?.info || result.job.currentPatternInfo,
          jobAge: result.job.jobAge,
          canRestart: result.job.status === "cancelled",
        },
      });

      if (result.job.status === "completed" || result.job.status === "failed" || result.job.status === "cancelled") {
        if (jobMonitorInterval.current) {
          window.clearInterval(jobMonitorInterval.current);
          jobMonitorInterval.current = null;
          console.log("🏁 Job monitoring stopped - job completed/failed/cancelled");
        }
      }
    } catch (error) {
      console.error("Job status check failed:", error);
      // **IMPROVED ERROR HANDLING** - Clear job on 404 errors
      if (error.message.includes("404")) {
        console.log("❌ Job not found (404), clearing job status");
        setJobStatus(null);
        if (jobMonitorInterval.current) {
          window.clearInterval(jobMonitorInterval.current);
          jobMonitorInterval.current = null;
        }
      }
    }
  };

  // **FIXED** Start job monitoring with proper defensive checks
  const startJobMonitoring = (jobId: string) => {
    console.log("🔄 Starting job monitoring for:", jobId);
    
    // **DEFENSIVE CHECK** - Make sure we're not monitoring an old job
    if (jobStatus?.jobId && jobStatus.jobId !== jobId) {
      console.log("⚠️ Job ID mismatch - not starting monitoring:", {
        currentJobId: jobStatus.jobId,
        requestedJobId: jobId
      });
      return;
    }
    
    // Clear any existing monitoring
    if (jobMonitorInterval.current) {
      window.clearInterval(jobMonitorInterval.current);
      jobMonitorInterval.current = null;
      console.log("🧹 Cleared existing monitoring before starting new");
    }

    // Initial check immediately
    checkJobStatus(jobId);

    // Start periodic checks every 5 seconds for more responsive updates to stop processing
    const intervalId = window.setInterval(() => {
      // **DEFENSIVE CHECK** - Only check if this is still the current job
      if (jobStatus?.jobId === jobId) {
        console.log("⏰ Scheduled job status check for:", jobId);
        checkJobStatus(jobId);
      } else {
        console.log("🛑 Stopping monitoring - job ID changed:", {
          currentJobId: jobStatus?.jobId,
          monitoringJobId: jobId
        });
        window.clearInterval(intervalId);
      }
    }, 5000); // **REDUCED from 15000 to 5000 for faster stop processing detection**
    
    jobMonitorInterval.current = intervalId;
    console.log("✅ Job monitoring started with interval ID:", intervalId);
  };

  // **FIXED** Monitor job status with proper cleanup and defensive checks
  useEffect(() => {
    console.log("🎯 Job monitoring effect triggered:", {
      jobId: jobStatus?.jobId,
      status: jobStatus?.status,
      hasInterval: !!jobMonitorInterval.current
    });

    // Clear any existing interval first
    if (jobMonitorInterval.current) {
      window.clearInterval(jobMonitorInterval.current);
      jobMonitorInterval.current = null;
      console.log("🧹 Cleared existing monitoring interval");
    }

    // Only start monitoring if we have a valid, active job
    if (jobStatus?.jobId && 
        jobStatus.status !== "completed" && 
        jobStatus.status !== "failed" &&
        jobStatus.status !== "cancelled") {
      
      console.log("🎯 Starting NEW job monitoring for:", jobStatus.jobId);
      startJobMonitoring(jobStatus.jobId);
    } else {
      console.log("🛑 Not starting monitoring:", {
        hasJobId: !!jobStatus?.jobId,
        status: jobStatus?.status,
        reason: !jobStatus?.jobId ? "no job ID" : `status is ${jobStatus.status}`
      });
    }

    // Cleanup function
    return () => {
      if (jobMonitorInterval.current) {
        window.clearInterval(jobMonitorInterval.current);
        jobMonitorInterval.current = null;
        console.log("🧹 Cleanup: cleared job monitoring interval");
      }
    };
  }, [jobStatus?.jobId, jobStatus?.status]); // **Watch both jobId AND status**

  useEffect(() => {
    if (sidebarOpen) {
      startTimeRef.current = Date.now();
      // Fetch human patterns when sidebar opens
      fetchHumanPatterns();
      // Check cooldown status when sidebar opens
      if (currentUserFullname) {
        const userId = getUserId();
        checkCooldownStatus(userId);
      }
      // Debug job memory when sidebar opens
      debugJobMemory();
    } else if (startTimeRef.current) {
      const durationSeconds = Math.round(
        (Date.now() - startTimeRef.current) / 1000
      );
      posthog.capture("extension_sidebar_time_spent", {
        duration_seconds: durationSeconds,
        page: window.location.href,
        source: "UDS LinkedIn Extension",
        user: currentUserFullname,
      });
      startTimeRef.current = null;
    }
  }, [sidebarOpen, currentUserFullname]);

  useEffect(() => {
    const handleUnload = () => {
      if (startTimeRef.current && sidebarOpen) {
        const durationSeconds = Math.round(
          (Date.now() - startTimeRef.current) / 1000
        );
        posthog.capture("extension_sidebar_time_spent", {
          duration_seconds: durationSeconds,
          page: window.location.href,
          source: "UDS LinkedIn Extension",
          user: currentUserFullname,
        });
      }
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [sidebarOpen]);

  // Check for cooldown status
  const checkCooldownStatus = async (userId: string) => {
    try {
      console.log("🔍 Checking cooldown status for user:", userId);
      const response = await fetch(`${API_BASE_URL}/user-cooldown/${encodeURIComponent(userId)}`);
      console.log("🔍 Cooldown API response status:", response.status);

      if (response.ok) {
        const result = await response.json();
        console.log("🔍 Cooldown API result:", result);

        if (result.success && result.cooldownStatus?.hasCooldown) {
          const cooldownData = result.cooldownStatus;
          const daysLeft = cooldownData.daysRemaining || 0;

          console.log("🚫 User is in cooldown period:", {
            daysLeft,
            completedAt: cooldownData.completedAt,
            cooldownEndDate: cooldownData.cooldownEndDate
          });

          setCooldownInfo({
            active: true,
            daysLeft: Math.max(0, Math.ceil(daysLeft)),
            lastCompleted: cooldownData.completedAt
          });

          // Show info message in UI (all contacts updated)
          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "cooldown_active",
              message: `🚫 Cooldown Period Active\nAll contacts updated.\nDays Remaining:\n${Math.max(0, Math.ceil(daysLeft))} days\nLast Completed:\n${new Date(cooldownData.completedAt).toLocaleString()}\nAll contacts have been processed. Please wait for the cooldown period to end before starting a new processing job.`,
              cooldownInfo: {
                active: true,
                daysLeft: Math.max(0, Math.ceil(daysLeft)),
                lastCompleted: cooldownData.completedAt
              }
            },
          });

          return true; // User is in cooldown
        } else {
          console.log("✅ No cooldown active for user:", userId);
          setCooldownInfo(null);
          return false; // No cooldown
        }
      } else {
        console.log("❌ Cooldown API call failed with status:", response.status);
        return false;
      }
    } catch (error) {
      console.error("❌ Error checking cooldown status:", error);
      return false;
    }
  };

  // Handle cooldown override
const handleOverrideCooldown = async () => {
  const userId = getUserId();
  console.log("🔓 Attempting to override cooldown for user:", userId);
  
  try {
    const response = await fetch(`${API_BASE_URL}/restart-processing/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reason: 'User manual restart from extension'
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log("✅ Processing restart successful:", result.message);
      
      // Clear cooldown state immediately
      setCooldownInfo(null);
      setJobStatus(null);
      localStorage.removeItem("lastJobRun");
      
      // **CLEAR MONITORING ON OVERRIDE**
      if (jobMonitorInterval.current) {
        window.clearInterval(jobMonitorInterval.current);
        jobMonitorInterval.current = null;
        console.log("🧹 Cleared monitoring during cooldown override");
      }
      
      // Send success message
      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        data: {
          status: "ready",
          message: "✅ Cooldown overridden! You can now start processing contacts again.",
        },
      });
      
      // **NEW: Check for existing jobs after override**
      console.log("🔍 Checking for existing jobs after cooldown override...");
      
      try {
        const crmParam = crmUrl ? `?crmUrl=${encodeURIComponent(crmUrl)}` : '';
        const jobCheckResponse = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}${crmParam}`);
        console.log("🔍 Post-override job check status:", jobCheckResponse.status);
        
        if (jobCheckResponse.ok) {
          const jobResult = await jobCheckResponse.json();
          console.log("📋 Post-override job result:", jobResult);
          
          // Check if there's a job that can be resumed
          if (jobResult.success && jobResult.canResume && jobResult.job) {
            console.log("✅ Found resumable job after override:", jobResult.job.jobId);
            
            // Set the job status to trigger monitoring
            setJobStatus(jobResult.job);
            setDailyLimitInfo(jobResult.job.dailyLimitInfo);
            
            const ageInfo = jobResult.job.jobAge?.days > 0 ? ` (${jobResult.job.jobAge.days}d old)` : '';
            let statusMessage = "";
            
            if (jobResult.job.status === "processing") {
              statusMessage = `🔄 Continuing job${ageInfo}... (${jobResult.job.processedCount}/${jobResult.job.totalContacts})`;
            } else if (jobResult.job.status === "paused") {
              // Use new pauseDisplayInfo if available
              if (jobResult.job.pauseDisplayInfo) {
                const pauseInfo = jobResult.job.pauseDisplayInfo;
                const pausedTime = jobResult.job.pausedAt 
                  ? ` (${new Date(jobResult.job.pausedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` 
                  : '';
                
                if (pauseInfo.needsUserAction) {
                  statusMessage = `⚠️ Job needs attention${ageInfo}${pausedTime} - ${pauseInfo.message}`;
                } else {
                  statusMessage = `⏸️ Found paused job${ageInfo}${pausedTime} - ${pauseInfo.message}`;
                }
              } else {
                statusMessage = `⏸️ Found paused job${ageInfo}. Ready to resume: ${jobResult.job.processedCount}/${jobResult.job.totalContacts}`;
              }
            } else {
              statusMessage = `Found ${jobResult.job.status} job${ageInfo}. Progress: ${jobResult.job.processedCount}/${jobResult.job.totalContacts}`;
            }
            
            // Update the message to show job found
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: jobResult.job.status === "processing" ? "continuing" : "can_resume",
                message: statusMessage,
                canResume: true,
                jobData: jobResult.job,
                dailyLimitInfo: jobResult.job.dailyLimitInfo,
                humanPattern: jobResult.currentPatternInfo,
                jobAge: jobResult.job.jobAge,
              },
            });
            
            console.log("✅ Job status set, monitoring will start via useEffect");
          } else {
            console.log("ℹ️ No resumable job found after override, staying in ready state");
            // Check daily limits for ready state message
            const limits = await checkDailyLimits(userId);
            const readyMessage = limits 
              ? `Ready to process. Today: ${limits.dailyCount}/${limits.dailyLimit} | Current pattern: ${limits.currentPattern} (${limits.patternCount}/${limits.patternLimit || '∞'})`
              : "Ready to process LinkedIn profiles";
            
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "ready",
                message: readyMessage,
                dailyLimitInfo: limits,
              },
            });
          }
        } else {
          console.log("ℹ️ Job check failed after override, staying in ready state");
        }
      } catch (jobCheckError) {
        console.error("❌ Error checking jobs after override:", jobCheckError);
        // Don't fail the override, just log the error
      }
      
      return true;
    } else {
      console.error("❌ Processing restart failed:", result.message);
      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        data: {
          status: "error",
          message: `❌ Failed to restart processing: ${result.message}`,
        },
      });
      return false;
    }
  } catch (error) {
    console.error("❌ Error during processing restart:", error);
    chrome.runtime.sendMessage({
      type: "PROCESS_STATUS",
      data: {
        status: "error",
        message: `❌ Error restarting processing: ${error.message}`,
      },
    });
    return false;
  }
};

  // **UPDATED** Handle stopping/completing processing - marks all remaining as successful
  const handleStopProcessing = async () => {
    const userId = getUserId();
    console.log("✅ Attempting to complete processing for user:", userId);

    try {
      const response = await fetch(`${API_BASE_URL}/cancel-processing/${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reason: 'User completed processing from extension - all remaining contacts marked as successful',
          crmUrl: crmUrl
        })
      });

      console.log("🔍 Complete API response status:", response.status);
      console.log("🔍 Complete API response headers:", Object.fromEntries(response.headers.entries()));

      const result = await response.json();
      console.log("🔍 Complete API result:", result);

      if (result.success) {
        console.log("✅ Processing completed successfully:", result.message);

        // **FORCE CLEAR** job status and monitoring immediately
        setJobStatus(null);

        if (jobMonitorInterval.current) {
          window.clearInterval(jobMonitorInterval.current);
          jobMonitorInterval.current = null;
          console.log("🧹 Cleared monitoring immediately after completion");
        }

        // **CHECK COOLDOWN STATUS AFTER COMPLETION**
        console.log("🔍 Checking cooldown status after completion...");
        const isInCooldown = await checkCooldownStatus(userId);
        console.log("🔍 Cooldown status after completion:", isInCooldown);

        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "completed",
            message: "✅ Processing completed successfully! All remaining contacts have been marked as successful.",
          },
        });

        return true;
      } else {
        console.error("❌ Processing completion failed:", result.message);
        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "error",
            message: `❌ Failed to complete processing: ${result.message}`,
          },
        });
        return false;
      }
    } catch (error) {
      console.error("❌ Error during completion:", error);
      console.error("❌ Error details:", {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        data: {
          status: "error",
          message: `❌ Error completing processing: ${error.message}`,
        },
      });
      return false;
    }
  };

  // **NEW** Handle force run - resets all limits and starts processing
  const handleForceRun = async () => {
    const userId = getUserId();
    console.log("🚀 Attempting to force run for user:", userId);

    try {
      const response = await fetch(`${API_BASE_URL}/force-run/${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log("🔍 Force run API response status:", response.status);
      const result = await response.json();
      console.log("🔍 Force run API result:", result);

      if (result.success) {
        console.log("✅ Force run successful:", result.message);
        
        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "success",
            message: "🚀 Force run successful! All limits reset and processing started.",
          },
        });

        // Refresh job status immediately
        const userId = getUserId();
        try {
          const crmParam = crmUrl ? `?crmUrl=${encodeURIComponent(crmUrl)}` : '';
          const response = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}${crmParam}`);
          if (response.ok) {
            const result = await response.json();
            if (result.success && result.job) {
              setJobStatus(result.job);
              setDailyLimitInfo(result.job.dailyLimitInfo);
            }
          }
        } catch (refreshError) {
          console.error("Error refreshing job status:", refreshError);
        }
        
        return true;
      } else {
        console.error("❌ Force run failed:", result.message);
        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "error",
            message: `❌ Force run failed: ${result.message}`,
          },
        });
        return false;
      }
    } catch (error) {
      console.error("❌ Error during force run:", error);
      chrome.runtime.sendMessage({
        type: "PROCESS_STATUS",
        data: {
          status: "error",
          message: `❌ Error during force run: ${error.message}`,
        },
      });
      return false;
    }
  };

  const callStartProcessingAPI = async (requestData: any) => {
    const userId = getUserId();

    // **COOLDOWN CHECK BEFORE STARTING PROCESSING**
    console.log("🔍 Checking cooldown before starting processing...");
    const isInCooldown = await checkCooldownStatus(userId);
    if (isInCooldown) {
      console.log("🚫 Cannot start processing - user is in cooldown period");
      throw new Error("Cannot start processing while in cooldown period. Please wait for the cooldown to end or use the override option.");
    }
    console.log("✅ No cooldown active, proceeding with processing start...");

    const response = await fetch(`${API_BASE_URL}/start-processing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(requestData),
    });

    const result = await response.json();

    // Handle different response cases
    if (response.ok) {
      // Success case
      return result;
    } else if (response.status === 403 && result.cooldownOverridden) {
      // **NEW** Cooldown overridden case - user needs to see override button
      console.log("🚫 API returned cooldown overridden:", result);
      return { ...result, needsOverrideButton: true };
    } else if (response.status === 400 && result.canResume) {
      // Incomplete job case - this is actually expected behavior
      console.log("📋 API returned incomplete job info:", result);
      return result;
    } else if (response.status === 400 && (result.jobCancelled || result.message?.includes('cancelled'))) {
      // **NEW** Cancelled job case - return with cancelled flag
      console.log("🛑 API returned cancelled job info:", result);
      return { ...result, jobCancelled: true };
    } else if (response.status === 429) {
      // Rate limit case
      throw new Error(result.message || "Daily/hourly rate limit exceeded. Please try again later.");
    } else {
      // Other error cases
      throw new Error(result.message || `API call failed with status ${response.status}`);
    }
  };

  // **ENHANCED** Job checking with cancelled job handling
  useEffect(() => {
    console.log("🔍 useEffect TRIGGERED with auth state:", {
      currentUserFullname: !!currentUserFullname,
      accessToken: !!accessToken,
      actualValues: {
        currentUserFullname,
        accessToken: accessToken?.substring(0, 10) + "..."
      }
    });
    
    const checkExistingJob = async () => {
      console.log("🔍 checkExistingJob STARTED - condition check:", {
        currentUserFullname: !!currentUserFullname,
        accessToken: !!accessToken,
        actualCurrentUserFullname: currentUserFullname,
        actualAccessToken: accessToken?.substring(0, 10) + "..."
      });
      
      if (!currentUserFullname || !accessToken) {
        console.log("❌ checkExistingJob EARLY RETURN - missing requirements:", {
          hasCurrentUserFullname: !!currentUserFullname,
          hasAccessToken: !!accessToken,
          currentUserFullnameValue: currentUserFullname,
          currentUserFullnameType: typeof currentUserFullname,
          isEmptyString: currentUserFullname === ""
        });
        return;
      }

      const userId = getUserId();
      const lastRun = localStorage.getItem("lastJobRun");

      console.log(`🔍 Enhanced job check for user: ${userId}`);
      console.log(`🔍 Last job run timestamp: ${lastRun}`);
      console.log(`🔍 Has one month passed: ${hasOneMonthPassed(lastRun)}`);

      // **CLEAR OLD JOB STATUS FIRST** - This is the key fix!
      setJobStatus(null);

      // Clear any existing monitoring intervals
      if (jobMonitorInterval.current) {
        window.clearInterval(jobMonitorInterval.current);
        jobMonitorInterval.current = null;
        console.log("🧹 Cleared old monitoring interval during job check");
      }

      // **FIRST PRIORITY: Check for cooldown status**
      console.log("🔍 Step 1: Checking cooldown status...");
      const isInCooldown = await checkCooldownStatus(userId);
      if (isInCooldown) {
        console.log("🚫 User is in cooldown period, skipping other checks");
        return;
      }
      console.log("✅ No cooldown active, proceeding with job check...");

      console.log("🔍 DEBUG: About to start pattern and limits check...");
      console.log("🔍 DEBUG: Current state before patterns:", {
        userId,
        currentUserFullname,
        accessToken,
        sidebarOpen
      });

      // Check human patterns first
      console.log("🔍 BEFORE fetchHumanPatterns...");
      let patternInfo = null;
      try {
        patternInfo = await fetchHumanPatterns();
        console.log("✅ fetchHumanPatterns SUCCESS:", patternInfo);
      } catch (patternError) {
        console.error("❌ fetchHumanPatterns ERROR:", patternError);
        // Continue despite pattern error
      }

      // Check daily limits
      console.log("🔍 BEFORE checkDailyLimits...");
      let limits = null;
      try {
        limits = await checkDailyLimits(userId);
        console.log("✅ checkDailyLimits SUCCESS:", limits);
      } catch (limitsError) {
        console.error("❌ checkDailyLimits ERROR:", limitsError);
        // Continue despite limits error
      }

      console.log("✅ BOTH FUNCTIONS COMPLETED - Moving to Step 2...");

      // **FIRST: Always check for existing jobs regardless of limits**
      console.log("🔍 Step 2: Checking for existing jobs first...");
      try {
        const crmParam = crmUrl ? `?crmUrl=${encodeURIComponent(crmUrl)}` : '';
        const jobResponse = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}${crmParam}`, {
          method: 'GET',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
        console.log("🔍 Job response status:", jobResponse.status);
        console.log("🔍 Job response ok:", jobResponse.ok);
        console.log("🔍 Job response statusText:", jobResponse.statusText);
        console.log("🔍 API URL:", `${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`);
        
        // **FIX: Handle 304 Not Modified as success**
        if (jobResponse.ok || jobResponse.status === 304) {
          let jobResult;
          try {
            jobResult = await jobResponse.json();
            console.log("🔍 Job result:", jobResult);
          } catch (jsonError) {
            if (jobResponse.status === 304) {
              console.log("⚠️ 304 response with no body - treating as no job found");
              jobResult = { success: true, canResume: false, job: null };
            } else {
              throw jsonError;
            }
          }
          console.log("🔍 Condition checks:", {
            success: jobResult.success,
            canResume: jobResult.canResume,
            hasJob: !!jobResult.job,
            jobStatus: jobResult.job?.status,
            jobType: typeof jobResult.job,
            jobKeys: jobResult.job ? Object.keys(jobResult.job) : 'no job'
          });
          
          // **PRIORITY 1: If there's an existing job, show it regardless of limits**
          console.log("🔍 Testing individual conditions:");
          console.log("🔍 jobResult.success:", jobResult.success, typeof jobResult.success);
          console.log("🔍 jobResult.canResume:", jobResult.canResume, typeof jobResult.canResume);  
          console.log("🔍 jobResult.job:", jobResult.job, typeof jobResult.job);
          console.log("🔍 !!jobResult.job:", !!jobResult.job);
          
          const conditionResult = jobResult.success && jobResult.canResume && jobResult.job;
          console.log("🔍 Final condition result:", conditionResult);
          console.log("🔍 DETAILED CHECK:", {
            step1: jobResult.success,
            step2: jobResult.success && jobResult.canResume,
            step3: jobResult.success && jobResult.canResume && jobResult.job,
            finalResult: conditionResult
          });
          
          // **ACTUAL CONDITION CHECK - FIXED**
          if (conditionResult) {
            console.log("✅ Found existing job - prioritizing job display over limits");
            console.log("🔍 Job details:", {
              status: jobResult.job.status,
              pauseDisplayInfo: jobResult.job.pauseDisplayInfo,
              hourlyLimitReached: jobResult.job.hourlyLimitInfo?.hourlyLimitReached,
              waitMinutes: jobResult.job.hourlyLimitInfo?.waitInfo?.waitMinutes
            });
            const jobObj = jobResult.job;
            
            setJobStatus(jobObj);
            setDailyLimitInfo(jobObj.dailyLimitInfo);
            setAuthError(null);

            let statusMessage = "";
            const ageInfo = jobObj.jobAge?.days > 0 ? ` (${jobObj.jobAge.days}d old)` : '';

            if (jobObj.status === "processing") {
              statusMessage = `🔄 Continuing job${ageInfo}... (${jobObj.processedCount}/${jobObj.totalContacts})`;
            } else if (jobObj.status === "paused") {
              // Use new pauseDisplayInfo if available
              if (jobObj.pauseDisplayInfo) {
                const pauseInfo = jobObj.pauseDisplayInfo;
                const pausedTime = jobObj.pausedAt 
                  ? ` (${new Date(jobObj.pausedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` 
                  : '';
                
                if (pauseInfo.needsUserAction) {
                  statusMessage = `⚠️ Job needs attention${ageInfo}${pausedTime} - ${pauseInfo.message}`;
                } else {
                  statusMessage = `⏸️ Job paused${ageInfo}${pausedTime} - ${pauseInfo.message}`;
                }
              } 
              // Fallback to hourly limit logic for paused jobs
              else if (jobObj.hourlyLimitInfo?.hourlyLimitReached) {
                const waitTime = jobObj.hourlyLimitInfo.waitInfo?.waitMinutes || 0;
                statusMessage = `⏸️ Job paused${ageInfo} - Hourly limit reached. Wait ${waitTime} minutes.`;
              }
              else {
                statusMessage = `⏸️ Job paused${ageInfo}. Processed: ${jobObj.processedCount}/${jobObj.totalContacts}`;
              }
            } else {
              statusMessage = `Found ${jobObj.status} job${ageInfo}. Progress: ${jobObj.processedCount}/${jobObj.totalContacts}`;
            }

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: jobObj.status,
                message: statusMessage,
                canResume: jobObj.status === "paused",
                jobData: jobObj,
                dailyLimitInfo: jobObj.dailyLimitInfo,
                humanPattern: jobResult.currentPatternInfo,
                jobAge: jobObj.jobAge,
              },
            });
            
            setIsCheckingJob(false);
            console.log("🚨 RETURNING EARLY - NO MORE CODE SHOULD RUN AFTER THIS");
            return; // Exit early - existing job takes priority
          } else {
            console.log("❌ Job condition failed:", {
              success: jobResult.success,
              canResume: jobResult.canResume,
              hasJob: !!jobResult.job,
              reason: !jobResult.success ? 'success=false' : 
                      !jobResult.canResume ? 'canResume=false' : 
                      !jobResult.job ? 'job missing' : 'unknown'
            });
          }
        } else {
          console.log("❌ Job response NOT OK:", {
            status: jobResponse.status,
            statusText: jobResponse.statusText,
            ok: jobResponse.ok,
            url: jobResponse.url
          });
        }
      } catch (jobCheckError) {
        console.error("Error checking for existing job:", jobCheckError);
      }

      console.log("🚨 THIS SHOULD NOT RUN IF JOB WAS FOUND - Step 2 continuing...");
      // **PRIORITY 2: Only check limits if no existing job found**
      if (limits && !limits.canProcess) {
        console.log("🚫 No existing job found and processing limits reached");
        
        let message = "Processing limits reached: ";

        if (limits.inPause) {
          message += `Currently in ${limits.currentPattern} pause period. `;
          if (limits.estimatedResumeTime) {
            const resumeTime = new Date(limits.estimatedResumeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            message += `Will resume at ${resumeTime} during ${limits.nextActivePattern?.name}.`;
          }
        } else if (limits.hourlyCount >= limits.hourlyLimit) {
          message += `Hourly limit reached (${limits.hourlyCount}/${limits.hourlyLimit}). `;
          // Add wait time info if available
          const waitMinutes = Math.ceil((new Date().getMinutes() === 0 ? 0 : 60 - new Date().getMinutes()));
          message += `Wait ${waitMinutes} minutes for next hour.`;
        } else if (limits.patternCount >= limits.patternLimit) {
          message += `Pattern limit reached (${limits.patternCount}/${limits.patternLimit} for ${limits.currentPattern}). `;
        } else if (limits.dailyCount >= limits.dailyLimit) {
          message += `Daily limit reached (${limits.dailyCount}/${limits.dailyLimit}). `;
        }

        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "limit_reached",
            message,
            dailyLimitInfo: limits,
            humanPattern: patternInfo?.currentPattern?.info,
          },
        });
        setIsCheckingJob(false);
        return;
      }

      // **PRIORITY 3: If no limits blocking and no existing job, show ready state**
      setIsCheckingJob(true);
      try {
        console.log("🔍 Step 3: No existing job found, checking for fresh start...");
        const crmParam = crmUrl ? `?crmUrl=${encodeURIComponent(crmUrl)}` : '';
        const response = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}${crmParam}`);
        console.log("🔍 User job API response status:", response.status);

        if (response.ok) {
          const result = await response.json();
          console.log("📋 User job API result:", result);

          // Handle cooldown case from user-job endpoint
          if (result.cooldownActive) {
            setCooldownInfo({
              active: true,
              daysLeft: result.cooldownDaysLeft,
              lastCompleted: result.lastCompleted
            });
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cooldown_active",
                message: `🚫 All contacts processed. ${result.cooldownDaysLeft} days remaining until next run allowed.`,
                cooldownInfo: {
                  active: true,
                  daysLeft: result.cooldownDaysLeft,
                  lastCompleted: result.lastCompleted
                }
              },
            });
            return;
          }

          // Double-check: if somehow we missed an active job above, catch it here
          let jobObj = null;
          if (result.job && typeof result.job === 'object') {
            jobObj = result.job;
          } else if (result.jobStatus && typeof result.jobStatus === 'string') {
            jobObj = {
              jobId: result.jobId || 'unknown',
              status: result.jobStatus,
              totalContacts: result.totalContacts || 0,
              processedCount: result.processedCount || 0,
              successCount: result.successCount || 0,
              failureCount: result.failureCount || 0,
              createdAt: result.createdAt || new Date().toISOString(),
            };
          }

          if (jobObj && (jobObj.status === "processing" || jobObj.status === "paused")) {
            console.log("⚠️ Found active job in second check - this should have been caught earlier!");
            setJobStatus(jobObj);
            setDailyLimitInfo(jobObj.dailyLimitInfo);
            return;
          }

          // Handle completed job cooldown logic
          if (jobObj && jobObj.status === "completed") {
            if (jobObj.cooldownOverridden) {
              console.log("🔓 Job was cooldown overridden - ignoring completed job and staying ready");
              setJobStatus(null);
              setAuthError(null);
              const readyMessage = limits 
                ? `Ready to process. Today: ${limits.dailyCount}/${limits.dailyLimit} | Current pattern: ${limits.currentPattern} (${limits.patternCount}/${limits.patternLimit || '∞'})`
                : "Ready to process LinkedIn profiles";

              chrome.runtime.sendMessage({
                type: "PROCESS_STATUS",
                data: {
                  status: "ready",
                  message: readyMessage,
                  dailyLimitInfo: limits,
                  humanPattern: patternInfo?.currentPattern?.info,
                },
              });
              return;
            }

            const completedAt = new Date(jobObj.completedAt);
            const daysSinceCompletion = (Date.now() - completedAt.getTime()) / (1000 * 60 * 60 * 24);

            if (daysSinceCompletion < 30 && jobObj.processedCount >= jobObj.totalContacts) {
              const daysLeft = Math.ceil(30 - daysSinceCompletion);
              setCooldownInfo({
                active: true,
                daysLeft: daysLeft,
                lastCompleted: jobObj.completedAt
              });
              chrome.runtime.sendMessage({
                type: "PROCESS_STATUS",
                data: {
                  status: "cooldown_active",
                  message: `🚫 All contacts processed. ${daysLeft} days remaining until next run allowed.`,
                  cooldownInfo: {
                    active: true,
                    daysLeft: daysLeft,
                    lastCompleted: jobObj.completedAt
                  }
                },
              });
              return;
            }
          }

          // Handle cancelled/failed job case
          if (jobObj && (jobObj.status === "cancelled" || jobObj.status === "failed")) {
            setJobStatus(jobObj);
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: jobObj.status,
                message: `🛑 Processing was ${jobObj.status}. Progress saved: ${jobObj.processedCount}/${jobObj.totalContacts} contacts. You can restart processing from where you left off.`,
                progress: {
                  total: jobObj.totalContacts,
                  processed: jobObj.processedCount,
                  success: jobObj.successCount,
                  failed: jobObj.failureCount,
                },
                canRestart: true,
                jobData: jobObj,
              },
            });
            return;
          }

          // **FINAL STATE: Ready to process**
          console.log("✅ No active job found, setting ready state");
          setJobStatus(null);
          setAuthError(null);
          const readyMessage = limits 
            ? `Ready to process. Today: ${limits.dailyCount}/${limits.dailyLimit} | Current pattern: ${limits.currentPattern} (${limits.patternCount}/${limits.patternLimit || '∞'})`
            : "Ready to process LinkedIn profiles";

          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "ready",
              message: readyMessage,
              dailyLimitInfo: limits,
              humanPattern: patternInfo?.currentPattern?.info,
            },
          });
        } else {
          setJobStatus(null);
        }
      } catch (error) {
        console.error("Error checking existing job:", error);
        setJobStatus(null);
      } finally {
        setIsCheckingJob(false);
      }
    };

    if (currentUserFullname && currentUserFullname.trim() !== "" && accessToken) {
      console.log("🚀 CALLING checkExistingJob - Auth state valid:", {
        currentUserFullname,
        hasAccessToken: !!accessToken
      });
      checkExistingJob();
    } else {
      console.log("❌ NOT CALLING checkExistingJob - Auth state invalid:", {
        currentUserFullname,
        currentUserFullnameType: typeof currentUserFullname,
        hasAccessToken: !!accessToken,
        isEmptyString: currentUserFullname === "",
        isTrimmedEmpty: currentUserFullname?.trim() === ""
      });
    }
  }, [currentUserFullname, accessToken]);

  // Enhanced message listener with cancel handling
  useEffect(() => {
    let abortController: AbortController | null = null;

    const messageListener = async (request: any) => {
      if (request.type === "LINKEDIN_COOKIES") {
        const userId = getUserId();

        try {
          // **FIRST PRIORITY: Check cooldown status before any processing**
          console.log("🔍 Step 1: Checking cooldown status before processing...");
          const isInCooldown = await checkCooldownStatus(userId);
          if (isInCooldown) {
            console.log("🚫 User is in cooldown period, blocking processing start");
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cooldown_active",
                message: "🚫 Cannot start processing while in cooldown period. Please wait for the cooldown to end or use the override option.",
                cooldownInfo: cooldownInfo
              },
            });
            return;
          }
          console.log("✅ No cooldown active, proceeding with processing checks...");

          // Check human patterns first
          const patternInfo = await fetchHumanPatterns();

          // Check daily limits before starting any job
          const limits = await checkDailyLimits(userId);
          if (limits && !limits.canProcess) {
            let message = "Cannot start processing: ";

            if (limits.inPause) {
              message += `Currently in ${limits.currentPattern} pause period. `;
              if (limits.estimatedResumeTime) {
                const resumeTime = new Date(limits.estimatedResumeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                message += `Will resume at ${resumeTime} during ${limits.nextActivePattern?.name}.`;
              }
            } else if (limits.patternCount >= limits.patternLimit) {
              message += `Pattern limit reached (${limits.patternCount}/${limits.patternLimit} for ${limits.currentPattern}). `;
            } else if (limits.dailyCount >= limits.dailyLimit) {
              message += `Daily limit reached (${limits.dailyCount}/${limits.dailyLimit}). `;
            } else if (limits.hourlyCount >= limits.hourlyLimit) {
              message += `Hourly limit reached (${limits.hourlyCount}/${limits.hourlyLimit}). `;
            }

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "limit_reached",
                message,
                dailyLimitInfo: limits,
                humanPattern: patternInfo?.currentPattern?.info,
              },
            });
            return;
          }

          // Check for existing job with enhanced logging
          console.log("🔍 Checking for existing job before starting new one...");
          const crmParam = crmUrl ? `?crmUrl=${encodeURIComponent(crmUrl)}` : '';
          const existingJobResponse = await fetch(
            `${API_BASE_URL}/user-job/${encodeURIComponent(userId)}${crmParam}`
          );
          
          let shouldResume = false;
          if (existingJobResponse.ok) {
            const existingJobResult = await existingJobResponse.json();

            if (existingJobResult.success && existingJobResult.canResume) {
              shouldResume = true;
              
              const ageInfo = existingJobResult.job.jobAge?.days > 0 ? ` (${existingJobResult.job.jobAge.days}d old)` : '';
              chrome.runtime.sendMessage({
                type: "PROCESS_STATUS",
                data: {
                  status: "resuming",
                  message: `🔄 Resuming existing job${ageInfo}... (${existingJobResult.job.processedCount}/${existingJobResult.job.totalContacts})`,
                  humanPattern: existingJobResult.currentPatternInfo,
                  jobAge: existingJobResult.job.jobAge,
                },
              });

              const jession = request.data.jsessionid.replace(/^"(.*)"$/, "$1");
              const resumeRequestData = {
                userId,
                jsessionid: jession,
                li_at: request.data.li_at,
                accessToken,
                refreshToken,
                clientId,
                tenantId,
                verifier: code_verifier,
                crmUrl,
                resume: true,
              };

              const resumeResult = await callStartProcessingAPI(resumeRequestData);
              
              // Handle cooldown case for resume
              if (resumeResult.cooldownActive) {
                setCooldownInfo({
                  active: true,
                  daysLeft: resumeResult.cooldownDaysLeft,
                  lastCompleted: resumeResult.lastCompleted
                });
                chrome.runtime.sendMessage({
                  type: "PROCESS_STATUS",
                  data: {
                    status: "cooldown_active",
                    message: `🚫 All contacts processed. ${resumeResult.cooldownDaysLeft} days remaining until next run allowed.`,
                    cooldownInfo: {
                      active: true,
                      daysLeft: resumeResult.cooldownDaysLeft,
                      lastCompleted: resumeResult.lastCompleted
                    }
                  },
                });
                return;
              }
              
              if (resumeResult.success) {
                setJobStatus(existingJobResult.job);
                // Job monitoring will start via useEffect
                setJobRunTimestamp();
              }
              return;
            }
          }
        } catch (error) {
          console.error("Error checking/resuming job:", error);
        }

        // Start new job
        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "starting",
            message: "🚀 Starting new LinkedIn profile processing job...",
          },
        });

        const jession = request.data.jsessionid.replace(/^"(.*)"$/, "$1");
        const requestData = {
          userId,
          jsessionid: jession,
          li_at: request.data.li_at,
          accessToken,
          refreshToken,
          clientId,
          tenantId,
          verifier: code_verifier,
          crmUrl,
          resume: false,
        };

        try {
          const result = await callStartProcessingAPI(requestData);

          // Handle cooldown override 403 response - show override button
          if (result.needsOverrideButton || (result.cooldownOverridden && !result.success)) {
            console.log("🚫 Cooldown overridden - showing override option:", result);
            setCooldownInfo({
              active: true,
              daysLeft: result.daysLeft || 30,
              lastCompleted: result.overriddenAt,
              needsOverride: true,
              overrideReason: result.message
            });
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cooldown_override_needed",
                message: result.message || "Cooldown is overridden. Please use the override option to continue.",
                cooldownInfo: {
                  active: true,
                  daysLeft: result.daysLeft || 30,
                  lastCompleted: result.overriddenAt,
                  needsOverride: true,
                  overrideReason: result.message
                },
                needsOverride: true
              },
            });
            return;
          }

          // Handle failed/cancelled job case from start-processing endpoint
          if ((result.jobStatus === 'failed' || result.jobStatus === 'cancelled') && result.cancelInfo) {
            setJobStatus({
              jobId: result.cancelInfo.jobId,
              status: result.cancelInfo.status,
              processedCount: result.cancelInfo.processedCount,
              totalContacts: result.cancelInfo.totalContacts,
              successCount: 0, // Not available in response
              failureCount: 0, // Not available in response
              createdAt: result.cancelInfo.cancelledAt,
              cancelledAt: result.cancelInfo.cancelledAt,
              canRestart: result.canRestart,
              dailyLimitInfo: result.limitInfo,
              currentPattern: result.currentPattern,
            });
            setDailyLimitInfo(result.limitInfo);
            setCurrentHumanPattern(null);
            setCooldownInfo(null);
            setAuthError(null);
            return;
          }

          // Handle cooldown override success case (older logic)
          if (result.cooldownOverridden === true && result.success) {
            const cooldownOverrideState = {
              jobId: result.jobId,
              status: "completed",
              totalContacts: 0,
              processedCount: 0,
              successCount: 0,
              failureCount: 0,
              createdAt: new Date().toISOString(),
              cooldownOverridden: true,
              overriddenAt: result.overriddenAt,
              message: result.message || "Cooldown is overridden. Please wait 1 month or contact admin.",
            };
            setJobStatus(cooldownOverrideState);
            localStorage.setItem("jobStatusCooldownOverride", JSON.stringify(cooldownOverrideState));
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "completed",
                message: cooldownOverrideState.message,
                cooldownOverridden: true,
                overriddenAt: result.overriddenAt,
              },
            });
            return;
          }

          // Handle cooldown case specifically
          if (result.cooldownActive) {
            setCooldownInfo({
              active: true,
              daysLeft: result.cooldownDaysLeft,
              lastCompleted: result.lastCompleted
            });
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cooldown_active",
                message: `🚫 All contacts processed. ${result.cooldownDaysLeft} days remaining until next run allowed.`,
                cooldownInfo: {
                  active: true,
                  daysLeft: result.cooldownDaysLeft,
                  lastCompleted: result.lastCompleted
                }
              },
            });
            return;
          }

          // Handle successful job start
          if (result.success && result.jobId) {
            console.log("✅ Job started successfully:", result.jobId);
            const jobData = {
              jobId: result.jobId,
              status: "processing",
              totalContacts: result.totalContacts || 0,
              processedCount: 0,
              successCount: 0,
              failureCount: 0,
              createdAt: new Date().toISOString(),
            };
            setJobStatus(jobData);
            setJobRunTimestamp();

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "processing",
                message: `🔄 Processing started! Found ${result.totalContacts || 0} contacts to process.`,
                progress: {
                  total: result.totalContacts || 0,
                  processed: 0,
                  success: 0,
                  failed: 0,
                },
                humanPattern: patternInfo?.currentPattern?.info,
              },
            });
          }

        } catch (error) {
          console.error("Error starting processing:", error);
          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "error",
              message: `❌ Error: ${error.message}`,
            },
          });
        }
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [
    accessToken,
    crmUrl,
    refreshToken,
    code_verifier,
    clientId,
    tenantId,
    currentUserFullname,
    jobStatus,
  ]);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_USER_DATA" });
    const messageListener = (request: any) => {
      if (request.type === "USER_DATA_RESPONSE_CURRENT") {
        const { linkedin, country, ip } = request.data;
        if (linkedin) {
          const fullName =
            linkedin.miniProfile.firstName +
            " " +
            linkedin.miniProfile.lastName;
          setCurrentUserFullName(fullName);

          posthog.identify(linkedin.miniProfile?.publicIdentifier, {
            fullName,
            country,
            ip,
            source: "UDS LinkedIn Extension",
          });
        }
      }
    };
    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, []);

  return (
    <div id="udsextension" className={`${sidebarOpen && "open"}`}>
      <button
        onClick={() => {
          setSidebarOpen(!sidebarOpen);
          posthog.capture("Extension Open", {
            property: "sidebar-open",
            sources: "UDS LINKEDIN Extension",
            user: currentUserFullname,
          });
        }}
        className={`linkedinSidePanelOpenClose`}
      >
        <span>
          <DoubleNextIcon />
        </span>
      </button>
      <div
        id="linkedin-side-panel"
        className={`linkedinSidePanel main ${
          window.location.href.includes(LINKEDIN_PAGE_ENUM.SALES) &&
          "salesExtension"
        }`}
      >
        {updated && (
          <>
            <div className="closeIconLinkedin">
              <JobStatusPopover 
                jobStatus={jobStatus} 
                dailyLimitInfo={dailyLimitInfo}
                isCheckingJob={isCheckingJob}
                currentHumanPattern={currentHumanPattern}
                allHumanPatterns={allHumanPatterns}
                cooldownInfo={cooldownInfo}
                authError={authError}
                needsTokenRefresh={jobStatus?.needsTokenRefresh}
                onOverrideCooldown={handleOverrideCooldown}
                onStopProcessing={handleStopProcessing}
                onForceRun={handleForceRun}
              />
              <span
                onClick={() => {
                  setSidebarOpen(false);
                  posthog.capture("Extension Toggle", {
                    state: "close",
                    source: "UDS LinkedIn Extension",
                    user: currentUserFullname,
                  });
                }}
              >
                <CloseIconBigger />
              </span>
            </div>
            {CurrentPage()}
            {(loading || isCheckingJob) && <Loader />}
            <div className="main__footer">
              <LogoIcon />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;