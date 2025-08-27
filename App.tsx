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
      const response = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`);
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
          
          if (result.job.pauseReason === "daily_limit_reached") {
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
      const response = await fetch(`${API_BASE_URL}/user-cooldown/${encodeURIComponent(userId)}`);
      if (response.ok) {
        const result = await response.json();
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
          
          return true; // User is in cooldown
        } else {
          setCooldownInfo(null);
          return false; // No cooldown
        }
      }
    } catch (error) {
      console.error("Error checking cooldown status:", error);
    }
    return false;
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
        
        // **DON'T CHECK FOR JOBS** - Just stay in ready state
        console.log("✅ Override completed - staying in ready state, no job check");
        
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
    console.log("🛑 Attempting to complete processing for user:", userId);
    
    try {
      const response = await fetch(`${API_BASE_URL}/cancel-processing/${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reason: 'User manual completion from extension - mark all as successful',
          saveProgress: true // Complete all remaining contacts as successful
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        console.log("✅ Processing completed successfully:", result.message);
        
        // **IMMEDIATE CLEANUP** - Clear everything immediately
        setJobStatus(null);
        
        if (jobMonitorInterval.current) {
          window.clearInterval(jobMonitorInterval.current);
          jobMonitorInterval.current = null;
          console.log("🧹 Cleared monitoring during processing completion");
        }
        
        // **FORCE SERVER COOLDOWN CHECK** - Wait for server to set cooldown, then check
        setTimeout(async () => {
          console.log("🔄 Checking if server set cooldown after completion...");
          const isInCooldown = await checkCooldownStatus(userId);
          
          if (isInCooldown) {
            console.log("✅ Server cooldown confirmed");
          } else {
            console.log("⚠️ Server cooldown not found, setting frontend cooldown");
            // **FALLBACK** - Set frontend cooldown if server didn't set it
            setCooldownInfo({
              active: true,
              daysLeft: 30,
              lastCompleted: new Date().toISOString()
            });
            
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cooldown_active",
                message: "🚫 30 days cooldown period started. Use override cooldown to restart processing.",
                cooldownInfo: {
                  active: true,
                  daysLeft: 30,
                  lastCompleted: new Date().toISOString()
                },
                canRestart: false,
              },
            });
          }
        }, 2000); // Wait 2 seconds for server to process
        
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
      console.error("❌ Error during processing completion:", error);
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

  // **NEW** Handle restarting after cancellation
  const handleRestartAfterCancel = async (resetContacts = true) => {
    const userId = getUserId();
    console.log("🔄 Attempting to restart after cancellation for user:", userId);
    
    try {
      const response = await fetch(`${API_BASE_URL}/restart-after-cancel/${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          reason: 'User manual restart from extension after cancellation',
          resetContacts: resetContacts
        })
      });
      
      const result = await response.json();
      
      if (result.success) {
        console.log("✅ Processing restarted successfully:", result.message);
        
        // Clear any previous job status and monitoring
        setJobStatus(null);
        
        if (jobMonitorInterval.current) {
          window.clearInterval(jobMonitorInterval.current);
          jobMonitorInterval.current = null;
          console.log("🧹 Cleared monitoring during restart");
        }
        
        // Set new job status
        const newJobStatus: JobStatus = {
          jobId: result.newJob.jobId,
          status: "processing",
          totalContacts: result.newJob.totalContacts,
          processedCount: result.newJob.processedCount,
          successCount: result.newJob.successCount,
          failureCount: 0,
          createdAt: new Date().toISOString(),
        };
        
        setJobStatus(newJobStatus);
        
        // Send restart message
        chrome.runtime.sendMessage({
          type: "PROCESS_STATUS",
          data: {
            status: "restarted",
            message: result.message,
            progress: {
              total: result.newJob.totalContacts,
              processed: result.newJob.processedCount,
              success: result.newJob.successCount,
              failed: 0,
            },
          },
        });
        
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

  // **ENHANCED** Job checking with cancelled job handling
  useEffect(() => {
    const checkExistingJob = async () => {
      if (!currentUserFullname || !accessToken) return;

      const userId = getUserId();
      const lastRun = localStorage.getItem("lastJobRun");
      
      console.log(`🔍 Enhanced job check for user: ${userId}`);
      
      // **CLEAR OLD JOB STATUS FIRST** - This is the key fix!
      setJobStatus(null);
      
      // Clear any existing monitoring intervals
      if (jobMonitorInterval.current) {
        window.clearInterval(jobMonitorInterval.current);
        jobMonitorInterval.current = null;
        console.log("🧹 Cleared old monitoring interval during job check");
      }
      
      // Check for cooldown first
      const isInCooldown = await checkCooldownStatus(userId);
      if (isInCooldown) {
        console.log("🚫 User is in cooldown period, skipping other checks");
        return;
      }
      
      // Check human patterns first
      const patternInfo = await fetchHumanPatterns();
      
      // Check daily limits
      const limits = await checkDailyLimits(userId);
      
      // If within one month and limits are exceeded, don't check for jobs
      if (!hasOneMonthPassed(lastRun)) {
        if (limits && !limits.canProcess) {
          console.log("🚫 Skipping job check - limits reached");
          let message = "Processing limits reached: ";
          
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
      }

      setIsCheckingJob(true);
      try {
        const response = await fetch(`${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`);

        if (response.ok) {
          const result = await response.json();
          
          console.log("📋 Enhanced job check result:", {
            success: result.success,
            canResume: result.canResume,
            jobId: result.job?.jobId,
            status: result.job?.status
          });
          
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
          
          // Additional check for cooldown even if not explicitly returned
          if (result.job && result.job.status === "completed") {
            // **CHECK FOR COOLDOWN OVERRIDE** - If job was override, don't trigger cooldown
            if (result.job.cooldownOverridden) {
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
            
            const completedAt = new Date(result.job.completedAt);
            const daysSinceCompletion = (Date.now() - completedAt.getTime()) / (1000 * 60 * 60 * 24);
            
            if (daysSinceCompletion < 30 && result.job.processedCount >= result.job.totalContacts) {
              const daysLeft = Math.ceil(30 - daysSinceCompletion);
              setCooldownInfo({
                active: true,
                daysLeft: daysLeft,
                lastCompleted: result.job.completedAt
              });
              chrome.runtime.sendMessage({
                type: "PROCESS_STATUS",
                data: {
                  status: "cooldown_active",
                  message: `🚫 All contacts processed. ${daysLeft} days remaining until next run allowed.`,
                  cooldownInfo: {
                    active: true,
                    daysLeft: daysLeft,
                    lastCompleted: result.job.completedAt
                  }
                },
              });
              return;
            }
          }
          
          // **NEW** Handle cancelled job case
          if (result.job && result.job.status === "cancelled") {
            setJobStatus(result.job);
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cancelled",
                message: `🛑 Processing was cancelled. Progress saved: ${result.job.processedCount}/${result.job.totalContacts} contacts. You can restart processing from where you left off.`,
                progress: {
                  total: result.job.totalContacts,
                  processed: result.job.processedCount,
                  success: result.job.successCount,
                  failed: result.job.failureCount,
                },
                canRestart: true,
                jobData: result.job,
              },
            });
            return;
          }
          
          if (result.success && result.canResume) {
            console.log("✅ Setting NEW job status with ID:", result.job.jobId);
            
            setJobStatus(result.job);
            setDailyLimitInfo(result.job.dailyLimitInfo);
            setAuthError(null); // Clear auth error on successful job check
            
            let statusMessage = "";
            let canResume = true;
            const ageInfo = result.job.jobAge?.days > 0 ? ` (${result.job.jobAge.days}d old)` : '';

            if (result.job.status === "processing") {
              statusMessage = `🔄 Continuing job${ageInfo}... (${result.job.processedCount}/${result.job.totalContacts})`;
              // Don't call startJobMonitoring here - let the useEffect handle it
            } else if (result.job.status === "paused") {
              if (result.job.pauseReason === "daily_limit_reached") {
                statusMessage = `⏸️ Paused${ageInfo} - Daily limit reached. Will resume tomorrow`;
                canResume = false;
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
                statusMessage = `⏸️ Found paused job${ageInfo}. Processed: ${result.job.processedCount}/${result.job.totalContacts}`;
              }
            } else {
              statusMessage = `Found ${result.job.status} job${ageInfo}. Progress: ${result.job.processedCount}/${result.job.totalContacts}`;
            }

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: result.job.status === "processing" ? "continuing" : "can_resume",
                message: statusMessage,
                canResume,
                jobData: result.job,
                dailyLimitInfo: result.job.dailyLimitInfo,
                humanPattern: result.currentPatternInfo,
                jobAge: result.job.jobAge,
              },
            });
          } else {
            console.log("❌ No active job found, clearing job status");
            setJobStatus(null);
            setAuthError(null); // Clear auth error when ready
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
          }
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

    if (currentUserFullname && accessToken) {
      checkExistingJob();
    }
  }, [currentUserFullname, accessToken]);

  // Enhanced message listener with cancel handling
  useEffect(() => {
    let abortController: AbortController | null = null;

    const messageListener = async (request: any) => {
      if (request.type === "LINKEDIN_COOKIES") {
        const userId = getUserId();

        try {
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
          const existingJobResponse = await fetch(
            `${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`
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
          
          // **NEW** Handle cancelled job case specifically
          if (result.jobCancelled || result.message?.includes('cancelled')) {
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "cancelled",
                message: result.message || "🛑 Previous job was cancelled. Please use the restart button to continue processing from where you left off.",
                canRestart: true,
              },
            });
            return;
          }
          
          // Handle both successful start AND incomplete job cases
          if (result.success) {
            // Reset cooldown info and auth error on successful start
            setCooldownInfo(null);
            setAuthError(null);
            
            const newJobStatus: JobStatus = {
              jobId: result.jobId,
              status: "processing",
              totalContacts: result.totalContacts,
              processedCount: result.processedCount || 0,
              successCount: 0,
              failureCount: 0,
              createdAt: new Date().toISOString(),
              humanPatterns: {
                startPattern: result.currentPattern,
                startTime: new Date().toISOString(),
              },
            };
            
            setJobStatus(newJobStatus);
            setDailyLimitInfo(result.limitInfo);
            // Job monitoring will start via useEffect
            setJobRunTimestamp();

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "started",
                message: `✅ Job started during ${result.currentPattern} pattern! Processing ${result.totalContacts} LinkedIn profiles with human-like timing`,
                dailyLimitInfo: result.limitInfo,
                humanPattern: result.currentPatternInfo,
              },
            });
          } else if (result.canResume && result.jobId) {
            // Handle incomplete job case
            console.log("📋 Found incomplete job, setting up monitoring:", result.jobId);
            
            const incompleteJobStatus: JobStatus = {
              jobId: result.jobId,
              status: result.status,
              totalContacts: result.totalContacts,
              processedCount: result.processedCount,
              successCount: 0,
              failureCount: 0,
              createdAt: new Date().toISOString(),
            };
            
            setJobStatus(incompleteJobStatus);
            setDailyLimitInfo(result.limitInfo);
            // Job monitoring will start via useEffect
            setJobRunTimestamp();

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "resuming",
                message: `🔄 Resuming incomplete job... (${result.processedCount}/${result.totalContacts} contacts processed)`,
                dailyLimitInfo: result.limitInfo,
                humanPattern: result.currentPattern,
              },
            });
          } else {
            // Handle error case
            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: "error",
                message: result.message || "Failed to start processing",
                canRestart: result.jobCancelled || result.message?.includes('cancelled'),
              },
            });
          }
        } catch (error) {
          console.error("❌ Job start failed:", error);
          
          // Check if it's an authentication error
          const errorMessage = error.message || "";
          if (errorMessage.includes("Missing required parameters") || 
              errorMessage.includes("userId") || 
              errorMessage.includes("li_at") || 
              errorMessage.includes("accessToken") || 
              errorMessage.includes("crmUrl") || 
              errorMessage.includes("jsessionid")) {
            setAuthError(errorMessage);
          }
          
          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "error",
              message: `❌ Failed to start job: ${error.message}`,
              canRestart: errorMessage.includes('cancelled'),
            },
          });
        }
      }
    };

    const callStartProcessingAPI = async (requestData: any) => {
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
                onOverrideCooldown={handleOverrideCooldown}
                onStopProcessing={handleStopProcessing}
                onRestartAfterCancel={handleRestartAfterCancel}
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
