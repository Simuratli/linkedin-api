const BAKU_TIMEZONE = 'Asia/Baku';

function getBakuTime() {
  return new Date().toLocaleString('en-US', { timeZone: BAKU_TIMEZONE });
}

function getBakuDateTime() {
  return new Date(getBakuTime());
}

function getBakuHour() {
  return getBakuDateTime().getHours();
}

function getBakuDay() {
  return getBakuDateTime().getDay();
}

module.exports = {
  getBakuTime,
  getBakuDateTime,
  getBakuHour,
  getBakuDay,
  BAKU_TIMEZONE
};
