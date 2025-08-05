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

function getRandomDelay() {
  // 8-45 saniye arası rastgele bekleme (LinkedIn için ideal)
  return Math.floor(Math.random() * 37000) + 8000;
}


module.exports = {sleep,chunkArray,getRandomDelay};