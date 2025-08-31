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

module.exports = { safeWrite };
