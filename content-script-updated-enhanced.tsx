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

  // Enhanced job monitoring with pattern awareness
  const checkJobStatus = (jobId: string) => {
    if (!jobId) return;
    
    console.log("🔍 Checking job status for:", jobId);
    
    fetch(`${API_BASE_URL}/job-status/${jobId}`)
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(result => {
        if (!result.success) {
          console.warn("Job status check returned unsuccessful result");
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
        
        if (result.job.currentPatternInfo) {
          setCurrentHumanPattern(result.job.currentPatternInfo);
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
            humanPattern: result.job.currentPatternInfo,
            jobAge: result.job.jobAge,
          },
        });

        if (result.job.status === "completed" || result.job.status === "failed") {
          if (jobMonitorInterval.current) {
            window.clearInterval(jobMonitorInterval.current);
            jobMonitorInterval.current = null;
            console.log("🏁 Job monitoring stopped - job completed/failed");
          }
        }
      })
      .catch(error => {
        console.error("Job status check failed:", error);
        // Don't clear the interval on error, just log it
      });
  };

  const startJobMonitoring = (jobId: string) => {
    console.log("🔄 Starting job monitoring for:", jobId);
    
    // Clear any existing monitoring
    if (jobMonitorInterval.current) {
      window.clearInterval(jobMonitorInterval.current);
      jobMonitorInterval.current = null;
    }

    // Initial check immediately
    checkJobStatus(jobId);

    // Start periodic checks every 15 seconds for more responsive updates
    const intervalId = window.setInterval(() => {
      console.log("⏰ Scheduled job status check for:", jobId);
      checkJobStatus(jobId);
    }, 15000);
    
    jobMonitorInterval.current = intervalId;
    console.log("✅ Job monitoring started with interval ID:", intervalId);
  };

  // Monitor job status
  useEffect(() => {
    // Start monitoring if we have a job
    if (jobStatus?.jobId) {
      startJobMonitoring(jobStatus.jobId);
    }

    // Cleanup
    return () => {
      if (jobMonitorInterval.current) {
        window.clearInterval(jobMonitorInterval.current);
        jobMonitorInterval.current = null;
      }
    };
  }, [jobStatus?.jobId]);

  useEffect(() => {
    if (sidebarOpen) {
      startTimeRef.current = Date.now();
      // Fetch human patterns when sidebar opens
      fetchHumanPatterns();
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
  }, [sidebarOpen]);

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

  // Enhanced job checking with pattern awareness and better memory
  useEffect(() => {
    const checkExistingJob = async () => {
      if (!currentUserFullname || !accessToken) return;

      const userId = getUserId();
      const lastRun = localStorage.getItem("lastJobRun");
      
      console.log(`🔍 Enhanced job check for user: ${userId}`);
      
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
            jobAge: result.job?.jobAge,
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
          
          if (result.success && result.canResume) {
            setJobStatus(result.job);
            setDailyLimitInfo(result.job.dailyLimitInfo);
            
            let statusMessage = "";
            let canResume = true;
            const ageInfo = result.job.jobAge?.days > 0 ? ` (${result.job.jobAge.days}d old)` : '';

            if (result.job.status === "processing") {
              statusMessage = `🔄 Continuing job${ageInfo}... (${result.job.processedCount}/${result.job.totalContacts})`;
              startJobMonitoring(result.job.jobId);
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
            setJobStatus(null);
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

  // Enhanced message listener with pattern awareness
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
                startJobMonitoring(existingJobResult.job.jobId);
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
          
          // Handle both successful start AND incomplete job cases
          if (result.success) {
            // Reset cooldown info on successful start
            setCooldownInfo(null);
            
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
            startJobMonitoring(result.jobId);
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
            startJobMonitoring(result.jobId);
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
              },
            });
          }
        } catch (error) {
          console.error("❌ Job start failed:", error);
          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "error",
              message: `❌ Failed to start job: ${error.message}`,
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
              {/* Debug button - remove in production */}
              <button 
                onClick={debugJobMemory} 
                style={{ 
                  marginTop: '10px', 
                  padding: '5px 10px', 
                  fontSize: '12px',
                  backgroundColor: '#0066cc',
                  color: 'white',
                  border: 'none',
                  borderRadius: '3px',
                  cursor: 'pointer'
                }}
              >
                🔍 Debug Job Memory
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
