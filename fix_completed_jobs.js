// Script to fix jobs that are completed but stuck in "processing" status
const fs = require('fs').promises;
const path = require('path');

// Load jobs from the data file
const loadJobs = async () => {
  try {
    const jobsPath = path.join(__dirname, 'data', 'processing_jobs.json');
    const data = await fs.readFile(jobsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading jobs:', error);
    return {};
  }
};

// Save jobs to the data file
const saveJobs = async (jobs) => {
  try {
    const jobsPath = path.join(__dirname, 'data', 'processing_jobs.json');
    await fs.writeFile(jobsPath, JSON.stringify(jobs, null, 2));
    console.log('✅ Jobs saved successfully');
  } catch (error) {
    console.error('Error saving jobs:', error);
  }
};

// Fix stuck completed jobs
const fixCompletedJobs = async () => {
  console.log('🔧 Starting to fix completed jobs...');
  
  const jobs = await loadJobs();
  let fixedCount = 0;
  
  for (const [jobId, job] of Object.entries(jobs)) {
    // Check if job should be completed but isn't
    if (job.status === "processing") {
      const remainingPending = job.contacts ? job.contacts.filter(c => c.status === "pending").length : 0;
      const allContactsProcessed = job.processedCount >= job.totalContacts;
      
      if (remainingPending === 0 && allContactsProcessed) {
        console.log(`🔧 Fixing job ${jobId} - all contacts completed but status was still processing`);
        console.log(`   - Total: ${job.totalContacts}, Processed: ${job.processedCount}, Success: ${job.successCount}`);
        
        // Fix the job status
        job.status = "completed";
        job.completedAt = new Date().toISOString();
        job.currentBatchIndex = 0;
        job.completionReason = "auto_completed_by_fix_script";
        
        fixedCount++;
      }
    }
  }
  
  if (fixedCount > 0) {
    await saveJobs(jobs);
    console.log(`✅ Fixed ${fixedCount} completed jobs`);
  } else {
    console.log('ℹ️ No jobs needed fixing');
  }
};

// Run the fix
fixCompletedJobs().catch(console.error);
