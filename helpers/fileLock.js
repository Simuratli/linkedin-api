const fs = require("fs").promises;

const writeQueue = new Map();

async function safeWrite(filePath, data) {
  if (!writeQueue.has(filePath)) {
    writeQueue.set(filePath, Promise.resolve());
  }

  const lastWrite = writeQueue.get(filePath);

  const newWrite = lastWrite.then(async () => {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  }).catch(err => {
    console.error("File write error:", err);
  });

  writeQueue.set(filePath, newWrite);
  return newWrite;
}

// Read JSON file safely
async function readJsonFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, return empty object
      return {};
    }
    throw error;
  }
}

// Write JSON file safely with locking
async function writeJsonFile(filePath, data) {
  return await safeWrite(filePath, data);
}

module.exports = { safeWrite, readJsonFile, writeJsonFile };
