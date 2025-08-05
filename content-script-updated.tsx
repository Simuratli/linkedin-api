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

// API Configuration
const API_BASE_URL = "https://linkedin-api-basl.onrender.com";
const MONITORING_INTERVAL = 15000; // 15 seconds

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
  const [jobStatus, setJobStatus] = useState<any>(null);
  const [isCheckingJob, setIsCheckingJob] = useState(false);
  const [apiStatus, setApiStatus] = useState<any>(null);
  const [simpleClientStats, setSimpleClientStats] = useState<any>(null);
  const [simpleClientInitialized, setSimpleClientInitialized] = useState(false);

  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  const hasOneMonthPassed = (lastRun: string | null) => {
    if (!lastRun) return true;
    const lastRunTime = new Date(lastRun).getTime();
    return Date.now() - lastRunTime > ONE_MONTH_MS;
  };

  const setJobRunTimestamp = () => {
    localStorage.setItem("lastJobRun", new Date().toISOString());
  };

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

  // Check API health and simple client status
  const checkApiHealth = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/health`);
      if (response.ok) {
        const result = await response.json();
        setApiStatus(result);
        setSimpleClientInitialized(result.simpleClientInitialized);
        setSimpleClientStats(result.simpleClientStats);
        
        // Log important status information
        if (result.simpleClientStats) {
          console.log(`📊 API Health: ${result.simpleClientStats.successRate || 0}% success rate, ${result.simpleClientStats.totalRequests || 0} total requests`);
        }
        
        return result;
      }
    } catch (error) {
      console.error("❌ API health check failed:", error);
      setApiStatus({ status: "unhealthy", error: error.message });
    }
    return null;
  };

  // Initialize simple LinkedIn client if needed
  const initializeSimpleClientIfNeeded = async () => {
    if (simpleClientInitialized) return true;

    try {
      console.log("🚀 Initializing simple LinkedIn client...");
      const response = await fetch(`${API_BASE_URL}/initialize-simple-client`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          setSimpleClientInitialized(true);
          setSimpleClientStats(result.simpleClientStats);
          console.log("✅ Simple LinkedIn client initialized successfully");
          
          // Send status to background script
          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "client_initialized",
              message: `Simple client initialized with ${result.simpleClientStats?.successRate || 0}% success rate`,
            },
          });
          
          return true;
        }
      }
      
      throw new Error("Simple client initialization failed");
    } catch (error) {
      console.error("❌ Simple client initialization failed:", error);
      return false;
    }
  };

  // Enhanced job status check with simple client stats
  const checkExistingJob = async () => {
    if (!currentUserFullname || !accessToken) return;

    // Check API health first
    const healthStatus = await checkApiHealth();
    if (!healthStatus || healthStatus.status !== "healthy") {
      console.log("⚠️ API is not healthy, skipping job check");
      return;
    }

    const lastRun = localStorage.getItem("lastJobRun");
    if (!hasOneMonthPassed(lastRun)) {
      // Still within 30 days — check if last job was completed
      const userId = getUserId();
      const response = await fetch(
        `${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`
      );

      if (response.ok) {
        const result = await response.json();
        console.log(result.job, "RESULT JOB STATUS");
        
        // Update simple client status
        setSimpleClientStats(result.simpleClientStats);
        setSimpleClientInitialized(result.simpleClientInitialized);
        
        if (result.success && result.job?.status !== "completed") {
          console.log("✅ Last job was not completed. Allowing resume/check.");
        } else {
          console.log("🚫 Skipping job check — already completed within 30 days.");
          return;
        }
      } else {
        console.log("ℹ️ Could not verify job status, proceeding with check...");
      }
    }

    setIsCheckingJob(true);
    try {
      const userId = getUserId();
      const response = await fetch(
        `${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`
      );

      if (response.ok) {
        const result = await response.json();
        
        // Update status information
        setSimpleClientStats(result.simpleClientStats);
        setSimpleClientInitialized(result.simpleClientInitialized);
        
        if (result.success && result.canResume) {
          setJobStatus(result.job);
          
          if (result.job.status === "processing") {
            startJobMonitoring(result.job.jobId);
          }

          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: result.job.status === "processing" ? "continuing" : "can_resume",
              message: result.job.status === "processing"
                ? `Continuing job... (${result.job.processedCount}/${result.job.totalContacts})`
                : `Found ${result.job.status} job. Processed: ${result.job.processedCount}/${result.job.totalContacts}`,
              canResume: true,
              jobData: result.job,
              simpleClientStats: result.simpleClientStats,
              simpleClientInitialized: result.simpleClientInitialized,
            },
          });
        } else {
          setJobStatus(null);
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

  // Enhanced job monitoring with simple client stats
  const startJobMonitoring = (jobId: string) => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/job-status/${jobId}`);
        if (response.ok) {
          const result = await response.json();
          if (result.success) {
            setJobStatus(result.job);
            setSimpleClientStats(result.simpleClientStats);
            setSimpleClientInitialized(result.simpleClientInitialized);

            // Enhanced status message with simple client info
            let statusMessage = `Processing: ${result.job.processedCount}/${result.job.totalContacts} (Success: ${result.job.successCount}, Failed: ${result.job.failureCount})`;
            
            if (result.simpleClientStats) {
              const stats = result.simpleClientStats;
              statusMessage += ` | Success Rate: ${stats.successRate || 0}% | Total Requests: ${stats.totalRequests || 0}`;
            }

            chrome.runtime.sendMessage({
              type: "PROCESS_STATUS",
              data: {
                status: result.job.status === "completed" ? "completed" : 
                       result.job.status === "paused" ? "paused" : "processing",
                message: statusMessage,
                progress: {
                  total: result.job.totalContacts,
                  processed: result.job.processedCount,
                  success: result.job.successCount,
                  failed: result.job.failureCount,
                },
                pauseReason: result.job.pauseReason,
                simpleClientStats: result.simpleClientStats,
              },
            });

            if (result.job.status === "completed") {
              clearInterval(interval);
              chrome.runtime.sendMessage({
                type: "PROCESS_STATUS",
                data: {
                  status: "completed",
                  message: "All LinkedIn profile updates completed!",
                  finalStats: {
                    total: result.job.totalContacts,
                    success: result.job.successCount,
                    failed: result.job.failureCount,
                  },
                },
              });
            } else if (result.job.status === "paused") {
              clearInterval(interval);
              let pauseMessage = "Job paused";
              if (result.job.pauseReason) {
                switch (result.job.pauseReason) {
                  case "daily_limit_reached":
                  case "daily_limit_approaching":
                    pauseMessage = "Job paused: Daily rate limit reached. Will resume tomorrow.";
                    break;
                  case "simple_client_health_degraded":
                    pauseMessage = "Job paused: Simple client health degraded. Will resume when healthy.";
                    break;
                  case "token_refresh_failed":
                    pauseMessage = "Job paused: Authentication expired. Please re-authenticate.";
                    break;
                  default:
                    pauseMessage = `Job paused: ${result.job.pauseReason}`;
                }
              }
              
              chrome.runtime.sendMessage({
                type: "PROCESS_STATUS",
                data: {
                  status: "paused",
                  message: pauseMessage,
                  pauseReason: result.job.pauseReason,
                },
              });
            }
          }
        }
      } catch (error) {
        console.error("Error monitoring job status:", error);
      }
    }, MONITORING_INTERVAL);
    
    return interval;
  };

  // Enhanced API call with better error handling
  const callStartProcessingAPI = async (requestData: any) => {
    try {
      // Initialize simple client if needed
      if (!simpleClientInitialized) {
        const initialized = await initializeSimpleClientIfNeeded();
        if (!initialized) {
          throw new Error("Failed to initialize simple LinkedIn client. Please try again.");
        }
      }

      const response = await fetch(`${API_BASE_URL}/start-processing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestData),
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `API call failed: ${response.status}`);
      }
      
      const result = await response.json();
      setJobRunTimestamp();
      
      // Update status info
      if (result.simpleClientStats) {
        setSimpleClientStats(result.simpleClientStats);
      }
      
      return result;
    } catch (error) {
      console.error("❌ Start processing API call failed:", error);
      throw error;
    }
  };

  // Initialize on mount
  useEffect(() => {
    // Check API health on component mount
    checkApiHealth();
  }, []);

  useEffect(() => {
    if (sidebarOpen) {
      startTimeRef.current = Date.now();
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

  useEffect(() => {
    if (currentUserFullname && accessToken) {
      checkExistingJob();
    }
  }, [currentUserFullname, accessToken]);

  useEffect(() => {
    let abortController: AbortController | null = null;

    const messageListener = async (request: any) => {
      if (request.type === "LINKEDIN_COOKIES") {
        const userId = getUserId();

        try {
          // Check existing job first
          const existingJobResponse = await fetch(
            `${API_BASE_URL}/user-job/${encodeURIComponent(userId)}`
          );
          
          if (existingJobResponse.ok) {
            const existingJobResult = await existingJobResponse.json();
            
            // Update status info
            setSimpleClientStats(existingJobResult.simpleClientStats);
            setSimpleClientInitialized(existingJobResult.simpleClientInitialized);

            if (existingJobResult.success && existingJobResult.canResume) {
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
              if (resumeResult.success) {
                setJobStatus(existingJobResult.job);
                startJobMonitoring(existingJobResult.job.jobId);
                setJobRunTimestamp();
              }
              return;
            }
          }
        } catch (error) {
          console.log("Error checking/resuming job:", error.message);
        }

        // Start new job
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
          if (result.success) {
            setJobStatus({
              jobId: result.jobId,
              status: "processing",
              totalContacts: result.totalContacts,
              processedCount: result.processedCount,
            });
            startJobMonitoring(result.jobId);
            setJobRunTimestamp();
          }
        } catch (error) {
          console.error("❌ Job start failed:", error);
          
          chrome.runtime.sendMessage({
            type: "PROCESS_STATUS",
            data: {
              status: "failed",
              message: `Job failed to start: ${error.message}`,
              error: error.message,
            },
          });
        }
      }
      
      // Handle simple client initialization requests
      if (request.type === "INITIALIZE_SIMPLE_CLIENT") {
        await initializeSimpleClientIfNeeded();
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
    simpleClientInitialized,
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
                simpleClientStats={simpleClientStats}
                simpleClientInitialized={simpleClientInitialized}
                apiStatus={apiStatus}
                onInitializeSimpleClient={initializeSimpleClientIfNeeded}
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
            {loading && <Loader />}
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