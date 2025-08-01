function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}


function getRandomDelay(min = 1500, max = 4000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {sleep,chunkArray,getRandomDelay};